import { expect, test } from "@playwright/test";
import { drive, shot, waitForDemo } from "./helpers.js";

// U7 — blueprints parity. Promote the demo Beat, give one of its rails a name, save it through
// the toolbar's own button and the modal, place it again from the library, update it, delete
// it with a confirm. The interesting assertion is the instance: nothing outside it comes
// along, so a rail labelled "Lead" on the copy can only be there because the blueprint
// carried the Beat's interface and pinned it back on.

type Rail = { id: string; label: string; forced?: boolean };
type NodeSummary = { id: string; type: string; blueprintId: string | null; promotedIn: Rail[]; promotedOut: Rail[] };
type Listed = { id: string; label: string; version: number; builtin: boolean; nodes: number };

test("save via the toolbar modal, apply, update, delete with confirm", async ({ page }) => {
  await waitForDemo(page);
  await drive(page, "promote", { id: "beat-1" });
  await drive(page, "set_rail_label", { id: "beat-1", port_id: "beat-1::sc-01:in:LOCATION", label: "Lead" });
  await expect(page.locator('.react-flow__node[data-id="beat-1"] .bd-pill-label', { hasText: "Lead" })).toBeVisible();

  // Select the Beat by its title so its toolbar shows, then its save button.
  const beat = page.locator('.react-flow__node[data-id="beat-1"]');
  await beat.locator(".bd-group-title").click();
  await page.locator('.bd-nodebar button[title="Save this Beat as a reusable blueprint"]').click();
  const dialog = page.locator(".bd-bp-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("input")).toHaveValue("Beat 1 — The approach");
  await dialog.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  await shot(page, "u7-blueprints");
  await dialog.locator("input").fill("Approach");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();

  const listed = await drive<Listed[]>(page, "list_blueprints");
  expect(listed.find((b) => b.id === "bp-approach")).toMatchObject({ label: "Approach", version: 1, builtin: false, nodes: 3 });
  expect(listed.find((b) => b.id === "bp-two-shot")).toMatchObject({ builtin: true });
  expect((await drive<NodeSummary>(page, "read_node", { id: "beat-1" })).blueprintId).toBe("bp-approach");

  // Place it. The copy is a subgraph, linked, selected, with the rail still called "Lead".
  const placed = await drive<{ id: string; blueprint: string; version: number }>(page, "apply_blueprint", { blueprint_id: "bp-approach", x: 900, y: 600 });
  expect(placed).toMatchObject({ blueprint: "bp-approach", version: 1 });
  const instance = page.locator(`.react-flow__node[data-id="${placed.id}"]`);
  await expect(instance.locator(".bd-pill-label", { hasText: "Lead" })).toBeVisible();
  await expect(instance).toHaveClass(/selected/);
  const inst = await drive<NodeSummary>(page, "read_node", { id: placed.id });
  expect(inst.type).toBe("subgraph");
  expect(inst.blueprintId).toBe("bp-approach");
  expect(inst.promotedIn.map((r) => r.label)).toEqual(["CHARACTER", "Lead"]);
  expect(inst.promotedOut.map((r) => r.label)).toEqual(["LAST FRAME"]);
  expect([...inst.promotedIn, ...inst.promotedOut].every((r) => r.forced)).toBe(true);
  expect(inst.promotedIn.map((r) => r.id)).toEqual([`${placed.id}::sc-01-${placed.id.slice("beat-1-".length)}:in:CHARACTER`, `${placed.id}::sc-01-${placed.id.slice("beat-1-".length)}:in:LOCATION`]);
  // The original is untouched: still wired to the outside, still "Lead".
  const original = await drive<NodeSummary>(page, "read_node", { id: "beat-1" });
  expect(original.promotedIn.map((r) => r.label)).toEqual(["CHARACTER", "Lead"]);

  // Update from the instance: the version moves, the instance re-links to it.
  const updated = await drive<{ blueprint_id: string; id: string; version: number }>(page, "update_blueprint", { blueprint_id: "bp-approach", id: placed.id });
  expect(updated).toMatchObject({ blueprint_id: "bp-approach", id: placed.id, version: 2 });
  expect((await drive<Listed[]>(page, "list_blueprints")).find((b) => b.id === "bp-approach")?.version).toBe(2);
  await expect(page.locator(".bd-note")).toContainText("updated blueprint “Approach” — v2");

  // Update with no id resolves through the link — but two Beats are linked now, so it must refuse.
  await expect(drive(page, "update_blueprint", { blueprint_id: "bp-approach" })).rejects.toThrow(/2 Beats are linked/);

  // Delete through the library menu, with the confirm.
  await page.locator(".bd-bpmenu-btn").click();
  const row = page.locator('.bd-bpmenu-row[data-blueprint="bp-approach"]');
  await expect(row).toContainText("v2");
  await expect(page.locator('.bd-bpmenu-row[data-blueprint="bp-two-shot"] button[title="Delete"]')).toHaveCount(0);
  await page.locator(".bd-bpmenu-pop").evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  await shot(page, "u7-blueprints-menu");
  // Place from the menu itself — the button computes a canvas position of its own.
  const beforePlace = (await drive<{ nodes: { id: string }[] }>(page, "outline")).nodes.length;
  await page.locator('.bd-bpmenu-row[data-blueprint="bp-two-shot"] button[title="Place on the canvas"]').click();
  await expect.poll(async () => (await drive<{ nodes: { id: string }[] }>(page, "outline")).nodes.length).toBe(beforePlace + 4);
  await expect(page.locator(".bd-bpmenu-pop")).toBeHidden();

  await page.locator(".bd-bpmenu-btn").click();
  await row.locator('button[title="Delete"]').click();
  const confirm = page.locator(".bd-modal");
  await expect(confirm).toContainText("Delete blueprint “Approach”?");
  await confirm.getByRole("button", { name: "Delete" }).click();
  await expect(confirm).toBeHidden();
  expect((await drive<Listed[]>(page, "list_blueprints")).some((b) => b.id === "bp-approach")).toBe(false);
  // The placed copies stay.
  await expect(instance).toBeVisible();

  // Built-ins are not the agent's to delete or update either.
  await expect(drive(page, "delete_blueprint", { blueprint_id: "bp-two-shot" })).rejects.toThrow(/ships with/);
  await expect(drive(page, "update_blueprint", { blueprint_id: "bp-two-shot", id: "beat-1" })).rejects.toThrow(/ships with/);
});

test("a linked Beat's save offers Update and Save as new; the drive delete needs no confirm", async ({ page }) => {
  await waitForDemo(page);
  await drive(page, "promote", { id: "beat-1" });
  await drive(page, "save_blueprint", { id: "beat-1", name: "Approach" });
  await expect.poll(async () => (await drive<Listed[]>(page, "list_blueprints")).some((b) => b.id === "bp-approach")).toBe(true);

  const beat = page.locator('.react-flow__node[data-id="beat-1"]');
  await beat.locator(".bd-group-title").click();
  await page.locator('.bd-nodebar button[title="Save this Beat as a reusable blueprint"]').click();
  const dialog = page.locator(".bd-bp-dialog");
  await expect(dialog).toContainText("Update blueprint");
  await expect(dialog.getByRole("button", { name: "Save as new" })).toBeVisible();
  await dialog.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  await shot(page, "u7-blueprints-update");
  await dialog.locator("input").fill("Approach B");
  await dialog.getByRole("button", { name: "Save as new" }).click();
  await expect(dialog).toBeHidden();
  const listed = await drive<Listed[]>(page, "list_blueprints");
  expect(listed.find((b) => b.id === "bp-approach")?.version).toBe(1);
  expect(listed.find((b) => b.id === "bp-approach-b")).toMatchObject({ label: "Approach B", version: 1 });
  expect((await drive<NodeSummary>(page, "read_node", { id: "beat-1" })).blueprintId).toBe("bp-approach-b");

  // Placing the built-in works and lands its authored rails.
  const two = await drive<{ id: string }>(page, "apply_blueprint", { blueprint_id: "bp-two-shot", x: 100, y: 700 });
  const summary = await drive<NodeSummary>(page, "read_node", { id: two.id });
  expect(summary.promotedIn.map((r) => r.label)).toEqual(["Lead-in"]);
  expect(summary.promotedOut.map((r) => r.label)).toEqual(["Hand-off"]);

  expect(await drive(page, "delete_blueprint", { blueprint_id: "bp-approach-b" })).toMatchObject({ deleted: "bp-approach-b" });
  expect(await drive(page, "delete_blueprint", { blueprint_id: "bp-approach" })).toMatchObject({ deleted: "bp-approach" });
  await expect(drive(page, "delete_blueprint", { blueprint_id: "bp-approach" })).rejects.toThrow(/no blueprint/);
});
