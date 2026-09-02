import { deflateSync } from "node:zlib";
import { expect, test } from "@playwright/test";
import { drive, shot, waitForDemo } from "./helpers.js";

// [U14] Assets — the gallery, generation, and the upload path.
//
// Calliope is NOT running in the harness, so the whole backend is a `page.route` stand-in that
// keeps STATE: a PATCH really changes the row the next GET returns. That matters — the point of
// the upload test is that a file the user picked ends up on the character's `sheet_path` and
// then shows on the card, which a stateless mock cannot prove.
//
// The mock answers from Calliope's real origin (127.0.0.1:8247), cross-origin to the harness,
// so every fulfilled response carries CORS headers and OPTIONS preflights are answered — a
// PATCH with `content-type: application/json` is not a simple request.

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type",
};

const UPLOADED = "C:/calliope/assets/uploads/9f2ab1c4-nadia.png";

/** A real PNG, so the card and the screenshot show an actual picture rather than a broken img. */
function gradientPng(width = 320, height = 400): Buffer {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  const crc32 = (buf: Buffer) => {
    let crc = 0xffffffff;
    for (const b of buf) crc = table[(crc ^ b) & 0xff]! ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed));
    return Buffer.concat([len, typed, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const off = y * (1 + width * 3);
    for (let x = 0; x < width; x++) {
      const p = off + 1 + x * 3;
      const t = y / height;
      raw[p] = Math.round(28 + 44 * t);
      raw[p + 1] = Math.round(118 + 92 * t);
      raw[p + 2] = Math.round(142 + 90 * t);
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** The seeded project "The Approach" — the same rows as `calliope-bind.test.ts`, plus one item. */
function fixtures() {
  const project = { id: 1, title: "The Approach", idea: null, genre: "thriller", tone: "quiet, tense", target_duration: "2 min", status: "draft" };
  const characters = [
    {
      id: 1,
      name: "Nadia",
      role: "lead",
      age: "late 20s",
      appearance: "cropped dark hair, grey field jacket, scarred left hand",
      personality: "watchful, economical with words",
      portrait_path: null as string | null,
      sheet_path: null as string | null,
      consistency_prompt: "same woman",
    },
  ];
  const locations = [{ id: 1, name: "Rooftop, night", description: "wet gravel, sodium haze, a city that never quite goes quiet", reference_image_path: null as string | null, consistency_prompt: null }];
  const items = [{ id: 5, name: "Brass key", description: "worn brass, a chipped enamel tag", reference_image_path: null as string | null, consistency_prompt: null }];
  const scene = (id: number, order_index: number, beat_id: number | null, chain: number) => ({
    id,
    project_id: 1,
    beat_id,
    order_index,
    heading: `SC-0${id}`,
    action: null,
    dialog: null,
    duration_sec: 5,
    workflow_id: null,
    env_image_path: null,
    location_id: 1,
    video_path: null,
    chain_from_prev: chain,
    character_ids: [1],
    video_settings: null,
  });
  return {
    project,
    characters,
    locations,
    items,
    beats: [
      { id: 1, order_index: 0, title: "Beat 1 — The approach", description: null },
      { id: 2, order_index: 1, title: "Beat 2 — The call", description: null },
    ],
    scenes: [scene(1, 0, 1, 0), scene(2, 1, 1, 1), scene(3, 2, 2, 1)],
    workflows: [
      {
        id: 7,
        name: "Character sheet · SDXL",
        kind: "image",
        is_enabled: true,
        prompt_profile: "prose",
        description: "reference sheets and environment plates",
        input_schema: [
          { nodeId: "6", label: "Positive prompt", role: "prompt", kind: "textarea", required: true },
          { nodeId: "9", label: "Steps", role: null, kind: "number", defaultValue: 28 },
        ],
        output_schema: [{ nodeId: "12", label: "Save image", role: "image", kind: "image" }],
      },
      // Neither of these may reach the picker: one is a video workflow, one is disabled.
      { id: 8, name: "WAN 2.2 · clip", kind: "video", is_enabled: true, prompt_profile: "prose", description: null, input_schema: [], output_schema: [] },
      { id: 9, name: "Old SD1.5 sheet", kind: "image", is_enabled: false, prompt_profile: "prose", description: null, input_schema: [], output_schema: [] },
    ],
  };
}

/** Mount a stateful Calliope on `page.route`, and hand back the call log. */
async function mockCalliope(page: import("@playwright/test").Page) {
  const state = fixtures();
  const calls: Call[] = [];
  const png = gradientPng();
  let coverPath: string | null = null;

  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const { pathname } = new URL(req.url());
    const method = req.method();
    if (method === "OPTIONS") return route.fulfill({ status: 204, headers: CORS, body: "" });

    let body: unknown = null;
    try {
      body = req.postDataJSON();
    } catch {
      body = req.postData();
    }
    calls.push({ method, path: pathname, body });
    const json = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", headers: CORS, body: JSON.stringify(data) });

    switch (`${method} ${pathname}`) {
      case "GET /api/health":
        return json({ status: "ok", version: "1.2.1", dry_run: false });
      case "GET /api/projects":
        return json([{ ...state.project, cover_path: null }]);
      case "GET /api/projects/1":
        return json({ ...state.project, cover_path: coverPath });
      case "PATCH /api/projects/1": {
        const patch = (body ?? {}) as { cover_path?: string | null };
        if ("cover_path" in patch) coverPath = patch.cover_path ?? null;
        return json({ ...state.project, cover_path: coverPath });
      }
      case "GET /api/projects/1/story":
        return json({ project: state.project, beats: state.beats, characters: state.characters, locations: state.locations, items: state.items });
      case "GET /api/projects/1/scenes":
        return json({ scenes: state.scenes, estimated_duration_sec: 15 });
      case "GET /api/projects/1/assets":
        return json({ characters: state.characters, locations: state.locations, items: state.items });
      case "POST /api/projects/1/generate-assets":
        return json({ ok: true, jobs: [] });
      case "PATCH /api/projects/1/characters/1": {
        Object.assign(state.characters[0]!, (body ?? {}) as Record<string, unknown>);
        return json(state.characters[0]);
      }
      case "POST /api/playground/uploads":
        return json({ ok: true, path: UPLOADED, name: "nadia.png", kind: "image" });
      case "GET /api/workflows":
        return json(state.workflows);
      case "GET /api/jobs":
        return json([]);
      case "GET /api/file":
        return route.fulfill({ status: 200, contentType: "image/png", headers: CORS, body: png });
      default:
        return json({});
    }
  });

  return { calls, state, bodiesFor: (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path).map((c) => c.body) };
}

test("assets: generate all missing, upload your own image, set the cover", async ({ page }) => {
  const mock = await mockCalliope(page);
  await waitForDemo(page);
  await drive(page, "project_open", { project_id: 1 });

  // The tab is registered by the module, not by DirectorApp.
  await page.locator('.bd-tabs [role="tab"]', { hasText: "Assets" }).click();
  const panel = page.locator('[data-panel="assets"]');
  await expect(panel).toBeVisible();

  // Sub-tabs carry live counts, and only the ENABLED IMAGE workflow is offered.
  await expect(panel.locator('[data-subtab="character"]')).toContainText("Characters");
  await expect(panel.locator('[data-subtab="character"] .bd-assets-count')).toHaveText("1");
  await expect(panel.locator('[data-subtab="location"] .bd-assets-count')).toHaveText("1");
  await expect(panel.locator('[data-subtab="item"] .bd-assets-count')).toHaveText("1");
  await expect(panel.locator('[data-workflow-select="character"] option')).toHaveCount(1);
  await expect(panel.locator('[data-workflow-select="character"]')).toHaveValue("7");
  // The prompt-role input is hidden (the card owns the prompt); the other one shows.
  await expect(panel.locator(".bd-dyn-field")).toHaveCount(1);

  // ── Generate all missing → the three scoped calls, in order ──────────────────
  await panel.getByRole("button", { name: "Generate all missing" }).click();
  await expect.poll(() => mock.bodiesFor("POST", "/api/projects/1/generate-assets").length).toBe(3);
  const [chars, locs, items] = mock.bodiesFor("POST", "/api/projects/1/generate-assets");
  expect(chars).toEqual({ missing_only: true, asset_target: "sheet", workflow_id: 7, character_ids: [1], input_values: { "9": 28 } });
  expect(locs).toEqual({ missing_only: true, asset_target: "sheet", workflow_id: 7, character_ids: [], location_ids: [1], input_values: { "9": 28 } });
  expect(items).toEqual({ missing_only: true, asset_target: "sheet", workflow_id: 7, character_ids: [], location_ids: [], item_ids: [5], input_values: { "9": 28 } });
  // An absent key is a different instruction from an empty one — that is the whole scoping rule.
  expect(Object.keys(chars as object)).not.toContain("location_ids");
  expect(Object.keys(locs as object)).not.toContain("item_ids");

  // ── Upload your own image for Nadia ─────────────────────────────────────────
  const card = panel.locator('[data-entity="character:1"]');
  await expect(card.getByRole("button", { name: /Upload own image/ })).toBeVisible();
  await expect(card.locator(".bd-entity-blank")).toContainText("No sheet yet");
  await card.locator('[data-file="character:1"]').setInputFiles({ name: "nadia.png", mimeType: "image/png", buffer: gradientPng(64, 80) });

  await expect.poll(() => mock.bodiesFor("POST", "/api/playground/uploads").length).toBe(1);
  await expect.poll(() => mock.bodiesFor("PATCH", "/api/projects/1/characters/1")).toEqual([{ sheet_path: UPLOADED }]);
  // The row really changed, so the card re-reads it and shows the picture.
  await expect(card.locator(".bd-entity-img")).toBeVisible();
  await expect(card.locator(".bd-entity-blank")).toHaveCount(0);

  // ── Set it as the project cover ─────────────────────────────────────────────
  await card.locator(".bd-entity-media").hover();
  await card.locator('[data-cover="character:1"]').click();
  await expect.poll(() => mock.bodiesFor("PATCH", "/api/projects/1")).toEqual([{ cover_path: UPLOADED }]);
  await expect(card.locator(".bd-cover-chip")).toBeVisible();

  // Clicking the same image again CLEARS the cover with an explicit null.
  await card.locator('[data-cover="character:1"]').click();
  await expect.poll(() => mock.bodiesFor("PATCH", "/api/projects/1")).toEqual([{ cover_path: UPLOADED }, { cover_path: null }]);
  await expect(card.locator(".bd-cover-chip")).toHaveCount(0);
  await card.locator('[data-cover="character:1"]').click();
  await expect(card.locator(".bd-cover-chip")).toBeVisible();

  // Clicking a card scrolls the panel's own scroll box; put it back so the shot shows the whole
  // feature — header, sub-tabs, generation settings, and the card.
  await page.locator(".bd-panel-host").evaluate((el) => el.scrollTo(0, 0));
  await shot(page, "u14-assets");
});

test("assets: the prompt fold shows the template, and Environments/Items have their own cards", async ({ page }) => {
  const mock = await mockCalliope(page);
  await waitForDemo(page);
  await drive(page, "project_open", { project_id: 1 });
  await page.locator('.bd-tabs [role="tab"]', { hasText: "Assets" }).click();
  const panel = page.locator('[data-panel="assets"]');

  // A saved consistency_prompt wins over the template…
  const fold = panel.locator('[data-entity="character:1"] .bd-prompt-fold');
  await fold.locator("summary").click();
  await expect(panel.locator('[data-prompt="character:1"]')).toHaveValue("same woman");
  // …and "Reset to template" puts Calliope's own sheet template back, from the row's own facts.
  await panel.getByRole("button", { name: "Reset to template" }).click();
  await expect(panel.locator('[data-prompt="character:1"]')).toHaveValue(/^CHARACTER SHEET — Nadia\nRole: lead\. Age: late 20s\./);
  await panel.getByRole("button", { name: "Save prompt" }).click();
  await expect.poll(() => (mock.bodiesFor("PATCH", "/api/projects/1/characters/1")[0] as { consistency_prompt?: string })?.consistency_prompt).toContain("CHARACTER SHEET — Nadia");

  // Environments and Items are the same card with their own noun and their own generate call.
  await panel.locator('[data-subtab="location"]').click();
  await expect(panel.locator('[data-entity="location:1"]')).toContainText("Rooftop, night");
  await panel.locator('[data-generate="location:1"]').click();
  await expect
    .poll(() => mock.bodiesFor("POST", "/api/projects/1/generate-assets").at(-1))
    .toEqual({ missing_only: false, asset_target: "sheet", workflow_id: 7, character_ids: [], location_ids: [1], input_values: { "9": 28 }, prompt: expect.stringContaining("ENVIRONMENT REFERENCE — Rooftop, night") });

  await panel.locator('[data-subtab="item"]').click();
  await expect(panel.locator('[data-entity="item:5"]')).toContainText("Brass key");
  await panel.locator('[data-generate="item:5"]').click();
  await expect
    .poll(() => mock.bodiesFor("POST", "/api/projects/1/generate-assets").at(-1))
    .toEqual({ missing_only: false, asset_target: "sheet", workflow_id: 7, character_ids: [], location_ids: [], item_ids: [5], input_values: { "9": 28 }, prompt: expect.stringContaining("ITEM REFERENCE — Brass key") });

  // Clicking a card scrolls the panel's own scroll box; put it back so the shot shows the whole
  // feature — header, sub-tabs, generation settings, and the card.
  await page.locator(".bd-panel-host").evaluate((el) => el.scrollTo(0, 0));
  await shot(page, "u14-assets-items");
});
