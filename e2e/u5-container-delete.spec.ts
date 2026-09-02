import { expect, test, type Page } from "@playwright/test";
import { drive, shot, waitForDemo } from "./helpers.js";

// U5 — container deletion & context. The demo project's beat-1 (a plain group) holds sc-01 and
// sc-02; sc-02 feeds sc-03 outside it. Every path that can delete a populated Beat must ask
// first, and "only the Beat" must leave its scenes exactly where they are on screen.

interface Summary {
  id: string;
  kind: string;
  parentId: string | null;
  position: { x: number; y: number };
}
interface Outline {
  nodes: Summary[];
  edges: { id: string; source: string; target: string }[];
}

/** A node's ABSOLUTE canvas position: read_node reports the parent-relative one. */
async function absolute(page: Page, id: string): Promise<{ x: number; y: number }> {
  let n = await drive<Summary>(page, "read_node", { id });
  let { x, y } = n.position;
  let hops = 0;
  while (n.parentId && hops++ < 10) {
    n = await drive<Summary>(page, "read_node", { id: n.parentId });
    x += n.position.x;
    y += n.position.y;
  }
  return { x, y };
}

async function selectBeat(page: Page): Promise<void> {
  await page.locator('.react-flow__node[data-id="beat-1"] .bd-group-title').click();
  await expect(page.locator(".bd-cdel-btn")).toBeVisible();
}

test("toolbar trash asks; 'Delete only the Beat' lifts the scenes out in place; undo restores; 'Delete all' takes everything", async ({ page }) => {
  await waitForDemo(page, { timeline: false });
  const before = { "sc-01": await absolute(page, "sc-01"), "sc-02": await absolute(page, "sc-02") };
  const edgesBefore = (await drive<Outline>(page, "outline")).edges.map((e) => e.id).sort();
  expect(edgesBefore.length).toBe(5);

  await selectBeat(page);
  await page.locator(".bd-cdel-btn").click();
  const modal = page.locator(".bd-modal");
  await expect(modal).toBeVisible();
  await expect(modal).toContainText("Delete “Beat 1 — The approach”?");
  await expect(modal.locator(".bd-cdel-row")).toHaveCount(2);
  await expect(modal.locator('.bd-cdel-row[data-id="sc-01"]')).toContainText("SC-01 · Nadia climbs out");
  await expect(modal.locator('.bd-cdel-row[data-id="sc-02"]')).toContainText("SC-02 · She sees the city");
  await expect(modal.locator(".bd-cdel-kind").first()).toHaveText("scene");
  await expect(page.locator(".react-flow__node")).toHaveCount(6); // asking deleted nothing
  await shot(page, "u5-container-delete");

  // ── only the shell ──
  await modal.locator("button", { hasText: "Delete only the Beat" }).click();
  await expect(modal).toBeHidden();
  let outline = await drive<Outline>(page, "outline");
  expect(outline.nodes.map((n) => n.id)).not.toContain("beat-1");
  for (const id of ["sc-01", "sc-02"] as const) {
    const n = outline.nodes.find((x) => x.id === id);
    expect(n, `${id} survives`).toBeTruthy();
    expect(n?.parentId, `${id} is on the canvas now`).toBeNull();
    expect(await absolute(page, id), `${id} did not move`).toEqual(before[id]);
  }
  expect(outline.edges.map((e) => e.id).sort(), "every wire kept").toEqual(edgesBefore);
  await expect(page.locator(".react-flow__node")).toHaveCount(5);
  await expect(page.locator(".bd-note")).toContainText("left where they stood");

  // ── undo puts the Beat back around them ──
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.locator('.react-flow__node[data-id="beat-1"]')).toBeVisible();
  outline = await drive<Outline>(page, "outline");
  for (const id of ["sc-01", "sc-02"] as const) {
    expect(outline.nodes.find((x) => x.id === id)?.parentId, `${id} back in beat-1`).toBe("beat-1");
    expect(await absolute(page, id)).toEqual(before[id]);
  }
  await expect(page.locator(".react-flow__node")).toHaveCount(6);

  // ── everything ──
  await selectBeat(page);
  await page.locator(".bd-cdel-btn").click();
  await expect(modal).toBeVisible();
  await modal.locator("button", { hasText: "Delete all" }).click();
  await expect(modal).toBeHidden();
  outline = await drive<Outline>(page, "outline");
  const ids = outline.nodes.map((n) => n.id).sort();
  expect(ids).toEqual(["char-nadia", "loc-rooftop", "sc-03"]);
  expect(outline.edges, "no wire survives without an endpoint").toEqual([]);
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  await expect(page.locator(".bd-note")).toContainText("deleted 3 nodes");
});

test("the Delete key on a populated Beat opens the confirm instead of cascading", async ({ page }) => {
  await waitForDemo(page, { timeline: false });
  await selectBeat(page);
  await page.keyboard.press("Delete");
  const modal = page.locator(".bd-modal");
  await expect(modal).toBeVisible();
  await expect(page.locator(".react-flow__node")).toHaveCount(6);
  // Cancel leaves the graph exactly as it was.
  await modal.locator(".bd-modal-actions button", { hasText: "Cancel" }).click();
  await expect(modal).toBeHidden();
  const outline = await drive<Outline>(page, "outline");
  expect(outline.nodes.length).toBe(6);
  expect(outline.nodes.find((n) => n.id === "sc-01")?.parentId).toBe("beat-1");
});

test("the pane toolbar's Delete routes a populated Beat to the confirm too", async ({ page }) => {
  await waitForDemo(page, { timeline: false });
  await selectBeat(page);
  await page.locator(".bd-toolbar button", { hasText: "Delete" }).first().click();
  await expect(page.locator(".bd-modal")).toBeVisible();
  await expect(page.locator(".react-flow__node")).toHaveCount(6);
  await page.keyboard.press("Escape");
  await expect(page.locator(".bd-modal")).toBeHidden();
});

test("an EMPTY Beat deletes at once, no question asked", async ({ page }) => {
  await waitForDemo(page, { timeline: false });
  const { id } = await drive<{ id: string }>(page, "group", { node_ids: ["sc-03"], label: "Lonely" });
  await drive(page, "set_parent", { id: "sc-03", parent_id: null });
  await drive(page, "move_node", { id: "sc-03", x: 1400, y: 900 });
  await drive(page, "reconcile", { id });
  await page.locator(`.react-flow__node[data-id="${id}"] .bd-group-title`).click();
  await page.locator(".bd-cdel-btn").click();
  await expect(page.locator(".bd-modal")).toHaveCount(0);
  await expect(page.locator(`.react-flow__node[data-id="${id}"]`)).toHaveCount(0);
  const outline = await drive<Outline>(page, "outline");
  expect(outline.nodes.map((n) => n.id)).not.toContain(id);
  expect(outline.nodes.find((n) => n.id === "sc-03")).toBeTruthy();
});

test("the agent's delete_container has both modes and refuses a leaf", async ({ page }) => {
  await waitForDemo(page, { timeline: false });
  const before = await absolute(page, "sc-02");
  await expect(drive(page, "delete_container", { id: "sc-03", mode: "all" })).rejects.toThrow(/not a Beat/);
  await expect(drive(page, "delete_container", { id: "beat-1" })).rejects.toThrow(/mode must be/);

  const shell = await drive<{ removed: string[]; reparented: string[] }>(page, "delete_container", { id: "beat-1", mode: "shell" });
  expect(shell.removed).toEqual(["beat-1"]);
  expect(shell.reparented.sort()).toEqual(["sc-01", "sc-02"]);
  expect(await absolute(page, "sc-02")).toEqual(before);
  await expect(page.locator(".react-flow__node")).toHaveCount(5);

  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.locator('.react-flow__node[data-id="beat-1"]')).toBeVisible();
  const all = await drive<{ removed: string[] }>(page, "delete_container", { id: "beat-1", mode: "all" });
  expect(all.removed.sort()).toEqual(["beat-1", "sc-01", "sc-02"]);
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
});

test("right-click on a Beat's body opens the palette at the cursor; a picked Scene lands inside the Beat", async ({ page }) => {
  await waitForDemo(page, { timeline: false });
  const beat = page.locator('.react-flow__node[data-id="beat-1"]');
  const palette = page.locator(".bd-palette");

  // The title bar is a real target — no palette there.
  await beat.locator(".bd-group-title").click({ button: "right" });
  await expect(palette).toHaveCount(0);

  const box = await beat.boundingBox();
  if (!box) throw new Error("no beat box");
  // Empty body: right of the two scene cards, halfway down — and far enough from the right
  // edge that the new card's centre lands inside (placement is by geometry, as a drag is).
  const x = box.x + box.width * 0.7;
  const y = box.y + box.height * 0.5;
  await page.mouse.click(x, y, { button: "right" });
  await expect(palette).toBeVisible();
  const pb = await palette.boundingBox();
  if (!pb) throw new Error("no palette box");
  // "At the cursor", not "at a fixed corner" — a menu's own padding and shadow move its box a
  // few pixels, and a design pass changes that number. The tolerance has to be looser than the
  // chrome or it pins the styling instead of the placement.
  expect(Math.abs(pb.x - x), "palette x at the cursor").toBeLessThan(16);
  expect(Math.abs(pb.y - y), "palette y at the cursor").toBeLessThan(16);
  await shot(page, "u5-container-delete-context");

  await palette.locator(".bd-palette-item", { hasText: "Scene" }).click();
  await expect(palette).toHaveCount(0);
  const outline = await drive<Outline>(page, "outline");
  const fresh = outline.nodes.filter((n) => n.kind === "scene" && !["sc-01", "sc-02", "sc-03"].includes(n.id));
  expect(fresh.length).toBe(1);
  expect(fresh[0]?.parentId, "the new scene is parented to the Beat it was dropped in").toBe("beat-1");
  await expect(page.locator(".react-flow__node")).toHaveCount(7);
});

test("the guard does not OVER-refuse: a leaf, a leaf inside the Beat, and an EMPTY Beat all still delete on the Delete key", async ({ page }) => {
  await waitForDemo(page, { timeline: false });

  // A plain node on the canvas.
  await page.locator('.react-flow__node[data-id="sc-03"]').click();
  await page.keyboard.press("Delete");
  await expect(page.locator('.react-flow__node[data-id="sc-03"]')).toHaveCount(0);
  await expect(page.locator(".bd-modal")).toHaveCount(0);

  // A leaf INSIDE the populated Beat: the Beat itself is not being deleted, so nothing is asked.
  await page.locator('.react-flow__node[data-id="sc-01"]').click();
  await page.keyboard.press("Delete");
  await expect(page.locator('.react-flow__node[data-id="sc-01"]')).toHaveCount(0);
  await expect(page.locator(".bd-modal")).toHaveCount(0);
  expect((await drive<Outline>(page, "outline")).nodes.find((n) => n.id === "beat-1"), "beat-1 survives its child").toBeTruthy();

  // Emptying the Beat makes the Delete key delete it outright, with no confirm.
  await page.locator('.react-flow__node[data-id="sc-02"]').click();
  await page.keyboard.press("Delete");
  await expect(page.locator('.react-flow__node[data-id="sc-02"]')).toHaveCount(0);
  await page.locator('.react-flow__node[data-id="beat-1"] .bd-group-title').click();
  await page.keyboard.press("Delete");
  await expect(page.locator(".bd-modal")).toHaveCount(0);
  await expect(page.locator('.react-flow__node[data-id="beat-1"]')).toHaveCount(0);
  expect((await drive<Outline>(page, "outline")).nodes.map((n) => n.id).sort()).toEqual(["char-nadia", "loc-rooftop"]);
});
