import { expect, test, type Page } from "@playwright/test";
import { drive, shot, waitForDemo } from "./helpers.js";

// U6 — a PLAIN group collapses to a header card. Its children vanish, every wire that crossed
// its boundary now terminates on a proxy handle at the card's edge, the wire between two hidden
// children is not drawn, and the state underneath stays canonical: `outline` keeps reporting
// the real endpoints throughout, and expanding puts everything back.

const NADIA_TO_SC01 = "lg:char-nadia:out:REF->sc-01:in:CHARACTER";
const SC02_TO_SC03 = "lg:sc-02:out:LAST FRAME->sc-03:in:IN FRAME";
const SC01_TO_SC02 = "lg:sc-01:out:LAST FRAME->sc-02:in:IN FRAME";
const DEMO_EDGES = 5;

type Proxy = { id: string; childId: string; childPortId: string; side: "in" | "out"; type: string; label: string };
type Summary = { id: string; type: string; hidden: boolean; parentId: string | null; position: { x: number; y: number }; collapsed?: boolean; proxies?: Proxy[] };
type Outline = { edges: { id: string; source: string; target: string }[] };

const edge = (page: Page, id: string) => page.locator(`.react-flow__edge[data-id="${id}"]`);
const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);

async function expectCanonical(page: Page): Promise<void> {
  const outline = await drive<Outline>(page, "outline");
  expect(outline.edges).toHaveLength(DEMO_EDGES);
  expect(outline.edges.find((e) => e.id === NADIA_TO_SC01)).toMatchObject({ source: "char-nadia", target: "sc-01" });
  expect(outline.edges.find((e) => e.id === SC02_TO_SC03)).toMatchObject({ source: "sc-02", target: "sc-03" });
  expect(outline.edges.some((e) => e.id.endsWith("@display"))).toBe(false);
}

test("collapsing a plain group hides its children and re-routes the crossing wires onto proxy handles", async ({ page }) => {
  await waitForDemo(page);
  await expect(page.locator(".react-flow__edge")).toHaveCount(DEMO_EDGES);
  const beat = await drive<Summary>(page, "read_node", { id: "beat-1" });
  expect(beat.type, "beat-1 is a PLAIN group in the demo — nothing is promoted here").toBe("groupbox");

  await drive(page, "set_collapsed", { id: "beat-1", collapsed: true });
  const card = node(page, "beat-1").locator(".bd-collapsed");
  await expect(card).toBeVisible();
  await expect(card).toContainText("2 inside");

  // The children are gone from the canvas but still in the group.
  await expect(node(page, "sc-01")).toHaveCount(0);
  await expect(node(page, "sc-02")).toHaveCount(0);
  for (const id of ["sc-01", "sc-02"]) {
    const n = await drive<Summary>(page, "read_node", { id });
    expect(n.hidden, `${id} hidden`).toBe(true);
    expect(n.parentId, `${id} still in beat-1`).toBe("beat-1");
  }

  // Four wires drawn: the three that enter and the one that leaves. The internal one is not.
  await expect(page.locator(".react-flow__edge")).toHaveCount(DEMO_EDGES - 1);
  await expect(edge(page, `${SC01_TO_SC02}@display`)).toHaveCount(0);
  await expect(edge(page, `${NADIA_TO_SC01}@display`)).toHaveAttribute("aria-label", "Edge from char-nadia to beat-1");
  await expect(edge(page, `${SC02_TO_SC03}@display`)).toHaveAttribute("aria-label", "Edge from beat-1 to sc-03");
  // …and each terminates on a proxy handle the card carries, on the right side of the header.
  await expect(card.locator('.react-flow__handle[data-handleid="beat-1::proxy:sc-01:in:CHARACTER"]')).toHaveAttribute("data-handlepos", "left");
  await expect(card.locator('.react-flow__handle[data-handleid="beat-1::proxy:sc-02:out:LAST FRAME"]')).toHaveAttribute("data-handlepos", "right");
  await expect(card.locator(".react-flow__handle.is-proxy")).toHaveCount(4);

  // The same four, as the AGENT sees them: one per hidden child port with an outside wire.
  const collapsedBeat = await drive<Summary>(page, "read_node", { id: "beat-1" });
  expect((collapsedBeat.proxies ?? []).map((p) => `${p.side}:${p.childId}:${p.label}`).sort()).toEqual([
    "in:sc-01:CHARACTER",
    "in:sc-01:LOCATION",
    "in:sc-02:CHARACTER",
    "out:sc-02:LAST FRAME",
  ]);

  // State never saw a proxy.
  await expectCanonical(page);

  // `decorate` re-derives `data.proxies` on EVERY settle, so settling again must be a no-op —
  // otherwise the collapsed card churns (or the reparent pass drops the hidden children out of
  // the group, whose relative positions sit outside the small collapsed box).
  await drive(page, "repair");
  await drive(page, "repair");
  const resettled = await drive<Summary>(page, "read_node", { id: "beat-1" });
  expect(resettled.proxies).toEqual(collapsedBeat.proxies);
  expect(resettled.collapsed).toBe(true);
  await expect(page.locator(".react-flow__edge")).toHaveCount(DEMO_EDGES - 1);
  await expect(card.locator(".react-flow__handle.is-proxy")).toHaveCount(4);
  for (const id of ["sc-01", "sc-02"]) {
    expect((await drive<Summary>(page, "read_node", { id })).parentId, `${id} survives a re-settle`).toBe("beat-1");
  }
  await expectCanonical(page);

  // Drag the collapsed card by its header: the hidden children ride along.
  const before = await drive<Summary>(page, "read_node", { id: "beat-1" });
  const head = node(page, "beat-1").locator(".bd-collapsed-head");
  const box = await head.boundingBox();
  if (!box) throw new Error("no collapsed head");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 200, box.y + box.height / 2 + 120, { steps: 10 });
  await page.mouse.up();
  const after = await drive<Summary>(page, "read_node", { id: "beat-1" });
  expect(after.position.x - before.position.x).toBeGreaterThan(100);
  for (const id of ["sc-01", "sc-02"]) {
    const n = await drive<Summary>(page, "read_node", { id });
    expect(n.parentId, `${id} stays in beat-1 through the drag`).toBe("beat-1");
  }
  await expect(edge(page, `${NADIA_TO_SC01}@display`)).toHaveAttribute("aria-label", "Edge from char-nadia to beat-1");
  await shot(page, "u6-group-collapse");

  // Expand: the children and every wire come back as they were.
  await drive(page, "set_collapsed", { id: "beat-1", collapsed: false });
  await expect(node(page, "beat-1").locator(".bd-group")).toBeVisible();
  await expect(node(page, "sc-01")).toBeVisible();
  await expect(node(page, "sc-02")).toBeVisible();
  await expect(page.locator(".react-flow__edge")).toHaveCount(DEMO_EDGES);
  await expect(edge(page, NADIA_TO_SC01)).toHaveAttribute("aria-label", "Edge from char-nadia to sc-01");
  await expect(edge(page, SC01_TO_SC02)).toHaveAttribute("aria-label", "Edge from sc-01 to sc-02");
  await expect(page.locator(".react-flow__handle.is-proxy")).toHaveCount(0);
  expect((await drive<Summary>(page, "read_node", { id: "beat-1" })).proxies ?? []).toEqual([]);
  for (const id of ["sc-01", "sc-02"]) {
    const n = await drive<Summary>(page, "read_node", { id });
    expect(n.parentId, `${id} still in beat-1 after expanding`).toBe("beat-1");
  }
  await expectCanonical(page);
  await shot(page, "u6-group-collapse-expanded");
});

test("the Collapse button on a plain group's toolbar collapses it, and Expand restores the box", async ({ page }) => {
  await waitForDemo(page);
  const beat = node(page, "beat-1");
  const boxBefore = await drive<{ width?: number; height?: number }>(page, "read_node", { id: "beat-1" });
  await beat.locator(".bd-group-title").click();
  await page.locator(".bd-nodebar button", { hasText: "Collapse" }).click();
  await expect(beat.locator(".bd-collapsed")).toBeVisible();
  await expect(page.locator(".react-flow__edge")).toHaveCount(DEMO_EDGES - 1);
  const collapsed = await drive<Summary>(page, "read_node", { id: "beat-1" });
  expect(collapsed.collapsed).toBe(true);

  await beat.locator(".bd-collapsed-head").click();
  await page.locator(".bd-nodebar button", { hasText: "Expand" }).click();
  await expect(beat.locator(".bd-group")).toBeVisible();
  const boxAfter = await drive<{ width?: number; height?: number }>(page, "read_node", { id: "beat-1" });
  expect(boxAfter.width).toBe(boxBefore.width);
  expect(boxAfter.height).toBe(boxBefore.height);
  await expect(page.locator(".react-flow__edge")).toHaveCount(DEMO_EDGES);
});

test("deleting a re-routed wire from its midpoint menu removes the CANONICAL edge", async ({ page }) => {
  await waitForDemo(page);
  await drive(page, "set_collapsed", { id: "beat-1", collapsed: true });
  // The OUTBOUND wire: the only one on the card's right hub, so its midpoint control is not
  // overlapped. (Every proxy stacks on one hub point, so the two wires into the left hub are
  // drawn along the same path and their midpoints coincide.)
  const shown = edge(page, `${SC02_TO_SC03}@display`);
  await expect(shown).toBeVisible();
  await shown.hover();
  await shown.locator(".bd-edge-mid").click();
  await page.locator(".bd-edge-menu button", { hasText: "Delete" }).click();
  await expect(shown).toHaveCount(0);
  const outline = await drive<Outline>(page, "outline");
  expect(outline.edges).toHaveLength(DEMO_EDGES - 1);
  expect(outline.edges.some((e) => e.id === SC02_TO_SC03), "the CANONICAL edge is the one removed").toBe(false);
  expect(outline.edges.some((e) => e.id.endsWith("@display")), "no displayed edge was ever written into state").toBe(false);
  // The proxy that wire needed goes with it; the inbound ones stay.
  const card = node(page, "beat-1");
  await expect(card.locator('.react-flow__handle[data-handleid="beat-1::proxy:sc-02:out:LAST FRAME"]')).toHaveCount(0);
  await expect(card.locator('.react-flow__handle[data-handleid="beat-1::proxy:sc-01:in:CHARACTER"]')).toHaveCount(1);
  await expect(card.locator(".react-flow__handle.is-proxy")).toHaveCount(3);
});

test("selecting and Delete-ing a re-routed wire removes the CANONICAL edge", async ({ page }) => {
  // The KEYBOARD path, which is the only one that goes through React Flow's own onEdgesChange:
  // both the select and the remove name the DISPLAYED edge, so without the canonical-id mapping
  // the select would land on an id that is not in state and the wire would never even select.
  await waitForDemo(page);
  await drive(page, "set_collapsed", { id: "beat-1", collapsed: true });
  const shown = edge(page, `${SC02_TO_SC03}@display`);
  await expect(shown).toBeVisible();
  // Click a point 25% along the wire. Not its centre: the midpoint menu control sits there and
  // stops the event, so a centre click opens the menu instead of selecting the edge.
  const at = await shown.locator("path.react-flow__edge-interaction").evaluate((el) => {
    const path = el as unknown as SVGPathElement;
    const local = path.getPointAtLength(path.getTotalLength() * 0.25);
    const m = path.getScreenCTM();
    if (!m) throw new Error("no screen CTM for the edge path");
    const q = new DOMPoint(local.x, local.y).matrixTransform(m);
    return { x: q.x, y: q.y };
  });
  await page.mouse.click(at.x, at.y);
  await expect(shown).toHaveClass(/selected/);
  await page.keyboard.press("Delete");
  await expect(shown).toHaveCount(0);
  const outline = await drive<Outline>(page, "outline");
  expect(outline.edges).toHaveLength(DEMO_EDGES - 1);
  expect(outline.edges.some((e) => e.id === SC02_TO_SC03), "the CANONICAL edge is the one removed").toBe(false);
  expect(outline.edges.some((e) => e.id.endsWith("@display")), "no displayed edge was ever written into state").toBe(false);
});

test("set_collapsed refuses a node that is not a Beat", async ({ page }) => {
  await waitForDemo(page);
  await expect(drive(page, "set_collapsed", { id: "sc-03", collapsed: true })).rejects.toThrow(/not a Beat/);
});
