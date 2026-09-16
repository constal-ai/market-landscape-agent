// Copyright 2026 Coresource AI, Inc.
// SPDX-License-Identifier: Apache-2.0
// Local stand-in for the platform's bounded UI SQLite state, used by the preview server and tests.
import { DatabaseSync } from "node:sqlite";
import handler from "../ui/worker.mjs";

export function createLocalState(path = ":memory:") {
  const db = new DatabaseSync(path);
  const query = (sql, bindings = []) => {
    const statement = db.prepare(sql);
    const rows = /^\s*SELECT/iu.test(sql) ? statement.all(...bindings) : (statement.run(...bindings), []);
    return { rows, rowsRead: rows.length, rowsWritten: 0, databaseSize: 0 };
  };
  const state = { query, batch: (items) => items.map(({ sql, bindings }) => query(sql, bindings)) };
  handler.migrate({ from: null, to: 1 }, { ui: "crn:local", revision: "local", publicBaseUrl: "http://127.0.0.1/", state });
  return state;
}

export function createLocalUi(assets, path) {
  const state = createLocalState(path);
  const context = { ui: "crn:local", revision: "local", publicBaseUrl: "http://127.0.0.1/", state,
    assets: { fetch: assets }, channel: { fetch: async () => new Response("channel unavailable locally", { status: 503 }) } };
  return { state, fetch: (request) => handler.fetch(request, context) };
}
