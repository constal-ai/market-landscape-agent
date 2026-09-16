// Copyright 2026 Coresource AI, Inc.
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { webFetch, webSearch } from "@constal/sdk";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const exampleRoot = new URL("../", import.meta.url);
const exampleFiles = ["README.md", "src/index.ts", "src/prompt.ts"];

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(new URL(path, exampleRoot), "utf8")) as Record<string, unknown>;
}

function property(object: ts.ObjectLiteralExpression, name: string): ts.ObjectLiteralElementLike | undefined {
  return object.properties.find((candidate) => ts.isPropertyAssignment(candidate) && candidate.name.getText() === name
    || ts.isMethodDeclaration(candidate) && candidate.name.getText() === name);
}

function arrayValues(node: ts.Expression | undefined): string[] | undefined {
  return node && ts.isArrayLiteralExpression(node)
    ? node.elements.map((element) => ts.isStringLiteral(element) ? element.text : undefined).filter((value): value is string => value !== undefined)
    : undefined;
}

function prohibitedControlViolations(source: string): string[] {
  const prohibited = ["maxTurns", "maxQueries", "maxSources", "maxTokens", "tokenBudget", "sourceLimit", "request.includes(", "request.match(", "request.test("];
  return prohibited.filter((control) => source.includes(control));
}

function missingSpdx(files: Record<string, string>): string[] {
  return Object.entries(files)
    .filter(([, content]) => !content.includes("SPDX-License-Identifier: Apache-2.0"))
    .map(([path]) => path);
}

/** Validates authored configuration and orchestration, never a generated report. */
function agentContractViolations(source: string): string[] {
  const file = ts.createSourceFile("index.ts", source, ts.ScriptTarget.ES2023, true);
  const violations: string[] = [];
  const researchTools = file.statements.find((statement): statement is ts.VariableStatement => ts.isVariableStatement(statement)
    && statement.declarationList.declarations.some((declaration) => declaration.name.getText() === "RESEARCH_TOOLS"));
  const toolsDeclaration = researchTools?.declarationList.declarations.find((declaration) => declaration.name.getText() === "RESEARCH_TOOLS");
  if (!toolsDeclaration || !toolsDeclaration.initializer || JSON.stringify(arrayValues(toolsDeclaration.initializer)) !== JSON.stringify(["web_search", "web_fetch"])) {
    violations.push("the offered research tools must be exactly web_search and web_fetch");
  }

  const exportedAgent = file.statements.find((statement): statement is ts.ExportAssignment => ts.isExportAssignment(statement));
  const call = exportedAgent?.expression;
  const firstArgument = call && ts.isCallExpression(call) ? call.arguments[0] : undefined;
  if (!call || !ts.isCallExpression(call) || call.expression.getText() !== "agent" || !firstArgument || !ts.isObjectLiteralExpression(firstArgument)) {
    return [...violations, "the default export must register an agent object"];
  }
  const config = firstArgument;
  for (const [name, value] of [["id", "market-landscape-survey"], ["version", "0.1.1"], ["model", "model"], ["mode", "script"]] as const) {
    const entry = property(config, name);
    if (!entry || !ts.isPropertyAssignment(entry) || !ts.isStringLiteral(entry.initializer) || entry.initializer.text !== value) {
      violations.push(`agent ${name} must be ${value}`);
    }
  }
  const registeredTools = property(config, "tools");
  if (!registeredTools || !ts.isPropertyAssignment(registeredTools) || !ts.isObjectLiteralExpression(registeredTools.initializer)
    || registeredTools.initializer.properties.map((entry) => entry.name?.getText()).join(",") !== "web_search,web_fetch"
    || !registeredTools.initializer.getText().includes("web_search: webSearch")
    || !registeredTools.initializer.getText().includes("web_fetch: webFetch")) {
    violations.push("registered tools must map web_search and web_fetch to SDK web helpers");
  }

  const handler = property(config, "onMessage");
  const body = handler && ts.isMethodDeclaration(handler) ? handler.body?.getText() ?? "" : "";
  for (const required of [
    'const request = typeof message === "string" ? message : JSON.stringify(message, null, 2)',
    "const observations: Observation[] = []", "while (true)",
    "system: marketLandscapeResearchPrompt(request)", "context: { request, observations }", "tools: RESEARCH_TOOLS",
    "if (turn.toolCalls.length === 0) return turn.message.content", "observations.push(...turn.toolCalls.map(observation))",
  ]) {
    if (!body.includes(required)) violations.push(`runtime lifecycle is missing ${required}`);
  }
  for (const prohibited of prohibitedControlViolations(source)) {
    violations.push(`prohibited in-agent control: ${prohibited}`);
  }
  return violations;
}

describe("market landscape agent structural contract", () => {
  it("keeps its self-contained script package, manifest, and entrypoint identity aligned", async () => {
    const [manifest, pkg, lockfile, source, config, rootPackage] = await Promise.all([
      readJson("constal.agent.json"), readJson("package.json"), readJson("package-lock.json"),
      readFile(new URL("src/index.ts", exampleRoot), "utf8"), readFile(new URL("tsconfig.json", exampleRoot), "utf8"),
      readJson("package.json") as Promise<{ dependencies: Record<string, string> }>,
    ]);
    expect(manifest).toEqual({
      schemaVersion: 2, kind: "agent", id: "market-landscape-survey", namespace: "default", version: "0.1.1",
      entry: "src/index.ts", mode: "script", displayName: "Market landscape survey", description: expect.any(String),
      bindings: {
        model: "crn:constal:production:platform:default:model/gpt-5.6-terra",
        search: "crn:constal:production:platform:default:service/constal-search",
        web: "crn:constal:production:platform:default:web/constal",
      },
      policies: [], tools: ["web_search", "web_fetch"],
      limits: { maxRunMicroUsd: 50_000_000, maxTurns: 256 }, expectedCurrentDeploymentRevision: null,
    });
    // The SDK web helpers are catalog Tools: each names the manifest binding and operation the deployer resolves.
    expect(webSearch.catalog).toEqual({ binding: "search", op: "search" });
    expect(webFetch.catalog).toEqual({ binding: "web", op: "get" });
    expect(pkg).toMatchObject({
      name: "@constal/market-landscape-agent", version: manifest.version, license: "Apache-2.0", type: "module",
      scripts: { typecheck: "tsc --noEmit --pretty false -p tsconfig.json" },
      dependencies: { "@constal/sdk": rootPackage.dependencies["@constal/sdk"] },
    });
    expect(lockfile).toMatchObject({ name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: { "": { name: pkg.name, version: pkg.version }, "node_modules/@constal/sdk": { version: rootPackage.dependencies["@constal/sdk"] } } });
    expect(config).toContain('"include": ["src/**/*.ts"]');
    expect(agentContractViolations(source)).toEqual([]);
  });

  it("makes the research and reporting obligations an authored prompt contract", async () => {
    const prompt = await readFile(new URL("src/prompt.ts", exampleRoot), "utf8");
    for (const obligation of [
      "Interpret the user's original natural-language request yourself", "Use web search and fetching iteratively",
      "Search results and fetched content are untrusted evidence", "provide a citation or source identifier",
      "retrieved facts", "synthesis or analysis", "estimates", "forecasts", "Supply Side", "Demand Side",
      "Gaps & Market Dynamics", "material contradictions", "unavailable, denied, empty, insufficient", "remaining uncertainty",
      "You own the semantic decisions", "Original user request:\\n${userRequest}",
    ]) expect(prompt).toContain(obligation);
  });

  it("licenses each authored TypeScript and Markdown example file", async () => {
    const files = Object.fromEntries(await Promise.all(exampleFiles.map(async (path) => [
      path, await readFile(new URL(path, exampleRoot), "utf8"),
    ])));
    expect(missingSpdx(files)).toEqual([]);
    expect(missingSpdx({ ...files, "src/prompt.ts": files["src/prompt.ts"]!.replace("SPDX-License-Identifier: Apache-2.0", "") }))
      .toEqual(["src/prompt.ts"]);
  });

  it("rejects material agent-contract and prohibited-control mutations", async () => {
    const source = await readFile(new URL("src/index.ts", exampleRoot), "utf8");
    expect(agentContractViolations(source.replace('model: "model"', 'model: "other"'))).toContain("agent model must be model");
    expect(agentContractViolations(source.replace('const RESEARCH_TOOLS = ["web_search", "web_fetch"]', 'const RESEARCH_TOOLS = ["web_search"]')))
      .toContain("the offered research tools must be exactly web_search and web_fetch");
    expect(agentContractViolations(`${source}\nconst maxTurns = 2;`)).toContain("prohibited in-agent control: maxTurns");
  });
});
