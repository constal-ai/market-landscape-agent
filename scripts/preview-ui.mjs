// Copyright 2026 Coresource AI, Inc.
// SPDX-License-Identifier: Apache-2.0
// Local preview of the Instant UI. Demo mode serves a labeled fixture; --live
// proxies to the deployed Agent with the operator's saved CLI credential, which
// stays on the local server and never reaches the browser.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { sampleReport } from "../ui/demo.mjs";
import { createLocalUi } from "./local-state.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AGENT_ID = "market-landscape-survey";
const live = process.argv.includes("--live");
const port = Number(process.env.PORT || 4173);
const contextRoot = process.env.CONSTAL_CONFIG_DIR || resolve(process.env.XDG_CONFIG_HOME || resolve(homedir(), ".config"), "constal");
const json = async (name) => { try { return JSON.parse(await readFile(resolve(contextRoot, name), "utf8")); } catch { return {}; } };
const config = live ? await json("config.json") : {};
const key = live ? process.env.CONSTAL_API_KEY || (await json("credentials.json")).apiKey : null;
if (live && !key) throw new Error("Sign in with constal auth login before using --live.");
const namespace = process.env.CONSTAL_NAMESPACE || config.namespace || "default";
const origin = new URL(process.env.CONSTAL_PLATFORM_URL || config.origin || "https://platform.constal.ai");
if (origin.protocol !== "https:" || origin.username || origin.password) throw new Error("The platform origin must use HTTPS.");
const tenantHeader = config.tenant ? { "x-constal-tenant": config.tenant } : {};
const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };
const demoRuns = new Map();
const publicRoot = resolve(root, "ui/public");
async function serveAsset(input) {
  const url = new URL(typeof input === "string" ? input : input.url);
  const path = resolve(publicRoot, url.pathname === "/" ? "index.html" : `.${url.pathname}`);
  if (!path.startsWith(publicRoot + "/")) return new Response("not found", { status: 404 });
  try { return new Response(await readFile(path), { headers: { "content-type": types[extname(path)] || "application/octet-stream" } }); }
  catch { return new Response("not found", { status: 404 }); }
}
const ui = createLocalUi(serveAsset, process.env.PREVIEW_STATE || ":memory:");
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!hosts.includes(request.headers.host ?? "")) { response.writeHead(403); response.end(); return; }
    if (request.headers.origin && !hosts.map((host) => `http://${host}`).includes(request.headers.origin)) { response.writeHead(403); response.end(); return; }
    const reply = (status, value) => { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(typeof value === "string" ? value : JSON.stringify(value)); };
    if (url.pathname === "/preview-info") return reply(200, { demo: !live });
    if (url.pathname === "/_constal/channel" && request.method === "POST") {
      let text = ""; for await (const chunk of request) { text += chunk; if (text.length > 131072) throw new Error("Request too large"); }
      const body = JSON.parse(text); body.model = AGENT_ID;
      if (live) {
        const upstream = await fetch(new URL("/v1/chat/completions", origin), { method: "POST", redirect: "error", headers: {
          authorization: `Bearer ${key}`, "content-type": "application/json", "x-constal-namespace": namespace,
          "x-session-id": String(request.headers["x-session-id"] || ""), "idempotency-key": String(request.headers["idempotency-key"] || ""),
          prefer: "respond-async", ...tenantHeader }, body: JSON.stringify(body), signal: AbortSignal.timeout(150000) });
        return reply(upstream.status, await upstream.text());
      }
      const runId = crypto.randomUUID(); demoRuns.set(runId, Date.now());
      return reply(202, { runId, status: "queued" });
    }
    const runMatch = url.pathname.match(/^\/_constal\/runs\/([A-Za-z0-9._~:-]+)$/u);
    if (runMatch && request.method === "GET") {
      const session = String(request.headers["x-session-id"] || "");
      if (!/^ui-request-[a-f0-9-]+$/u.test(session)) throw new Error("Invalid UI request session");
      if (!live) {
        const started = demoRuns.get(runMatch[1]); if (!started) return reply(404, { error: "run not found" });
        return reply(200, Date.now() - started < 4000 ? { runId: runMatch[1], status: "leased" } : { runId: runMatch[1], status: "complete", result: sampleReport });
      }
      const auth = { authorization: `Bearer ${key}`, "x-constal-namespace": namespace, ...tenantHeader };
      const upstream = await fetch(new URL(`/v1/namespaces/${encodeURIComponent(namespace)}/agents/${AGENT_ID}/sessions/${session}/runs/${runMatch[1]}`, origin), { headers: auth });
      const value = await upstream.json();
      if (upstream.ok && value.status === "complete" && value.result === undefined && value.resultRef) {
        const artifact = await fetch(new URL(`/v1/artifacts/${value.resultRef}`, origin), { headers: auth });
        if (!artifact.ok) throw new Error("The completed result is unavailable");
        value.result = await artifact.json();
      }
      return reply(upstream.status, value);
    }
    // Everything else goes through the durable handler, exactly as the platform host does.
    let text = ""; if (!["GET", "HEAD"].includes(request.method)) for await (const chunk of request) { text += chunk; if (text.length > 1_048_576) throw new Error("Request too large"); }
    const handled = await ui.fetch(new Request(url, { method: request.method, headers: { "content-type": request.headers["content-type"] ?? "" }, ...(text ? { body: text } : {}) }));
    const headers = Object.fromEntries(handled.headers.entries());
    response.writeHead(handled.status, { ...headers, "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" });
    response.end(Buffer.from(await handled.arrayBuffer()));
  } catch (error) {
    response.writeHead(error?.code === "ENOENT" ? 404 : 500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: key ? String(error.message).replaceAll(key, "[redacted]") : error.message }));
  }
});
server.listen(port, "127.0.0.1", () => console.log(`Market landscape UI: http://127.0.0.1:${port} (${live ? "authenticated live agent" : "explicit demo preview"})`));
