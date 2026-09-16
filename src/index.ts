// Copyright 2026 Coresource AI, Inc.
// SPDX-License-Identifier: Apache-2.0

import { agent, webFetch, webSearch } from "@constal/sdk";
import { contextAllowance, fold, initialState, recalibrate, recordRound, surveyContext, type SurveyState } from "./memory.js";
import { marketLandscapeResearchPrompt } from "./prompt.js";
import { recallEvidence } from "./tools.js";

const TOOLS = { web_search: webSearch, web_fetch: webFetch, recall_evidence: recallEvidence };
const RESEARCH_TOOLS = ["web_search", "web_fetch", "recall_evidence"];
const TOOL_DECLARATIONS = JSON.stringify(Object.values(TOOLS).map(({ name, description, schema }) => ({ name, description, schema })));

interface ChatMessage {
  role: string;
  content: string;
}

function chatMessages(message: unknown): ChatMessage[] | null {
  const messages = message && typeof message === "object" && !Array.isArray(message)
    ? (message as { messages?: unknown }).messages : undefined;
  return Array.isArray(messages) && messages.length > 0 && messages.every((item) => item && typeof item === "object"
    && typeof (item as ChatMessage).role === "string" && typeof (item as ChatMessage).content === "string")
    ? messages as ChatMessage[] : null;
}

/**
 * The request reaches the model unchanged. Plain text is used as is; the chat
 * envelope delivered by the platform's OpenAI-compatible Channel and the Instant
 * UI is rendered as a transcript; anything else is serialized rather than
 * interpreted here.
 */
export function requestText(message: unknown): string {
  if (typeof message === "string") return message;
  const messages = chatMessages(message);
  if (messages) {
    return messages.length === 1 ? messages[0]!.content : messages.map(({ role, content }) => `${role}: ${content}`).join("\n\n");
  }
  return JSON.stringify(message, null, 2);
}

/**
 * Durable: each dispatch resumes from the stored state and runs exactly one
 * research turn. The first research turn that makes no tool call is the final
 * report, stored verbatim. Full tool results stay in the context until the
 * bound model's own window is the constraint; released results remain readable
 * through recall_evidence by their platform ref.
 */
export default agent<SurveyState>({
  id: "market-landscape-survey",
  version: "0.4.3",
  model: "model",
  mode: "durable",
  tools: TOOLS,
  init(message) {
    return initialState(requestText(message));
  },
  async step(state, ctx) {
    if (state.report !== null) return { state, done: true };
    const system = marketLandscapeResearchPrompt(state.request);
    const overhead = system.length + TOOL_DECLARATIONS.length;
    const allowance = contextAllowance(await ctx.describeResource("model"), state, overhead);
    const folded = allowance === null ? state : fold(state, allowance);
    const spec = { system, context: surveyContext(folded), tools: RESEARCH_TOOLS, effort: "high" as const };
    const turn = await ctx.turn(spec);
    const calibrated = recalibrate(folded, turn.cost, JSON.stringify(spec.context).length + overhead);
    if (turn.toolCalls.length === 0) {
      return { state: { ...calibrated, turns: calibrated.turns + 1, report: turn.message.content }, done: true };
    }
    return { state: recordRound(calibrated, turn), done: false };
  },
  output(state) {
    return state.report ?? "";
  },
});
