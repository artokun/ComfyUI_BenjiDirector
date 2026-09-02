import { expect, test, type Page } from "@playwright/test";
import { drive, shot, waitForDemo } from "./helpers.js";

// U9 — the markdown sticky note and the widget kit on a collapsed Beat's face.
//
// The harness mounts the editor with no `renderMarkdown`, so a note renders the FALLBACK:
// escaped text with line breaks. The "rendered on blur" check therefore looks for the text
// and the <br>, not an <h1> — the <h1> is the panel's marked + DOMPurify, not ours to test here.

const OVERLAYS = ".react-flow__node, .react-flow__edge, .bd-toolbar, .bd-palette, .bd-dock, .react-flow__controls, .bd-panel-host";

/** A screen point on bare canvas: on the pane, under nothing drawn over it. */
async function emptyCanvasPoint(page: Page): Promise<{ x: number; y: number }> {
  const pane = await page.locator(".react-flow__pane").boundingBox();
  if (!pane) throw new Error("no pane");
  const spots: [number, number][] = [
    [0.14, 0.9],
    [0.5, 0.93],
    [0.9, 0.1],
    [0.06, 0.55],
    [0.94, 0.9],
    [0.3, 0.75],
    [0.5, 0.5],
  ];
  for (const [fx, fy] of spots) {
    const x = Math.round(pane.x + pane.width * fx);
    const y = Math.round(pane.y + pane.height * fy);
    const bare = await page.evaluate(
      ({ px, py, sel }) => {
        const el = document.elementFromPoint(px, py);
        return !!el && !el.closest(sel);
      },
      { px: x, py: y, sel: OVERLAYS },
    );
    if (bare) return { x, y };
  }
  throw new Error("no bare canvas point in view");
}

const durationOf = async (page: Page, id: string) => (await drive<{ durationSec: number }>(page, "read_node", { id })).durationSec;

test("a note: placed from the palette, written by hand, rendered on blur, resized by its grip", async ({ page }) => {
  await waitForDemo(page);
  const at = await emptyCanvasPoint(page);
  await page.mouse.click(at.x, at.y, { button: "right" });
  const palette = page.locator(".bd-palette");
  await expect(palette).toBeVisible();
  await palette.locator(".bd-palette-item", { hasText: "Note" }).click();

  const note = page.locator(".react-flow__node-note").first();
  await expect(note).toBeVisible();
  await expect(note.locator(".bd-sticky-empty")).toBeVisible();

  // Double-click opens the editor; typing is per keystroke, the real path.
  await note.locator(".bd-sticky-view").dblclick();
  const ta = note.locator("textarea.bd-sticky-edit");
  await expect(ta).toBeVisible();
  await expect(ta).toBeFocused();
  await ta.pressSequentially("# Plan\n- shot list");

  // Blur by clicking bare canvas. The view then renders from the GRAPH, not the textarea.
  const away = await emptyCanvasPoint(page);
  await page.mouse.click(away.x, away.y);
  await expect(ta).toHaveCount(0);
  const md = note.locator(".bd-sticky-md");
  await expect(md).toContainText("# Plan");
  await expect(md).toContainText("- shot list");
  expect(await md.innerHTML()).toContain("<br>");

  const outline = await drive<{ nodes: { id: string; kind?: string; text?: string }[] }>(page, "outline");
  const row = outline.nodes.find((n) => n.kind === "note");
  expect(row?.text).toBe("# Plan\n- shot list");
  const id = row?.id ?? "";

  // The dog-ear grip writes node.width / node.height.
  const before = await drive<{ width?: number; height?: number }>(page, "read_node", { id });
  const grip = note.locator(".bd-sticky-grip");
  const gb = await grip.boundingBox();
  if (!gb) throw new Error("no grip");
  await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2);
  await page.mouse.down();
  await page.mouse.move(gb.x + gb.width / 2 + 120, gb.y + gb.height / 2 + 80, { steps: 8 });
  await page.mouse.up();
  const after = await drive<{ width?: number; height?: number }>(page, "read_node", { id });
  expect((after.width ?? 0) - (before.width ?? 0)).toBeGreaterThan(60);
  expect((after.height ?? 0) - (before.height ?? 0)).toBeGreaterThan(40);

  // Frame everything before the shot — a note dropped at the edge of the pane hangs off the
  // bottom of the picture, and the picture is the point.
  await page.locator(".react-flow__controls-fitview").click();
  await expect(note).toBeInViewport();
  await shot(page, "u9-note-widgets");
});

test("a pinned scene's duration is a RangeControl on the collapsed Beat's face; a pinned note shows its first line", async ({ page }) => {
  await waitForDemo(page);
  await drive(page, "promote", { id: "beat-1" });
  await drive(page, "set_pin", { id: "sc-01", promoted: true });
  const made = await drive<{ id: string }>(page, "add_note", { x: 540, y: 290, text: "## Shot list\n- crane in\n- hold" });
  expect((await drive<{ parentId: string | null }>(page, "read_node", { id: made.id })).parentId).toBe("beat-1");
  await drive(page, "set_pin", { id: made.id, promoted: true });
  await drive(page, "set_collapsed", { id: "beat-1", collapsed: true });

  const beat = page.locator('.react-flow__node[data-id="beat-1"]');
  const face = beat.locator('.bd-face[data-face="sc-01"]');
  await expect(face).toBeVisible();
  await expect(face.locator(".bd-face-label")).toHaveText("SC-01 · Nadia climbs out");
  await expect(beat.locator(`.bd-face[data-face="${made.id}"]`)).toContainText("Shot list");

  expect(await durationOf(page, "sc-01")).toBe(6);
  const beatBefore = await drive<{ position: { x: number; y: number } }>(page, "read_node", { id: "beat-1" });

  // A real slide along the track — past the value label, so it is a drag and not a click.
  const track = face.locator(".bd-range-track");
  const tb = await track.boundingBox();
  if (!tb) throw new Error("no track");
  await page.mouse.move(tb.x + tb.width * 0.6, tb.y + tb.height / 2);
  await page.mouse.down();
  await page.mouse.move(tb.x + tb.width * 0.9, tb.y + tb.height / 2, { steps: 6 });
  await page.mouse.up();
  const slid = await durationOf(page, "sc-01");
  expect(slid).toBeGreaterThan(45);
  expect(slid).toBeLessThanOrEqual(60);
  // The slide never reached the node: the Beat did not move.
  const beatAfter = await drive<{ position: { x: number; y: number } }>(page, "read_node", { id: "beat-1" });
  expect(beatAfter.position).toEqual(beatBefore.position);

  // Typing goes through the same clamp; a ± click keeps the whole second the old face stepper
  // moved by, even though the pointer snaps to the half.
  await face.locator(".bd-range-val").click();
  const input = face.locator("input.bd-range-edit");
  await expect(input).toBeVisible();
  await input.fill("999");
  await input.press("Enter");
  expect(await durationOf(page, "sc-01")).toBe(60);
  await face.locator('.bd-range-step[aria-label="decrease"]').click();
  expect(await durationOf(page, "sc-01")).toBe(59);
  await expect(face.locator(".bd-range-val")).toHaveText("59s");

  await shot(page, "u9-note-widgets-face");
});

test("add_note / set_note drive the note the way the mouse does", async ({ page }) => {
  await waitForDemo(page);
  const made = await drive<{ id: string; label: string }>(page, "add_note", { x: 900, y: 40, text: "hello" });
  expect(made.id).toMatch(/^note-/);
  const card = page.locator(`.react-flow__node[data-id="${made.id}"]`);
  await expect(card.locator(".bd-sticky-md")).toHaveText("hello");

  await drive(page, "set_note", { id: made.id, text: "line one\nline two" });
  const row = await drive<{ kind: string; text: string }>(page, "read_node", { id: made.id });
  expect(row.kind).toBe("note");
  expect(row.text).toBe("line one\nline two");
  await expect(card.locator(".bd-sticky-md")).toContainText("line two");

  await expect(drive(page, "set_note", { id: "sc-01", text: "x" })).rejects.toThrow(/not a note/);
  await expect(drive(page, "set_note", { id: made.id, text: 5 })).rejects.toThrow(/text must be a string/);
  await expect(drive(page, "add_note", { x: 0, y: 0, text: 5 })).rejects.toThrow(/text must be a string/);
});
