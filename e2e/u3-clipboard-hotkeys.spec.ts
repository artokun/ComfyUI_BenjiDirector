import { expect, test, type Page } from "@playwright/test";
import { drive, shot, waitForDemo } from "./helpers.js";

// U3 — clipboard, duplicate, hotkeys, help. Drives the REAL keyboard against the demo project:
// the hook only answers while the pointer is over the pane, so every chord is preceded by a
// mouse move onto empty canvas (bottom-left, away from the Beat's box).

interface Summary {
  id: string;
  label?: string;
  heading?: string;
  parentId: string | null;
}
const outline = (page: Page) => drive<{ nodes: Summary[] }>(page, "outline");
const SC01 = "SC-01 · Nadia climbs out";

/** Put the pointer on empty canvas so the hotkey scope (hover) holds and a paste has an anchor. */
async function hoverCanvas(page: Page, fx = 0.12, fy = 0.88): Promise<void> {
  const box = await page.locator(".bd-canvas").boundingBox();
  if (!box) throw new Error("no canvas");
  await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy);
}

test("select, copy, paste, duplicate and undo from the keyboard", async ({ page }) => {
  await waitForDemo(page);
  await drive(page, "select", { ids: ["sc-01"] });
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(1);
  await expect(page.locator('.react-flow__node.selected[data-id="sc-01"]')).toBeVisible();

  await hoverCanvas(page);
  await page.keyboard.press("Control+c");
  await expect(page.locator(".bd-note")).toContainText("copied 1 node");
  await hoverCanvas(page, 0.2, 0.9);
  await page.keyboard.press("Control+v");
  await expect(page.locator(".react-flow__node")).toHaveCount(7);

  const after = await outline(page);
  const copies = after.nodes.filter((n) => n.heading === SC01);
  expect(copies).toHaveLength(2);
  const pasted = copies.find((n) => n.id !== "sc-01");
  expect(pasted, "the paste minted a new id").toBeTruthy();
  expect(pasted!.id.startsWith("sc-")).toBe(true);
  // The pasted node is the selection now, and it is not inside the Beat sc-01 lives in.
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(1);
  await expect(page.locator(`.react-flow__node.selected[data-id="${pasted!.id}"]`)).toBeVisible();
  expect(pasted!.parentId).toBeNull();

  // Ctrl+D duplicates the (pasted) selection without touching the clipboard.
  await hoverCanvas(page);
  await page.keyboard.press("Control+d");
  await expect(page.locator(".react-flow__node")).toHaveCount(8);
  expect((await outline(page)).nodes.filter((n) => n.heading === SC01)).toHaveLength(3);

  // Ctrl+Z walks both back.
  await page.keyboard.press("Control+z");
  await expect(page.locator(".react-flow__node")).toHaveCount(7);
  await page.keyboard.press("Control+z");
  await expect(page.locator(".react-flow__node")).toHaveCount(6);
  expect((await outline(page)).nodes.filter((n) => n.heading === SC01)).toHaveLength(1);
});

test("Delete removes the selection and Ctrl+Z brings it back (undo records the pre-delete graph)", async ({ page }) => {
  await waitForDemo(page);
  await drive(page, "select", { ids: ["sc-03"] });
  await hoverCanvas(page);
  await page.keyboard.press("Delete");
  await expect(page.locator(".react-flow__node")).toHaveCount(5);
  expect((await outline(page)).nodes.some((n) => n.id === "sc-03")).toBe(false);

  await page.keyboard.press("Control+z");
  await expect(page.locator(".react-flow__node")).toHaveCount(6);
  expect((await outline(page)).nodes.some((n) => n.id === "sc-03")).toBe(true);
  // The wire into sc-03 came back with it.
  const edges = await drive<{ edges: { target: string }[] }>(page, "outline");
  expect(edges.edges.some((e) => e.target === "sc-03")).toBe(true);
});

test("Ctrl+A selects everything, Esc clears; Ctrl+X cuts", async ({ page }) => {
  await waitForDemo(page);
  await hoverCanvas(page);
  await page.keyboard.press("Control+a");
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(6);
  await page.keyboard.press("Escape");
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(0);

  await drive(page, "select", { ids: ["loc-rooftop"] });
  await page.keyboard.press("Control+x");
  await expect(page.locator(".react-flow__node")).toHaveCount(5);
  await hoverCanvas(page, 0.5, 0.9);
  await page.keyboard.press("Control+v");
  await expect(page.locator(".react-flow__node")).toHaveCount(6);
  const o = await outline(page);
  const rooftop = o.nodes.filter((n) => n.label === "Rooftop, night");
  expect(rooftop).toHaveLength(1);
  expect(rooftop[0]!.id).not.toBe("loc-rooftop");
  expect(rooftop[0]!.id.startsWith("location-")).toBe(true);
});

test("Delete removes a selected WIRE too (React Flow's own delete key is off)", async ({ page }) => {
  await waitForDemo(page);
  const before = await page.locator(".react-flow__edge").count();
  // Click the wire 30% along its path — its MIDPOINT is the edge-menu control, which stops
  // propagation, so a bounding-box click there opens the menu instead of selecting the wire.
  const pt = await page.evaluate(() => {
    const path = document.querySelector(".react-flow__edge .react-flow__edge-path") as SVGPathElement | null;
    const m = path?.getScreenCTM();
    if (!path || !m) return null;
    const p = path.getPointAtLength(path.getTotalLength() * 0.3);
    return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
  });
  if (!pt) throw new Error("no edge path to click");
  await page.mouse.click(pt.x, pt.y);
  await expect(page.locator(".react-flow__edge.selected")).toHaveCount(1);
  await hoverCanvas(page);
  await page.keyboard.press("Delete");
  await expect(page.locator(".react-flow__edge")).toHaveCount(before - 1);
  await expect(page.locator(".bd-note")).toContainText("deleted 1 wire");
  await page.keyboard.press("Control+z");
  await expect(page.locator(".react-flow__edge")).toHaveCount(before);
});

test("the drive commands: copy / paste / duplicate / select, and a Beat pastes with its scenes", async ({ page }) => {
  await waitForDemo(page);
  const copied = await drive<{ ids: string[] }>(page, "copy", { ids: ["beat-1"] });
  expect(copied.ids.sort()).toEqual(["beat-1", "sc-01", "sc-02"]);
  const pasted = await drive<{ ids: string[] }>(page, "paste", { x: 400, y: 700 });
  expect(pasted.ids).toHaveLength(3);
  await expect(page.locator(".react-flow__node")).toHaveCount(9);
  const o = await outline(page);
  const newBeat = pasted.ids.find((id) => id.startsWith("beat-"))!;
  for (const id of pasted.ids.filter((id) => id !== newBeat)) expect(o.nodes.find((n) => n.id === id)!.parentId).toBe(newBeat);

  const dup = await drive<{ ids: string[] }>(page, "duplicate", { ids: ["sc-03"] });
  expect(dup.ids).toHaveLength(1);
  await expect(page.locator(".react-flow__node")).toHaveCount(10);

  await drive(page, "select", { ids: [newBeat, "sc-03"] });
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(2);
  await drive(page, "select", { ids: [] });
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(0);

  await expect(drive(page, "paste", { x: "no" })).rejects.toThrow(/x must be a number/);
  await expect(drive(page, "copy", { ids: ["ghost"] })).rejects.toThrow(/no node "ghost"/);
});

test("the ? button opens the shortcuts sheet", async ({ page }) => {
  await waitForDemo(page);
  await page.locator(".bd-help-btn").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Shortcuts");
  await expect(dialog).toContainText("Duplicate");
  await expect(dialog).toContainText("rail");
  // The sheet fades in (bd-in, 200ms); shoot it settled so the PNG shows the real surface.
  await page.waitForTimeout(400);
  await shot(page, "u3-clipboard-hotkeys");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  // The `?` key opens it too, from the canvas.
  await hoverCanvas(page);
  await page.keyboard.press("Shift+?");
  await expect(page.getByRole("dialog")).toContainText("Shortcuts");
});
