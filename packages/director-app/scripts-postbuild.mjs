// Vite's lib build leaves some dependency comment blocks intact even when minifying.
// That matters here for a non-obvious reason: the panel's check-tool-vocabulary gate scans
// every tracked file for retired tool names and cannot tell a live instruction from an
// English word, so a React Flow comment reading "needs to regenerate the list" fails the
// panel's build. Re-running esbuild with legalComments:"none" strips them using a real
// parser — a regex pass would eat `//` inside string literals and URLs.
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";

const FILE = "dist/director-app.js";
const before = readFileSync(FILE, "utf8");
const res = await build({
  entryPoints: [FILE],
  bundle: false,
  minify: true,
  legalComments: "none",
  format: "esm",
  write: false,
  target: "es2022",
});
const out = res.outputFiles?.[0]?.text;
if (!out) throw new Error("postbuild: esbuild produced no output");
writeFileSync(FILE, out);
const kb = (s) => `${(Buffer.byteLength(s) / 1024).toFixed(1)}kB`;
console.log(`[postbuild] ${kb(before)} -> ${kb(out)}`);
