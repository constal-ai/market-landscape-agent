// Copyright 2026 Coresource AI, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { renderInline, renderMarkdown } from "../ui/public/markdown.js";
import { buildUi, UI_ID } from "../scripts/build-ui.mjs";
import { requestText } from "../src/index.js";

describe("request text", () => {
  it("passes plain text through unchanged", () => {
    expect(requestText("electric bikes, Europe")).toBe("electric bikes, Europe");
  });
  it("uses the single user message of the OpenAI Channel envelope", () => {
    expect(requestText({ messages: [{ role: "user", content: "heat pumps" }], metadata: null })).toBe("heat pumps");
  });
  it("renders a multi-message envelope as a transcript", () => {
    expect(requestText({ messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }] }))
      .toBe("user: a\n\nassistant: b\n\nuser: c");
  });
  it("serializes anything else instead of interpreting it", () => {
    expect(requestText({ objective: "x" })).toBe(JSON.stringify({ objective: "x" }, null, 2));
  });
});

describe("markdown renderer", () => {
  it("escapes HTML before formatting", () => {
    expect(renderInline("<script>alert(1)</script> **bold** `a<b`")).toBe("&lt;script&gt;alert(1)&lt;/script&gt; <strong>bold</strong> <code>a&lt;b</code>");
  });
  it("keeps only http(s) link targets", () => {
    expect(renderInline("[ok](https://example.com/a?b=1) [bad](javascript:alert(1))"))
      .toBe('<a href="https://example.com/a?b=1" target="_blank" rel="noopener noreferrer">ok</a> [bad](javascript:alert(1))');
    expect(renderInline('<img src=x onerror=alert(1)>')).not.toContain("<img");
  });
  it("renders headings, lists, tables, quotes, and code blocks", () => {
    const html = renderMarkdown("# Title\n\n## Supply Side\n\n- one\n- two\n  - nested\n\n1. first\n2. second\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n> quote\n\n```\nx < y\n```\n\nSee https://example.com/x.");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<h2>Supply Side</h2>");
    expect(html).toContain("<ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul>");
    expect(html).toContain("<ol><li>first</li><li>second</li></ol>");
    expect(html).toContain("<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>");
    expect(html).toContain("<blockquote><p>quote</p></blockquote>");
    expect(html).toContain("<pre><code>x &lt; y</code></pre>");
    expect(html).toContain('<a href="https://example.com/x" target="_blank" rel="noopener noreferrer">https://example.com/x</a>.');
  });
});

describe("ui bundle", () => {
  it("builds a valid stateless constal.ui.v1 bundle with every asset", async () => {
    const built = await buildUi();
    expect(UI_ID).toBe("market-landscape-workspace");
    expect(built.bundle.manifest).toEqual({ schemaVersion: 1, kind: "constal.ui", runtime: { contract: "constal.ui-handler.v1", entry: "worker.mjs" },
      assets: { root: "public", fallback: "index.html" }, contentSecurityPolicy: "strict" });
    expect(Object.keys(built.bundle.modules)).toEqual(["worker.mjs"]);
    expect(Object.keys(built.bundle.assets).sort()).toEqual(["public/app.js", "public/favicon.svg", "public/index.html", "public/markdown.js", "public/styles.css"]);
    expect(built.ref).toMatch(/^[a-f0-9]{64}$/u);
    const html = Buffer.from(built.bundle.assets["public/index.html"]!.bodyBase64, "base64").toString("utf8");
    expect(html).not.toMatch(/<script(?![^>]*src=)/u);
    expect(html).not.toMatch(/ on[a-z]+=|<style/u);
  });
});
