import { expect, test } from "@playwright/test";

// The harness mounts the editor with the DEMO project and no Calliope. This is the floor every
// unit's spec builds on: the canvas lays out (a headless page is visible, so React Flow
// measures), the wires render, and the drive API is reachable at `window.__director`.

test("demo project renders nodes, wires and the drive API", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".react-flow__node")).toHaveCount(6);
  await expect.poll(async () => page.locator(".react-flow__edge").count()).toBeGreaterThanOrEqual(4);
  await expect(page.locator(".bd-toolbar")).toBeVisible();

  const outline = (await page.evaluate(() => (window as unknown as { __director: { drive(n: string): Promise<unknown> } }).__director.drive("outline"))) as { nodes: unknown[]; edges: unknown[] };
  expect(outline.nodes.length).toBe(6);
  expect(outline.edges.length).toBeGreaterThanOrEqual(4);

  await page.screenshot({ path: "out/smoke.png", fullPage: true });
});

type Drive = { drive(n: string, a?: unknown): Promise<unknown> };
const drive = (page: import("@playwright/test").Page, name: string, args?: unknown) =>
  page.evaluate(([n, a]) => (window as unknown as { __director: Drive }).__director.drive(n as string, a), [name, args] as const);

test("dragging a COLLAPSED Beat keeps its children inside", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".react-flow__node")).toHaveCount(6);
  await drive(page, "promote", { id: "beat-1" });
  await drive(page, "set_collapsed", { id: "beat-1", collapsed: true });
  await expect(page.locator('.react-flow__node[data-id="beat-1"] .bd-collapsed')).toBeVisible();
  const before = (await drive(page, "read_node", { id: "beat-1" })) as { position: { x: number; y: number } };
  // A real mouse drag of the collapsed card by its header.
  const head = page.locator('.react-flow__node[data-id="beat-1"] .bd-collapsed-head');
  const box = await head.boundingBox();
  if (!box) throw new Error("no collapsed head");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 220, box.y + box.height / 2 + 140, { steps: 10 });
  await page.mouse.up();
  const after = (await drive(page, "read_node", { id: "beat-1" })) as { position: { x: number; y: number } };
  expect(after.position.x - before.position.x).toBeGreaterThan(100);
  for (const id of ["sc-01", "sc-02"]) {
    const n = (await drive(page, "read_node", { id })) as { parentId: string | null };
    expect(n.parentId, `${id} stays in beat-1 while collapsed`).toBe("beat-1");
  }
  await drive(page, "set_collapsed", { id: "beat-1", collapsed: false });
  for (const id of ["sc-01", "sc-02"]) {
    const n = (await drive(page, "read_node", { id })) as { parentId: string | null };
    expect(n.parentId, `${id} still in beat-1 after expanding`).toBe("beat-1");
  }
});

test("a Beat is picked up by its title bar and resized by its corner", async ({ page }) => {
  await page.goto("/");
  const beat = page.locator('.react-flow__node[data-id="beat-1"]');
  await expect(beat).toBeVisible();
  const title = beat.locator(".bd-group-title");
  await title.click();
  await expect(beat.locator(".react-flow__resize-control.handle")).toHaveCount(4);
  const box = await beat.boundingBox();
  if (!box) throw new Error("no beat box");
  const before = await page.evaluate(() => (window as unknown as { __director: { drive(n: string, a: unknown): Promise<{ width?: number; height?: number }> } }).__director.drive("read_node", { id: "beat-1" }));
  await page.mouse.move(box.x + box.width - 2, box.y + box.height - 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width + 80, box.y + box.height + 60, { steps: 8 });
  await page.mouse.up();
  const after = await page.evaluate(() => (window as unknown as { __director: { drive(n: string, a: unknown): Promise<{ width?: number; height?: number }> } }).__director.drive("read_node", { id: "beat-1" }));
  expect((after.width ?? 0) - (before.width ?? 0)).toBeGreaterThan(40);
});
