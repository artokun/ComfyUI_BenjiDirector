import { defineConfig } from "vitest/config";

// One suite across every workspace package. graph-core is the package that carries
// real risk (the ported boundary-port algebra), so its tests are the ones that must
// stay fast enough to run on every save.
export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    environment: "node",
  },
});
