// Copyright 2026 Coresource AI, Inc.
// SPDX-License-Identifier: Apache-2.0

import { canonicalJson, hashValue, type BoundResourceCapabilities, type Cost, type ToolCallRecord, type TurnRecord, type TurnSpec } from "@constal/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  CONTEXT_CHARACTERS, CONTEXT_SHARE, DIGEST_SHARE, EXCERPT_CHARACTERS, clip, compactContext, contextAllowance, contextSize,
  digestRound, initialState, observation, recalibrate, recordRound, relieveDigest, type Round, type SurveyState,
} from "../src/memory.js";
import { WORKING_NOTES_PROMPT } from "../src/prompt.js";

const record = (overrides: Partial<ToolCallRecord> = {}): ToolCallRecord => ({
  id: "c1", pos: "0", name: "web_fetch", version: "1", args: { url: "https://example.com/a" }, maxEffect: "read", effectObserved: "read",
  status: "ok", result: "body", ...overrides,
} as ToolCallRecord);
const turn = (content: string, toolCalls: ToolCallRecord[] = [], extra: Partial<TurnRecord> = {}): TurnRecord =>
  ({ hash: "h", message: { role: "assistant", content }, toolCalls, final: false, artifact: null, cost: { tokens: { input: 0, output: 0, cached: 0, cacheWrite: 0 } } as Cost, attempts: 1, gate: null, ...extra });
const capabilities = (contextTokens?: number) => ({ model: { id: "m", ...(contextTokens === undefined ? {} : { contextTokens }) } } as BoundResourceCapabilities);

/** A state with `rounds` recent rounds whose fetch bodies are `body` characters long (a function gives the body of round i). */
function survey(rounds: number, body: number | ((round: number) => number), notes: string | null = null): SurveyState {
  let state = { ...initialState("heat pumps"), notes };
  for (let i = 0; i < rounds; i += 1) {
    state = recordRound(state, turn(`intent ${i}`, [
      record({ id: `s${i}`, name: "web_search", args: { query: `q${i}` }, result: { hits: [`https://example.com/${i}`] }, ref: `ref-s${i}` }),
      record({ id: `f${i}`, args: { url: `https://example.com/${i}` }, result: "x".repeat(typeof body === "number" ? body : body(i)), preview: `preview ${i}`, ref: `ref-f${i}` }),
    ]));
  }
  return state;
}

/** Rounds without the runtime's bounded preview, so only the full result remains. */
function withoutPreviews(state: SurveyState): SurveyState {
  return { ...state, recent: state.recent.map((round) => ({ ...round, observations: round.observations.map(({ preview: _preview, ...item }) => item) })) };
}

function fakeCtx(notes: (spec: TurnSpec, calls: TurnSpec[]) => TurnRecord | Promise<TurnRecord>) {
  const calls: TurnSpec[] = [];
  return { calls, turn: vi.fn(async (spec: TurnSpec) => { calls.push(spec); return notes(spec, calls); }) };
}

describe("survey state", () => {
  it("starts from the documented shape and stays canonical-JSON safe", async () => {
    expect(initialState("heat pumps")).toEqual({ v: 1, request: "heat pumps", turns: 0, nextSeq: 1, notes: null, notesThroughTurn: 0, digest: [], recent: [], charactersPerToken: 4, report: null });
    const full = observation(record({ preview: "p", error: "e", ref: "r" }), 7);
    expect(full).toEqual({ seq: 7, name: "web_fetch", args: { url: "https://example.com/a" }, status: "ok", result: "body", preview: "p", error: "e", ref: "r" });
    const sparse = observation(record({ result: undefined, preview: undefined, error: undefined, ref: undefined }), 1);
    expect(Object.keys(sparse)).toEqual(["seq", "name", "args", "status"]);
    const state = survey(2, 10);
    expect(JSON.parse(canonicalJson(state))).toEqual(survey(2, 10));
    expect(await hashValue(state)).toBe(await hashValue(survey(2, 10)));
    expect(state.recent.map((round) => round.observations.map((item) => item.seq))).toEqual([[1, 2], [3, 4]]);
    expect(state).toMatchObject({ turns: 2, nextSeq: 5 });
  });

  it("clips without splitting surrogate pairs and digests deterministically", () => {
    const short = "a".repeat(EXCERPT_CHARACTERS);
    expect(clip(short, EXCERPT_CHARACTERS)).toBe(short);
    const long = `${"a".repeat(EXCERPT_CHARACTERS - 1)}😀${"b".repeat(10)}`;
    const clipped = clip(long, EXCERPT_CHARACTERS);
    expect(clipped.startsWith(`${"a".repeat(EXCERPT_CHARACTERS - 1)}…(`)).toBe(true);
    expect(clipped).toBe(`${"a".repeat(EXCERPT_CHARACTERS - 1)}…(${long.length - EXCERPT_CHARACTERS + 1} more characters)`);
    expect(clip("abcdef", 3)).toBe("abc…(3 more characters)");
    const round: Round = { turn: 4, intent: "i", observations: [
      { seq: 9, name: "web_fetch", args: { url: "u" }, status: "ok", result: "r".repeat(5_000), preview: "pv", ref: "ref" },
      { seq: 10, name: "web_search", args: { query: "q" }, status: "ok", result: { hits: [] } },
      { seq: 11, name: "web_fetch", args: { url: "v" }, status: "error", error: { code: "denied" } },
    ] };
    expect(digestRound(round)).toEqual([
      { seq: 9, turn: 4, name: "web_fetch", args: { url: "u" }, status: "ok", ref: "ref", excerpt: "pv" },
      { seq: 10, turn: 4, name: "web_search", args: { query: "q" }, status: "ok", excerpt: '{"hits":[]}' },
      { seq: 11, turn: 4, name: "web_fetch", args: { url: "v" }, status: "error", excerpt: '{"code":"denied"}' },
    ]);
    expect(digestRound({ ...round, observations: [{ seq: 1, name: "web_fetch", args: {}, status: "ok", result: "r".repeat(5_000) }] })[0]!.excerpt!.length)
      .toBeLessThan(EXCERPT_CHARACTERS + 30);
    expect(digestRound(round)).toEqual(digestRound(round));
    expect(digestRound({ turn: 0, intent: "i", observations: [{ seq: 1, name: "web_fetch", args: {}, status: "ok" }] }))
      .toEqual([{ seq: 1, turn: 0, name: "web_fetch", args: {}, status: "ok" }]);
  });

  it("derives the allowance from the reported context window and calibrates characters per token", () => {
    const state = initialState("x");
    expect(contextAllowance(null, state)).toBe(CONTEXT_CHARACTERS);
    expect(contextAllowance(capabilities(), state)).toBe(CONTEXT_CHARACTERS);
    expect(contextAllowance(capabilities(50_000), state)).toBe(Math.floor(50_000 * CONTEXT_SHARE * 4));
    expect(contextAllowance(capabilities(1_000_000), state)).toBe(CONTEXT_CHARACTERS);
    expect(contextAllowance(capabilities(50_000), { ...state, charactersPerToken: 2.5 })).toBe(Math.floor(50_000 * CONTEXT_SHARE * 2.5));
    const cost = (input: number) => ({ tokens: { input, output: 0, cached: 0, cacheWrite: 0 } } as Cost);
    expect(recalibrate(state, cost(0), 1_000)).toBe(state);
    expect(recalibrate(state, cost(400), 1_000).charactersPerToken).toBe(2.5);
    expect(recalibrate(state, cost(10), 1_000).charactersPerToken).toBe(4);
    expect(recalibrate(state, cost(5_000), 1_000).charactersPerToken).toBe(1);
  });
});

describe("context compaction", () => {
  it("is a no-op while the research context fits", async () => {
    const state = survey(3, 100);
    const ctx = fakeCtx(() => turn("notes"));
    expect(await compactContext(state, contextSize(state), ctx)).toBe(state);
    expect(ctx.turn).not.toHaveBeenCalled();
    expect(await compactContext(initialState("x"), 1, ctx)).toEqual(initialState("x"));
  });

  it("folds the oldest rounds into digest and notes and keeps the newest verbatim", async () => {
    const state = survey(3, (round) => (round === 2 ? 6_000 : 500));
    const allowance = contextSize({ ...state, recent: state.recent.slice(2) }) + 1_000;
    const ctx = fakeCtx(() => turn("  the notes  "));
    const next = await compactContext(state, allowance, ctx);
    expect(next.recent).toEqual(state.recent.slice(2));
    expect(next.notes).toBe("the notes");
    expect(next.notesThroughTurn).toBe(2);
    expect(next.digest).toEqual([
      { seq: 1, turn: 0, name: "web_search", args: { query: "q0" }, status: "ok", ref: "ref-s0" },
      { seq: 2, turn: 0, name: "web_fetch", args: { url: "https://example.com/0" }, status: "ok", ref: "ref-f0" },
      { seq: 3, turn: 1, name: "web_search", args: { query: "q1" }, status: "ok", ref: "ref-s1" },
      { seq: 4, turn: 1, name: "web_fetch", args: { url: "https://example.com/1" }, status: "ok", ref: "ref-f1" },
    ]);
    expect(ctx.turn).toHaveBeenCalledTimes(1);
    const spec = ctx.calls[0]!;
    expect(spec.tools).toEqual([]);
    expect(spec.system.startsWith(WORKING_NOTES_PROMPT)).toBe(true);
    expect(spec.system).toContain("Original user request:\nheat pumps");
    expect(spec.context).toMatchObject({ request: "heat pumps", priorNotes: null, part: { index: 1, total: 1 } });
    const evidence = (spec.context as { evidence: { turn: number; intent: string; observations: { seq: number; evidence?: string }[] }[] }).evidence;
    expect(evidence.map((round) => [round.turn, round.intent, round.observations.map((item) => item.seq)])).toEqual([[0, "intent 0", [1, 2]], [1, "intent 1", [3, 4]]]);
    expect(evidence[0]!.observations[0]!.evidence).toBe('{"hits":["https://example.com/0"]}');
    expect(evidence[0]!.observations[1]!.evidence).toBe("x".repeat(500));
    expect(evidence[1]!.observations[1]!.evidence).toBe("x".repeat(500));
    expect(contextSize(next)).toBeLessThanOrEqual(allowance);
    expect({ ...next, recent: [], digest: [], notes: null, notesThroughTurn: 0 }).toEqual({ ...state, recent: [], digest: [] });
  });

  it("folds every round when the newest alone exceeds the allowance and splits large folds into parts", async () => {
    const state = withoutPreviews(survey(3, 3_000));
    const allowance = EXCERPT_CHARACTERS;
    const ctx = fakeCtx((spec) => turn(`notes after part ${(spec.context as { part: { index: number } }).part.index}`));
    const next = await compactContext(state, allowance, ctx);
    expect(next.recent).toEqual([]);
    expect(next.digest.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(next.notesThroughTurn).toBe(3);
    expect(ctx.calls.length).toBeGreaterThan(1);
    const parts = ctx.calls.map((spec) => spec.context as { priorNotes: string | null; part: { index: number; total: number } });
    expect(parts.map((part) => part.part.index)).toEqual(parts.map((_, index) => index + 1));
    expect(parts.every((part) => part.part.total === parts.length)).toBe(true);
    expect(parts.map((part) => part.priorNotes)).toEqual([null, ...parts.slice(1).map((_, index) => `notes after part ${index + 1}`)]);
    expect(next.notes).toBe(`notes after part ${parts.length}`);
    expect(ctx.calls.every((spec) => JSON.stringify(spec.context).length <= allowance / 2 + 500)).toBe(true);
    expect(JSON.stringify(ctx.calls[0]!.context)).toContain("x".repeat(100));
  });

  it("hands the full fetched body to the notes turn even when the runtime attached a preview", async () => {
    const state = survey(2, 3_000);
    const allowance = contextSize(state) - 1;
    const ctx = fakeCtx(() => turn("notes"));
    await compactContext(state, allowance, ctx);
    const evidence = (ctx.calls[0]!.context as { evidence: { observations: { seq: number; evidence?: string }[] }[] }).evidence;
    const fetched = evidence.flatMap((round) => round.observations).find((item) => item.seq === 2)!;
    expect(fetched.evidence!.startsWith("x".repeat(1_000))).toBe(true);
    expect(fetched.evidence).not.toBe("preview 0");
  });

  it("excludes rounds the notes already cover from the next refresh and threads the prior notes", async () => {
    const state = survey(3, 3_000);
    const allowance = contextSize({ ...state, recent: state.recent.slice(2) }) + 1_000;
    const first = await compactContext(state, allowance, fakeCtx(() => turn("n1")));
    expect(first).toMatchObject({ notes: "n1", notesThroughTurn: 2 });
    const later = recordRound(first, turn("intent 3", [record({ id: "f3", args: { url: "https://example.com/3" }, result: "y".repeat(3_000) })]));
    const ctx = fakeCtx(() => turn("n2"));
    const second = await compactContext(later, contextSize({ ...later, recent: later.recent.slice(1) }) + 1_000, ctx);
    const evidence = ctx.calls[0]!.context as { evidence: { turn: number }[]; priorNotes: string | null };
    expect(ctx.calls.length).toBe(1);
    expect(evidence.evidence.map((round) => round.turn)).toEqual([2]);
    expect(evidence.priorNotes).toBe("n1");
    expect(second).toMatchObject({ notes: "n2", notesThroughTurn: 3 });
    expect(second.recent).toEqual(later.recent.slice(1));
    expect(second.digest.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(second.digest.every((entry) => entry.excerpt === undefined)).toBe(true);
  });

  it("keeps excerpts and prior notes when a notes turn fails, propagates errors, and retries later", async () => {
    const state = survey(3, 3_000);
    const allowance = contextSize({ ...state, recent: state.recent.slice(2) }) + 1_000;
    for (const failed of [turn(""), turn("partial", [], { completion: { status: "incomplete", reason: "length" } })]) {
      const next = await compactContext(state, allowance, fakeCtx(() => failed));
      expect(next.notes).toBeNull();
      expect(next.notesThroughTurn).toBe(0);
      expect(next.recent).toEqual(state.recent.slice(2));
      expect(next.digest.map((entry) => entry.excerpt)).toEqual(['{"hits":["https://example.com/0"]}', "preview 0", '{"hits":["https://example.com/1"]}', "preview 1"]);
    }
    const sentinel = new Error("provider down");
    await expect(compactContext(state, allowance, fakeCtx(() => Promise.reject(sentinel)))).rejects.toBe(sentinel);

    const stripped = withoutPreviews(state);
    const partial = fakeCtx((spec) => (spec.context as { part: { index: number } }).part.index === 1 ? turn("part1 notes") : turn(""));
    const halted = await compactContext(stripped, EXCERPT_CHARACTERS, partial);
    expect(partial.calls.length).toBe(2);
    expect(halted.notes).toBeNull();
    expect(halted.notesThroughTurn).toBe(0);
    expect(halted.recent).toEqual([]);
    expect(halted.digest.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(halted.digest.every((entry) => entry.excerpt === undefined)).toBe(true);
    expect(JSON.stringify(halted.digest).length).toBe(JSON.stringify(halted.digest.map(({ seq, turn, name, args, status, ref }) => ({ seq, turn, name, args, status, ref }))).length);
    expect(JSON.stringify(halted.digest).length).toBeGreaterThan(DIGEST_SHARE * EXCERPT_CHARACTERS);

    const stale = await compactContext(state, allowance, fakeCtx(() => turn("")));
    const later = recordRound(stale, turn("intent 3", [record({ id: "f3", args: { url: "https://example.com/3" }, result: "y".repeat(12_000) })]));
    const ctx = fakeCtx(() => turn("covered"));
    const recovered = await compactContext(later, contextSize({ ...later, recent: later.recent.slice(1) }) + 1_000, ctx);
    const evidence = (ctx.calls[0]!.context as { evidence: { turn: number; intent?: string; observations: { seq: number; evidence?: string }[] }[] }).evidence;
    expect(evidence.map((round) => [round.turn, round.intent, round.observations.map((item) => item.seq)])).toEqual([[0, undefined, [1, 2]], [1, undefined, [3, 4]], [2, "intent 2", [5, 6]]]);
    expect(evidence[0]!.observations[1]!.evidence).toBe("preview 0");
    expect(evidence[2]!.observations[1]!.evidence).toBe("x".repeat(3_000));
    expect(ctx.calls.length).toBe(1);
    expect(recovered).toMatchObject({ notes: "covered", notesThroughTurn: 3 });
    expect(recovered.digest.every((entry) => entry.excerpt === undefined)).toBe(true);
    expect(recovered.digest.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("keeps errors and falls back to previews when handing folded observations to the notes turn", async () => {
    let state = initialState("heat pumps");
    state = recordRound(state, turn("intent 0", [
      record({ id: "e0", args: { url: "https://example.com/denied" }, status: "error", result: undefined, error: { code: "denied" } }),
      record({ id: "p0", args: { url: "https://example.com/p" }, result: undefined, preview: "only preview", ref: "r" }),
    ]));
    state = recordRound(state, turn("intent 1", [record({ id: "f1", args: { url: "https://example.com/1" }, result: "x".repeat(3_000) })]));
    const ctx = fakeCtx(() => turn("notes"));
    const next = await compactContext(state, contextSize(state) - 1, ctx);
    expect(ctx.calls.length).toBe(1);
    const evidence = (ctx.calls[0]!.context as { evidence: { turn: number; observations: unknown[] }[] }).evidence;
    expect(evidence.map((round) => round.turn)).toEqual([0]);
    expect(evidence[0]!.observations[0]).toEqual({ seq: 1, name: "web_fetch", args: { url: "https://example.com/denied" }, status: "error", error: { code: "denied" } });
    expect(evidence[0]!.observations[1]).toEqual({ seq: 2, name: "web_fetch", args: { url: "https://example.com/p" }, status: "ok", ref: "r", evidence: "only preview" });
    expect(next.notesThroughTurn).toBe(1);
    expect(next.recent).toEqual(state.recent.slice(1));
    expect(next.digest).toEqual([
      { seq: 1, turn: 0, name: "web_fetch", args: { url: "https://example.com/denied" }, status: "error" },
      { seq: 2, turn: 0, name: "web_fetch", args: { url: "https://example.com/p" }, status: "ok", ref: "r" },
    ]);
  });

  it("covers receipt-only rounds whose excerpts were relieved before the notes covered them", async () => {
    const state = survey(3, 3_000);
    const allowance = contextSize({ ...state, recent: state.recent.slice(2) }) + 1_000;
    const failed = await compactContext(state, allowance, fakeCtx(() => turn("")));
    expect(failed.digest.every((entry) => entry.excerpt !== undefined)).toBe(true);
    const receipts = relieveDigest(failed, 1);
    expect(receipts.digest.map((entry) => entry.seq)).toEqual([1, 2, 3, 4]);
    expect(receipts.digest.every((entry) => entry.excerpt === undefined)).toBe(true);
    expect(receipts).toMatchObject({ notes: null, notesThroughTurn: 0 });
    const later = recordRound(receipts, turn("intent 3", [record({ id: "f3", args: { url: "https://example.com/3" }, result: "y".repeat(3_000) })]));
    const ctx = fakeCtx(() => turn("covered"));
    const next = await compactContext(later, contextSize({ ...later, recent: later.recent.slice(1) }) + 1_000, ctx);
    expect(ctx.calls.length).toBe(1);
    const evidence = (ctx.calls[0]!.context as { evidence: { turn: number; observations: object[] }[] }).evidence;
    expect(evidence.map((round) => [round.turn, round.observations.map((item) => "evidence" in item)])).toEqual([[0, [false, false]], [1, [false, false]], [2, [true, true]]]);
    expect(next).toMatchObject({ notes: "covered", notesThroughTurn: 3 });
    expect(next.recent).toEqual(later.recent.slice(1));
    expect(next.digest.map(({ seq, turn, name, args, status, ref }) => ({ seq, turn, name, args, status, ref })))
      .toEqual(state.recent.flatMap((round) => digestRound(round)).map(({ seq, turn, name, args, status, ref }) => ({ seq, turn, name, args, status, ref })));
    expect(next.digest.every((entry) => entry.excerpt === undefined)).toBe(true);
  });

  it("relieves digest pressure oldest-first while keeping every receipt", () => {
    const state = survey(6, 10);
    const digest = state.recent.flatMap((round) => digestRound({ ...round, observations: round.observations.map((item) => ({ ...item, preview: "p".repeat(500) })) }));
    const allowance = 8_000;
    const relieved = relieveDigest({ ...state, recent: [], digest }, allowance);
    expect(JSON.stringify(relieved.digest).length).toBeLessThanOrEqual(DIGEST_SHARE * allowance);
    const stripped = relieved.digest.findIndex((entry) => entry.excerpt !== undefined);
    expect(stripped).toBeGreaterThan(0);
    expect(relieved.digest.slice(stripped).every((entry) => entry.excerpt !== undefined)).toBe(true);
    expect(relieved.digest.map(({ seq, name, args, status, ref }) => ({ seq, name, args, status, ref })))
      .toEqual(digest.map(({ seq, name, args, status, ref }) => ({ seq, name, args, status, ref })));
    expect(relieveDigest({ ...state, digest }, 1_000_000).digest).toBe(digest);
  });
});
