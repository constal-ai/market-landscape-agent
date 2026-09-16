// Copyright 2026 Coresource AI, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { BoundResourceCapabilities, Cost, ToolCallRecord, TurnRecord } from "@constal/sdk";

/** One Tool outcome as the runtime delivered it. `ref` is the platform's content address of the full result. */
export interface Observation {
  /** 1-based, increasing across the run: the citation anchor "[obs N]". */
  seq: number;
  name: string;
  args: unknown;
  status: ToolCallRecord["status"];
  result?: unknown;
  preview?: unknown;
  error?: unknown;
  ref?: string;
}

/** One research turn that issued tool calls: the model's stated intent plus what came back. */
export interface Round { turn: number; intent: string; observations: Observation[] }

export interface SurveyState {
  v: 2;
  /** requestText(message), verbatim. */
  request: string;
  /** Research turns completed (= the next Round.turn). */
  turns: number;
  /** The next Observation.seq. */
  nextSeq: number;
  /** Every research round, oldest first. Older observations may carry only their preview and ref once the window is full. */
  rounds: Round[];
  /** Measured characters per reported input token; starts at 4 until the first turn reports its usage. */
  charactersPerToken: number;
  /** Set once, by the research turn that makes no tool call. */
  report: string | null;
}

export interface SurveyContext { request: string; rounds: Round[] }

export function initialState(request: string): SurveyState {
  return { v: 2, request, turns: 0, nextSeq: 1, rounds: [], charactersPerToken: 4, report: null };
}

/** Optional fields are added only when present so the state stays canonical-JSON safe. */
export function observation({ name, args, status, result, preview, error, ref }: ToolCallRecord, seq: number): Observation {
  return {
    seq, name, args, status,
    ...(result !== undefined ? { result } : {}), ...(preview !== undefined ? { preview } : {}),
    ...(error !== undefined ? { error } : {}), ...(ref !== undefined ? { ref } : {}),
  };
}

export function recordRound(state: SurveyState, turn: TurnRecord): SurveyState {
  const observations = turn.toolCalls.map((call, index) => observation(call, state.nextSeq + index));
  return { ...state, turns: state.turns + 1, nextSeq: state.nextSeq + observations.length,
    rounds: [...state.rounds, { turn: state.turns, intent: turn.message.content, observations }] };
}

export function surveyContext(state: SurveyState): SurveyContext {
  return { request: state.request, rounds: state.rounds };
}

export function contextSize(state: SurveyState): number {
  return JSON.stringify(surveyContext(state)).length;
}

/**
 * Characters the research context may occupy: the model's reported window minus
 * its reported output reservation, converted with the measured ratio, minus the
 * characters the system prompt and tool declarations take. Null when the bound
 * model reports no window; the platform then governs the prompt on its own.
 */
export function contextAllowance(capabilities: BoundResourceCapabilities | null, state: SurveyState, overheadCharacters: number): number | null {
  const window = capabilities?.model?.contextTokens; const output = capabilities?.model?.maxOutputTokens ?? 0;
  if (typeof window !== "number" || !Number.isFinite(window) || window <= 0) return null;
  return Math.floor((window - output) * state.charactersPerToken) - overheadCharacters;
}

/** Observed characters per reported input token, from the turn the model just processed. */
export function recalibrate(state: SurveyState, cost: Cost, promptCharacters: number): SurveyState {
  const ratio = promptCharacters / cost.tokens.input;
  return Number.isFinite(ratio) && ratio > 0 ? { ...state, charactersPerToken: ratio } : state;
}

const recallable = ({ result, ref }: Observation) => result !== undefined && ref !== undefined;

function withoutResult({ result: _result, ...rest }: Observation): Observation {
  return rest;
}

/**
 * Releases full results, oldest round first, until the context fits the
 * allowance. A released observation keeps its preview and ref, and the model
 * reads it back exactly through recall_evidence. Results the platform did not
 * content-address stay inline; when nothing recallable is left, the context is
 * returned as is and the model's own limits apply.
 */
export function fold(state: SurveyState, allowance: number): SurveyState {
  let rounds = state.rounds;
  while (JSON.stringify({ request: state.request, rounds }).length > allowance) {
    const index = rounds.findIndex((round) => round.observations.some(recallable));
    if (index < 0) break;
    rounds = rounds.map((round, position) => position === index
      ? { ...round, observations: round.observations.map((item) => recallable(item) ? withoutResult(item) : item) } : round);
  }
  return rounds === state.rounds ? state : { ...state, rounds };
}
