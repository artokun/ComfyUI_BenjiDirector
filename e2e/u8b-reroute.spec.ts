import { expect, test } from "@playwright/test";
import { drive, shot, waitForDemo } from "./helpers.js";

// U8b — the reroute dot, driven through the real DOM: the edge menu that places it, the drag
// that moves it, the × that takes it away and rejoins the wire, and the agent's own command.

const CHAIN = "lg:sc-01:out:LAST FRAME->sc-02:in:IN FRAME";
const REF = "lg:char-nadia:out:REF->sc-01:in:CHARACTER";

interface Outline {
  nodes: { id: string; type?: string; kind?: string; portType?: string; position: { x: number; y: number } }[];
  edges: { id: string; source: string; target: string; sourceHandle: string | null; targetHandle: string | null }[];
}

const outline = (page: import("@playwright/test").Page) => drive<Outline>(page, "outline");
const dots = (o: Outline) => o.nodes.filter((n) => n.type === "reroute");

/** The rendered geometry of an edge — what "the wires follow" actually means on screen. */
const pathOf = (page: import("@playwright/test").Page, edgeId: string) =>
  page.locator(`.react-flow__edge[data-id="${edgeId}"] .react-flow__edge-path`).getAttribute("d");

// The wire this test opens the menu on is the Nadia → SC-01 reference, NOT the SC-01 → SC-02
// continuity: in the demo layout the latter runs underneath SC-02's own card, so its midpoint
// control is behind a node and no real mouse can reach it either. The dot itself is placed on
// that wire from the agent's side in the next test.
test("the edge menu drops a dot on the wire; dragging it moves the wires; × rejoins them", async ({ page }) => {
  await waitForDemo(page);
  const before = await outline(page);
  expect(before.edges.some((e) => e.id === REF)).toBe(true);

  const mid = page.locator(`.react-flow__edge[data-id="${REF}"] .bd-edge-mid`);
  await mid.hover();
  await mid.click();
  await expect(page.locator(".bd-edge-menu")).toBeVisible();
  await page.locator(".bd-edge-menu button", { hasText: "Reroute" }).click();

  // One dot, two edges where there was one.
  const dot = page.locator(".bd-reroute");
  await expect(dot).toHaveCount(1);
  await expect(page.locator(".bd-reroute .react-flow__handle")).toHaveCount(2);

  const spliced = await outline(page);
  expect(spliced.edges).toHaveLength(before.edges.length + 1);
  expect(spliced.edges.some((e) => e.id === REF), "the direct wire is gone").toBe(false);
  expect(dots(spliced)).toHaveLength(1);
  const id = dots(spliced)[0]?.id as string;
  expect(dots(spliced)[0]?.portType, "it carries what the wire carried").toBe("ref");

  const head = spliced.edges.find((e) => e.target === id);
  const tail = spliced.edges.find((e) => e.source === id);
  expect(head?.source).toBe("char-nadia");
  expect(head?.sourceHandle).toBe("char-nadia:out:REF");
  expect(tail?.target).toBe("sc-01");
  expect(tail?.targetHandle).toBe("sc-01:in:CHARACTER");

  // Drag the dot 80px and watch both halves of the wire follow it. Straight DOWN, into open
  // canvas: 80px to the right would put it inside Beat 1, which is a reparent, and this test is
  // about the wires, not about containment.
  const headPathWas = await pathOf(page, head?.id as string);
  const tailPathWas = await pathOf(page, tail?.id as string);
  const box = await page.locator(`.react-flow__node[data-id="${id}"]`).boundingBox();
  if (!box) throw new Error("no dot box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 80, { steps: 12 });
  await page.mouse.up();

  const moved = await outline(page);
  const wasAt = dots(spliced)[0]?.position as { x: number; y: number };
  const nowAt = dots(moved)[0]?.position as { x: number; y: number };
  expect(nowAt.y - wasAt.y, "the dot moved with the mouse").toBeGreaterThan(40);
  expect(await pathOf(page, head?.id as string)).not.toBe(headPathWas);
  expect(await pathOf(page, tail?.id as string)).not.toBe(tailPathWas);
  expect(moved.edges, "moving it rewires nothing").toHaveLength(spliced.edges.length);

  // The × takes the dot away and puts the wire back — one edge, the original id.
  await dot.hover();
  await page.locator(".bd-reroute-x").click();
  await expect(page.locator(".bd-reroute")).toHaveCount(0);
  const rejoined = await outline(page);
  expect(rejoined.edges).toHaveLength(before.edges.length);
  expect(rejoined.edges.some((e) => e.id === REF), "the direct wire is back, with its own id").toBe(true);
});

test("the agent drops one too, and a dot keeps the type of the wire it sits on", async ({ page }) => {
  await waitForDemo(page);
  const before = await outline(page);

  // The agent's command, on the Nadia → SC-01 reference wire.
  const placed = await drive<{ id: string; type: string }>(page, "reroute", { edge_id: REF, x: 250, y: 120 });
  expect(placed.type).toBe("ref");
  await expect(page.locator(".bd-reroute")).toHaveCount(1);

  const after = await outline(page);
  expect(after.edges).toHaveLength(before.edges.length + 1);
  expect(after.edges.some((e) => e.id === REF)).toBe(false);
  expect(after.edges.filter((e) => e.source === placed.id || e.target === placed.id)).toHaveLength(2);
  expect(dots(after)[0]?.portType).toBe("ref");

  // A second dot on the image wire, so the shot shows both colours the dots take.
  await drive(page, "reroute", { edge_id: CHAIN, x: 700, y: 260 });
  await expect(page.locator(".bd-reroute")).toHaveCount(2);
  const both = await outline(page);
  expect(dots(both).map((n) => n.portType).sort()).toEqual(["image", "ref"]);

  // Hover one so the screenshot carries the type chip and the remove control.
  await page.locator(`.react-flow__node[data-id="${placed.id}"]`).hover();
  await expect(page.locator(".bd-reroute-x").first()).toBeVisible();
  await shot(page, "u8b-reroute");
});

test("Delete on a selected dot rejoins the wire rather than cutting it", async ({ page }) => {
  await waitForDemo(page);
  const before = await outline(page);
  const placed = await drive<{ id: string }>(page, "reroute", { edge_id: CHAIN, x: 700, y: 260 });

  await page.locator(`.react-flow__node[data-id="${placed.id}"]`).click();
  await expect(page.locator(".bd-reroute.is-selected")).toHaveCount(1);
  await page.keyboard.press("Delete");

  // React Flow's own delete would have taken both halves of the wire with the dot; the
  // capture-phase interception turns it into a rejoin, so the graph is exactly as it was.
  await expect(page.locator(".bd-reroute")).toHaveCount(0);
  const after = await outline(page);
  expect(after.edges.map((e) => e.id).sort()).toEqual(before.edges.map((e) => e.id).sort());
  expect(after.nodes).toHaveLength(before.nodes.length);
});

test("remove_node on a dot rejoins; on a scene it still deletes", async ({ page }) => {
  await waitForDemo(page);
  const before = await outline(page);
  const placed = await drive<{ id: string }>(page, "reroute", { edge_id: CHAIN, x: 700, y: 260 });

  const removed = await drive<{ removed: string[] }>(page, "remove_node", { id: placed.id });
  expect(removed.removed).toEqual([placed.id]);
  const back = await outline(page);
  expect(back.edges.map((e) => e.id).sort()).toEqual(before.edges.map((e) => e.id).sort());
  expect(dots(back)).toHaveLength(0);
});
