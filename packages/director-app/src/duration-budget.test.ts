import { describe, expect, it } from "vitest";
import { budgetHint, estimateTargetSeconds, formatSeconds, recommendBeatCount, recommendSceneCount } from "./duration-budget.js";

describe("estimateTargetSeconds", () => {
  it("parses Calliope's presets and the free-text forms people type", () => {
    expect(estimateTargetSeconds("2 min")).toBe(120);
    expect(estimateTargetSeconds("2 minutes")).toBe(120);
    expect(estimateTargetSeconds("30 seconds")).toBe(30);
    expect(estimateTargetSeconds("1 minute")).toBe(60);
    expect(estimateTargetSeconds("10 minutes")).toBe(600);
    expect(estimateTargetSeconds("1 min 30 sec")).toBe(90);
    expect(estimateTargetSeconds("1.5 min")).toBe(90);
  });

  it("parses the clock form", () => {
    expect(estimateTargetSeconds("1:30")).toBe(90);
    expect(estimateTargetSeconds("0:45")).toBe(45);
    expect(estimateTargetSeconds("12:00")).toBe(720);
  });

  it("keeps Calliope's fallbacks: scene counts, bare numbers, words, and the 30 s default", () => {
    expect(estimateTargetSeconds("8 scenes")).toBe(64);
    expect(estimateTargetSeconds("2 scenes")).toBe(30);
    expect(estimateTargetSeconds("3")).toBe(180); // a bare 3 reads as minutes
    expect(estimateTargetSeconds("90")).toBe(90); // a bare 90 reads as seconds
    expect(estimateTargetSeconds("short")).toBe(30);
    expect(estimateTargetSeconds("medium")).toBe(120);
    expect(estimateTargetSeconds("feature length")).toBe(180);
    expect(estimateTargetSeconds("")).toBe(30);
    expect(estimateTargetSeconds(null)).toBe(30);
    expect(estimateTargetSeconds("whatever")).toBe(60);
  });

  it("never goes under 15 s for a parsed duration", () => {
    expect(estimateTargetSeconds("3 seconds")).toBe(15);
    expect(estimateTargetSeconds("0:05")).toBe(15);
  });
});

describe("recommendations", () => {
  it("follow the 12 s / 7 s rules for the presets", () => {
    expect(recommendBeatCount("2 minutes")).toBe(10);
    expect(recommendSceneCount("2 minutes")).toBe(17);
    expect(recommendBeatCount("30 seconds")).toBe(4); // 2.5 → clamped up to 4
    expect(recommendSceneCount("30 seconds")).toBe(4);
    expect(recommendBeatCount("5 minutes")).toBe(25);
    expect(recommendSceneCount("5 minutes")).toBe(43);
  });

  it("clamp at both ends", () => {
    expect(recommendBeatCount("3 seconds")).toBe(4);
    expect(recommendSceneCount("3 seconds")).toBe(4);
    expect(recommendBeatCount("30 minutes")).toBe(60); // 150 → 60
    expect(recommendSceneCount("30 minutes")).toBe(90); // 257 → 90
  });
});

describe("hint", () => {
  it("formats the seconds as a clock and names both counts", () => {
    expect(formatSeconds(120)).toBe("2:00");
    expect(formatSeconds(45)).toBe("0:45");
    expect(formatSeconds(-3)).toBe("0:00");
    expect(budgetHint("2 minutes")).toBe("≈ 2:00 · 10 beats · 17 scenes");
    expect(budgetHint("1:30")).toBe("≈ 1:30 · 8 beats · 13 scenes");
  });
});
