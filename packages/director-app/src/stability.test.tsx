// @vitest-environment jsdom
//
// [U1] Soak: mount the real editor and hammer it through the drive API — 300 drags and 50
// collapse/expand cycles — while counting every timer, listener and observer that is alive.
// The lock-up the owner hit was a measurement kick that re-armed a 60 s interval on every
// node-list change and could never finish while a node was hidden. The invariant this pins:
// after the canvas has measured, NOTHING is armed, and no amount of editing arms anything
// that is not torn down again.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DirectorApp, type DriveFn } from "./DirectorApp.jsx";

// ── counters: what is alive right now ──────────────────────────────────────────────────
const live = { intervals: 0, timeouts: 0, listeners: 0, observers: 0, rafs: 0 };
const errors: string[] = [];
const snapshot = () => ({ ...live });

function install() {
  const g = globalThis as unknown as Record<string, unknown>;
  // Without this React logs "not configured to support act(...)" on every update — noise the
  // error assertion below would count as a failure, and it hides real warnings.
  g.IS_REACT_ACT_ENVIRONMENT = true;
  const realSetInterval = g.setInterval as typeof setInterval;
  const realClearInterval = g.clearInterval as typeof clearInterval;
  const realSetTimeout = g.setTimeout as typeof setTimeout;
  const realClearTimeout = g.clearTimeout as typeof clearTimeout;
  const intervals = new Set<unknown>();
  const timeouts = new Set<unknown>();
  g.setInterval = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    const id = realSetInterval(fn, ms, ...rest);
    intervals.add(id);
    live.intervals = intervals.size;
    return id;
  }) as typeof setInterval;
  g.clearInterval = ((id: unknown) => {
    intervals.delete(id);
    live.intervals = intervals.size;
    realClearInterval(id as never);
  }) as typeof clearInterval;
  g.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    const id = realSetTimeout(
      (...a: unknown[]) => {
        timeouts.delete(id);
        live.timeouts = timeouts.size;
        fn(...a);
      },
      ms,
      ...rest,
    );
    timeouts.add(id);
    live.timeouts = timeouts.size;
    return id;
  }) as typeof setTimeout;
  g.clearTimeout = ((id: unknown) => {
    timeouts.delete(id);
    live.timeouts = timeouts.size;
    realClearTimeout(id as never);
  }) as typeof clearTimeout;

  const proto = EventTarget.prototype;
  const realAdd = proto.addEventListener;
  const realRemove = proto.removeEventListener;
  const listeners = new Map<EventTarget, Map<string, Set<unknown>>>();
  const key = (fn: unknown, opts: unknown) => `${typeof opts === "object" && opts && (opts as { capture?: boolean }).capture ? "c" : opts === true ? "c" : "b"}`;
  proto.addEventListener = function (this: EventTarget, type: string, fn: unknown, opts?: unknown) {
    if (fn) {
      const byType = listeners.get(this) ?? new Map<string, Set<unknown>>();
      const set = byType.get(type + key(fn, opts)) ?? new Set();
      if (!set.has(fn)) {
        set.add(fn);
        live.listeners += 1;
      }
      byType.set(type + key(fn, opts), set);
      listeners.set(this, byType);
    }
    return realAdd.call(this, type, fn as EventListener, opts as boolean);
  };
  proto.removeEventListener = function (this: EventTarget, type: string, fn: unknown, opts?: unknown) {
    const set = listeners.get(this)?.get(type + key(fn, opts));
    if (set?.delete(fn)) live.listeners -= 1;
    return realRemove.call(this, type, fn as EventListener, opts as boolean);
  };

  class CountingResizeObserver {
    constructor(_cb: ResizeObserverCallback) {
      live.observers += 1;
    }
    observe() {}
    unobserve() {}
    disconnect() {
      live.observers -= 1;
    }
  }
  g.ResizeObserver = CountingResizeObserver;

  // React Flow reads the viewport zoom off a DOMMatrix jsdom does not have.
  g.DOMMatrixReadOnly = class {
    m22 = 1;
    constructor(_transform?: string) {}
  };
  const w = window as unknown as Record<string, unknown>;
  if (typeof w.requestAnimationFrame !== "function") {
    w.requestAnimationFrame = (cb: FrameRequestCallback) => realSetTimeout(() => cb(performance.now()), 16);
    w.cancelAnimationFrame = (id: number) => realClearTimeout(id);
  }
  // Give every element a size, so React Flow MEASURES the canvas and the kick has something
  // to finish. The nodes never measure under plain jsdom (offsetWidth is 0), and a kick that
  // cannot finish would only prove the 60 s bound, not that it stops.
  //
  // A sized node reports ITS OWN size: React Flow writes node.width/height as an inline style,
  // and containment is geometry. A flat 200x100 would make a 460x380 Beat measure smaller than
  // the offsets of its own children and evict them on the next settle — a fact about this stub,
  // not about the editor.
  const inlinePx = (el: HTMLElement, prop: "width" | "height", fallback: number) => {
    const raw = el.style?.[prop];
    const n = raw && raw.endsWith("px") ? Number.parseFloat(raw) : NaN;
    return Number.isFinite(n) ? n : fallback;
  };
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return inlinePx(this, "width", 200);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return inlinePx(this, "height", 100);
    },
  });

  // Calliope probes must fail fast, not hang on a socket.
  g.fetch = () => Promise.reject(new Error("offline"));

  window.addEventListener("error", (e) => errors.push(`window.error: ${e.message}`));
  const realError = console.error;
  console.error = (...a: unknown[]) => {
    errors.push(a.map(String).join(" "));
    realError(...a);
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("stability soak", () => {
  let root: Root;
  let host: HTMLDivElement;
  const apiRef: { current: DriveFn | null } = { current: null };
  const api = (name: string, args: Record<string, unknown> = {}) => {
    if (!apiRef.current) throw new Error("editor not mounted");
    return apiRef.current(name, args);
  };
  /** Run drive commands inside act, so React's updates — and the microtask-chained settle — flush. */
  const drive = async (calls: [string, Record<string, unknown>?][]) => {
    let results: Promise<unknown>[] = [];
    await act(async () => {
      results = calls.map(([n, a]) => api(n, a));
    });
    return Promise.all(results);
  };

  beforeAll(async () => {
    install();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root.render(createElement(DirectorApp, { apiRef, calliopeBaseUrl: "http://127.0.0.1:1" }));
    });
    // Let the measurement kick's first frame land and stop.
    await act(async () => {
      await sleep(60);
    });
  });

  afterAll(async () => {
    await act(async () => {
      root.unmount();
    });
  });

  it("mounts the demo, measures it, and the measurement kick stops", async () => {
    expect(apiRef.current).not.toBeNull();
    const outline = (await api("outline")) as { nodes: unknown[] };
    expect(outline.nodes).toHaveLength(6);
    // Every visible node reported a size, so nothing is left armed: no interval, no observer
    // of ours (React Flow keeps its own single ResizeObserver for the node renderer).
    expect(live.intervals).toBe(0);
  }, 10_000);

  it("300 drags and 50 collapse/expand cycles arm nothing that stays alive", async () => {
    // Warm up: the first edits may allocate lazily (undo history, memoised handlers).
    await drive([["move_node", { id: "sc-03", x: 900, y: 300 }]]);
    await drive([["promote", { id: "beat-1" }]]);
    await act(async () => {
      await sleep(30);
    });
    const before = snapshot();
    const errorsBefore = errors.length;

    // Only nodes that start OUTSIDE beat-1, plus the Beat itself. move_node re-parents by
    // geometry (settle's job), so dragging beat-1's own children to random coordinates would
    // legitimately move them out — a fact about containment, not about leaks, and it would
    // cost the coherence check at the end its meaning.
    const ids = ["sc-03", "char-nadia", "loc-rooftop", "beat-1"];
    for (let i = 0; i < 300; i += 5) {
      // Five drags per act keeps the run under the budget while every drag still runs its own
      // withCurrent → settle → decorate pass against the state the previous one left.
      const batch: [string, Record<string, unknown>][] = [];
      for (let k = 0; k < 5; k++) {
        const n = i + k;
        const id = ids[n % ids.length]!;
        batch.push(["move_node", { id, x: 40 + ((n * 37) % 900), y: 40 + ((n * 53) % 500) }]);
      }
      await drive(batch);
    }
    for (let i = 0; i < 50; i++) {
      await drive([["set_collapsed", { id: "beat-1", collapsed: true }]]);
      await drive([["set_collapsed", { id: "beat-1", collapsed: false }]]);
    }
    // Quiesce: any one-shot timer a settle armed must have fired or been cleared.
    await act(async () => {
      await sleep(60);
    });
    const after = snapshot();

    expect(errors.slice(errorsBefore), "no errors during the soak").toEqual([]);
    expect(after.intervals, "intervals").toBe(before.intervals);
    expect(after.observers, "resize observers").toBe(before.observers);
    expect(after.listeners, "event listeners").toBe(before.listeners);
    expect(after.rafs, "animation frames").toBe(before.rafs);
    // One-shot timers are allowed to fluctuate by a frame or two (React's scheduler), never
    // by anything that scales with the number of edits.
    expect(Math.abs(after.timeouts - before.timeouts), "one-shot timers").toBeLessThanOrEqual(2);

    // The graph is still coherent: every child of beat-1 is still its child, and the drags landed.
    for (const id of ["sc-01", "sc-02"]) {
      const n = (await api("read_node", { id })) as { parentId: string | null };
      expect(n.parentId, `${id} stays in beat-1`).toBe("beat-1");
    }
  }, 20_000);

  it("a node that is hidden and was NEVER measured arms nothing", async () => {
    // The pathological case behind the lock-up. React Flow never measures a hidden node, so a
    // kick that waits for EVERY node to report a size can never finish once one is born hidden
    // — it re-armed its 500 ms interval on each settle and force-remeasured the whole canvas
    // for a minute at a time. A node added INSIDE a collapsed Beat is exactly that node.
    await drive([["set_collapsed", { id: "beat-1", collapsed: true }]]);
    await act(async () => {
      await sleep(40);
    });
    const before = snapshot();

    const made = (await (async () => {
      let r: unknown;
      await act(async () => {
        r = await api("add_node", { kind: "scene", x: 5000, y: 5000, label: "born hidden" });
      });
      return r as { id: string };
    })()) as { id: string };
    await drive([["set_parent", { id: made.id, parent_id: "beat-1" }]]);
    await act(async () => {
      await sleep(40);
    });

    const hidden = (await api("read_node", { id: made.id })) as { hidden: boolean; parentId: string | null };
    expect(hidden.parentId, "the new scene is inside the collapsed Beat").toBe("beat-1");
    expect(hidden.hidden, "and it is hidden, so React Flow will never measure it").toBe(true);

    const after = snapshot();
    expect(after.intervals, "nothing is armed for a node that can never measure").toBe(before.intervals);
    expect(after.intervals, "and nothing is armed at all").toBe(0);
    expect(after.observers, "resize observers").toBe(before.observers);
    expect(after.listeners, "event listeners").toBe(before.listeners);

    await drive([["set_collapsed", { id: "beat-1", collapsed: false }]]);
  }, 15_000);
});
