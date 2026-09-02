import { expect, test, type Page, type Route } from "@playwright/test";
import { drive, shot, waitForDemo } from "./helpers.js";

// [U13] Canvas write-back parity, against a RECORDED Calliope.
//
// The harness runs the demo project with no server, so Calliope is mocked with page.route and
// every request is recorded: the point of this unit is not that the canvas changes — it is
// that the right rows change with it, in the right order, with the reorder Calliope's own
// script stage does. Assertions are on the RECORDING, so a canvas that looks right while
// writing nothing still fails.
//
// Rows are the ones observed on the wire for the seeded project "The Approach" (the fixtures
// calliope-bind.test.ts uses), with a beat_id per scene so the Beats have something in them.

interface Recorded {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

const STORY = {
  project: { id: 1, title: "The Approach", idea: null, genre: "thriller", tone: "quiet, tense", target_duration: "2 min", status: "draft" },
  beats: [
    { id: 1, order_index: 0, title: "Beat 1 — The approach", description: null },
    { id: 2, order_index: 1, title: "Beat 2 — The call", description: null },
  ],
  characters: [
    { id: 1, name: "Nadia", role: null, age: null, appearance: null, personality: null, portrait_path: null, sheet_path: null, consistency_prompt: "same woman" },
    { id: 2, name: "The caller", role: null, age: null, appearance: null, personality: null, portrait_path: null, sheet_path: null, consistency_prompt: null },
  ],
  locations: [{ id: 1, name: "Rooftop, night", description: null, reference_image_path: null, consistency_prompt: null }],
  items: [],
};

const sceneRow = (id: number, order_index: number, beat_id: number | null, extra: Record<string, unknown> = {}) => ({
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

/**
 * A Calliope that answers from an in-memory cut and RECORDS every request.
 *
 * The mutating routes echo a row built from what they were sent — which is what makes this a
 * fair test of the echo rule: the editor believes a write landed because the row says so, and
 * a test that echoed something else would be testing the mock, not the editor.
 */
async function mockCalliope(page: Page): Promise<Recorded[]> {
  const seen: Recorded[] = [];
  const scenes = new Map<number, ReturnType<typeof sceneRow>>([
    [1, sceneRow(1, 0, 1)],
    [2, sceneRow(2, 1, 1)],
    [3, sceneRow(3, 2, 2)],
  ]);
  const beats = new Map(STORY.beats.map((b) => [b.id, { ...b }]));
  let nextSceneId = 4;
  let nextBeatId = 3;

  await page.route("**/api/**", async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();
    let body: Record<string, unknown> | null = null;
    try {
      body = method === "GET" || method === "DELETE" ? null : (req.postDataJSON() as Record<string, unknown>);
    } catch {
      body = null;
    }
    seen.push({ method, path, body });
    const json = (data: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
    const cut = () => [...scenes.values()].sort((a, b) => a.order_index - b.order_index);

    if (path === "/api/health") return json({ status: "ok", version: "1.2.1", dry_run: false });
    if (path === "/api/projects" && method === "GET") return json([STORY.project]);
    if (path === "/api/projects/1/story") return json({ ...STORY, beats: [...beats.values()] });
    if (path === "/api/projects/1/scenes" && method === "GET") return json({ scenes: cut(), estimated_duration_sec: 15 });

    if (path === "/api/projects/1/scenes" && method === "POST") {
      const b = body ?? {};
      const created = sceneRow(nextSceneId, Number(b.order_index ?? 0), (b.beat_id as number | null) ?? null, {
        heading: b.heading ?? "",
        duration_sec: b.duration_sec ?? null,
        location_id: b.location_id ?? null,
        character_ids: b.character_ids ?? [],
      });
      scenes.set(nextSceneId, created);
      nextSceneId += 1;
      return json(created);
    }
    if (path === "/api/projects/1/scenes/reorder" && method === "POST") {
      const ids = (body?.scene_ids as number[]) ?? [];
      ids.forEach((id, i) => {
        const row = scenes.get(id);
        if (row) row.order_index = i + 1;
      });
      return json({ scenes: cut() });
    }
    const sceneMatch = /^\/api\/projects\/1\/scenes\/(\d+)$/.exec(path);
    if (sceneMatch) {
      const id = Number(sceneMatch[1]);
      const row = scenes.get(id);
      if (!row) return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ detail: "Scene not found" }) });
      if (method === "DELETE") {
        scenes.delete(id);
        return json({ ok: true });
      }
      // PATCH: apply and echo, the way update_scene does — including character_ids.
      for (const [k, v] of Object.entries(body ?? {})) (row as Record<string, unknown>)[k] = k === "chain_from_prev" ? (v ? 1 : 0) : v;
      return json(row);
    }
    if (path === "/api/projects/1/beats" && method === "POST") {
      const made = { id: nextBeatId, order_index: Number(body?.order_index ?? 0), title: String(body?.title ?? ""), description: null };
      beats.set(nextBeatId, made);
      nextBeatId += 1;
      return json(made);
    }
    const beatMatch = /^\/api\/projects\/1\/beats\/(\d+)$/.exec(path);
    if (beatMatch) {
      const id = Number(beatMatch[1]);
      const row = beats.get(id);
      if (!row) return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ detail: "Beat not found" }) });
      if (method === "DELETE") {
        beats.delete(id);
        for (const s of scenes.values()) if (s.beat_id === id) s.beat_id = null; // FK SET NULL
        return json({ ok: true });
      }
      Object.assign(row, body ?? {});
      return json(row);
    }
    return json({});
  });
  return seen;
}

const post = (seen: Recorded[], path: string) => seen.filter((r) => r.method === "POST" && r.path === path);
const patch = (seen: Recorded[], path: string) => seen.filter((r) => r.method === "PATCH" && r.path === path);

/** Load project 1 through the drive API the agent uses, and wait for the canvas to be it. */
async function openProject(page: Page): Promise<void> {
  await drive(page, "project_open", { project_id: 1 });
  await page.locator('.react-flow__node[data-id="cal-sc-1"]').waitFor();
}

test("a scene added inside a Beat creates the row FIRST and takes its id", async ({ page }) => {
  const seen = await mockCalliope(page);
  await waitForDemo(page);
  await openProject(page);

  await expect(page.locator('.react-flow__node[data-id="cal-beat-1"]')).toBeVisible();
  // Inside Beat 1's box (340,40)-(800,480), clear of the two scenes already stacked in it.
  const added = await drive<{ id: string; label: string }>(page, "add_node", { kind: "scene", x: 380, y: 390, label: "SC-NEW" });

  // The id the agent gets back is the ROW's: no local id was ever handed out.
  expect(added.id).toMatch(/^cal-sc-\d+$/);
  const creates = post(seen, "/api/projects/1/scenes");
  expect(creates).toHaveLength(1);
  expect(creates[0]?.body).toMatchObject({ heading: "SC-NEW", duration_sec: 5, order_index: 4 });
  // Dropped inside Beat 1, so the row is in Beat 1 — not "wherever a later settle puts it".
  expect(creates[0]?.body?.beat_id).toBe(1);
  // ...then the reorder with the FULL id list, so order_index stays contiguous.
  const reorders = post(seen, "/api/projects/1/scenes/reorder");
  expect(reorders).toHaveLength(1);
  expect(reorders[0]?.body?.scene_ids).toEqual([1, 2, 3, 4]);
  // The create came before the reorder, and both before anything else touched the scene.
  const order = seen.filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.path}`);
  expect(order).toEqual(["POST /api/projects/1/scenes", "POST /api/projects/1/scenes/reorder"]);

  await expect(page.locator(`.react-flow__node[data-id="${added.id}"]`)).toBeVisible();
  await shot(page, "u13-writeback");
});

test("wiring and cutting a CHARACTER writes character_ids; a LOCATION writes location_id", async ({ page }) => {
  const seen = await mockCalliope(page);
  await waitForDemo(page);
  await openProject(page);

  await drive(page, "connect", { source_handle: "cal-char-2:out:REF", target_handle: "cal-sc-3:in:CHARACTER" });
  await expect.poll(() => patch(seen, "/api/projects/1/scenes/3").length).toBe(1);
  // The wired character goes FIRST — the canvas draws character_ids[0] — and the character the
  // old wire stood for is dropped, not the whole list.
  expect(patch(seen, "/api/projects/1/scenes/3")[0]?.body).toEqual({ character_ids: [2] });

  await drive(page, "disconnect", { target_handle: "cal-sc-3:in:CHARACTER" });
  await expect.poll(() => patch(seen, "/api/projects/1/scenes/3").length).toBe(2);
  expect(patch(seen, "/api/projects/1/scenes/3")[1]?.body).toEqual({ character_ids: [] });

  await drive(page, "disconnect", { target_handle: "cal-sc-3:in:LOCATION" });
  await expect.poll(() => patch(seen, "/api/projects/1/scenes/3").length).toBe(3);
  expect(patch(seen, "/api/projects/1/scenes/3")[2]?.body).toEqual({ location_id: null });
});

test("renaming a Beat patches the beat row; renaming a scene patches its heading", async ({ page }) => {
  const seen = await mockCalliope(page);
  await waitForDemo(page);
  await openProject(page);

  await drive(page, "set_title", { id: "cal-beat-1", label: "Beat 1 — The climb" });
  await expect.poll(() => patch(seen, "/api/projects/1/beats/1").length).toBe(1);
  expect(patch(seen, "/api/projects/1/beats/1")[0]?.body).toEqual({ title: "Beat 1 — The climb" });

  await drive(page, "set_title", { id: "cal-sc-1", label: "SC-01 · The climb" });
  await expect.poll(() => patch(seen, "/api/projects/1/scenes/1").length).toBe(1);
  expect(patch(seen, "/api/projects/1/scenes/1")[0]?.body).toEqual({ heading: "SC-01 · The climb" });
});

test("removing a scene confirms, DELETEs the row and reorders what is left", async ({ page }) => {
  const seen = await mockCalliope(page);
  await waitForDemo(page);
  await openProject(page);

  const removal = drive<{ removed: string[] }>(page, "remove_node", { id: "cal-sc-2" });
  // The confirm names the consequence: the film loses the row, not just the canvas.
  const dialog = page.locator(".bd-modal");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("also deletes the Calliope row");
  await dialog.getByRole("button", { name: "Delete" }).click();
  expect((await removal).removed).toEqual(["cal-sc-2"]);

  const deletes = seen.filter((r) => r.method === "DELETE" && r.path === "/api/projects/1/scenes/2");
  expect(deletes).toHaveLength(1);
  const reorders = post(seen, "/api/projects/1/scenes/reorder");
  expect(reorders).toHaveLength(1);
  expect(reorders[0]?.body?.scene_ids).toEqual([1, 3]);
  await expect(page.locator('.react-flow__node[data-id="cal-sc-2"]')).toHaveCount(0);
});

test("cancelling the confirm leaves the row AND the node exactly where they were", async ({ page }) => {
  const seen = await mockCalliope(page);
  await waitForDemo(page);
  await openProject(page);

  const removal = drive<{ removed: string[] }>(page, "remove_node", { id: "cal-sc-2" });
  await page.locator(".bd-modal").getByRole("button", { name: "Cancel" }).click();
  expect((await removal).removed).toEqual([]);
  expect(seen.filter((r) => r.method === "DELETE")).toHaveLength(0);
  await expect(page.locator('.react-flow__node[data-id="cal-sc-2"]')).toHaveCount(1);
});

test("grouping Calliope scenes creates the Beat row and moves them into it", async ({ page }) => {
  const seen = await mockCalliope(page);
  await waitForDemo(page);
  await openProject(page);

  const grouped = await drive<{ id: string }>(page, "group", { node_ids: ["cal-sc-1", "cal-sc-2"], label: "Beat 3 — The climb" });
  // The id handed back is the ROW's, not the local one the container was built with.
  expect(grouped.id).toBe("cal-beat-3");
  const beatCreates = post(seen, "/api/projects/1/beats");
  expect(beatCreates).toHaveLength(1);
  expect(beatCreates[0]?.body).toMatchObject({ title: "Beat 3 — The climb", order_index: 2 });
  // Each scene's beat_id follows, because the re-id IS the move the write-back diff writes.
  // The row's id only exists after the POST, so the beat_id PATCH is the SECOND write for each
  // scene — the first carries the local Beat, whose beat_id is null. Poll for the id, not for
  // "a patch happened", or the assertion reads the transient one.
  await expect.poll(() => patch(seen, "/api/projects/1/scenes/1").at(-1)?.body?.beat_id).toBe(3);
  await expect.poll(() => patch(seen, "/api/projects/1/scenes/2").at(-1)?.body?.beat_id).toBe(3);
  await expect(page.locator('.react-flow__node[data-id="cal-beat-3"]')).toBeVisible();
});

test("undo goes through settle, so Calliope follows the move back", async ({ page }) => {
  const seen = await mockCalliope(page);
  await waitForDemo(page);
  await openProject(page);

  const before = await drive<{ position: { x: number; y: number } }>(page, "read_node", { id: "cal-sc-1" });
  await drive(page, "move_node", { id: "cal-sc-1", x: 520, y: 300 });
  await expect.poll(() => patch(seen, "/api/projects/1/scenes/1").length).toBe(1);

  // Undo is not a drive command (the vocabulary is frozen) — it is the toolbar button.
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  // The undo is an edit like any other: the row goes back where the canvas does. Before this
  // unit, undo called decorate directly and the row kept the position it had been dragged to.
  await expect.poll(() => patch(seen, "/api/projects/1/scenes/1").length).toBe(2);
  const last = patch(seen, "/api/projects/1/scenes/1").at(-1)?.body as { video_settings?: { director?: { position?: { x: number; y: number } } } };
  expect(last?.video_settings?.director?.position).toEqual({ x: Math.round(before.position.x), y: Math.round(before.position.y) });
  const after = await drive<{ position: { x: number; y: number } }>(page, "read_node", { id: "cal-sc-1" });
  expect(after.position).toEqual(before.position);
});

test("the demo project refuses a row and says so, instead of writing nowhere", async ({ page }) => {
  const seen = await mockCalliope(page);
  await waitForDemo(page);
  // No project_open: the canvas is the demo graph, which has no rows at all.
  const added = await drive<{ id: string }>(page, "add_node", { kind: "scene", x: 200, y: 520, label: "Local scene" });
  expect(added.id).not.toMatch(/^cal-/);
  await expect(page.locator(".bd-note")).toContainText("demo project");
  expect(seen.filter((r) => r.method !== "GET")).toHaveLength(0);
});
