// Copyright 2026 Coresource AI, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { BoundResourceCapabilities, Cost, Ctx, ToolCallRecord, TurnRecord } from "@constal/sdk";
import { workingNotesPrompt } from "./prompt.js";

/** Fallback allowance, in characters, for the serialized research context. */
export const CONTEXT_CHARACTERS = 240_000;
/** Share of a reported model context window spent on the research context. */
export const CONTEXT_SHARE = 0.6;
/** Bound of one digest excerpt. */
export const EXCERPT_CHARACTERS = 2_000;
/** Bound of the evidence of one observation handed to a working-notes turn. */
export const NOTES_EVIDENCE_CHARACTERS = 40_000;
/** Share of the allowance the digest may occupy before its oldest excerpts become receipts. */
export const DIGEST_SHARE = 0.25;

/** One Tool outcome exactly as the runtime delivered it (verbatim tier). */
export interface Observation {
  /** 1-based, monotonically increasing across the run: the citation anchor "[obs N]". */
  seq: number;
  name: string;
  args: unknown;
  status: ToolCallRecord["status"];
  result?: unknown;
  preview?: unknown;
  error?: unknown;
  /** Content address of the full result; survives folding as the receipt. */
  ref?: string;
}

/** One research turn that issued tool calls: the model's stated intent plus what came back. */
export interface Round { turn: number; intent: string; observations: Observation[] }

/** Compact tier for folded observations: a receipt plus, until the notes cover it, a bounded excerpt. */
export interface DigestEntry {
  seq: number;
  turn: number;
  name: string;
  args: unknown;
  status: ToolCallRecord["status"];
  ref?: string;
  excerpt?: string;
}

export interface SurveyState {
  v: 1;
  /** requestText(message), verbatim. */
  request: string;
  /** Research turns completed (= the next Round.turn). */
  turns: number;
  /** The next Observation.seq. */
  nextSeq: number;
  /** The model's own working notes (compacted form); null until the first successful refresh. */
  notes: string | null;
  /** Rounds with turn < notesThroughTurn are folded into `notes`. */
  notesThroughTurn: number;
  /** Folded observations, oldest first. */
  digest: DigestEntry[];
  /** Newest rounds, verbatim. */
  recent: Round[];
  /** Starts at 4; recalibrated from the reported input tokens after each research turn. */
  charactersPerToken: number;
  /** Set once, by the research turn that makes no tool call. */
  report: string | null;
}

/** What the research turn sees: the request, the model's own notes and intents, and tool observations. */
export interface SurveyContext {
  request: string;
  workingNotes: string | null;
  earlierEvidence: DigestEntry[];
  recentRounds: Round[];
}

interface NotesObservation { seq: number; name: string; args: unknown; status: ToolCallRecord["status"]; ref?: string; evidence?: string; error?: unknown }
interface NotesRound { turn: number; intent?: string; observations: NotesObservation[] }

export function initialState(request: string): SurveyState {
  return { v: 1, request, turns: 0, nextSeq: 1, notes: null, notesThroughTurn: 0, digest: [], recent: [], charactersPerToken: 4, report: null };
}

/** Optional fields are added only when present so the state stays canonical-JSON safe. */
export function observation({ name, args, status, result, preview, error, ref }: ToolCallRecord, seq: number): Observation {
  return {
    seq, name, args, status,
    ...(result !== undefined ? { result } : {}), ...(preview !== undefined ? { preview } : {}),
    ...(error !== undefined ? { error } : {}), ...(ref !== undefined ? { ref } : {}),
  };
}

export function surveyContext(state: SurveyState): SurveyContext {
  return { request: state.request, workingNotes: state.notes, earlierEvidence: state.digest, recentRounds: state.recent };
}

export function contextSize(state: SurveyState): number {
  return JSON.stringify(surveyContext(state)).length;
}

export function contextAllowance(capabilities: BoundResourceCapabilities | null, state: SurveyState): number {
  const contextTokens = capabilities?.model?.contextTokens;
  return Number.isFinite(contextTokens)
    ? Math.min(CONTEXT_CHARACTERS, Math.floor(contextTokens! * CONTEXT_SHARE * state.charactersPerToken))
    : CONTEXT_CHARACTERS;
}

/** Horizon's calibration in inverse form: observed characters per reported input token, clamped to [1, 4]. */
export function recalibrate(state: SurveyState, cost: Cost, specCharacters: number): SurveyState {
  const input = cost.tokens.input;
  return input > 0 ? { ...state, charactersPerToken: Math.min(4, Math.max(1, specCharacters / input)) } : state;
}

export function recordRound(state: SurveyState, turn: TurnRecord): SurveyState {
  const observations = turn.toolCalls.map((call, index) => observation(call, state.nextSeq + index));
  return {
    ...state, turns: state.turns + 1, nextSeq: state.nextSeq + observations.length,
    recent: [...state.recent, { turn: state.turns, intent: turn.message.content, observations }],
  };
}

function render(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value) ?? "";
}

/** Bounds text without splitting a surrogate pair; the suffix reports what was removed. */
export function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const code = text.charCodeAt(limit - 1);
  const cut = code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit;
  return `${text.slice(0, cut)}…(${text.length - cut} more characters)`;
}

function receipt({ seq, turn, name, args, status, ref }: DigestEntry): DigestEntry {
  return { seq, turn, name, args, status, ...(ref !== undefined ? { ref } : {}) };
}

export function digestRound(round: Round): DigestEntry[] {
  return round.observations.map(({ seq, name, args, status, ref, preview, result, error }) => {
    const source = preview ?? result ?? error;
    return {
      ...receipt({ seq, turn: round.turn, name, args, status, ...(ref !== undefined ? { ref } : {}) }),
      ...(source !== undefined ? { excerpt: clip(render(source), EXCERPT_CHARACTERS) } : {}),
    };
  });
}

function notesRounds(state: SurveyState, fold: Round[]): NotesRound[] {
  const folded = new Set(fold.map((round) => round.turn));
  const pending = new Map<number, NotesRound>();
  for (const entry of state.digest) {
    if (entry.turn < state.notesThroughTurn || folded.has(entry.turn)) continue;
    const round = pending.get(entry.turn) ?? { turn: entry.turn, observations: [] };
    const { seq, name, args, status, ref, excerpt } = entry;
    round.observations.push({ seq, name, args, status, ...(ref !== undefined ? { ref } : {}), ...(excerpt !== undefined ? { evidence: excerpt } : {}) });
    pending.set(entry.turn, round);
  }
  const verbatim = fold.map((round): NotesRound => ({
    turn: round.turn, intent: round.intent,
    observations: round.observations.map(({ seq, name, args, status, ref, preview, result, error }) => {
      const source = result ?? preview;
      return {
        seq, name, args, status, ...(ref !== undefined ? { ref } : {}),
        ...(source !== undefined ? { evidence: render(source) } : {}), ...(error !== undefined ? { error } : {}),
      };
    }),
  }));
  return [...pending.values(), ...verbatim];
}

function clipRound(round: NotesRound, characters: number): NotesRound {
  return { ...round, observations: round.observations.map((item) => item.evidence === undefined ? item : { ...item, evidence: clip(item.evidence, characters) }) };
}

function size(value: unknown): number {
  return JSON.stringify(value).length;
}

/** Greedy grouping of rounds into parts of bounded size; an oversized round is clipped by halving until it fits alone. */
function notesParts(rounds: NotesRound[], limit: number): NotesRound[][] {
  const parts: NotesRound[][] = [];
  let current: NotesRound[] = [];
  for (const round of rounds) {
    let characters = NOTES_EVIDENCE_CHARACTERS;
    let clipped = clipRound(round, characters);
    while (size(clipped) > limit && characters > 1) clipped = clipRound(round, characters = Math.floor(characters / 2));
    if (current.length > 0 && size([...current, clipped]) > limit) {
      parts.push(current);
      current = [];
    }
    current.push(clipped);
  }
  return current.length > 0 ? [...parts, current] : parts;
}

/** The model tier: refreshes the working notes over every folded round the notes do not cover yet. */
async function refreshNotes(state: SurveyState, fold: Round[], allowance: number, ctx: Pick<Ctx, "turn">): Promise<SurveyState> {
  const rounds = notesRounds(state, fold);
  if (rounds.length === 0) return state;
  const parts = notesParts(rounds, allowance / 2);
  let notes = state.notes;
  for (const [index, evidence] of parts.entries()) {
    const refresh = await ctx.turn({
      system: workingNotesPrompt(state.request),
      context: { request: state.request, priorNotes: notes, evidence, part: { index: index + 1, total: parts.length } },
      tools: [],
    });
    const content = refresh.message.content.trim();
    if (content.length === 0 || refresh.completion?.status === "incomplete") return state;
    notes = content;
  }
  const notesThroughTurn = rounds[rounds.length - 1]!.turn + 1;
  return { ...state, notes, notesThroughTurn, digest: state.digest.map((entry) => entry.turn < notesThroughTurn ? receipt(entry) : entry) };
}

/** Digest pressure: the oldest excerpts become receipts until the digest fits its share; receipts are never removed. */
export function relieveDigest(state: SurveyState, allowance: number): SurveyState {
  let digest = state.digest;
  while (size(digest) > DIGEST_SHARE * allowance) {
    const index = digest.findIndex((entry) => entry.excerpt !== undefined);
    if (index < 0) break;
    digest = digest.map((entry, position) => position === index ? receipt(entry) : entry);
  }
  return digest === state.digest ? state : { ...state, digest };
}

/**
 * Folds the oldest rounds into the digest and the model's working notes when
 * the research context exceeds its allowance; returns the same state otherwise.
 * Every reduction is a pure function of (state, allowance), so a re-executed
 * step replays its notes turn deterministically.
 */
export async function compactContext(state: SurveyState, allowance: number, ctx: Pick<Ctx, "turn">): Promise<SurveyState> {
  if (state.recent.length === 0 || contextSize(state) <= allowance) return state;
  const newest = state.recent[state.recent.length - 1]!;
  const older = state.recent.slice(0, -1);
  const keepNewest = contextSize({ ...state, recent: [newest], digest: [...state.digest, ...older.flatMap(digestRound)] }) <= allowance;
  const fold = keepNewest ? older : state.recent;
  const digested = { ...state, recent: keepNewest ? [newest] : [], digest: [...state.digest, ...fold.flatMap(digestRound)] };
  return relieveDigest(await refreshNotes(digested, fold, allowance, ctx), allowance);
}
