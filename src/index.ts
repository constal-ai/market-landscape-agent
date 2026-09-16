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

function observation({ name, args, status, result, preview, error }: ToolCallRecord): Observation {
  return { name, args, status, result, preview, error };
}

export default agent({
  id: "market-landscape-survey",
  version: "0.1.1",
  model: "model",
  mode: "script",
  tools: {
    web_search: webSearch,
    web_fetch: webFetch,
  },
  async onMessage(message, ctx) {
    // The request reaches the model unchanged; a structured message is
    // serialized rather than interpreted here.
    const request = typeof message === "string" ? message : JSON.stringify(message, null, 2);
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
