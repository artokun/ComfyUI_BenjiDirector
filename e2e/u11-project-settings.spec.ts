import { expect, test, type Page } from "@playwright/test";
import { shot, waitForDemo } from "./helpers.js";

// U11: the project menu and the Settings tab, against a MOCKED Calliope. Every /api/** call
// is answered here, so the assertions are about what the pane SENDS — the create body, the
// rename patch, and a settings save that carries only the key that changed.

interface Project {
  id: number;
  title: string;
  idea: string | null;
  genre: string | null;
  tone: string | null;
  target_duration: string | null;
  cover_path?: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

const now = new Date().toISOString();
const STATS: Record<number, { scene_count: number; character_count: number; asset_ready_count: number; asset_total_count: number }> = {
  1: { scene_count: 3, character_count: 2, asset_ready_count: 1, asset_total_count: 3 },
  2: { scene_count: 5, character_count: 1, asset_ready_count: 0, asset_total_count: 2 },
};

/** Row shapes copied from calliope-bind.test.ts (Calliope 1.2.1, seeded project, 2026-09-01). */
function storyFor(p: Project) {
  return {
    project: { id: p.id, title: p.title, idea: p.idea, genre: p.genre, tone: p.tone, target_duration: p.target_duration, status: p.status },
    beats: [
      { id: 1, order_index: 0, title: "Beat 1 — The approach", description: null },
      { id: 2, order_index: 1, title: "Beat 2 — The call", description: null },
    ],
    characters: [{ id: 1, name: "Nadia", role: null, age: null, appearance: null, personality: null, portrait_path: null, sheet_path: null, consistency_prompt: "same woman" }],
    locations: [{ id: 1, name: "Rooftop, night", description: null, reference_image_path: null, consistency_prompt: null }],
    items: [],
  };
}
function scenesFor(p: Project) {
  const row = (id: number, order_index: number, beat_id: number, chain_from_prev: number) => ({
    id,
    project_id: p.id,
    beat_id,
    order_index,
    heading: `SC-0${id}`,
    action: null,
    dialog: null,
    duration_sec: 5,
    workflow_id: null,
    env_image_path: null,
    location_id: 1,
    video_path: null,
    chain_from_prev,
    character_ids: [1],
    video_settings: null,
  });
  return { scenes: [row(1, 0, 1, 0), row(2, 1, 1, 1), row(3, 2, 2, 1)], estimated_duration_sec: 15 };
}

async function mockCalliope(page: Page) {
  const state = {
    projects: new Map<number, Project>([
      [1, { id: 1, title: "The Approach", idea: null, genre: "Thriller", tone: "quiet, tense", target_duration: "2 min", status: "in_progress", created_at: now, updated_at: now }],
      [2, { id: 2, title: "Lantern Road", idea: "a lighthouse keeper", genre: "Fantasy", tone: "Whimsical, warm", target_duration: "1 minute", status: "draft", created_at: now, updated_at: "2026-08-30 08:00:00" }],
    ]),
    nextId: 3,
    settings: {
      host: "127.0.0.1",
      port: 8247,
      data_dir: "C:\\Users\\me\\.calliope",
      assets_dir: "C:\\Users\\me\\.calliope\\assets",
      comfyui_base_url: "http://127.0.0.1:8188",
      queue_concurrency: 2,
      queue_poll_interval_sec: 2,
      queue_poll_timeout_sec: 0,
      queue_max_retries: 3,
      dry_run: false,
    } as Record<string, unknown>,
    created: [] as unknown[],
    patched: [] as { id: number; body: unknown }[],
    settingsPosts: [] as unknown[],
    deleted: [] as number[],
  };
  const withStats = (p: Project) => ({ ...p, stats: STATS[p.id] ?? { scene_count: 0, character_count: 0, asset_ready_count: 0, asset_total_count: 0 } });

  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const method = req.method();
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (path === "/api/health") return json({ status: "ok", version: "1.2.1", dry_run: false });
    if (path === "/api/projects" && method === "GET") return json([...state.projects.values()].map(withStats));
    if (path === "/api/projects" && method === "POST") {
      const body = req.postDataJSON() as Partial<Project>;
      state.created.push(body);
      const p: Project = { id: state.nextId++, title: body.title ?? "", idea: body.idea ?? null, genre: body.genre ?? null, tone: body.tone ?? null, target_duration: body.target_duration ?? null, status: "draft", created_at: now, updated_at: now };
      state.projects.set(p.id, p);
      return json(p);
    }
    const m = path.match(/^\/api\/projects\/(\d+)(?:\/(story|scenes))?$/);
    if (m) {
      const id = Number(m[1]);
      const p = state.projects.get(id);
      if (!p) return json({ detail: "Project not found" }, 404);
      if (m[2] === "story") return json(storyFor(p));
      if (m[2] === "scenes") return json(scenesFor(p));
      if (method === "GET") return json(withStats(p));
      if (method === "PATCH") {
        const body = req.postDataJSON() as Partial<Project>;
        state.patched.push({ id, body });
        Object.assign(p, body, { updated_at: now });
        return json(p);
      }
      if (method === "DELETE") {
        state.projects.delete(id);
        state.deleted.push(id);
        return json({ ok: true });
      }
    }
    if (path === "/api/settings" && method === "GET") return json(state.settings);
    if (path === "/api/settings" && method === "POST") {
      const body = req.postDataJSON() as Record<string, unknown>;
      state.settingsPosts.push(body);
      Object.assign(state.settings, body);
      return json(state.settings);
    }
    if (path === "/api/jobs" && method === "GET") return json([]);
    return json({ detail: `unmocked ${method} ${path}` }, 404);
  });
  return state;
}

test("project menu: list, search, create, load, rename, status; Settings: clamp, discard, save only what changed", async ({ page }) => {
  const state = await mockCalliope(page);
  await waitForDemo(page);
  await expect(page.locator(".bd-status")).toContainText("Calliope 1.2.1");
  // The toolbar's old <select> is gone; the menu replaced it.
  await expect(page.locator("select.bd-project")).toHaveCount(0);

  // ── the list ──
  const trigger = page.getByTestId("u11-project-trigger");
  await expect(trigger).toContainText("Demo project");
  await trigger.click();
  const menu = page.getByTestId("u11-project-menu");
  await expect(menu).toBeVisible();
  await expect(menu.locator(".bd-u11-row.is-project")).toHaveCount(2);
  await expect(menu.locator(".bd-u11-row.is-demo")).toHaveClass(/is-current/);
  const approach = menu.locator('.bd-u11-row[data-project-id="1"]');
  await expect(approach).toContainText("The Approach");
  await expect(approach).toContainText("3 scenes · 2 characters");
  await expect(approach).toContainText("In progress");
  await expect(approach).toContainText("just now");
  await expect(menu.locator('.bd-u11-row[data-project-id="2"]')).toContainText("Draft");
  await shot(page, "u11-project-settings");

  // Search narrows; clearing restores.
  await menu.getByLabel("Search projects").fill("lantern");
  await expect(menu.locator(".bd-u11-row.is-project")).toHaveCount(1);
  await expect(menu.locator(".bd-u11-row.is-project")).toContainText("Lantern Road");
  await menu.getByLabel("Search projects").fill("");
  await expect(menu.locator(".bd-u11-row.is-project")).toHaveCount(2);

  // ── create ──
  await page.getByTestId("u11-new-project").click();
  const form = page.getByTestId("u11-project-form-create");
  await expect(form).toBeVisible();
  // Title is required: submitting empty stays on the form and says so.
  await form.getByRole("button", { name: "Create project" }).click();
  await expect(form).toContainText("Give the project a title.");
  expect(state.created).toHaveLength(0);
  await form.locator("#u11-title").fill("Moonlit Harbor");
  await form.locator("#u11-idea").fill("A lighthouse keeper finds a glowing bottle.");
  await form.locator("#u11-genre").selectOption("Sci-Fi");
  await form.locator("#u11-tone").selectOption("Dark, tense");
  await form.locator("#u11-duration").selectOption("2 minutes");
  await expect(page.getByTestId("u11-budget")).toContainText("≈ 2:00 · 10 beats · 17 scenes");
  // A custom duration re-budgets live.
  await form.locator("#u11-duration").selectOption("__custom");
  await form.locator("#u11-duration-custom").fill("1:30");
  await expect(page.getByTestId("u11-budget")).toContainText("≈ 1:30 · 8 beats · 13 scenes");
  await form.locator("#u11-duration").selectOption("2 minutes");
  await form.getByRole("button", { name: "Create project" }).click();

  // The created project is loaded onto the canvas and the trigger names it.
  await expect(trigger).toContainText("Moonlit Harbor");
  await expect(page.locator(".bd-note")).toContainText("loaded “Moonlit Harbor”");
  expect(state.created).toEqual([{ title: "Moonlit Harbor", idea: "A lighthouse keeper finds a glowing bottle.", genre: "Sci-Fi", tone: "Dark, tense", target_duration: "2 minutes" }]);
  await expect(menu).toHaveCount(0);

  // ── the loaded project's card, and rename ──
  await trigger.click();
  const current = page.getByTestId("u11-current");
  await expect(current).toContainText("Moonlit Harbor");
  await expect(current).toContainText("Sci-Fi");
  await expect(page.getByTestId("u11-project-menu").locator('.bd-u11-row[data-project-id="3"]')).toHaveClass(/is-current/);
  await current.getByRole("button", { name: "Rename" }).click();
  const modal = page.locator(".bd-modal");
  await expect(modal).toContainText("Rename project");
  await expect(modal.locator("input")).toHaveValue("Moonlit Harbor");
  await modal.locator("input").fill("Moonlit Harbor II");
  await modal.getByRole("button", { name: "Rename" }).click();
  await expect(trigger).toContainText("Moonlit Harbor II");
  await expect(page.locator(".bd-note")).toContainText("renamed to “Moonlit Harbor II”");
  expect(state.patched).toEqual([{ id: 3, body: { title: "Moonlit Harbor II" } }]);

  // ── set status through the chooser ──
  await trigger.click();
  await page.getByTestId("u11-current").getByRole("button", { name: "Status" }).click();
  await expect(page.locator(".bd-modal")).toContainText("Currently Draft");
  await page.locator(".bd-modal").getByRole("button", { name: "Ready" }).click();
  await expect(page.locator(".bd-note")).toContainText("is now Ready");
  expect(state.patched[1]).toEqual({ id: 3, body: { status: "completed" } });
  await trigger.click();
  await expect(page.getByTestId("u11-current").locator(".bd-chip-state")).toHaveText("Ready");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("u11-project-menu")).toHaveCount(0);

  // ── Settings tab ──
  await page.getByRole("tab", { name: "Settings" }).click();
  const settings = page.getByTestId("u11-settings");
  await expect(settings).toBeVisible();
  await expect(page.getByTestId("u11-calliope-status")).toContainText("reachable");
  await expect(page.getByTestId("u11-calliope-status")).toContainText("1.2.1");
  await expect(settings).toContainText("LLM settings are unused here");
  await expect(settings).not.toContainText("llm_");
  const concurrency = settings.locator("#u11-concurrency");
  await expect(concurrency).toHaveValue("2");
  await expect(settings.locator("#u11-comfy-url")).toHaveValue("http://127.0.0.1:8188");
  await expect(settings).toContainText("Current: C:\\Users\\me\\.calliope");
  const save = page.getByTestId("u11-settings-save");
  await expect(save).toBeDisabled();

  // Clamp on blur: 20 → 8, and that counts as a change.
  await concurrency.fill("20");
  await concurrency.blur();
  await expect(concurrency).toHaveValue("8");
  await expect(page.getByTestId("u11-settings-actions")).toContainText("1 unsaved change");
  // Quotes pasted around a path are stripped on blur.
  const dataDir = settings.locator("#u11-data-dir");
  await dataDir.fill('"D:\\films"');
  await dataDir.blur();
  await expect(dataDir).toHaveValue("D:\\films");
  await expect(page.getByTestId("u11-settings-actions")).toContainText("2 unsaved changes");
  // An emptied field reverts instead of blanking the setting Calliope would then store.
  const comfyUrl = settings.locator("#u11-comfy-url");
  await comfyUrl.fill("");
  await comfyUrl.blur();
  await expect(comfyUrl).toHaveValue("http://127.0.0.1:8188");
  await expect(page.getByTestId("u11-settings-actions")).toContainText("2 unsaved changes");
  // Discard puts everything back.
  await settings.getByRole("button", { name: "Discard" }).click();
  await expect(concurrency).toHaveValue("2");
  await expect(dataDir).toHaveValue("C:\\Users\\me\\.calliope");
  await expect(save).toBeDisabled();

  // Leave-guard: a dirty draft survives a tab switch and is announced in the note.
  await concurrency.fill("4");
  await concurrency.blur();
  await page.getByRole("tab", { name: "Canvas" }).click();
  await expect(page.locator(".bd-note")).toContainText("Settings: 1 unsaved change kept");
  await page.getByRole("tab", { name: "Settings" }).click();
  await expect(settings.locator("#u11-concurrency")).toHaveValue("4");

  // Save sends ONLY the touched key.
  await shot(page, "u11-settings");
  await page.getByTestId("u11-settings-save").click();
  await expect(page.locator(".bd-note")).toContainText("settings saved");
  expect(state.settingsPosts).toEqual([{ queue_concurrency: 4 }]);
  await expect(page.getByTestId("u11-settings-save")).toBeDisabled();
  await expect(settings.locator("#u11-concurrency")).toHaveValue("4");

  // ── delete the loaded project: confirm, then back to the demo ──
  await page.getByRole("tab", { name: "Canvas" }).click();
  await trigger.click();
  await page.getByTestId("u11-current").getByRole("button", { name: "Delete" }).click();
  await expect(page.locator(".bd-modal")).toContainText("asset files stay on disk");
  await page.locator(".bd-modal").getByRole("button", { name: "Delete" }).click();
  expect(state.deleted).toEqual([3]);
  await expect(trigger).toContainText("Demo project");
  await expect(page.locator(".react-flow__node")).toHaveCount(6);
});

test("with Calliope down the menu still opens, says so, and cannot create", async ({ page }) => {
  await page.route("**/api/**", (route) => route.abort("connectionrefused"));
  await waitForDemo(page);
  await expect(page.locator(".bd-status")).toContainText("unreachable");
  await page.getByTestId("u11-project-trigger").click();
  const menu = page.getByTestId("u11-project-menu");
  await expect(menu).toContainText("Calliope is not answering");
  await expect(page.getByTestId("u11-new-project")).toBeDisabled();
  // The menu is a popover over the whole pane, so it is dismissed before reaching for the tab
  // strip behind it — the same thing a user's hand does.
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await page.getByRole("tab", { name: "Settings" }).click();
  await expect(page.getByTestId("u11-calliope-status")).toContainText("unreachable");
  await expect(page.getByTestId("u11-settings-actions")).toContainText("Settings load once Calliope answers.");
});
