import { expect, test, type Page } from "@playwright/test";
import { drive, shot, waitForDemo } from "./helpers.js";

// The demo's SC-03 sits far to the right, and with the dopesheet open the fitted layout puts
// it past the canvas edge. These cases are about a card's own chrome, so they take the whole
// canvas — the same switch the dock's caret flips.

// U2 — leaf-node toolbar & chrome, driven through the real DOM: select a scene, use its
// toolbar (TYPE · colour · pin · bypass · delete), collapse it to its header by the chevron,
// rename it in place, and confirm the agent's commands see the same state.

const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const bar = (page: Page) => page.locator(".bd-leafbar");
const tb = (page: Page, what: string) => bar(page).locator(`[data-bd="${what}"]`);

/** Screen-space start point of an edge path (the SVG layer carries the viewport transform). */
async function edgeStart(page: Page, edgeId: string): Promise<{ x: number; y: number }> {
  return page.evaluate((eid) => {
    const path = document.querySelector<SVGPathElement>(`.react-flow__edge[data-id="${eid}"] path.react-flow__edge-path`);
    if (!path) throw new Error(`no edge ${eid}`);
    const p = path.getPointAtLength(0);
    const m = path.getScreenCTM();
    if (!m) throw new Error("no CTM");
    const pt = new DOMPoint(p.x, p.y).matrixTransform(m);
    return { x: pt.x, y: pt.y };
  }, edgeId);
}

test("a selected scene shows TYPE, colour, bypass and delete — the pin only inside a subgraph", async ({ page }) => {
  await waitForDemo(page, { timeline: false });
  await node(page, "sc-01").locator(".bd-node-title").click();
  await expect(bar(page)).toBeVisible();
  await expect(tb(page, "type")).toHaveText("SCENE");
  await expect(tb(page, "color")).toBeVisible();
  await expect(tb(page, "bypass")).toBeVisible();
  await expect(tb(page, "delete")).toBeVisible();
  // beat-1 is a plain group in the demo: no collapsed face, so no pin.
  await expect(tb(page, "pin")).toHaveCount(0);

  // Promote beat-1 → sc-01 is now inside a SUBGRAPH and the pin appears.
  await drive(page, "promote", { id: "beat-1" });
  await node(page, "sc-01").locator(".bd-node-title").click();
  await expect(tb(page, "pin")).toBeVisible();
  await drive(page, "dissolve", { id: "beat-1" });

  // An asset's TYPE is its kind.
  await node(page, "char-nadia").locator(".bd-node-title").click();
  await expect(tb(page, "type")).toHaveText("CHARACTER");
});

test("bypass fades the card and read_node reports it; a colour tints the header", async ({ page }) => {
  await waitForDemo(page, { timeline: false });
  await node(page, "sc-01").locator(".bd-node-title").click();
  await tb(page, "bypass").click();
  const card = node(page, "sc-01").locator(".bd-node");
  await expect(card).toHaveClass(/is-bypassed/);
  await expect(card).toHaveAttribute("title", /bypassed — skipped by render tools/);
  const opacity = await card.evaluate((el) => getComputedStyle(el).opacity);
  expect(Number(opacity)).toBeCloseTo(0.35, 1);
  expect((await drive<{ bypassed: boolean }>(page, "read_node", { id: "sc-01" })).bypassed).toBe(true);

  // Toggle it back — the same button — and the agent sees that too.
  await tb(page, "bypass").click();
  await expect(card).not.toHaveClass(/is-bypassed/);
  expect((await drive<{ bypassed: boolean }>(page, "read_node", { id: "sc-01" })).bypassed).toBe(false);

  // Colour: open the swatches, pick the first preset.
  await tb(page, "color").click();
  const swatches = page.locator('[data-bd="swatches"]');
  await expect(swatches).toBeVisible();
  const first = swatches.locator(".bd-swatch").first();
  const picked = await first.getAttribute("title");
  await first.click();
  await expect(swatches).toHaveCount(0);
  const read = await drive<{ color: string | null }>(page, "read_node", { id: "sc-01" });
  expect(read.color).toBe(picked);
  const kind = await card.evaluate((el) => getComputedStyle(el).getPropertyValue("--bd-kind").trim());
  expect(kind).toBe(picked);

  // The agent clears it.
  await drive(page, "set_node_color", { id: "sc-01", color: null });
  expect((await drive<{ color: string | null }>(page, "read_node", { id: "sc-01" })).color).toBeNull();
});

test("the chevron collapses a scene to its header: wires stay, handles sit on the header", async ({ page }) => {
  await waitForDemo(page, { timeline: false });
  const edgesBefore = await page.locator(".react-flow__edge").count();
  const lastFrame = 'lg:sc-01:out:LAST FRAME->sc-02:in:IN FRAME';
  const startBefore = await edgeStart(page, lastFrame);

  await node(page, "sc-01").locator('[data-bd="caret"]').click();
  const card = node(page, "sc-01").locator(".bd-node");
  await expect(card).toHaveClass(/is-collapsed/);
  await expect(card.locator(".bd-ports")).toHaveCount(0);
  // Every handle still exists, now inside the header: 4 inputs + 2 outputs.
  const header = card.locator(".bd-node-title");
  await expect(header.locator(".react-flow__handle")).toHaveCount(6);
  await expect(header.locator(".react-flow__handle.target")).toHaveCount(4);
  await expect(header.locator(".react-flow__handle.source")).toHaveCount(2);
  await expect(page.locator(".react-flow__edge")).toHaveCount(edgesBefore);
  expect((await drive<{ collapsed: boolean }>(page, "read_node", { id: "sc-01" })).collapsed).toBe(true);

  // The LAST FRAME wire now leaves from the header's right edge, not from where its row was.
  const box = await header.boundingBox();
  if (!box) throw new Error("no header box");
  await expect
    .poll(async () => {
      const s = await edgeStart(page, lastFrame);
      return s.y >= box.y - 2 && s.y <= box.y + box.height + 2 && Math.abs(s.x - (box.x + box.width)) < 12;
    }, { message: "edge start converges on the header's mid-right" })
    .toBe(true);
  expect(Math.abs(startBefore.y - (box.y + box.height / 2))).toBeGreaterThan(8);

  // Expand again through the agent — the rows come back and the wire count is unchanged.
  await drive(page, "set_node_collapsed", { id: "sc-01", collapsed: false });
  await expect(card).not.toHaveClass(/is-collapsed/);
  await expect(card.locator(".bd-port")).toHaveCount(6);
  await expect(page.locator(".react-flow__edge")).toHaveCount(edgesBefore);
});

test("double-click renames a scene in place; the (i) shows its facts on hover", async ({ page }) => {
  await waitForDemo(page, { timeline: false });
  const title = node(page, "sc-01").locator(".bd-title-text");
  await title.dblclick();
  const input = node(page, "sc-01").locator(".bd-title-input");
  await expect(input).toBeVisible();
  await input.fill("SC-01 · Renamed");
  await input.press("Enter");
  await expect(node(page, "sc-01").locator(".bd-title-text")).toHaveText("SC-01 · Renamed");
  const read = await drive<{ heading: string; label: string }>(page, "read_node", { id: "sc-01" });
  expect(read.heading).toBe("SC-01 · Renamed");
  expect(read.label).toBe("SC-01 · Renamed");

  const info = node(page, "sc-01").locator('[data-bd="info"]');
  await info.hover();
  const tip = info.locator(".bd-leaf-tip");
  await expect(tip).toBeVisible();
  await expect(tip).toContainText("6s");
});

test("delete: an unwired node goes at once, a wired one asks first", async ({ page }) => {
  await waitForDemo(page, { timeline: false });
  const { id } = await drive<{ id: string }>(page, "add_node", { kind: "item", x: 900, y: 60, label: "Prop" });
  await node(page, id).locator(".bd-node-title").click();
  await expect(tb(page, "type")).toHaveText("ITEM");
  await tb(page, "delete").click();
  await expect(page.locator(".bd-modal")).toHaveCount(0);
  await expect(node(page, id)).toHaveCount(0);

  // sc-03 has a wire: the confirm appears; Cancel keeps it.
  await node(page, "sc-03").locator(".bd-node-title").click();
  await tb(page, "delete").click();
  const modal = page.locator(".bd-modal");
  await expect(modal).toBeVisible();
  await expect(modal).toContainText("1 wire");
  await modal.getByRole("button", { name: "Cancel" }).click();
  await expect(node(page, "sc-03")).toHaveCount(1);
});

test("collapsing a leaf INSIDE a promoted Beat leaves the Beat's rails alone", async ({ page }) => {
  await waitForDemo(page, { timeline: false });
  // sc-02 lives in beat-1 and its LAST FRAME crosses the boundary to sc-03, so promoting the
  // Beat derives exactly one output rail. Collapsing sc-02 moves that wire's endpoint onto the
  // scene's header; the rail is derived from EDGES, so it must survive untouched.
  await drive(page, "promote", { id: "beat-1" });
  const before = await drive<{ promotedIn: unknown[]; promotedOut: unknown[] }>(page, "read_node", { id: "beat-1" });
  expect(before.promotedOut.length).toBe(1);
  const edges = await page.locator(".react-flow__edge").count();

  await node(page, "sc-02").locator('[data-bd="caret"]').click();
  await expect(node(page, "sc-02").locator(".bd-node")).toHaveClass(/is-collapsed/);
  const after = await drive<{ promotedIn: unknown[]; promotedOut: unknown[] }>(page, "read_node", { id: "beat-1" });
  expect(after.promotedOut).toEqual(before.promotedOut);
  expect(after.promotedIn).toEqual(before.promotedIn);
  await expect(page.locator(".react-flow__edge")).toHaveCount(edges);
  await expect(page.locator(".bd-rail-out .bd-pill").first()).toBeVisible();

  // The pin belongs to a node inside a subgraph, and it still works while collapsed.
  await node(page, "sc-02").locator(".bd-node-title").click();
  await tb(page, "pin").click();
  expect((await drive<{ promoted: boolean }>(page, "read_node", { id: "sc-02" })).promoted).toBe(true);
  await expect(page.locator(".react-flow__edge")).toHaveCount(edges);
});

test("the swatch's no-tint clears a colour the same way the agent does", async ({ page }) => {
  await waitForDemo(page, { timeline: false });
  await drive(page, "set_node_color", { id: "sc-01", color: "#34d399" });
  await node(page, "sc-01").locator(".bd-node-title").click();
  await tb(page, "color").click();
  await page.locator('[data-bd="swatches"] .bd-swatch-none').click();
  expect((await drive<{ color: string | null }>(page, "read_node", { id: "sc-01" })).color).toBeNull();
  // Cleared means the kind tint is back, not a transparent header.
  const kind = await node(page, "sc-01").locator(".bd-node").evaluate((el) => getComputedStyle(el).getPropertyValue("--bd-kind").trim());
  expect(kind).toBe("#3b82f6");
});

test("the look: toolbar on a tinted collapsed scene, a bypassed scene beside it", async ({ page }) => {
  await waitForDemo(page, { timeline: false });
  await drive(page, "set_node_color", { id: "sc-01", color: "#34d399" });
  await drive(page, "set_node_collapsed", { id: "sc-01", collapsed: true });
  await drive(page, "set_bypassed", { id: "sc-03", bypassed: true });
  await drive(page, "set_node_color", { id: "char-nadia", color: "#f472b6" });
  await node(page, "sc-01").locator(".bd-node-title").click();
  await expect(bar(page)).toBeVisible();
  await node(page, "sc-02").locator('[data-bd="info"]').hover();
  await expect(node(page, "sc-02").locator(".bd-leaf-tip")).toBeVisible();
  await shot(page, "u2-node-chrome");
});
