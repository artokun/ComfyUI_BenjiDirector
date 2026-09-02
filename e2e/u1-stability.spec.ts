import { expect, test, type Page } from "@playwright/test";
import { drive, shot, waitForDemo } from "./helpers.js";

// [U1] Stability: resize, z-order, drag.
//
// What these pin, against the real DOM:
//  - a leaf node resizes by its corner grip, and the size lands on the node (survives settle);
//  - a Beat resizes by its corner, and a COLLAPSED Beat by its width-only edge;
//  - a Beat is selected and dragged by its BODY (not just its title bar), children along;
//  - a wire that crosses a Beat's body is still the thing under the pointer — hover shows the
//    midpoint control and clicking it opens the edge menu — because containers sit below the
//    wires in the stack (z-order.ts), not because the body was made pointer-transparent.

type Box = { x: number; y: number; width: number; height: number };

async function nodeBox(page: Page, id: string): Promise<Box> {
  const box = await page.locator(`.react-flow__node[data-id="${id}"]`).boundingBox();
  if (!box) throw new Error(`no box for ${id}`);
  return box;
}

async function dragMouse(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 3, from.y + 3);
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();
}

/** What is under a screen point: the closest node id (or null) and whether it is a wire. */
async function hit(page: Page, x: number, y: number): Promise<{ node: string | null; edge: boolean; group: boolean }> {
  return page.evaluate(
    ([px, py]) => {
      const el = document.elementFromPoint(px, py);
      return {
        node: el?.closest(".react-flow__node")?.getAttribute("data-id") ?? null,
        edge: !!el?.closest(".react-flow__edge"),
        group: !!el?.closest(".bd-group"),
      };
    },
    [x, y] as const,
  );
}

/** A point on beat-1's BODY: inside its box, on the group itself — not a child, wire, title or grip. */
async function bodyPoint(page: Page, id: string): Promise<{ x: number; y: number }> {
  const box = await nodeBox(page, id);
  for (const [fx, fy] of [
    [0.85, 0.35],
    [0.85, 0.5],
    [0.7, 0.3],
    [0.9, 0.6],
    [0.6, 0.45],
  ]) {
    const x = box.x + box.width * fx!;
    const y = box.y + box.height * fy!;
    const h = await hit(page, x, y);
    if (h.node === id && h.group && !h.edge) return { x, y };
  }
  throw new Error(`no free body point on ${id}`);
}

test("a Scene grows when dragged by its corner grip, and the size lands on the node", async ({ page }) => {
  await waitForDemo(page, { timeline: false });
  await expect(page.locator('.react-flow__node[data-id="sc-03"] .bd-grip')).toBeAttached();
  const before = await nodeBox(page, "sc-03");
  const beforeNode = await drive<{ width?: number; height?: number }>(page, "read_node", { id: "sc-03" });
  expect(beforeNode.width, "an unresized scene carries no width").toBeUndefined();
  await dragMouse(page, { x: before.x + before.width - 5, y: before.y + before.height - 5 }, { x: before.x + before.width + 90, y: before.y + before.height + 40 });
  const after = await nodeBox(page, "sc-03");
  expect(after.width - before.width, "the card got wider on screen").toBeGreaterThan(70);
  expect(after.height - before.height, "and taller").toBeGreaterThan(25);
  const node = await drive<{ width?: number; height?: number }>(page, "read_node", { id: "sc-03" });
  expect(node.width ?? 0, "width written to the node").toBeGreaterThan(0);
  expect(node.height ?? 0, "height written to the node").toBeGreaterThan(0);
  // It survives a settle: a structural edit elsewhere does not lose the size.
  await drive(page, "set_title", { id: "sc-01", label: "SC-01 · renamed" });
  const kept = await drive<{ width?: number }>(page, "read_node", { id: "sc-03" });
  expect(kept.width).toBe(node.width);
});

test("beat-1 resizes by its corner; a collapsed Beat by its width-only edge", async ({ page }) => {
  await waitForDemo(page, { timeline: false });
  const beat = page.locator('.react-flow__node[data-id="beat-1"]');
  await beat.locator(".bd-group-title").click();
  await expect(beat.locator(".react-flow__resize-control.handle")).toHaveCount(4);
  const box = await nodeBox(page, "beat-1");
  const before = await drive<{ width?: number }>(page, "read_node", { id: "beat-1" });
  await dragMouse(page, { x: box.x + box.width - 2, y: box.y + box.height - 2 }, { x: box.x + box.width + 80, y: box.y + box.height + 60 });
  const after = await drive<{ width?: number }>(page, "read_node", { id: "beat-1" });
  expect((after.width ?? 0) - (before.width ?? 0)).toBeGreaterThan(40);

  // Collapsed: the card is content-height, so only the width resizes — by the right edge.
  await drive(page, "promote", { id: "beat-1" });
  await drive(page, "set_collapsed", { id: "beat-1", collapsed: true });
  await expect(beat.locator(".bd-collapsed")).toBeVisible();
  await beat.locator(".bd-collapsed-head").click();
  await expect(beat.locator(".react-flow__resize-control.line.right")).toBeAttached();
  const cb = await nodeBox(page, "beat-1");
  // The right edge, at the hub row — the middle of the edge, where the card's own header used
  // to cover the 2px control and swallow the drag. Vertical travel is deliberate: a width-only
  // resizer must ignore it.
  await dragMouse(page, { x: cb.x + cb.width, y: cb.y + cb.height / 2 }, { x: cb.x + cb.width + 80, y: cb.y + cb.height / 2 + 30 });
  const cb2 = await nodeBox(page, "beat-1");
  expect(cb2.width - cb.width, "the collapsed card got wider").toBeGreaterThan(50);
  expect(Math.abs(cb2.height - cb.height), "and no taller").toBeLessThan(3);
  const collapsed = await drive<{ width?: number }>(page, "read_node", { id: "beat-1" });
  expect(collapsed.width ?? 0).toBeGreaterThan(0);
});

test("a Beat is selected by its body and dragged by it, children along", async ({ page }) => {
  await waitForDemo(page, { timeline: false });
  const p = await bodyPoint(page, "beat-1");
  await page.mouse.click(p.x, p.y);
  await expect(page.locator('.react-flow__node[data-id="beat-1"] .bd-group')).toHaveClass(/is-selected/);

  const beatBefore = await nodeBox(page, "beat-1");
  const childBefore = await nodeBox(page, "sc-01");
  await dragMouse(page, p, { x: p.x + 200, y: p.y });
  const beatAfter = await nodeBox(page, "beat-1");
  const childAfter = await nodeBox(page, "sc-01");
  expect(beatAfter.x - beatBefore.x, "the Beat moved 200px").toBeGreaterThan(190);
  expect(beatAfter.x - beatBefore.x).toBeLessThan(210);
  expect(childAfter.x - childBefore.x, "its child moved with it").toBeGreaterThan(190);
  for (const id of ["sc-01", "sc-02"]) {
    const n = await drive<{ parentId: string | null }>(page, "read_node", { id });
    expect(n.parentId, `${id} stays in beat-1`).toBe("beat-1");
  }
});

test("a wire crossing a Beat body stays hoverable and clickable; screenshot", async ({ page }) => {
  await waitForDemo(page, { timeline: false });
  // The demo's sc-02 (inside beat-1) → sc-03 (outside) wire already runs out through the
  // Beat's empty right half. Dragging sc-03 *into* the Beat instead would put a card over
  // the wire — legitimate, since a node sits above an edge, but then there is no open body
  // left to test the actual claim on.
  const outside = await drive<{ parentId: string | null }>(page, "read_node", { id: "sc-03" });
  expect(outside.parentId, "sc-03 stays outside the Beat").toBeNull();

  const edge = page.locator('.react-flow__edge[data-id="lg:sc-02:out:LAST FRAME->sc-03:in:IN FRAME"]');
  await expect(edge).toBeAttached();
  const mid = edge.locator(".bd-edge-mid");
  const mb = await mid.boundingBox();
  if (!mb) throw new Error("no midpoint control");
  const mx = mb.x + mb.width / 2;
  const my = mb.y + mb.height / 2;
  const beat = await nodeBox(page, "beat-1");
  expect(mx, "the midpoint is inside beat-1's box").toBeGreaterThan(beat.x);
  expect(mx).toBeLessThan(beat.x + beat.width);
  expect(my).toBeGreaterThan(beat.y);
  expect(my).toBeLessThan(beat.y + beat.height);

  // The claim is "a wire beats the Beat's BODY", not "a wire beats a node card" — a Scene
  // legitimately sits above a wire, and one may cover the midpoint depending on layout. So
  // sample along the wire's own path for a point over open Beat body and hit-test THERE.
  const open = await page.evaluate(
    ([sel, bx, by, bw, bh]) => {
      const path = document.querySelector<SVGPathElement>(`${sel} path.react-flow__edge-path`);
      if (!path) return null;
      const len = path.getTotalLength();
      for (let i = 1; i < 60; i++) {
        const p = path.getPointAtLength((len * i) / 60);
        const r = path.ownerSVGElement?.getBoundingClientRect();
        const m = path.getScreenCTM();
        if (!m || !r) return null;
        const x = m.a * p.x + m.c * p.y + m.e;
        const y = m.b * p.x + m.d * p.y + m.f;
        const inBeat = x > (bx as number) && x < (bx as number) + (bw as number) && y > (by as number) && y < (by as number) + (bh as number);
        if (!inBeat) continue;
        const el = document.elementFromPoint(x, y);
        if (el?.closest(".react-flow__node:not([data-id='beat-1'])")) continue; // a card, not the body
        return { x, y, edge: !!el?.closest(".react-flow__edge") };
      }
      return null;
    },
    ['.react-flow__edge[data-id="lg:sc-02:out:LAST FRAME->sc-03:in:IN FRAME"]', beat.x, beat.y, beat.width, beat.height] as const,
  );
  expect(open, "found a stretch of wire over open Beat body").not.toBeNull();
  expect(open?.edge, "the wire is under the pointer, above the Beat body").toBe(true);

  await page.mouse.move(mx, my);
  await expect(mid).toHaveCSS("opacity", "1");
  await page.mouse.click(mx, my);
  await expect(mid).toHaveClass(/is-open/);
  await expect(page.locator(".bd-edge-menu")).toBeVisible();

  // Selection does not reshuffle the stack: select the Beat by its body, the wire still wins.
  await page.keyboard.press("Escape");
  await page.mouse.click(beat.x + beat.width * 0.85, beat.y + beat.height * 0.2);
  const still = await hit(page, open!.x, open!.y);
  expect(still.edge, "still the wire after selecting the Beat").toBe(true);

  // A picture of all of it: resized scene, selected Beat, open wire menu.
  const sc = await nodeBox(page, "sc-01");
  await dragMouse(page, { x: sc.x + sc.width - 5, y: sc.y + sc.height - 5 }, { x: sc.x + sc.width + 60, y: sc.y + sc.height + 30 });
  await page.mouse.move(mx, my);
  await page.mouse.click(mx, my);
  await expect(page.locator(".bd-edge-menu")).toBeVisible();
  await shot(page, "u1-stability");
});
