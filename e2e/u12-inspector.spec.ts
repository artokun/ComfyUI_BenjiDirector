import { expect, test, type Page } from "@playwright/test";
import { drive, shot, waitForDemo } from "./helpers.js";

// The inspector against a MOCKED Calliope: the harness has no backend, so every /api/* call
// the editor makes (health probe, project list, story + scenes, workflows, the PATCHes the
// forms send) is answered here. Row fixtures are the shapes calliope-bind.test.ts pins from
// Calliope 1.2.1. A PATCH merges into the in-memory row and echoes it, the way the real
// server does, so the forms' echo check runs for real.

type Row = Record<string, unknown>;
interface Patch {
  path: string;
  body: Row;
}

const story = {
  project: { id: 1, title: "The Approach", idea: null, genre: "thriller", tone: "quiet, tense", target_duration: "2 min", status: "draft" },
  beats: [
    { id: 1, order_index: 0, title: "Beat 1 — The approach", description: null },
    { id: 2, order_index: 1, title: "Beat 2 — The call", description: null },
  ],
  characters: [
    { id: 1, name: "Nadia", role: null, age: null, appearance: null, personality: null, portrait_path: null, sheet_path: null, consistency_prompt: "same woman" },
    { id: 2, name: "Marco", role: "the voice on the phone", age: null, appearance: null, personality: null, portrait_path: null, sheet_path: null, consistency_prompt: null },
  ],
  locations: [{ id: 1, name: "Rooftop, night", description: null, reference_image_path: null, consistency_prompt: null }],
  items: [],
};
const sceneRow = (id: number, order_index: number, beat_id: number | null, extra: Row = {}): Row => ({
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
  chain_from_prev: 0,
  character_ids: [1],
  video_settings: null,
  ...extra,
});
const workflows = [
  { id: 7, name: "Wan I2V", kind: "video", is_enabled: true, prompt_profile: "prose", description: null, input_schema: [{ nodeId: "3", label: "prompt", role: "prompt", kind: "text" }, { nodeId: "5", label: "video", role: "video", kind: "video" }], output_schema: [] },
  { id: 8, name: "T2V only", kind: "video", is_enabled: true, prompt_profile: "prose", description: null, input_schema: [{ nodeId: "3", label: "prompt", role: "prompt", kind: "text" }], output_schema: [] },
  { id: 9, name: "Old I2V", kind: "video", is_enabled: false, prompt_profile: "prose", description: null, input_schema: [], output_schema: [] },
  { id: 10, name: "Flux sheet", kind: "image", is_enabled: true, prompt_profile: "prose", description: null, input_schema: [], output_schema: [] },
];

/** Route every Calliope call. Returns the PATCH log and the live rows. */
async function mockCalliope(page: Page) {
  const scenes: Row[] = [sceneRow(1, 0, 1), sceneRow(2, 1, 1, { chain_from_prev: 1 }), sceneRow(3, 2, 2, { chain_from_prev: 1 })];
  const characters: Row[] = story.characters.map((c) => ({ ...c }));
  const patches: Patch[] = [];
  const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS", "access-control-allow-headers": "content-type" };
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    const m = req.method();
    if (m === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const json = (body: unknown, status = 200) => route.fulfill({ status, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify(body) });
    if (p === "/api/health") return json({ status: "ok", version: "1.2.1-mock", dry_run: true });
    if (p === "/api/projects" && m === "GET") return json([{ ...story.project, created_at: "2026-09-01", updated_at: "2026-09-01" }]);
    if (p === "/api/projects/1" && m === "GET") return json(story.project);
    if (p === "/api/projects/1/story") return json({ ...story, characters });
    if (p === "/api/projects/1/scenes" && m === "GET") return json({ scenes, estimated_duration_sec: scenes.reduce((a, s) => a + Number(s.duration_sec ?? 0), 0) });
    if (p === "/api/workflows") return json(workflows);
    if (p === "/api/playground/uploads") return json([]);
    const sc = p.match(/^\/api\/projects\/1\/scenes\/(\d+)$/);
    if (sc && m === "PATCH") {
      const row = scenes.find((s) => s.id === Number(sc[1]));
      if (!row) return json({ detail: "Scene not found" }, 404);
      const body = req.postDataJSON() as Row;
      patches.push({ path: p, body });
      Object.assign(row, body);
      return json(row);
    }
    const ch = p.match(/^\/api\/projects\/1\/characters\/(\d+)$/);
    if (ch && m === "PATCH") {
      const row = characters.find((c) => c.id === Number(ch[1]));
      if (!row) return json({ detail: "Character not found" }, 404);
      const body = req.postDataJSON() as Row;
      patches.push({ path: p, body });
      Object.assign(row, body);
      return json(row);
    }
    return json({ detail: `unmocked ${m} ${p}` }, 404);
  });
  return { patches, scenes, characters };
}

async function openProject(page: Page) {
  await waitForDemo(page);
  // [U11] replaced the project <select> with its own menu, so the project is opened the way
  // every other Calliope-backed spec opens it — through the drive command the menu calls.
  await drive(page, "project_open", { project_id: 1 });
  await page.locator('.react-flow__node[data-id="cal-sc-1"]').waitFor();
}

test("empty state, then a local node says it has no row", async ({ page }) => {
  await waitForDemo(page);
  const insp = page.locator(".bd-inspector");
  await expect(insp).toBeVisible();
  await expect(insp).toContainText("Select a scene, Beat or asset");
  await drive(page, "inspect", { id: "sc-01" });
  await expect(insp.locator(".bd-insp-title")).toHaveText("SC-01 · Nadia climbs out");
  await expect(insp).toContainText("local — not in Calliope yet");
  // A local edit writes to the node itself.
  await insp.locator('[name="heading"]').fill("SC-01 · Out onto the roof");
  await insp.locator('[name="duration_sec"]').fill("7");
  await insp.locator('[name="duration_sec"]').blur();
  await expect(page.locator('.react-flow__node[data-id="sc-01"]')).toContainText("SC-01 · Out onto the roof");
  const n = await drive<{ durationSec: number | null }>(page, "read_node", { id: "sc-01" });
  expect(n.durationSec).toBe(7);
});

test("scene: edit action + duration, blur → one PATCH per blur with only the dirty fields", async ({ page }) => {
  const { patches } = await mockCalliope(page);
  await openProject(page);
  const insp = page.locator(".bd-inspector");

  const res = await drive<{ id: string; calliope: { kind: string; id: number } }>(page, "inspect", { id: "cal-sc-1" });
  expect(res.calliope).toEqual({ kind: "scene", id: 1 });
  await expect(insp.locator(".bd-insp-title")).toHaveText("SC-01");
  await expect(insp.locator('[name="heading"]')).toHaveValue("SC-01");
  await expect(insp.locator('[name="duration_sec"]')).toHaveValue("5");
  // The first scene in the cut cannot chain.
  await expect(insp.locator('[name="chain_from_prev"]')).toBeDisabled();

  // A blur writes ONE patch carrying only the dirty field.
  await insp.locator('[name="action"]').fill("Nadia climbs out onto the roof.");
  await insp.locator('[name="action"]').blur();
  await expect.poll(() => patches.length).toBe(1);
  expect(patches[0]).toEqual({ path: "/api/projects/1/scenes/1", body: { action: "Nadia climbs out onto the roof." } });
  // The write refreshed the project, which rebuilds the canvas — the inspector stays open on
  // the same scene rather than closing itself.
  await expect(insp).toHaveAttribute("data-node", "cal-sc-1");

  await insp.locator('[name="duration_sec"]').fill("8");
  await insp.locator('[name="duration_sec"]').blur();
  // Asserted first: the acknowledgement is a chip that clears itself after a moment, so a
  // slower assertion ahead of it would be racing the chip rather than testing it.
  await expect(insp.locator(".bd-insp-save")).toHaveText(/Saved/);
  await expect.poll(() => patches.length).toBe(2);
  expect(patches[1]?.body).toEqual({ duration_sec: 8 });
  // The echo came back through refresh(): the card shows the new duration.
  await expect(page.locator('.react-flow__node[data-id="cal-sc-1"]')).toContainText("8s");

  // Heading flows onto the canvas the same way.
  await insp.locator('[name="heading"]').fill("SC-01 · The roof");
  await insp.locator('[name="heading"]').blur();
  await expect.poll(() => patches.length).toBe(3);
  expect(patches[2]?.body).toEqual({ heading: "SC-01 · The roof" });
  await expect(page.locator('.react-flow__node[data-id="cal-sc-1"]')).toContainText("SC-01 · The roof");

  // A blur with nothing dirty is not a PATCH.
  await insp.locator('[name="action"]').focus();
  await insp.locator('[name="action"]').blur();
  await page.waitForTimeout(150);
  expect(patches.length).toBe(3);

  // Characters are a set replace: adding Marco sends the whole list.
  await insp.locator('.bd-insp-chip[data-character="2"]').click();
  await expect.poll(() => patches.length).toBe(4);
  expect(patches[3]?.body).toEqual({ character_ids: [1, 2] });
  await expect(insp.locator('.bd-insp-chip[data-character="2"]')).toHaveAttribute("aria-pressed", "true");

  // Location cleared → explicit null (a clearable column).
  await insp.locator('[name="location_id"]').selectOption("");
  await expect.poll(() => patches.length).toBe(5);
  expect(patches[4]?.body).toEqual({ location_id: null });
});

test("scene: chain toggle, workflow select, and the no-video-input warning", async ({ page }) => {
  const { patches } = await mockCalliope(page);
  await openProject(page);
  const insp = page.locator(".bd-inspector");

  await drive(page, "inspect", { id: "cal-sc-2" });
  await expect(insp.locator(".bd-insp-title")).toHaveText("SC-02");
  const chain = insp.locator('[name="chain_from_prev"]');
  await expect(chain).toBeEnabled();
  await expect(chain).toBeChecked();
  await chain.click();
  await expect.poll(() => patches.length).toBe(1);
  expect(patches[0]).toEqual({ path: "/api/projects/1/scenes/2", body: { chain_from_prev: false } });
  await expect(chain).not.toBeChecked();
  // Off: the continuity wire into SC-02 is gone from the canvas after the refresh.
  await expect.poll(async () => {
    const o = await drive<{ edges: Array<{ id: string }> }>(page, "outline");
    return o.edges.some((e) => e.id.endsWith("->cal-sc-2:in:IN FRAME"));
  }).toBe(false);

  await chain.click();
  await expect.poll(() => patches.length).toBe(2);
  expect(patches[1]?.body).toEqual({ chain_from_prev: true });

  // Only enabled VIDEO workflows are offered; "default" is null.
  const wf = insp.locator('[name="workflow_id"]');
  await expect(wf.locator("option")).toHaveText(["default", "Wan I2V", "T2V only"]);
  await wf.selectOption("8");
  await expect.poll(() => patches.length).toBe(3);
  expect(patches[2]?.body).toEqual({ workflow_id: 8 });
  await expect(insp.locator(".bd-insp-warn")).toContainText("no video input");
  await wf.selectOption("7");
  await expect.poll(() => patches.length).toBe(4);
  await expect(insp.locator(".bd-insp-warn")).toHaveCount(0);
  await wf.selectOption("");
  await expect.poll(() => patches.length).toBe(5);
  expect(patches[4]?.body).toEqual({ workflow_id: null });

  await insp.evaluate((el) => el.parentElement?.scrollTo(0, 0));
  await shot(page, "u12-inspector");
});

test("character: consistency prompt on blur, and the template reset", async ({ page }) => {
  const { patches } = await mockCalliope(page);
  await openProject(page);
  const insp = page.locator(".bd-inspector");

  await drive(page, "inspect", { id: "cal-char-1" });
  await expect(insp.locator(".bd-insp-title")).toHaveText("Nadia");
  await expect(insp.locator('[name="consistency_prompt"]')).toHaveValue("same woman");
  await insp.locator('[name="consistency_prompt"]').fill("same woman, red coat, short dark hair");
  await insp.locator('[name="consistency_prompt"]').blur();
  await expect.poll(() => patches.length).toBe(1);
  expect(patches[0]).toEqual({ path: "/api/projects/1/characters/1", body: { consistency_prompt: "same woman, red coat, short dark hair" } });

  // The template is Calliope's own, built from the fields as they are.
  await insp.locator('[name="role"]').fill("lead");
  await insp.locator('[name="role"]').blur();
  await expect.poll(() => patches.length).toBe(2);
  expect(patches[1]?.body).toEqual({ role: "lead" });
  await insp.getByRole("button", { name: /Reset to sheet template/ }).click();
  await expect.poll(() => patches.length).toBe(3);
  expect(patches[2]?.body.consistency_prompt).toMatch(/^CHARACTER SHEET — Nadia\nRole: lead\. Age: unspecified age\./);

  await insp.evaluate((el) => el.parentElement?.scrollTo(0, 0));
  await shot(page, "u12-inspector-character");

  // A Beat opens too.
  await drive(page, "inspect", { id: "cal-beat-1" });
  await expect(insp.locator(".bd-insp-title")).toHaveText("Beat 1 — The approach");
  await expect(insp).toContainText("2 scenes");
  await shot(page, "u12-inspector-beat");
});
