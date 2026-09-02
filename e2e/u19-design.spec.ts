import { expect, test } from "@playwright/test";
import { drive, shot, waitForDemo } from "./helpers.js";

// The design gallery: one shot per surface the design system owns, so the look can be JUDGED
// rather than asserted. The expectations here are the few things a screenshot cannot tell you
// apart — that the tokens actually resolved, that the recipe classes are on the elements — and
// the PNGs in e2e/out/ are the real acceptance test.

const px = (v: string) => Number.parseFloat(v);

test("tokens resolve, and the canvas wears the graphite palette", async ({ page }) => {
  await waitForDemo(page);

  const tokens = await page.evaluate(() => {
    const root = document.querySelector(".bd-root") as HTMLElement;
    const cs = getComputedStyle(root);
    const read = (n: string) => cs.getPropertyValue(n).trim();
    return {
      bg: read("--bd-bg"),
      panel: read("--bd-panel"),
      raised: read("--bd-raised"),
      hover: read("--bd-hover"),
      accent: read("--bd-accent"),
      radius: read("--bd-radius"),
      font: cs.fontFamily,
      canvas: getComputedStyle(document.querySelector(".bd-canvas") as HTMLElement).backgroundColor,
    };
  });
  expect(tokens.bg).toBe("#080808");
  expect(tokens.panel).toBe("#171717");
  expect(tokens.raised).toBe("#262626");
  expect(tokens.hover).toBe("#404040");
  expect(tokens.accent).toBe("#22d3ee");
  expect(tokens.radius).toBe("16px");
  expect(tokens.font).toContain("Geist");
  expect(tokens.canvas).toBe("rgb(8, 8, 8)");

  // The toolbar is the 40px glass bar; its buttons are monochrome, never a colour.
  const bar = await page.locator(".bd-toolbar").evaluate((el) => {
    const cs = getComputedStyle(el);
    return { h: (el as HTMLElement).offsetHeight, blur: cs.backdropFilter, border: cs.borderBottomColor };
  });
  expect(bar.h).toBeGreaterThanOrEqual(40);
  expect(bar.blur).toContain("blur");

  await shot(page, "u19-1-canvas");
});

test("a Scene card is a 16px node: gradient body, 34px keyed header, 8px handles", async ({ page }) => {
  await waitForDemo(page);
  const card = page.locator('.react-flow__node[data-id="sc-01"] .bd-node');
  await expect(card).toBeVisible();

  const look = await card.evaluate((el) => {
    const cs = getComputedStyle(el);
    const head = el.querySelector(".bd-node-title") as HTMLElement;
    const hs = getComputedStyle(head);
    const port = el.querySelector(".bd-port") as HTMLElement;
    const ps = getComputedStyle(port);
    const handle = el.querySelector(".react-flow__handle") as HTMLElement;
    return {
      radius: cs.borderTopLeftRadius,
      body: cs.backgroundImage,
      text: cs.color,
      shadow: cs.boxShadow,
      headH: head.offsetHeight,
      headTitle: hs.color,
      headUnderline: hs.borderBottomWidth,
      portCaps: ps.textTransform,
      portSize: ps.fontSize,
      handleW: handle.offsetWidth,
    };
  });
  expect(look.radius).toBe("16px");
  expect(look.body).toContain("linear-gradient");
  expect(look.text).toBe("rgb(221, 221, 221)"); // node text #ddd
  expect(look.headH).toBe(34);
  expect(look.headTitle).toBe("rgb(153, 153, 153)"); // title #999 until selected
  expect(look.headUnderline).toBe("2px");
  expect(look.portCaps).toBe("uppercase");
  expect(px(look.portSize)).toBeLessThanOrEqual(10);
  expect(look.handleW).toBe(8);

  // Selected: the title goes white and the card takes a 1px outline, not a second border.
  await page.locator('.react-flow__node[data-id="sc-01"] .bd-node-title').click();
  await expect(card).toHaveClass(/is-selected/);
  // The title colour is a 150ms transition, so poll it rather than catching it mid-fade.
  await expect
    .poll(() => card.evaluate((el) => getComputedStyle(el.querySelector(".bd-node-title") as HTMLElement).color))
    .toBe("rgb(255, 255, 255)");
  expect(await card.evaluate((el) => getComputedStyle(el).outlineWidth)).toBe("1px");

  await shot(page, "u19-2-node-selected");
});

test("a promoted Beat shows its rails as tinted pills", async ({ page }) => {
  await waitForDemo(page);
  await drive(page, "promote", { id: "beat-1" });
  const beat = page.locator('.react-flow__node[data-id="beat-1"]');
  await expect(beat.locator(".bd-pill").first()).toBeVisible();

  const rail = await beat.locator(".bd-pill").first().evaluate((el) => {
    const cs = getComputedStyle(el);
    return { radius: cs.borderTopLeftRadius, caps: cs.textTransform, tracking: cs.letterSpacing, size: cs.fontSize };
  });
  expect(px(rail.radius)).toBeGreaterThan(9); // pill
  expect(rail.caps).toBe("uppercase");
  expect(px(rail.tracking)).toBeGreaterThan(0);
  expect(px(rail.size)).toBeLessThanOrEqual(10);

  // The Beat's title bar is the micro-caps window chrome, not a label floating on the box.
  const title = await beat.locator(".bd-group-title").evaluate((el) => {
    const cs = getComputedStyle(el);
    return { caps: cs.textTransform, h: (el as HTMLElement).offsetHeight, blur: cs.backdropFilter };
  });
  expect(title.caps).toBe("uppercase");
  expect(title.h).toBe(30);
  expect(title.blur).toContain("blur");

  await shot(page, "u19-3-rails");
});

test("a collapsed Beat is one composed card with its pinned scene on the face", async ({ page }) => {
  await waitForDemo(page);
  await drive(page, "promote", { id: "beat-1" });
  await drive(page, "set_pin", { id: "sc-01", promoted: true });
  await drive(page, "set_collapsed", { id: "beat-1", collapsed: true });

  const card = page.locator('.react-flow__node[data-id="beat-1"] .bd-collapsed');
  await expect(card).toBeVisible();
  await expect(card.locator(".bd-face")).toHaveCount(1);
  const look = await card.evaluate((el) => {
    const cs = getComputedStyle(el);
    const head = el.querySelector(".bd-collapsed-head") as HTMLElement;
    return {
      radius: cs.borderTopLeftRadius,
      body: cs.backgroundImage,
      headH: head.offsetHeight,
      headBottom: getComputedStyle(head).borderBottomWidth,
      face: getComputedStyle(el.querySelector(".bd-face") as HTMLElement).borderTopLeftRadius,
    };
  });
  expect(look.radius).toBe("16px");
  expect(look.body).toContain("linear-gradient");
  expect(look.headH).toBe(34);
  expect(look.headBottom).toBe("2px");
  expect(px(look.face)).toBeGreaterThan(6);

  await shot(page, "u19-4-collapsed");
});

test("the right-click palette is a glass command menu", async ({ page }) => {
  await waitForDemo(page);
  // Right-click has to land on the PANE: a node under the cursor opens its own menu instead.
  const spot = await page.evaluate(() => {
    for (let y = 300; y < 620; y += 20) {
      for (let x = 200; x < 1200; x += 40) {
        const el = document.elementFromPoint(x, y);
        if (el?.classList.contains("react-flow__pane")) return { x, y };
      }
    }
    throw new Error("no empty canvas");
  });
  await page.mouse.click(spot.x, spot.y, { button: "right" });
  const palette = page.locator(".bd-palette");
  await expect(palette).toBeVisible();

  const look = await palette.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { w: (el as HTMLElement).offsetWidth, radius: cs.borderTopLeftRadius, blur: cs.backdropFilter, shadow: cs.boxShadow };
  });
  expect(look.w).toBe(240);
  expect(look.radius).toBe("16px");
  expect(look.blur).toContain("blur");

  // The cursor row uses the hover fill, #404040 — the reference's menu highlight.
  await palette.locator(".bd-palette-item").first().hover();
  const cursor = await palette.locator(".bd-palette-item.is-cursor").first().evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(cursor).toBe("rgb(64, 64, 64)");
  // No emoji anywhere in the menu: every leading mark is an SVG icon or the fallback dot.
  await expect(palette.locator(".bd-palette-icon svg, .bd-palette-icon .bd-palette-dot").first()).toBeVisible();

  await shot(page, "u19-5-palette");
});

test("the edge midpoint menu opens on the wire", async ({ page }) => {
  await waitForDemo(page);
  const mid = page.locator(".bd-edge-mid").first();
  await mid.click({ force: true });
  const menu = page.locator(".bd-edge-menu");
  await expect(menu).toBeVisible();
  const look = await menu.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { radius: cs.borderTopLeftRadius, blur: cs.backdropFilter, icons: el.querySelectorAll("button svg").length };
  });
  expect(px(look.radius)).toBeGreaterThan(9);
  expect(look.blur).toContain("blur");
  expect(look.icons).toBeGreaterThanOrEqual(3); // insert / delete / reroute, all lucide

  await shot(page, "u19-6-edge-menu");
});

// The modal has no drive path yet (the units that raise one are still in flight), so this
// renders the modal's own markup — verbatim from modal.tsx — inside the live .bd-root and
// checks the RECIPE: 28.8px radius, glass over a black/80 scrim, monochrome primary.
test("the modal recipe: 2xl radius, glass, black/80 scrim", async ({ page }) => {
  await waitForDemo(page);
  await page.evaluate(() => {
    const root = document.querySelector(".bd-root") as HTMLElement;
    const backdrop = document.createElement("div");
    backdrop.className = "bd-modal-backdrop";
    backdrop.innerHTML = `
      <div class="bd-modal" role="dialog" aria-modal="true">
        <div class="bd-modal-title">Save this Beat as a blueprint</div>
        <div class="bd-modal-body">A blueprint stores the Beat's logical wiring, so stamping a copy re-derives its rails through the same algebra that built them.</div>
        <label class="bd-modal-field"><span>Name</span><input class="bd-input" value="The approach" /></label>
        <div class="bd-modal-actions">
          <button type="button" class="bd-btn">Cancel</button>
          <button type="button" class="bd-btn is-primary">Save blueprint</button>
        </div>
      </div>`;
    root.appendChild(backdrop);
  });
  const modal = page.locator(".bd-modal");
  const look = await modal.evaluate((el) => {
    const cs = getComputedStyle(el);
    const scrim = getComputedStyle(el.parentElement as HTMLElement).backgroundColor;
    const primary = getComputedStyle(el.querySelector(".bd-btn.is-primary") as HTMLElement);
    return { radius: cs.borderTopLeftRadius, blur: cs.backdropFilter, scrim, btnBg: primary.backgroundColor, btnFg: primary.color };
  });
  expect(look.radius).toBe("28.8px");
  expect(look.blur).toContain("blur");
  expect(look.scrim).toBe("rgba(0, 0, 0, 0.8)");
  expect(look.btnBg).toBe("rgb(212, 212, 212)"); // monochrome primary #d4d4d4
  expect(look.btnFg).toBe("rgb(23, 23, 23)");

  await shot(page, "u19-7-modal");
});
