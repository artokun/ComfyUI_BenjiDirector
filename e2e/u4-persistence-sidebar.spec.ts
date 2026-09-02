import { expect, test, type Page } from "@playwright/test";
import { drive, shot, waitForDemo } from "./helpers.js";

// U4 — the left sidebar and everything it persists.
//
// The harness is the demo project with no Calliope, which is exactly the state the autosave
// covers (`projectId === null`), so every path here is the real one.

const nodeCount = (page: Page) => drive<{ nodes: unknown[] }>(page, "outline").then((o) => o.nodes.length);

/**
 * Start on the demo with nothing remembered.
 *
 * Deliberately NOT `addInitScript`: that re-runs on every navigation, including the reload the
 * last test is measuring, so it would wipe the very autosave under test before the app booted.
 * Clear once, then let `waitForDemo`'s own navigation boot the editor against empty storage.
 */
async function freshCanvas(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(() => {
    try {
      window.localStorage.removeItem("benjidirector/graph");
      window.localStorage.removeItem("benjidirector/saves");
    } catch {
      /* a private window still runs the editor, just without persistence */
    }
  });
  await waitForDemo(page);
}

test("the sidebar is there, with its io bars, node list and blueprints", async ({ page }) => {
  await freshCanvas(page);
  const side = page.locator(".bd-u4-side");
  await expect(side).toBeVisible();
  await expect(side.locator(".bd-u4-io-label")).toHaveText(["Export", "Import", "Saves"]);
  await expect(side.locator(".bd-u4-rule")).toHaveText(["Nodes", "Blueprints", "Canvas"]);
  // Scenes / Assets / Helpers, and every palette kind reachable under them.
  await expect(side.locator(".bd-u4-acc-head .bd-u4-acc-name")).toHaveText(["Scenes", "Assets", "Helpers"]);
  await expect(side.locator(".bd-u4-node[data-kind]")).toHaveCount(5);
  await shot(page, "u4-persistence-sidebar");
});

test("a Scene dragged from the NODES list lands on the canvas", async ({ page }) => {
  await freshCanvas(page);
  expect(await nodeCount(page)).toBe(6);

  const item = page.locator('.bd-u4-node[data-kind="scene"]');
  const canvas = page.locator(".bd-canvas");
  const from = await item.boundingBox();
  const to = await canvas.boundingBox();
  if (!from || !to) throw new Error("no sidebar item or canvas box");

  // A real HTML5 drag: Playwright's mouse does not synthesise dragstart/drop, so the
  // DataTransfer is built in the page and dispatched at the two ends the editor listens on.
  const dropX = to.x + to.width * 0.62;
  const dropY = to.y + to.height * 0.72;
  await page.evaluate(
    ([sx, sy, dx, dy]) => {
      const source = document.querySelector('.bd-u4-node[data-kind="scene"]');
      const target = document.querySelector(".bd-canvas");
      if (!source || !target) throw new Error("nothing to drag");
      const dt = new DataTransfer();
      source.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: sx, clientY: sy }));
      target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: dx, clientY: dy }));
      target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: dx, clientY: dy }));
    },
    [from.x + from.width / 2, from.y + from.height / 2, dropX, dropY] as const,
  );

  await expect.poll(() => nodeCount(page)).toBe(7);
  await expect(page.locator(".react-flow__node")).toHaveCount(7);

  // The other half of the same list: click to drop one at the viewport centre.
  await page.locator('.bd-u4-node[data-kind="character"]').click();
  await expect.poll(() => nodeCount(page)).toBe(8);
  await expect(page.locator(".react-flow__node")).toHaveCount(8);
  await shot(page, "u4-persistence-sidebar-dropped");
});

test("save as “test”, clear to nothing, load it back", async ({ page }) => {
  await freshCanvas(page);
  await drive(page, "add_node", { kind: "scene", x: 900, y: 620 });
  await expect.poll(() => nodeCount(page)).toBe(7);

  // Saved through the sidebar's own popover, not the drive API: the UI is what is under test.
  await page.locator('.bd-u4-io-bar:has(.bd-u4-io-label:text-is("Saves")) .bd-u4-io').click();
  await page.getByLabel("Save current as").fill("test");
  await page.locator(".bd-u4-pop-new .bd-u4-io").click();
  await expect(page.locator(".bd-u4-save-load")).toHaveText(["test"]);
  await expect(page.locator(".bd-u4-flash.is-on")).toContainText("Saved");
  await shot(page, "u4-persistence-sidebar-saves");

  // Clear is two-click armed: one click asks, the second does it.
  const clear = page.getByRole("button", { name: "Clear canvas" });
  await clear.click();
  await expect(page.getByRole("button", { name: /Clear — sure\?/ })).toBeVisible();
  await page.getByRole("button", { name: /Clear — sure\?/ }).click();
  await expect.poll(() => nodeCount(page)).toBe(0);
  await expect(page.locator(".react-flow__node")).toHaveCount(0);

  await page.locator('.bd-u4-io-bar:has(.bd-u4-io-label:text-is("Saves")) .bd-u4-io').click();
  await page.locator(".bd-u4-save-load", { hasText: "test" }).click();
  await expect.poll(() => nodeCount(page)).toBe(7);
  await expect(page.locator(".react-flow__node")).toHaveCount(7);
  await shot(page, "u4-persistence-sidebar-loaded");

  // Deleting a save asks first, through the editor's own modal.
  await page.locator('.bd-u4-io-bar:has(.bd-u4-io-label:text-is("Saves")) .bd-u4-io').click();
  await page.getByRole("button", { name: "Delete save test" }).click();
  const dialog = page.locator(".bd-modal");
  await expect(dialog).toContainText("Delete the save “test”?");
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(page.locator(".bd-u4-pop .bd-u4-empty")).toContainText("No saved graphs yet.");
  // The canvas it was deleted from is untouched.
  expect(await nodeCount(page)).toBe(7);

  // The other armed button: back to the demo the editor ships with.
  await page.getByRole("button", { name: "Reset to demo" }).click();
  await page.getByRole("button", { name: /Reset — sure\?/ }).click();
  await expect.poll(() => nodeCount(page)).toBe(6);
  await expect(page.locator(".react-flow__node")).toHaveCount(6);
});

test("export to the clipboard and import it back", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await freshCanvas(page);

  await page.locator('.bd-u4-io-bar:has(.bd-u4-io-label:text-is("Export")) .bd-u4-io').first().click();
  await expect(page.locator(".bd-u4-flash.is-on")).toContainText("Copied");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(JSON.parse(copied)).toMatchObject({ version: 1 });

  await drive(page, "clear");
  await expect.poll(() => nodeCount(page)).toBe(0);

  await page.locator('.bd-u4-io-bar:has(.bd-u4-io-label:text-is("Import")) .bd-u4-io').first().click();
  await expect(page.locator(".bd-u4-flash.is-on")).toContainText("Imported");
  await expect.poll(() => nodeCount(page)).toBe(6);
  await expect(page.locator(".react-flow__node")).toHaveCount(6);

  // And a paste that is not a graph says so instead of emptying the canvas.
  await page.evaluate(() => navigator.clipboard.writeText("{not a graph"));
  await page.locator('.bd-u4-io-bar:has(.bd-u4-io-label:text-is("Import")) .bd-u4-io').first().click();
  await expect(page.locator(".bd-u4-flash.is-bad")).toContainText("Bad JSON");
  expect(await nodeCount(page)).toBe(6);
});

test("the working graph survives a reload", async ({ page }) => {
  await freshCanvas(page);
  await drive(page, "add_node", { kind: "character", x: 60, y: 560, label: "Autosaved Ada" });
  await expect.poll(() => nodeCount(page)).toBe(7);
  // The debounce is 600 ms; a hidden tab flushes immediately, which is the path a real reload
  // takes too.
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("benjidirector/graph")?.includes("Autosaved Ada") ?? false), { timeout: 5000 })
    .toBe(true);

  await page.reload();
  await page.locator(".react-flow__node").nth(6).waitFor();
  await expect.poll(() => nodeCount(page)).toBe(7);
  const restored = await drive<{ nodes: { label: string }[] }>(page, "outline");
  expect(restored.nodes.map((n) => n.label)).toContain("Autosaved Ada");
  await shot(page, "u4-persistence-sidebar-restored");
});
