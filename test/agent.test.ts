// Copyright 2026 Coresource AI, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Cost, Ctx, ToolCallRecord, TurnRecord, TurnSpec } from "@constal/sdk";
import { describe, expect, it, vi } from "vitest";
import agent from "../src/index.js";
import { contextSize, initialState, recordRound, type SurveyState } from "../src/memory.js";
import { marketLandscapeResearchPrompt } from "../src/prompt.js";
import { recallEvidence } from "../src/tools.js";

const REF = "b".repeat(64);
const call = (id: string, url: string, body: string): ToolCallRecord =>
  ({ id, pos: "0", name: "web_fetch", version: "1", args: { url }, maxEffect: "read-only", effectObserved: "read-only", status: "ok", result: body, preview: body.slice(0, 20), ref: REF } as ToolCallRecord);
const turn = (content: string, toolCalls: ToolCallRecord[] = [], input = 0): TurnRecord =>
  ({ hash: "h", message: { role: "assistant", content }, toolCalls, final: false, artifact: null, cost: { tokens: { input, output: 0, cached: 0, cacheWrite: 0 } } as Cost, attempts: 1, gate: null });

function fakeCtx(turns: TurnRecord[], model?: { contextTokens?: number; maxOutputTokens?: number }) {
  const calls: TurnSpec[] = [];
  const ctx = {
    calls,
    turn: vi.fn(async (spec: TurnSpec) => { calls.push(spec); return turns.shift() ?? turn("exhausted"); }),
    describeResource: vi.fn(async () => model === undefined ? null : { model: { id: "m", ...model } }),
  };
  return { ctx, run: (state: SurveyState) => agent.step!(state, ctx as unknown as Ctx) };
}

describe("durable survey agent", () => {
  it("initializes its state from the request text and offers exactly the research tools", () => {
    expect(agent.mode).toBe("durable");
    expect(agent.version).toBe("0.4.3");
    expect(Object.keys(agent.tools!)).toEqual(["web_search", "web_fetch", "recall_evidence"]);
    expect(agent.init!({ messages: [{ role: "user", content: "heat pumps" }] }).request).toBe("heat pumps");
    expect(agent.init!("x")).toEqual(initialState("x"));
    expect(agent.output!(initialState("x"))).toBe("");
  });

  it("runs one research turn per step and stores the no-tool response as the report", async () => {
    const { ctx, run } = fakeCtx([turn("looking", [call("c1", "https://example.com/a", "body a")], 250), turn("# Report", [], 300)], { contextTokens: 1_000_000, maxOutputTokens: 100_000 });
    const first = await run(initialState("heat pumps"));
    expect(first.done).toBe(false);
    expect(ctx.calls[0]).toEqual({ system: marketLandscapeResearchPrompt("heat pumps"), context: { request: "heat pumps", rounds: [] }, tools: ["web_search", "web_fetch", "recall_evidence"], effort: "high" });
    expect(first.state.rounds).toEqual([{ turn: 0, intent: "looking", observations: [
      { seq: 1, name: "web_fetch", args: { url: "https://example.com/a" }, status: "ok", result: "body a", preview: "body a", ref: REF },
    ] }]);
    expect(first.state).toMatchObject({ turns: 1, nextSeq: 2, report: null });
    expect(first.state.charactersPerToken).toBeGreaterThan(0);
    expect(first.state.charactersPerToken).not.toBe(4);
    const second = await run(first.state);
    expect(second).toMatchObject({ done: true, state: { report: "# Report", turns: 2 } });
    expect((ctx.calls[1]!.context as { rounds: unknown[] }).rounds).toEqual(first.state.rounds);
    expect(agent.output!(second.state)).toBe("# Report");
    expect(await run(second.state)).toEqual({ state: second.state, done: true });
    expect(ctx.turn).toHaveBeenCalledTimes(2);
  });

  it("releases old results only when the model's reported window is full, and keeps everything when it reports none", async () => {
    let state = initialState("heat pumps");
    for (let i = 0; i < 3; i += 1) state = recordRound(state, turn(`intent ${i}`, [call(`c${i}`, `https://example.com/${i}`, "x".repeat(20_000))]));
    const overhead = marketLandscapeResearchPrompt("heat pumps").length
      + JSON.stringify(Object.values(agent.tools!).map(({ name, description, schema }) => ({ name, description, schema }))).length;
    // Allowance of (contextSize - 15_000) characters: releasing the oldest 20_000-character result is enough, releasing two is not needed.
    const window = Math.ceil((contextSize(state) - 15_000 + overhead) / 4);
    const full = fakeCtx([turn("next", [call("c3", "https://example.com/3", "y")])], { contextTokens: window, maxOutputTokens: 0 });
    const result = await full.run(state);
    const rounds = (full.ctx.calls[0]!.context as { rounds: Array<{ observations: Array<{ result?: unknown; ref?: string }> }> }).rounds;
    expect(rounds.map((round) => round.observations[0]!.result === undefined)).toEqual([true, false, false]);
    expect(rounds[0]!.observations[0]!.ref).toBe(REF);
    expect(result.state.rounds[0]!.observations[0]!.result).toBeUndefined();
    expect(result.state.rounds.length).toBe(4);
    const unbounded = fakeCtx([turn("next", [call("c3", "https://example.com/3", "y")])]);
    await unbounded.run(state);
    expect((unbounded.ctx.calls[0]!.context as { rounds: unknown[] }).rounds).toEqual(state.rounds);
  });

  it("recalls an exact saved result by ref, whole or as a chosen window", async () => {
    const invoke = vi.fn(async () => ({ ref: REF, value: "0123456789" }));
    const ctx = { invoke, resources: { cas: "crn:cas" } } as unknown as Ctx;
    expect(await recallEvidence.run!({ ref: REF }, ctx)).toEqual({ ref: REF, value: "0123456789" });
    expect(await recallEvidence.run!({ ref: REF, offset: 4, length: 3 }, ctx)).toEqual({ ref: REF, text: "456", offset: 4, characters: 10, nextOffset: 7 });
    expect(await recallEvidence.run!({ ref: REF, offset: 8 }, ctx)).toMatchObject({ text: "89", nextOffset: null });
    expect(invoke).toHaveBeenCalledWith("crn:cas", "get", { ref: REF });
    expect(recallEvidence.needs).toEqual([{ binding: "cas", kind: "cas", ops: ["get"] }]);
  });
});
