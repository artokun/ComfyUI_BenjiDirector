import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CalliopeClient, ROUTES, fillRoute, scenePromptHash } from "./client.js";
import { resolveConfig } from "./index.js";

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as {
  info: { version: string };
  paths: Record<string, Record<string, unknown>>;
};

describe("ROUTES against the committed OpenAPI snapshot", () => {
  it("every route the client can call exists in the spec, with that method", () => {
    const missing: string[] = [];
    for (const [key, [method, path]] of Object.entries(ROUTES)) {
      const entry = spec.paths[path];
      if (!entry || !entry[method.toLowerCase()]) missing.push(`${key}: ${method} ${path}`);
    }
    expect(missing).toEqual([]);
  });

  it("the client deliberately does NOT reach Calliope's own agent", () => {
    // Two agents on one SQLite database with no shared lock. If this ever appears in
    // ROUTES it is a design change, not a convenience.
    for (const [, [, path]] of Object.entries(ROUTES)) expect(path.startsWith("/api/agent")).toBe(false);
  });

  it("nor its LLM-backed story/script generation", () => {
    for (const [, [, path]] of Object.entries(ROUTES)) {
      expect(path).not.toMatch(/generate-story|generate-script/);
    }
  });

  it("names the snapshot it was generated from", () => {
    expect(spec.info.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("fillRoute", () => {
  it("fills every slot and encodes values", () => {
    expect(fillRoute("/api/projects/{project_id}/scenes/{scene_id}", { project_id: 7, scene_id: "a b" })).toBe("/api/projects/7/scenes/a%20b");
  });
  it("refuses a slot left unfilled — a literal {scene_id} is a 404 that looks real", () => {
    expect(() => fillRoute("/api/projects/{project_id}/scenes/{scene_id}", { project_id: 7 })).toThrow(/missing \{scene_id\}/);
  });
});

describe("scenePromptHash — the freshness contract Calliope checks a draft against", () => {
  const scene = { heading: "SC-01", action: "She climbs out", dialog: null, duration_sec: 6, location_id: 2, character_ids: [5, 3] };

  it("is 16 lowercase hex chars", async () => {
    expect(await scenePromptHash(scene)).toMatch(/^[0-9a-f]{16}$/);
  });
  it("sorts character ids, so order of assignment cannot fake staleness", async () => {
    expect(await scenePromptHash(scene)).toBe(await scenePromptHash({ ...scene, character_ids: [3, 5] }));
  });
  it("changes when any fingerprinted field changes — which is what makes a stale draft detectable", async () => {
    const base = await scenePromptHash(scene);
    expect(await scenePromptHash({ ...scene, heading: "SC-01b" })).not.toBe(base);
    expect(await scenePromptHash({ ...scene, duration_sec: 7 })).not.toBe(base);
    expect(await scenePromptHash({ ...scene, location_id: 9 })).not.toBe(base);
    expect(await scenePromptHash({ ...scene, character_ids: [5] })).not.toBe(base);
  });
  it("matches Calliope's own fingerprint for a known input", async () => {
    // Computed with Calliope's _scene_prompt_hash on the same scene: the basis string is
    // "SC-01|She climbs out||6|2|3,5". If this ever drifts, drafts silently stop being fresh
    // and Calliope's model quietly takes prompt authoring back.
    const expected = await (async () => {
      const bytes = new TextEncoder().encode("SC-01|She climbs out||6|2|3,5");
      const d = await crypto.subtle.digest("SHA-256", bytes);
      return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
    })();
    expect(await scenePromptHash(scene)).toBe(expected);
  });
});

describe("CalliopeClient", () => {
  it("builds file URLs against the configured base", () => {
    const c = new CalliopeClient(resolveConfig({ baseUrl: "http://127.0.0.1:8247/" }));
    expect(c.fileUrl("assets/x y.png")).toBe("http://127.0.0.1:8247/api/file?path=assets%2Fx%20y.png");
  });
});
