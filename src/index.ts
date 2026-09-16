// Copyright 2026 Coresource AI, Inc.
// SPDX-License-Identifier: Apache-2.0

import { agent, webFetch, webSearch, type ToolCallRecord } from "@constal/sdk";
import { marketLandscapeResearchPrompt } from "./prompt.js";

const RESEARCH_TOOLS = ["web_search", "web_fetch"];

/** The runtime's Tool outcome, projected to what the model needs on later turns. */
interface Observation {
  name: string;
  args: unknown;
  status: ToolCallRecord["status"];
  result?: unknown;
  preview?: unknown;
  error?: unknown;
}

interface ChatMessage {
  role: string;
  content: string;
}

function observation({ name, args, status, result, preview, error }: ToolCallRecord): Observation {
  return { name, args, status, result, preview, error };
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

export default agent({
  id: "market-landscape-survey",
  version: "0.2.0",
  model: "model",
  mode: "script",
  tools: {
    web_search: webSearch,
    web_fetch: webFetch,
  },
  async onMessage(message, ctx) {
    const request = requestText(message);
    const observations: Observation[] = [];

    while (true) {
      const turn = await ctx.turn({
        system: marketLandscapeResearchPrompt(request),
        context: { request, observations },
        tools: RESEARCH_TOOLS,
      });

      if (turn.toolCalls.length === 0) return turn.message.content;
      observations.push(...turn.toolCalls.map(observation));
    }
  },
});
