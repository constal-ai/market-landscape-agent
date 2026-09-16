// Copyright 2026 Coresource AI, Inc.
// SPDX-License-Identifier: Apache-2.0
// Durable UI handler: one SQLite table of surveys shared by every visitor.
// The browser drives the Agent run; this handler only records what it reports.

const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const OWNER = /^[A-Za-z0-9_-]{16,128}$/u;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._~:-]{0,255}$/u;
const STATUSES = new Set(["running", "complete", "failed"]);
const MAX_REQUEST = 8_192;
const MAX_REPORT = 512 * 1024;
const MAX_ERROR = 1_024;
const STALE_MS = 120_000;
const FEED_LIMIT = 50;
const FEED_COLUMNS = "id, title, status, run_id IS NOT NULL AS started, report IS NOT NULL AS has_report, created_at, updated_at, completed_at";

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const titleOf = (request) => request.trim().split("\n")[0].slice(0, 96);

async function ownerHash(owner) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`market-landscape-owner/v1:${owner}`)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function body(request) {
  try { const value = await request.json(); return value && typeof value === "object" && !Array.isArray(value) ? value : null; }
  catch { return null; }
}

function publicRow(row, now) {
  const stalled = row.status === "running" && now - Number(row.updated_at) > STALE_MS;
  return { id: row.id, title: row.title, status: stalled ? "stalled" : row.status, started: Boolean(row.started),
    hasReport: Boolean(row.has_report), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    completedAt: row.completed_at === null ? null : Number(row.completed_at) };
}

function feedVersion(state) {
  const row = state.query("SELECT COUNT(*) AS count, COALESCE(MAX(updated_at), 0) AS updated FROM surveys").rows[0];
  return `${row.count}.${row.updated}`;
}

export default {
  migrate({ from }, { state }) {
    if (from === null) {
      state.query("CREATE TABLE surveys (id TEXT PRIMARY KEY, owner_hash TEXT NOT NULL, request TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, run_id TEXT, report TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER)");
      state.query("CREATE INDEX surveys_updated_at ON surveys(updated_at)");
    }
  },

  async fetch(request, context) {
    const url = new URL(request.url); const path = url.pathname; const now = Date.now(); const { state } = context;

    if (path === "/api/feed" && request.method === "GET") {
      const version = feedVersion(state);
      if (url.searchParams.get("since") === version) return json({ version, changed: false, now });
      const rows = state.query(`SELECT ${FEED_COLUMNS} FROM surveys ORDER BY updated_at DESC LIMIT ${FEED_LIMIT}`).rows;
      return json({ version, changed: true, now, surveys: rows.map((row) => publicRow(row, now)) });
    }

    if (path === "/api/surveys" && request.method === "POST") {
      const input = await body(request);
      const id = input?.id; const owner = input?.owner; const text = typeof input?.request === "string" ? input.request.trim() : "";
      if (typeof id !== "string" || !ID.test(id) || typeof owner !== "string" || !OWNER.test(owner) || !text || text.length > MAX_REQUEST) {
        return json({ error: "invalid survey" }, 400);
      }
      const hash = await ownerHash(owner);
      state.query("INSERT OR IGNORE INTO surveys (id, owner_hash, request, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'running', ?, ?)",
        [id, hash, text, titleOf(text), now, now]);
      const row = state.query(`SELECT owner_hash, ${FEED_COLUMNS} FROM surveys WHERE id = ?`, [id]).rows[0];
      if (row.owner_hash !== hash) return json({ error: "survey id is taken" }, 409);
      return json({ survey: publicRow(row, now) }, 201);
    }

    const survey = path.match(/^\/api\/surveys\/([a-f0-9-]{36})$/u);
    if (survey && request.method === "GET") {
      const row = state.query(`SELECT request, report, error, ${FEED_COLUMNS} FROM surveys WHERE id = ?`, [survey[1]]).rows[0];
      if (!row) return json({ error: "survey not found" }, 404);
      return json({ survey: { ...publicRow(row, now), request: row.request, report: row.report, error: row.error } });
    }
    if (survey && request.method === "PATCH") {
      const input = await body(request); const owner = input?.owner;
      if (typeof owner !== "string" || !OWNER.test(owner)) return json({ error: "invalid survey update" }, 400);
      const current = state.query("SELECT owner_hash, status FROM surveys WHERE id = ?", [survey[1]]).rows[0];
      if (!current) return json({ error: "survey not found" }, 404);
      if (current.owner_hash !== await ownerHash(owner)) return json({ error: "not the survey owner" }, 403);
      const status = input.status === undefined ? current.status : input.status;
      const report = input.report === undefined ? undefined : input.report; const error = input.error === undefined ? undefined : input.error;
      const runId = input.runId === undefined ? undefined : input.runId;
      if (!STATUSES.has(status) || (current.status !== "running" && status !== current.status)
        || (runId !== undefined && (typeof runId !== "string" || !RUN_ID.test(runId)))
        || (report !== undefined && (typeof report !== "string" || !report.trim() || report.length > MAX_REPORT))
        || (error !== undefined && (typeof error !== "string" || error.length > MAX_ERROR))
        || (status === "complete" && report === undefined)) return json({ error: "invalid survey update" }, 400);
      const sets = ["updated_at = ?", "status = ?"]; const values = [now, status];
      if (runId !== undefined) { sets.push("run_id = ?"); values.push(runId); }
      if (report !== undefined) { sets.push("report = ?"); values.push(report); }
      if (error !== undefined) { sets.push("error = ?"); values.push(error); }
      if (status !== "running" && current.status === "running") { sets.push("completed_at = ?"); values.push(now); }
      values.push(survey[1]);
      state.query(`UPDATE surveys SET ${sets.join(", ")} WHERE id = ?`, values);
      const row = state.query(`SELECT ${FEED_COLUMNS} FROM surveys WHERE id = ?`, [survey[1]]).rows[0];
      return json({ survey: publicRow(row, now) });
    }

    if (path.startsWith("/api/")) return json({ error: "not found" }, 404);
    // Shared report links render the single-page app; the browser reads the id from the URL.
    if (/^\/r\/[a-f0-9-]{36}$/u.test(path)) return context.assets.fetch(new Request(new URL("/", request.url), { method: "GET" }));
    return context.assets.fetch(request);
  },
};
