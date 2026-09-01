#!/usr/bin/env node
// Build this module and copy the artifacts into a checkout of comfyui-mcp-panel.
//
// WHY THE OUTPUT IS COMMITTED INTO THE PANEL REPO RATHER THAN LEFT IN THE SUBMODULE
// --------------------------------------------------------------------------------
// The panel ships to the Comfy Registry from CI, and neither `ci.yml` nor
// `publish_action.yml` passes `submodules:` to actions/checkout — which does NOT fetch
// submodules by default. A submodule left to itself therefore publishes an EMPTY directory,
// and the failure is invisible until a user installs the pack and the tab does nothing.
//
// So the submodule is the source of truth for DEVELOPMENT, and the built artifacts are
// vendored into the panel the same way `vendor/tool-vocabulary.json` already is. Adding
// `submodules: recursive` to those workflows is worth doing too, but as a second layer —
// not as the thing correctness rests on.
//
// Usage:
//   node scripts/sync-to-panel.mjs [--panel <path>] [--check]
//
//   --check  build and compare instead of writing; exits 1 on drift. This is what CI runs
//            to prove the committed artifacts still match the pinned submodule commit.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEST_SUBPATH = join("web", "js", "vendor", "benjidirector");

const args = process.argv.slice(2);
const check = args.includes("--check");
const panelIdx = args.indexOf("--panel");
const panelRoot = resolve(
  panelIdx >= 0 && args[panelIdx + 1] ? args[panelIdx + 1] : join(ROOT, "..", "comfyui-mcp-panel"),
);

if (!existsSync(join(panelRoot, "web", "js", "comfyui-mcp-panel.js"))) {
  console.error(
    `[sync-to-panel] ${panelRoot} does not look like a comfyui-mcp-panel checkout.\n` +
      `Pass --panel <path> to point at one.`,
  );
  process.exit(2);
}

console.log("[sync-to-panel] building…");
execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" });

const built = join(ROOT, "packages", "director-app", "dist");
if (!existsSync(built)) {
  console.error(`[sync-to-panel] no build output at ${built}`);
  process.exit(2);
}

const dest = join(panelRoot, DEST_SUBPATH);
const files = readdirSync(built).filter((f) => !f.endsWith(".map"));

// Compare CONTENT, not bytes. Git checks these files out with CRLF on Windows while a fresh
// build emits LF, so a raw byte compare reports drift on every Windows checkout — and a guard
// that cries wolf is one people learn to ignore, which is worse than not having it.
const norm = (buf) => buf.toString("utf8").replace(/\r\n/g, "\n");
const sha = (buf) => createHash("sha256").update(norm(buf)).digest("hex");

let drift = 0;
// Content hash of the bundle, stamped into pane.js's dynamic import so the browser cannot
// serve a stale editor after an update.
const bundleHash = createHash("sha256")
  .update(readFileSync(join(built, "director-app.js")))
  .digest("hex")
  .slice(0, 12);

for (const f of [...files, "pane.js"]) {
  const src = f === "pane.js" ? join(ROOT, "panel", "pane.js") : join(built, f);
  const out = join(dest, f);
  let body = readFileSync(src);
  if (f === "pane.js") body = Buffer.from(body.toString("utf8").replace("__BUNDLE_HASH__", bundleHash));
  if (check) {
    const current = existsSync(out) ? readFileSync(out) : null;
    if (!current || sha(current) !== sha(body)) {
      console.error(`[sync-to-panel] DRIFT: ${DEST_SUBPATH}/${f}`);
      drift += 1;
    }
    continue;
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, body);
  console.log(`[sync-to-panel] wrote ${DEST_SUBPATH}/${f}`);
}

if (check && drift > 0) {
  console.error(
    `\n[sync-to-panel] ${drift} file(s) differ from a fresh build.\n` +
      `The panel would ship stale bytes. Run: node scripts/sync-to-panel.mjs`,
  );
  process.exit(1);
}
console.log(check ? "[sync-to-panel] OK — vendored output matches the build." : "[sync-to-panel] done.");
