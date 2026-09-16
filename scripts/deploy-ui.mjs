// Copyright 2026 Coresource AI, Inc.
// SPDX-License-Identifier: Apache-2.0
// Publishes the Instant UI as a private UI Resource pinned to the deployed Agent.
// The bundle is stored through a temporary helper Agent's ordinary CAS `put`;
// no administrator credential or direct storage access is used.
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import { buildUi, UI_ID } from "./build-ui.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AGENT_ID = "market-landscape-survey";
const PLATFORM_MODEL = "crn:constal:production:platform:default:model/gpt-5.6-terra";
const PLATFORM_CAS = "crn:constal:production:platform:default:cas/constal";

/** Public by default: anyone with the URL can run a survey on the tenant's account. Set UI_ACCESS=authenticated to require a Constal login. */
function accessMode(options) {
  const mode = options.access || process.env.UI_ACCESS || "public";
  if (mode !== "public" && mode !== "authenticated") throw new Error("UI_ACCESS must be public or authenticated");
  return mode;
}

export async function publishUi(options = {}) {
  const built = await buildUi(); const access = accessMode(options);
  if (options.dryRun) return { kind: "ui", id: UI_ID, access, bundleRef: built.ref, bytes: Buffer.byteLength(built.canonical) };
  const configRoot = process.env.CONSTAL_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "constal");
  const read = async (name) => { try { return JSON.parse(await readFile(join(configRoot, name), "utf8")); } catch (error) { if (error.code === "ENOENT") return {}; throw error; } };
  const config = await read("config.json");
  const token = process.env.CONSTAL_API_KEY || (await read("credentials.json")).apiKey;
  if (!token) throw new Error("Run constal auth login or set CONSTAL_API_KEY before publishing the UI.");
  const namespace = options.namespace || process.env.CONSTAL_NAMESPACE || config.namespace || "default";
  const tenant = options.tenant || process.env.CONSTAL_TENANT || config.tenant;
  const origin = new URL(options.origin || process.env.CONSTAL_PLATFORM_URL || config.origin || "https://platform.constal.ai");
  if (origin.protocol !== "https:" || origin.username || origin.password) throw new Error("Use an HTTPS platform origin.");
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", "x-constal-namespace": namespace,
    ...(tenant ? { "x-constal-tenant": tenant } : {}) };
  async function api(path, body, method = body === undefined ? "GET" : "POST", missing = false) {
    const response = await fetch(new URL("/v1/" + path, origin), { method, redirect: "error", headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120000) });
    if (missing && response.status === 404) return null;
    const value = await response.json();
    if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(value).replaceAll(token, "[redacted]")}`);
    return value.data ?? value;
  }
  const resource = (kind, id) => `namespaces/${namespace}/resources/${kind}/${id}`;
  const agent = await api(resource("agent", AGENT_ID));
  if (agent.labels?.["channels.constal.ai/openai"] !== "enabled") throw new Error("Deploy the Agent with the channels.constal.ai/openai label first (constal deploy . --wait).");
  const channel = await api(resource("channel", "openai-chat-completions"));
  const provider = access === "authenticated" ? await api(resource("auth-provider", "constal-api-key")) : null;
  const current = await api(resource("ui", UI_ID), undefined, "GET", true);
  const sdkVersion = JSON.parse(await readFile(join(root, "package.json"), "utf8")).dependencies["@constal/sdk"];
  const helperId = "market-landscape-ui-artifacts-" + crypto.randomUUID().slice(0, 8);
  const temporary = await mkdtemp(join(tmpdir(), "market-landscape-ui-publish-"));
  let deployed = false;
  try {
    await mkdir(join(temporary, "src"));
    await writeFile(join(temporary, "src/index.ts"), `import {agent} from '@constal/sdk';
export default agent({id:${JSON.stringify(helperId)},version:'1.0.0',mode:'script',model:'model',tools:{},
async onMessage(value,ctx){return ctx.invoke(ctx.resources.cas!,'put',{value});}});`);
    await writeFile(join(temporary, "package.json"), JSON.stringify({ name: "@constal/ui-artifact-install", version: "1.0.0", type: "module", dependencies: { "@constal/sdk": sdkVersion } }));
    await writeFile(join(temporary, "constal.agent.json"), JSON.stringify({ schemaVersion: 2, kind: "agent", id: helperId, version: "1.0.0", namespace,
      mode: "script", entry: "src/index.ts", bindings: { cas: PLATFORM_CAS, model: PLATFORM_MODEL }, policies: [], tools: [], limits: { maxRunMicroUsd: 1000000, maxTurns: 1 } }));
    const cli = join(root, "node_modules/@constal/cli/publish/cli.mjs");
    await new Promise((resolvePromise, reject) => {
      const child = spawn(process.execPath, [cli, "deploy", temporary, "--namespace", namespace, ...(tenant ? ["--tenant", tenant] : []), "--wait", "--output", "json"], { stdio: ["ignore", "ignore", "inherit"] });
      child.on("error", reject); child.on("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`Artifact helper deployment failed (${code})`)));
    });
    deployed = true;
    const helper = await api(resource("agent", helperId));
    const cas = helper.resources?.bindings?.cas?.document;
    if (!cas?.crn || !cas.hash) throw new Error("The helper Agent does not expose its pinned CAS Resource.");
    const base = `namespaces/${namespace}/agents/${helperId}/sessions/artifact`;
    const accepted = await api(base + "/events", { eventId: "store-" + built.ref, deliver: "queue", body: built.bundle });
    if (!accepted.runId) throw new Error("Artifact storage Run was not accepted.");
    let run; const deadline = Date.now() + 300000;
    while (Date.now() < deadline) {
      run = await api(base + "/runs/" + accepted.runId);
      if (run.status === "complete") break;
      if (["failed", "stopped"].includes(run.status)) throw new Error("Artifact storage Run failed: " + JSON.stringify(run));
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1500));
    }
    if (run?.status !== "complete") throw new Error(`Observe the existing artifact Run ${accepted.runId} before publishing.`);
    const result = run.result ?? await api("artifacts/" + run.resultRef);
    if (result.ref !== built.ref) throw new Error("CAS artifact reference differs from the UI bundle hash.");
    const definition = { kind: "ui", id: UI_ID, version: String(Number(current?.version ?? 0) + 1),
      displayName: "Market landscape", description: "Ask for a market in a few words and read a sourced supply, demand, and dynamics report.",
      labels: { "app.constal.ai/use-case": "market-research", "app.constal.ai/primary": "true" }, policies: [],
      source: { kind: "bundle", artifact: { cas: { crn: cas.crn, hash: cas.hash }, ref: built.ref, manifestHash: built.manifestHash, format: "constal.ui.v1" } },
      target: { agent: { crn: agent.crn, hash: agent.hash }, channel: { crn: channel.crn, hash: channel.hash } },
      access: provider ? { mode: "authenticated", authProvider: { crn: provider.crn, hash: provider.hash } } : { mode: "public" }, execution: { mode: "stateless" },
      limits: { requestBodyBytes: 131072, responseBodyBytes: 4194304, cpuMs: 1000, subrequests: 8 }, expectedCurrentHash: current?.hash ?? null };
    const published = await api(`namespaces/${namespace}/resources`, definition);
    await mkdir(join(root, "dist/ui"), { recursive: true });
    await writeFile(join(root, "dist/ui/deployment.json"), JSON.stringify({ ...published, bundleRef: built.ref }, null, 2));
    return { kind: "ui", id: UI_ID, namespace, url: published.url, hash: published.hash, bundleRef: built.ref, access };
  } finally {
    if (deployed) await api(resource("agent", helperId), undefined, "DELETE");
    await rm(temporary, { recursive: true, force: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await publishUi({ dryRun: process.argv.includes("--dry-run"),
    ...(process.argv.includes("--private") ? { access: "authenticated" } : {}) }), null, 2));
}
