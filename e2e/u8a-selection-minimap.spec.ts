import { expect, test, type Page } from "@playwright/test";
import { drive, shot, waitForDemo } from "./helpers.js";

// U8a — selection ergonomics and the minimap, driven through the real DOM: a left-drag on the
// pane draws a marquee, the floating pill counts what it caught, Subgraph wraps and promotes it,
// a middle-drag pans, and `fit_view` frames what it is told to.

type Summary = { id: string; type?: string; parentId: string | null };

async function nodeBox(page: Page, id: string) {
  const box = await page.locator(`.react-flow__node[data-id="${id}"]`).boundingBox();
  if (!box) throw new Error(`no box for ${id}`);
  return box;
}

const transform = (page: Page) => page.locator(".react-flow__viewport").evaluate((el) => (el as HTMLElement).style.transform);

/** True when that screen point is BARE pane — not a node, and not an edge's fat hit area. */
const isPane = (page: Page, x: number, y: number) =>
  page.evaluate(([px, py]) => document.elementFromPoint(px as number, py as number)?.classList.contains("react-flow__pane") ?? false, [x, y]);

/**
 * Draw a marquee over the two scenes inside Beat 1.
 *
 * It has to START on empty pane — React Flow only begins a selection when the pointer goes down
 * on the pane ITSELF, and a wire's hit area counts as something else — so the drag opens in the
 * gap left of the Beat, above the wires running into it, and pulls down-right across both scenes.
 */
async function marqueeOverScenes(page: Page) {
  const [beat, nadia, rooftop, sc02] = await Promise.all([nodeBox(page, "beat-1"), nodeBox(page, "char-nadia"), nodeBox(page, "loc-rooftop"), nodeBox(page, "sc-02")]);
  const assetsRight = Math.max(nadia.x + nadia.width, rooftop.x + rooftop.width);
  expect(assetsRight, "the demo leaves empty pane between the assets and Beat 1").toBeLessThan(beat.x);
  const startX = (assetsRight + beat.x) / 2;
  const canvas = await page.locator(".bd-canvas").boundingBox();
  if (!canvas) throw new Error("no canvas");

  let startY = 0;
  for (let y = canvas.y + 12; y < beat.y - 6; y += 10) {
    if (await isPane(page, startX, y)) {
      startY = y;
      break;
    }
  }
  expect(startY, "empty pane above Beat 1 to start the marquee from").toBeGreaterThan(0);

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(sc02.x + sc02.width * 0.6, sc02.y + sc02.height * 0.75, { steps: 12 });
  await page.mouse.up();
}

test("a left-drag box-selects the two scenes, and the pill counts them", async ({ page }) => {
  await waitForDemo(page);
  await marqueeOverScenes(page);

  // Beat 1 is brushed by any box drawn around its children; only a box that swallows it whole
  // means it, so the marquee comes back with the two scenes and nothing else.
  await expect(page.getByTestId("selection-pill")).toBeVisible();
  await expect(page.locator(".bd-selpill-count")).toHaveText("2 selected");
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(2);
  await expect(page.locator('.react-flow__node[data-id="sc-01"].selected')).toBeVisible();
  await expect(page.locator('.react-flow__node[data-id="sc-02"].selected')).toBeVisible();

  await expect(page.locator(".react-flow__minimap.bd-minimap")).toBeVisible();
  await shot(page, "u8a-selection-minimap");
});

test("Subgraph in the pill wraps the selection in a Beat and promotes it", async ({ page }) => {
  await waitForDemo(page);
  await marqueeOverScenes(page);
  await expect(page.locator(".bd-selpill-count")).toHaveText("2 selected");

  await page.locator(".bd-selpill-btn", { hasText: "Subgraph" }).click();

  await expect
    .poll(async () => (await drive<{ nodes: Summary[] }>(page, "outline")).nodes.filter((n) => n.type === "subgraph").length, { timeout: 10_000 })
    .toBe(1);

  const outline = await drive<{ nodes: Summary[] }>(page, "outline");
  const wrap = outline.nodes.find((n) => n.type === "subgraph");
  expect(wrap, "the wrap is a subgraph").toBeTruthy();
  expect(wrap?.id).not.toBe("beat-1");
  for (const id of ["sc-01", "sc-02"]) {
    expect(outline.nodes.find((n) => n.id === id)?.parentId, `${id} is inside the new subgraph`).toBe(wrap?.id);
  }
  await shot(page, "u8a-selection-subgraph");
});

test("a middle-drag pans the canvas", async ({ page }) => {
  await waitForDemo(page);
  const before = await transform(page);
  const beat = await nodeBox(page, "beat-1");
  const x = beat.x + beat.width / 2;
  const y = beat.y + beat.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(x - 160, y - 90, { steps: 10 });
  await page.mouse.up({ button: "middle" });
  await expect.poll(() => transform(page)).not.toBe(before);
  // The pan moved the viewport, not the graph.
  const beatNode = await drive<{ position: { x: number; y: number } }>(page, "read_node", { id: "beat-1" });
  expect(beatNode.position).toEqual({ x: 340, y: 40 });
});

test("right-drag pans, and a right-click alone still opens the palette", async ({ page }) => {
  await waitForDemo(page);
  const canvas = await page.locator(".bd-canvas").boundingBox();
  if (!canvas) throw new Error("no canvas");
  const x = canvas.x + 60;
  const y = canvas.y + canvas.height - 60;
  expect(await isPane(page, x, y), "bare pane to right-click on").toBe(true);

  // Pan with the right button held: the palette must NOT open on a drag.
  const before = await transform(page);
  await page.mouse.move(x, y);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(x + 140, y - 70, { steps: 10 });
  await page.mouse.up({ button: "right" });
  await expect.poll(() => transform(page)).not.toBe(before);
  await expect(page.locator(".bd-palette")).toHaveCount(0);

  // A right-click that does not move still opens it.
  await page.mouse.click(x, y, { button: "right" });
  await expect(page.locator(".bd-palette")).toBeVisible();
});

test("fit_view frames everything, or only the ids it is given", async ({ page }) => {
  await waitForDemo(page);
  const framed = await transform(page);

  expect(await drive(page, "fit_view", { ids: ["sc-03"] })).toEqual({ fitted: ["sc-03"] });
  await expect.poll(() => transform(page)).not.toBe(framed);
  const onSc03 = await transform(page);

  expect(await drive(page, "fit_view")).toEqual({ fitted: "all" });
  await expect.poll(() => transform(page)).not.toBe(onSc03);
  // "All" means all: every node is back inside the canvas.
  const canvas = await page.locator(".bd-canvas").boundingBox();
  if (!canvas) throw new Error("no canvas");
  for (const id of ["char-nadia", "loc-rooftop", "beat-1", "sc-01", "sc-02", "sc-03"]) {
    const box = await nodeBox(page, id);
    expect(box.x, `${id} is framed`).toBeGreaterThanOrEqual(canvas.x - 1);
    expect(box.y, `${id} is framed`).toBeGreaterThanOrEqual(canvas.y - 1);
    expect(box.x + box.width, `${id} is framed`).toBeLessThanOrEqual(canvas.x + canvas.width + 1);
    expect(box.y + box.height, `${id} is framed`).toBeLessThanOrEqual(canvas.y + canvas.height + 1);
  }

  await expect(drive(page, "fit_view", { ids: ["nope"] })).rejects.toThrow(/no node "nope"/);
});

test("select sets the selection, and the pill follows it", async ({ page }) => {
  await waitForDemo(page);
  await expect(page.getByTestId("selection-pill")).toHaveCount(0);

  expect(await drive(page, "select", { ids: ["sc-01", "sc-03"] })).toEqual({ selected: ["sc-01", "sc-03"] });
  await expect(page.locator(".bd-selpill-count")).toHaveText("2 selected");
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(2);

  await drive(page, "select", { ids: [] });
  await expect(page.getByTestId("selection-pill")).toHaveCount(0);
});

test("the minimap paints a node per kind, and the Snap switch reaches the canvas", async ({ page }) => {
  await waitForDemo(page);
  const minimap = page.locator(".react-flow__minimap.bd-minimap");
  await expect(minimap).toBeVisible();
  await expect(minimap.locator(".react-flow__minimap-node.bd-mm-scene")).toHaveCount(3);
  await expect(minimap.locator(".react-flow__minimap-node.bd-mm-asset")).toHaveCount(2);
  await expect(minimap.locator(".react-flow__minimap-node.bd-mm-beat")).toHaveCount(1);

  const snap = page.locator(".bd-snap-toggle");
  await expect(snap).toHaveAttribute("aria-pressed", "false");
  await snap.click();
  await expect(snap).toHaveAttribute("aria-pressed", "true");

  // With snap on, a dragged node lands ON the 18px grid the Background draws.
  const sc03 = await nodeBox(page, "sc-03");
  await page.mouse.move(sc03.x + sc03.width / 2, sc03.y + 12);
  await page.mouse.down();
  await page.mouse.move(sc03.x + sc03.width / 2 + 57, sc03.y + 12 + 41, { steps: 8 });
  await page.mouse.up();
  const moved = await drive<{ position: { x: number; y: number } }>(page, "read_node", { id: "sc-03" });
  expect(moved.position.x % 18, "snapped x").toBe(0);
  expect(moved.position.y % 18, "snapped y").toBe(0);
});
