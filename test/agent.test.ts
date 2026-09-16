// Copyright 2026 Coresource AI, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Cost, Ctx, ToolCallRecord, TurnRecord, TurnSpec } from "@constal/sdk";
import { describe, expect, it, vi } from "vitest";
import agent from "../src/index.js";
import { EXCERPT_CHARACTERS, contextSize, initialState, recordRound, type SurveyState } from "../src/memory.js";
import { WORKING_NOTES_PROMPT, marketLandscapeResearchPrompt } from "../src/prompt.js";

const call = (id: string, url: string, body: string): ToolCallRecord =>
  ({ id, pos: "0", name: "web_fetch", version: "1", args: { url }, maxEffect: "read", effectObserved: "read", status: "ok", result: body, preview: body.slice(0, 20), ref: `ref-${id}` } as ToolCallRecord);
const turn = (content: string, toolCalls: ToolCallRecord[] = [], input = 0): TurnRecord =>
  ({ hash: "h", message: { role: "assistant", content }, toolCalls, final: false, artifact: null, cost: { tokens: { input, output: 0, cached: 0, cacheWrite: 0 } } as Cost, attempts: 1, gate: null });

function fakeCtx(turns: TurnRecord[] | ((spec: TurnSpec) => TurnRecord | Promise<TurnRecord>), contextTokens?: number) {
  const calls: TurnSpec[] = [];
  const ctx = {
    calls,
    turn: vi.fn(async (spec: TurnSpec) => { calls.push(spec); return Array.isArray(turns) ? turns.shift() ?? turn("exhausted") : turns(spec); }),
    describeResource: vi.fn(async () => contextTokens === undefined ? null : { model: { id: "m", contextTokens } }),
    step: (_name: string, fn: () => Promise<unknown>) => fn(),
  };
  return { ctx, run: (state: SurveyState) => agent.step!(state, ctx as unknown as Ctx) };
}

describe("durable survey agent", () => {
  it("initializes its state from the request text", () => {
    expect(agent.mode).toBe("durable");
    expect(agent.version).toBe("0.3.0");
    expect(agent.init!({ messages: [{ role: "user", content: "heat pumps" }] }).request).toBe("heat pumps");
    expect(agent.init!("x")).toEqual(initialState("x"));
    expect(agent.output!(initialState("x"))).toBe("");
  });

  it("runs one research turn per step and stores the no-tool response as the report", async () => {
    const { ctx, run } = fakeCtx([turn("looking", [call("c1", "https://example.com/a", "body a")], 250), turn("# Report", [], 300)]);
    const first = await run(initialState("heat pumps"));
    expect(first.done).toBe(false);
    expect(ctx.calls[0]).toEqual({
      system: marketLandscapeResearchPrompt("heat pumps"),
      context: { request: "heat pumps", workingNotes: null, earlierEvidence: [], recentRounds: [] },
      tools: ["web_search", "web_fetch"],
    });
    expect(first.state.recent).toEqual([{ turn: 0, intent: "looking", observations: [
      { seq: 1, name: "web_fetch", args: { url: "https://example.com/a" }, status: "ok", result: "body a", preview: "body a", ref: "ref-c1" },
    ] }]);
    expect(first.state).toMatchObject({ turns: 1, nextSeq: 2, report: null, charactersPerToken: Math.min(4, JSON.stringify(ctx.calls[0]).length / 250) });

    const second = await run(first.state);
    expect(second.done).toBe(true);
    expect(second.state.report).toBe("# Report");
    expect(second.state.turns).toBe(2);
    expect((ctx.calls[1]!.context as { recentRounds: unknown[] }).recentRounds).toEqual(first.state.recent);
    expect(agent.output!(second.state)).toBe("# Report");
    expect(typeof agent.output!(second.state)).toBe("string");
    expect(ctx.describeResource).toHaveBeenCalledWith("model");

    const again = await run(second.state);
    expect(again).toEqual({ state: second.state, done: true });
    expect(ctx.turn).toHaveBeenCalledTimes(2);
  });

  it("refreshes the working notes before the research turn when the context exceeds the allowance", async () => {
    let state = initialState("heat pumps");
    for (let i = 0; i < 4; i += 1) state = recordRound(state, turn(`intent ${i}`, [call(`c${i}`, `https://example.com/${i}`, "x".repeat(20_000))]));
    const contextTokens = Math.ceil((contextSize({ ...state, recent: state.recent.slice(3) }) + 4 * EXCERPT_CHARACTERS) / (0.6 * 4));
    const { ctx, run } = fakeCtx((spec) => spec.tools.length === 0 ? turn("private notes") : turn("next", [call("c4", "https://example.com/4", "y")]), contextTokens);
    const result = await run(state);
    const notesTurns = ctx.calls.slice(0, -1);
    const research = ctx.calls[ctx.calls.length - 1]!;
    expect(notesTurns.length).toBeGreaterThan(0);
    expect(notesTurns.every((spec) => spec.tools.length === 0 && spec.system.startsWith(WORKING_NOTES_PROMPT))).toBe(true);
    expect(notesTurns.some((spec) => JSON.stringify(spec.context).includes("x".repeat(1_000)))).toBe(true);
    expect(research).toMatchObject({ system: marketLandscapeResearchPrompt("heat pumps"), tools: ["web_search", "web_fetch"] });
    expect(research.context).toEqual({
      request: "heat pumps", workingNotes: "private notes",
      earlierEvidence: [0, 1, 2].map((i) => ({ seq: i + 1, turn: i, name: "web_fetch", args: { url: `https://example.com/${i}` }, status: "ok", ref: `ref-c${i}` })),
      recentRounds: state.recent.slice(3),
    });
    expect(result.done).toBe(false);
    expect(result.state).toMatchObject({ notes: "private notes", notesThroughTurn: 3, report: null, turns: 5, nextSeq: 6 });
    expect(result.state.recent.map((round) => round.turn)).toEqual([3, 4]);
    expect(JSON.stringify(result.state)).not.toContain('"report":"private notes"');
  });

  it("runs the research turn with the excerpts intact when the notes turn fails and never catches errors", async () => {
    let state = initialState("heat pumps");
    for (let i = 0; i < 4; i += 1) state = recordRound(state, turn(`intent ${i}`, [call(`c${i}`, `https://example.com/${i}`, "x".repeat(20_000))]));
    const contextTokens = Math.ceil((contextSize({ ...state, recent: state.recent.slice(3) }) + 4 * EXCERPT_CHARACTERS) / (0.6 * 4));
    const { ctx, run } = fakeCtx((spec) => spec.tools.length === 0 ? turn("") : turn("next", [call("c4", "https://example.com/4", "y")]), contextTokens);
    const result = await run(state);
    expect(ctx.calls.length).toBeGreaterThan(1);
    expect(ctx.calls.slice(0, -1).every((spec) => spec.tools.length === 0)).toBe(true);
    const research = ctx.calls[ctx.calls.length - 1]!;
    expect(research.tools).toEqual(["web_search", "web_fetch"]);
    const context = research.context as { workingNotes: string | null; earlierEvidence: { excerpt?: unknown }[] };
    expect(context.workingNotes).toBeNull();
    expect(context.earlierEvidence.map((entry) => typeof entry.excerpt)).toEqual(["string", "string", "string"]);
    expect(result.done).toBe(false);
    expect(result.state).toMatchObject({ notes: null, notesThroughTurn: 0, turns: 5, report: null });
    expect(result.state.digest.every((entry) => typeof entry.excerpt === "string")).toBe(true);

    const sentinel = new Error("down");
    const failing = fakeCtx(() => Promise.reject(sentinel));
    await expect(failing.run(initialState("x"))).rejects.toBe(sentinel);
    expect(failing.ctx.turn).toHaveBeenCalledTimes(1);
  });
});
