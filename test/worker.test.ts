// Copyright 2026 Coresource AI, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { createLocalUi } from "../scripts/local-state.mjs";

const OWNER = "a".repeat(32); const OTHER = "b".repeat(32);
const ID = "11111111-2222-4333-8444-555555555555";
const call = (ui: ReturnType<typeof createLocalUi>, path: string, method = "GET", body?: unknown) =>
  ui.fetch(new Request(`https://ui.local${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) }));
const json = async (response: Response) => ({ status: response.status, body: await response.json() as Record<string, unknown> });
const assets = async (input: string | Request) => new Response(`asset:${new URL(typeof input === "string" ? input : input.url).pathname}`);

describe("durable survey handler", () => {
  it("records a survey, its run, and its report for the owner only", async () => {
    const ui = createLocalUi(assets);
    const created = await json(await call(ui, "/api/surveys", "POST", { id: ID, owner: OWNER, request: "electric bikes, Europe\nmore detail" }));
    expect(created.status).toBe(201);
    expect(created.body.survey).toMatchObject({ id: ID, title: "electric bikes, Europe", status: "running", started: false, hasReport: false });
    const again = await json(await call(ui, "/api/surveys", "POST", { id: ID, owner: OWNER, request: "electric bikes, Europe" }));
    expect(again.status).toBe(201);
    const stolen = await json(await call(ui, "/api/surveys", "POST", { id: ID, owner: OTHER, request: "something else" }));
    expect(stolen.status).toBe(409);
    const foreign = await json(await call(ui, `/api/surveys/${ID}`, "PATCH", { owner: OTHER, status: "failed" }));
    expect(foreign.status).toBe(403);
    const started = await json(await call(ui, `/api/surveys/${ID}`, "PATCH", { owner: OWNER, runId: "run-1" }));
    expect(started.body.survey).toMatchObject({ status: "running", started: true });
    const incomplete = await json(await call(ui, `/api/surveys/${ID}`, "PATCH", { owner: OWNER, status: "complete" }));
    expect(incomplete.status).toBe(400);
    const done = await json(await call(ui, `/api/surveys/${ID}`, "PATCH", { owner: OWNER, status: "complete", report: "# Report" }));
    expect(done.body.survey).toMatchObject({ status: "complete", hasReport: true });
    expect((done.body.survey as { completedAt: number }).completedAt).toBeGreaterThan(0);
    const reopened = await json(await call(ui, `/api/surveys/${ID}`, "PATCH", { owner: OWNER, status: "running" }));
    expect(reopened.status).toBe(400);
    const shared = await json(await call(ui, `/api/surveys/${ID}`));
    expect(shared.body.survey).toMatchObject({ id: ID, report: "# Report", request: "electric bikes, Europe\nmore detail", status: "complete" });
    expect(shared.body.survey).not.toHaveProperty("owner_hash");
    expect((await json(await call(ui, "/api/surveys/00000000-0000-4000-8000-000000000000"))).status).toBe(404);
    expect((await call(ui, `/api/surveys/${ID}`, "DELETE", { owner: OTHER })).status).toBe(403);
    expect((await json(await call(ui, `/api/surveys/${ID}`, "DELETE", { owner: OWNER }))).body).toEqual({ deleted: ID });
    expect((await call(ui, `/api/surveys/${ID}`)).status).toBe(404);
    expect((await call(ui, `/api/surveys/${ID}`, "DELETE", { owner: OWNER })).status).toBe(404);
  });

  it("serves a versioned public feed that reports unchanged cheaply and marks abandoned runs", async () => {
    const ui = createLocalUi(assets);
    const empty = await json(await call(ui, "/api/feed"));
    expect(empty.body).toMatchObject({ changed: true, surveys: [] });
    await call(ui, "/api/surveys", "POST", { id: ID, owner: OWNER, request: "heat pumps" });
    const first = await json(await call(ui, `/api/feed?since=${empty.body.version}`));
    expect(first.body.changed).toBe(true);
    expect((first.body.surveys as unknown[]).length).toBe(1);
    const unchanged = await json(await call(ui, `/api/feed?since=${first.body.version}`));
    expect(unchanged.body).toEqual({ version: first.body.version, changed: false, now: expect.any(Number) });
    expect(unchanged.body).not.toHaveProperty("surveys");
    ui.state.query("UPDATE surveys SET updated_at = ? WHERE id = ?", [Date.now() - 10 * 60_000, ID]);
    const stale = await json(await call(ui, "/api/feed"));
    expect((stale.body.surveys as Array<{ status: string }>)[0]!.status).toBe("stalled");
    const report = await json(await call(ui, `/api/surveys/${ID}`));
    expect((report.body.survey as { status: string }).status).toBe("stalled");
  });

  it("rejects malformed input and routes shared report links to the app shell", async () => {
    const ui = createLocalUi(assets);
    expect((await call(ui, "/api/surveys", "POST", { id: "nope", owner: OWNER, request: "x" })).status).toBe(400);
    expect((await call(ui, "/api/surveys", "POST", { id: ID, owner: "short", request: "x" })).status).toBe(400);
    expect((await call(ui, "/api/surveys", "POST", { id: ID, owner: OWNER, request: "x".repeat(9000) })).status).toBe(400);
    expect((await call(ui, "/api/surveys", "POST", "not json" as unknown)).status).toBe(400);
    expect((await call(ui, "/api/nothing")).status).toBe(404);
    expect(await (await call(ui, `/r/${ID}`)).text()).toBe("asset:/");
    expect(await (await call(ui, "/styles.css")).text()).toBe("asset:/styles.css");
  });
});
