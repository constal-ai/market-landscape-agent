// Copyright 2026 Coresource AI, Inc.
// SPDX-License-Identifier: Apache-2.0

import { canonicalJson, hashValue, type Cost, type ToolCallRecord, type TurnRecord } from "@constal/sdk";
import { describe, expect, it } from "vitest";
import { contextAllowance, contextSize, fold, initialState, observation, recalibrate, recordRound, surveyContext } from "../src/memory.js";

const call = (id: string, url: string, body: string, extra: Partial<ToolCallRecord> = {}): ToolCallRecord =>
  ({ id, pos: "0", name: "web_fetch", version: "1", args: { url }, maxEffect: "read-only", effectObserved: "read-only", status: "ok",
    result: body, preview: body.slice(0, 8), ref: "a".repeat(64), ...extra } as ToolCallRecord);
const turn = (content: string, toolCalls: ToolCallRecord[]): TurnRecord =>
  ({ hash: "h", message: { role: "assistant", content }, toolCalls, final: false, artifact: null,
    cost: { tokens: { input: 0, output: 0, cached: 0, cacheWrite: 0 } } as Cost, attempts: 1, gate: null });

describe("survey state", () => {
  it("records rounds with numbered observations and stays canonical-JSON safe", async () => {
    let state = initialState("heat pumps");
    state = recordRound(state, turn("first", [call("c1", "https://a", "body a"), call("c2", "https://b", "body b", { result: undefined, ref: undefined, error: "denied", status: "refused" })]));
    state = recordRound(state, turn("second", [call("c3", "https://c", "body c")]));
    expect(state.rounds).toEqual([
      { turn: 0, intent: "first", observations: [
        { seq: 1, name: "web_fetch", args: { url: "https://a" }, status: "ok", result: "body a", preview: "body a", ref: "a".repeat(64) },
        { seq: 2, name: "web_fetch", args: { url: "https://b" }, status: "refused", preview: "body b", error: "denied" },
      ] },
      { turn: 1, intent: "second", observations: [{ seq: 3, name: "web_fetch", args: { url: "https://c" }, status: "ok", result: "body c", preview: "body c", ref: "a".repeat(64) }] },
    ]);
    expect(state).toMatchObject({ v: 2, turns: 2, nextSeq: 4, report: null });
    expect(JSON.parse(canonicalJson(state))).toEqual(JSON.parse(JSON.stringify(state)));
    expect(await hashValue(state)).toBe(await hashValue(JSON.parse(JSON.stringify(state))));
    expect(Object.keys(observation(call("c", "https://x", "y", { preview: undefined, ref: undefined }), 9))).toEqual(["seq", "name", "args", "status", "result"]);
    expect(surveyContext(state)).toEqual({ request: "heat pumps", rounds: state.rounds });
  });

  it("derives the allowance only from what the model reports and measures its own ratio", () => {
    const state = initialState("x");
    expect(contextAllowance(null, state, 100)).toBeNull();
    expect(contextAllowance({ model: { id: "m" } }, state, 100)).toBeNull();
    expect(contextAllowance({ model: { id: "m", contextTokens: 0 } }, state, 100)).toBeNull();
    expect(contextAllowance({ model: { id: "m", contextTokens: 1_000, maxOutputTokens: 200 } }, state, 100)).toBe(800 * 4 - 100);
    expect(contextAllowance({ model: { id: "m", contextTokens: 1_000 } }, { ...state, charactersPerToken: 2.5 }, 0)).toBe(2_500);
    const cost = (input: number) => ({ tokens: { input, output: 0, cached: 0, cacheWrite: 0 } } as Cost);
    expect(recalibrate(state, cost(250), 1_000).charactersPerToken).toBe(4);
    expect(recalibrate(state, cost(100), 750).charactersPerToken).toBe(7.5);
    expect(recalibrate(state, cost(0), 1_000)).toBe(state);
  });

  it("releases the oldest recallable results first and never drops evidence that cannot be recalled", () => {
    let state = initialState("x");
    state = recordRound(state, turn("r0", [call("c0", "https://0", "0".repeat(1_000))]));
    state = recordRound(state, turn("r1", [call("c1", "https://1", "1".repeat(1_000), { ref: undefined })]));
    state = recordRound(state, turn("r2", [call("c2", "https://2", "2".repeat(1_000))]));
    expect(fold(state, contextSize(state))).toBe(state);
    const once = fold(state, contextSize(state) - 1);
    expect(once.rounds[0]!.observations[0]).toEqual({ seq: 1, name: "web_fetch", args: { url: "https://0" }, status: "ok", preview: "00000000", ref: "a".repeat(64) });
    expect(once.rounds[1]!.observations[0]!.result).toBe("1".repeat(1_000));
    expect(once.rounds[2]!.observations[0]!.result).toBe("2".repeat(1_000));
    const all = fold(state, 10);
    expect(all.rounds.map((round) => round.observations[0]!.result)).toEqual([undefined, "1".repeat(1_000), undefined]);
    expect(all.rounds.map((round) => round.observations[0]!.ref)).toEqual(["a".repeat(64), undefined, "a".repeat(64)]);
    expect(contextSize(all)).toBeGreaterThan(10);
    expect(fold(all, 10)).toBe(all);
  });
});
