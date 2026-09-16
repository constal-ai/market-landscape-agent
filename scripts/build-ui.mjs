// Copyright 2026 Coresource AI, Inc.
// SPDX-License-Identifier: Apache-2.0
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, hashValue, uiBundle } from "@constal/sdk";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const UI_ID = "market-landscape-workspace";
export async function buildUi() {
  const types = { "index.html": "text/html; charset=utf-8", "app.js": "text/javascript; charset=utf-8",
    "markdown.js": "text/javascript; charset=utf-8", "styles.css": "text/css; charset=utf-8", "favicon.svg": "image/svg+xml" };
  const bundle = uiBundle({ manifest: { schemaVersion: 1, kind: "constal.ui",
    runtime: { contract: "constal.ui-handler.v1", entry: "worker.mjs" }, assets: { root: "public", fallback: "index.html" }, contentSecurityPolicy: "strict" },
    modules: { "worker.mjs": { type: "esmodule", source: await readFile(resolve(root, "ui/worker.mjs"), "utf8") } },
    assets: Object.fromEntries(await Promise.all(Object.entries(types).map(async ([name, contentType]) =>
      [`public/${name}`, { contentType, bodyBase64: (await readFile(resolve(root, "ui/public", name))).toString("base64") }]))),
  }, "stateless");
  return { bundle, ref: await hashValue(bundle), manifestHash: await hashValue(bundle.manifest), canonical: canonicalJson(bundle) };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildUi(); await mkdir(resolve(root, "dist/ui"), { recursive: true });
  await writeFile(resolve(root, "dist/ui/bundle.json"), result.canonical);
  await writeFile(resolve(root, "dist/ui/manifest.json"), JSON.stringify({ ref: result.ref, manifestHash: result.manifestHash }, null, 2));
  process.stdout.write(JSON.stringify({ ref: result.ref, bytes: Buffer.byteLength(result.canonical), output: "dist/ui/bundle.json" }) + "\n");
}
