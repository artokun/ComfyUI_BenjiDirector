import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The panel is served RAW — ComfyUI hands `web/js/*` to the browser with plain static-file
// semantics and there is no bundler on that side. So this package's job is to emit exactly
// one self-contained ES module plus one stylesheet, which `scripts/sync-to-panel.mjs` drops
// into the panel's `web/js/vendor/` tree.
//
// `vendor/` is the right destination for a second reason: the panel's check-panel-scope gate
// deliberately ignores that path (`IGNORED_PATH = /[\/]vendor[\/]/`), because vendored
// bundles are third-party build output whose internals it does not police. Emitting anywhere
// else would drag a React bundle through a TypeScript scope check that has no opinion worth
// hearing about it.
//
// React is BUNDLED, not externalised: ComfyUI's own frontend is Vue, so there is no React on
// the page to borrow.
export default defineConfig({
  plugins: [react()],
  build: {
    lib: {
      entry: "src/index.tsx",
      formats: ["es"],
      fileName: () => "director-app.js",
    },
    outDir: "dist",
    emptyOutDir: true,
    cssCodeSplit: false,
    sourcemap: true,
  },
});
