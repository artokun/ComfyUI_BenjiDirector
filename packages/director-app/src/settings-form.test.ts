import { describe, expect, it } from "vitest";
import type { CalliopeSettings } from "@benjidirector/calliope-client";
import { clampNumber, diffSettings, normalizeText, stripQuotes } from "./settings-form.js";

const saved: CalliopeSettings = {
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
};

describe("clampNumber", () => {
  it("clamps to Calliope's Field limits", () => {
    expect(clampNumber("queue_concurrency", "20")).toBe(8);
    expect(clampNumber("queue_concurrency", "0")).toBe(1);
    expect(clampNumber("queue_poll_interval_sec", "0.1")).toBe(0.5);
    expect(clampNumber("queue_poll_interval_sec", "99")).toBe(60);
    expect(clampNumber("queue_poll_timeout_sec", "100000")).toBe(86400);
    expect(clampNumber("queue_max_retries", "-1")).toBe(0);
  });

  it("snaps to the step", () => {
    expect(clampNumber("queue_concurrency", "2.7")).toBe(3);
    expect(clampNumber("queue_poll_interval_sec", "1.3")).toBe(1.5);
    expect(clampNumber("queue_poll_interval_sec", "1.2")).toBe(1);
    expect(clampNumber("queue_poll_timeout_sec", "12.4")).toBe(12);
  });

  it("refuses non-numbers rather than sending NaN", () => {
    expect(clampNumber("queue_concurrency", "")).toBeNull();
    expect(clampNumber("queue_concurrency", "four")).toBeNull();
    expect(clampNumber("queue_concurrency", "  ")).toBeNull();
  });
});

describe("stripQuotes / normalizeText", () => {
  it("strips the quotes Explorer's Copy-as-path wraps a path in", () => {
    expect(stripQuotes('"C:\\Users\\me\\data"')).toBe("C:\\Users\\me\\data");
    expect(stripQuotes("'/home/me/data'")).toBe("/home/me/data");
    expect(stripQuotes('  "C:\\x"  ')).toBe("C:\\x");
    expect(stripQuotes('"unbalanced')).toBe('"unbalanced');
    expect(stripQuotes("plain")).toBe("plain");
  });

  it("only strips for path keys; the URL is merely trimmed", () => {
    expect(normalizeText("data_dir", '"C:\\d"')).toBe("C:\\d");
    expect(normalizeText("comfyui_base_url", ' "http://x" ')).toBe('"http://x"');
  });
});

describe("diffSettings", () => {
  it("carries only the keys that differ from what Calliope has", () => {
    expect(diffSettings(saved, { queue_concurrency: "4" })).toEqual({ queue_concurrency: 4 });
    expect(diffSettings(saved, { queue_concurrency: "4", comfyui_base_url: "http://127.0.0.1:8188" })).toEqual({ queue_concurrency: 4 });
  });

  it("a field typed back to its saved value is not a change", () => {
    expect(diffSettings(saved, { queue_concurrency: "2", dry_run: false, data_dir: saved.data_dir })).toEqual({});
  });

  it("normalizes before comparing: quotes, clamps, trims", () => {
    expect(diffSettings(saved, { data_dir: `"${saved.data_dir}"` })).toEqual({});
    expect(diffSettings(saved, { assets_dir: '"D:\\assets"' })).toEqual({ assets_dir: "D:\\assets" });
    expect(diffSettings(saved, { queue_concurrency: "99" })).toEqual({ queue_concurrency: 8 });
    expect(diffSettings(saved, { comfyui_base_url: "  http://gpu:8188 " })).toEqual({ comfyui_base_url: "http://gpu:8188" });
  });

  it("an EMPTIED text field reverts rather than blanking the setting", () => {
    // Calliope assigns comfyui_base_url straight through: "" would point every render job at
    // an empty URL. Clearing a box means "leave it alone", not "erase it".
    expect(diffSettings(saved, { comfyui_base_url: "" })).toEqual({});
    expect(diffSettings(saved, { comfyui_base_url: "   " })).toEqual({});
    expect(diffSettings(saved, { data_dir: "" })).toEqual({});
    expect(diffSettings(saved, { assets_dir: '""' })).toEqual({});
    // A real value alongside an emptied one still goes.
    expect(diffSettings(saved, { comfyui_base_url: "", queue_concurrency: "5" })).toEqual({ queue_concurrency: 5 });
  });

  it("a non-number in a numeric field is dropped, not sent", () => {
    expect(diffSettings(saved, { queue_max_retries: "lots" })).toEqual({});
  });

  it("dry_run flips as a boolean", () => {
    expect(diffSettings(saved, { dry_run: true })).toEqual({ dry_run: true });
    expect(diffSettings({ ...saved, dry_run: true }, { dry_run: true })).toEqual({});
  });
});
