// Copyright 2026 Coresource AI, Inc.
// SPDX-License-Identifier: Apache-2.0

import { canonicalJson, type Tool } from "@constal/sdk";

/** Reads an exact saved Tool result by its receipt reference; the model chooses any text window it needs. */
export const recallEvidence: Tool = {
  name: "recall_evidence", version: "1", maxEffect: "read-only",
  description: "Read the exact saved result of an earlier observation by its ref. Omit offset and length for the complete value; for a large result, offset and length select a text window of its string or JSON representation.",
  schema: { type: "object", properties: {
    ref: { type: "string", pattern: "^[a-f0-9]{64}$" },
    offset: { type: "integer", minimum: 0, description: "Character offset in the string or JSON representation." },
    length: { type: "integer", minimum: 1, description: "Number of characters to return." },
  }, required: ["ref"], additionalProperties: false },
  needs: [{ binding: "cas", kind: "cas", ops: ["get"] }],
  async run(args: { ref: string; offset?: number; length?: number }, ctx) {
    const { value } = await ctx.invoke<{ ref: string; value: unknown }>(ctx.resources.cas!, "get", { ref: args.ref });
    if (args.offset === undefined && args.length === undefined) return { ref: args.ref, value };
    const text = typeof value === "string" ? value : canonicalJson(value); const offset = args.offset ?? 0;
    const end = Math.min(text.length, offset + (args.length ?? text.length));
    return { ref: args.ref, text: text.slice(offset, end), offset, characters: text.length, nextOffset: end < text.length ? end : null };
  },
};
