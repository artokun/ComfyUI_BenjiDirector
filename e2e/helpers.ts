import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";

/** `e2e/out/` — screenshots land here whatever the runner's cwd is. Gitignored. */
export const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "out");

/** Full-page screenshot into e2e/out/<name>. Open the PNG afterwards and LOOK at it. */
export async function shot(page: Page, name: string): Promise<string> {
  mkdirSync(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, name.endsWith(".png") ? name : `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  return path;
}

type Handle = { drive(name: string, args?: unknown): Promise<unknown> };

/** Run an editor command through the drive API the harness exposes as `window.__director`. */
export function drive<T = unknown>(page: Page, name: string, args?: Record<string, unknown>): Promise<T> {
  return page.evaluate(([n, a]) => (window as unknown as { __director: Handle }).__director.drive(n as string, a), [name, args] as const) as Promise<T>;
}

/** The demo project is loaded and laid out: 6 nodes, at least 4 wires drawn. */
export async function waitForDemo(page: Page): Promise<void> {
  await page.goto("/");
  await page.locator(".react-flow__node").nth(5).waitFor();
  await page.waitForFunction(() => document.querySelectorAll(".react-flow__edge").length >= 4);
}
