import { expect, test, type Page } from "@playwright/test";
import { drive, shot, waitForDemo } from "./helpers.js";

// The dopesheet and the card bodies, driven through the real DOM. The demo film is
// SC-01 (6s) and SC-02 (4s) inside Beat 1, then SC-03 (8s) loose: 18 seconds in three clips.

// A clip is drawn once on the film track and again on its Beat's, so every locator names the
// ROW it means — that duplication is the point of the sheet, not an accident to work around.
const clip = (page: Page, id: string, row = "film") => page.locator(`.bd-tl-row[data-row="${row}"] .bd-tl-clip[data-clip="${id}"]`);
const box = async (page: Page, id: string, row = "film") => {
  const b = await clip(page, id, row).boundingBox();
  if (!b) throw new Error(`no clip box for ${id} on ${row}`);
  return b;
};

interface Sheet {
  duration: number;
  durationClock: string;
  mutedSec: number;
  cut: string[];
  rows: { id: string; kind: string; label: string; start: number; end: number; clips: string[] }[];
  clips: { id: string; row: string; cut: number; seconds: number; start: number }[];
}

test("the sheet is the film: a master track, and a shorter one per Beat", async ({ page }) => {
  await waitForDemo(page);
  const tl = page.getByTestId("timeline");
  await expect(tl).toBeVisible();
  await expect(page.getByTestId("timeline-total")).toHaveText("0:18");

  // The rows read the same as the canvas: everything, then the Beat, then what has no Beat.
  await expect(page.locator("[data-rowhead]")).toHaveCount(3);
  await expect(page.locator('[data-rowhead="film"]')).toContainText("Film");
  await expect(page.locator('[data-rowhead="beat-1"]')).toContainText("Beat 1");
  await expect(page.locator('[data-rowhead="loose"]')).toContainText("No Beat");

  // A Beat's row is SHORTER than the film's, and sits where its scenes play.
  const sheet = await drive<Sheet>(page, "timeline");
  expect(sheet.duration).toBe(18);
  expect(sheet.rows.map((r) => [r.id, r.start, r.end])).toEqual([
    ["film", 0, 18],
    ["beat-1", 0, 10],
    ["loose", 10, 18],
  ]);
  expect(sheet.cut).toEqual(["sc-01", "sc-02", "sc-03"]);

  // Every clip is drawn once per row it belongs to: three on the film track, two on the Beat.
  await expect(page.locator('.bd-tl-row[data-row="film"] .bd-tl-clip')).toHaveCount(3);
  await expect(page.locator('.bd-tl-row[data-row="beat-1"] .bd-tl-clip')).toHaveCount(2);
  await shot(page, "u21-timeline");
});

test("the row labels stay with their rows when the sheet is scrolled", async ({ page }) => {
  // A short dock, so three rows do not fit and the sheet has to scroll. The gutter and the
  // track are ONE scroller; two would keep their own scrollTop and the labels would drift off
  // the rows they name the moment a film had more Beats than the dock is tall.
  await page.addInitScript(() => {
    try {
      localStorage.setItem("benjidirector/timeline", JSON.stringify({ height: 100, open: true, pps: null }));
    } catch {
      /* the assertion below fails loudly if the seed did not take */
    }
  });
  await waitForDemo(page);

  const mid = async (sel: string) => {
    const b = await page.locator(sel).boundingBox();
    if (!b) throw new Error(`no box for ${sel}`);
    return b.y + b.height / 2;
  };
  const body = page.locator(".bd-tl-body");
  await expect(body).toBeVisible();
  const scrolled = await body.evaluate((el) => {
    el.scrollTop = 60;
    return el.scrollTop;
  });
  expect(scrolled, "the sheet actually scrolls at this height").toBeGreaterThan(0);

  for (const row of ["film", "beat-1", "loose"]) {
    expect(Math.abs((await mid(`[data-rowhead="${row}"]`)) - (await mid(`.bd-tl-row[data-row="${row}"]`))), `${row} label sits on its row`).toBeLessThan(2);
  }
});

test("clicking a clip selects its node, and the canvas selection lights the clip", async ({ page }) => {
  await waitForDemo(page);
  const first = page.locator('.bd-tl-row[data-row="film"] .bd-tl-clip[data-clip="sc-02"]');
  await first.click();
  await expect(page.locator('.react-flow__node[data-id="sc-02"]')).toHaveClass(/selected/);
  await expect(first).toHaveClass(/is-on/);

  // …and the other direction: selecting on the canvas lights the clip, because both read one
  // selection rather than keeping their own.
  await drive(page, "select", { ids: ["sc-03"] });
  await expect(page.locator('.bd-tl-row[data-row="film"] .bd-tl-clip[data-clip="sc-03"]')).toHaveClass(/is-on/);
  await expect(first).not.toHaveClass(/is-on/);
});

test("dragging a clip's right edge re-times the scene, and the film gets longer", async ({ page }) => {
  await waitForDemo(page);
  const before = await box(page, "sc-01");
  const pps = before.width / 6; // the clip is 6 seconds wide

  // Grab the handle inside the clip's right edge and pull it four seconds further.
  const handle = page.locator('.bd-tl-row[data-row="film"] .bd-tl-clip[data-clip="sc-01"] .bd-tl-handle');
  const hb = await handle.boundingBox();
  if (!hb) throw new Error("no handle");
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2 + pps * 4, hb.y + hb.height / 2, { steps: 8 });
  await page.mouse.up();

  await expect.poll(() => drive<{ durationSec: number }>(page, "read_node", { id: "sc-01" }).then((n) => n.durationSec)).toBe(10);
  // The whole film follows, because a start is the sum of what plays before it.
  await expect(page.getByTestId("timeline-total")).toHaveText("0:22");
  const sheet = await drive<Sheet>(page, "timeline");
  expect(sheet.clips.map((c) => [c.id, c.start])).toEqual([
    ["sc-01", 0],
    ["sc-02", 10],
    ["sc-03", 14],
  ]);
});

test("dragging a clip onto another row moves the scene into that Beat", async ({ page }) => {
  await waitForDemo(page);
  expect((await drive<{ parentId: string | null }>(page, "read_node", { id: "sc-03" })).parentId).toBeNull();

  const from = await box(page, "sc-03");
  const target = await page.locator('.bd-tl-row[data-row="beat-1"]').boundingBox();
  if (!target) throw new Error("no beat row");
  await page.mouse.move(from.x + 8, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 8, target.y + target.height / 2, { steps: 10 });
  await page.mouse.up();

  await expect.poll(() => drive<{ parentId: string | null }>(page, "read_node", { id: "sc-03" }).then((n) => n.parentId)).toBe("beat-1");
  // The canvas agrees: the card is inside the Beat, not merely drawn over it.
  await expect(page.locator('.react-flow__node[data-id="beat-1"]')).toBeVisible();
  // With nothing loose left, the loose row goes.
  await expect(page.locator('[data-rowhead="loose"]')).toHaveCount(0);
});

test("the agent drives the same three verbs the pointer does", async ({ page }) => {
  await waitForDemo(page);

  expect(await drive(page, "set_duration", { id: "sc-02", seconds: 9 })).toEqual({ id: "sc-02", durationSec: 9 });
  await expect(page.getByTestId("timeline-total")).toHaveText("0:23");

  // A re-cut: SC-01 to the end. `to` counts the film WITHOUT the scene being moved.
  await drive(page, "reorder_scene", { id: "sc-01", to: 2 });
  await expect.poll(() => drive<Sheet>(page, "timeline").then((s) => s.cut)).toEqual(["sc-02", "sc-03", "sc-01"]);

  await drive(page, "move_to_beat", { id: "sc-03", beat: "beat-1" });
  await expect.poll(() => drive<{ parentId: string | null }>(page, "read_node", { id: "sc-03" }).then((n) => n.parentId)).toBe("beat-1");
  await drive(page, "move_to_beat", { id: "sc-03", beat: null });
  await expect.poll(() => drive<{ parentId: string | null }>(page, "read_node", { id: "sc-03" }).then((n) => n.parentId)).toBeNull();
});

test("the dock hides and comes back, and remembers which across a reload", async ({ page }) => {
  await waitForDemo(page);
  await page.locator(".bd-tl-caret").click();
  await expect(page.locator(".bd-tl.is-shut")).toBeVisible();
  await expect(page.locator("[data-rowhead]")).toHaveCount(0);

  await page.reload();
  await page.locator(".react-flow__node").nth(5).waitFor();
  await expect(page.locator(".bd-tl.is-shut")).toBeVisible();

  await page.locator(".bd-tl-toggle").click();
  await expect(page.getByTestId("timeline-total")).toHaveText("0:18");
});

// ── the card body ───────────────────────────────────────────────────────────────────────────

test("a scene card opens a body you can write in, and it writes on blur", async ({ page }) => {
  await waitForDemo(page);
  const card = page.locator('.react-flow__node[data-id="sc-01"]');
  await expect(card.locator(".bd-nb")).toHaveCount(0);

  await card.locator('[data-expander="sc-01"]').click();
  await expect(card.locator(".bd-nb")).toBeVisible();

  const action = card.locator('.bd-nb-field:has-text("Action") textarea');
  await action.fill("Nadia hauls herself over the parapet.");
  // Still local: the body writes on BLUR, not per keystroke.
  expect((await drive<{ action?: string }>(page, "read_node", { id: "sc-01" })).action ?? "").toBe("");
  await action.blur();
  await expect.poll(() => drive<{ action?: string }>(page, "read_node", { id: "sc-01" }).then((n) => n.action)).toBe("Nadia hauls herself over the parapet.");

  // The duration control on the card is the same value the sheet draws.
  await expect(card.locator(".bd-nb-range")).toBeVisible();
  await shot(page, "u21-node-body");

  await card.locator('[data-expander="sc-01"]').click();
  await expect(card.locator(".bd-nb")).toHaveCount(0);
});

test("expanding is exclusive with collapsing, and the agent can drive it", async ({ page }) => {
  await waitForDemo(page);
  await drive(page, "set_node_collapsed", { id: "sc-02", collapsed: true });
  await expect(page.locator('.react-flow__node[data-id="sc-02"] .bd-nb-toggle')).toHaveCount(0);

  // Opening the body opens the card: the two states cannot both be on, or the header would
  // have a body hanging off it.
  expect(await drive(page, "set_expanded", { id: "sc-02", expanded: true })).toEqual({ id: "sc-02", expanded: true });
  const n = await drive<{ collapsed?: boolean; expanded?: boolean }>(page, "read_node", { id: "sc-02" });
  expect(n.collapsed).toBeFalsy();
  await expect(page.locator('.react-flow__node[data-id="sc-02"] .bd-nb')).toBeVisible();

  // No argument toggles.
  expect(await drive(page, "set_expanded", { id: "sc-02" })).toEqual({ id: "sc-02", expanded: false });
  await expect(page.locator('.react-flow__node[data-id="sc-02"] .bd-nb')).toHaveCount(0);
});

test("an asset card's body edits the prompt every render of it reuses", async ({ page }) => {
  await waitForDemo(page);
  const card = page.locator('.react-flow__node[data-id="char-nadia"]');
  await card.locator('[data-expander="char-nadia"]').click();
  const field = card.locator(".bd-nb-input");
  await expect(field).toBeVisible();
  await field.fill("late twenties, cropped dark hair, grey jacket");
  await field.blur();
  await expect.poll(() => drive<{ consistencyPrompt?: string }>(page, "read_node", { id: "char-nadia" }).then((n) => n.consistencyPrompt)).toBe(
    "late twenties, cropped dark hair, grey jacket",
  );
});
