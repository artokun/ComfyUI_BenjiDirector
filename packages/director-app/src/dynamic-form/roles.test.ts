import { describe, expect, it } from "vitest";
import { CANONICAL_ROLES, hasRole, INPUT_ROLE_ALIASES, inputWithRole, isPromptLike, normalizeInputRole, roleLabel, videoInputOf } from "./roles.js";

// The alias table is a contract with Calliope's `comfyui/roles.py`; these pin every row of it
// so a drift on either side is a red test here, not a prompt box that turned into a text field.

describe("normalizeInputRole", () => {
  it("folds every alias onto its canonical role, case- and whitespace-insensitively", () => {
    for (const [canonical, aliases] of Object.entries(INPUT_ROLE_ALIASES)) {
      for (const a of aliases) {
        expect(normalizeInputRole(a)).toBe(canonical);
        expect(normalizeInputRole(` ${a.toUpperCase()} `)).toBe(canonical);
      }
    }
  });

  it("carries the eleven roles Calliope knows", () => {
    expect(CANONICAL_ROLES).toEqual(["prompt", "negative", "width", "height", "character", "location", "image", "video", "audio", "seed", "duration"]);
  });

  it("maps the aliases the backend accepts — positive, neg, env, ref, vid, sfx, seconds", () => {
    expect(normalizeInputRole("positive")).toBe("prompt");
    expect(normalizeInputRole("neg")).toBe("negative");
    expect(normalizeInputRole("env")).toBe("location");
    expect(normalizeInputRole("background")).toBe("location");
    expect(normalizeInputRole("ref")).toBe("character");
    expect(normalizeInputRole("sheet")).toBe("character");
    expect(normalizeInputRole("vid")).toBe("video");
    expect(normalizeInputRole("sfx")).toBe("audio");
    expect(normalizeInputRole("seconds")).toBe("duration");
    expect(normalizeInputRole("w")).toBe("width");
    expect(normalizeInputRole("h")).toBe("height");
  });

  it("keeps an unknown role rather than dropping it, and null stays null", () => {
    expect(normalizeInputRole("steps")).toBe("steps");
    expect(normalizeInputRole("  CFG ")).toBe("cfg");
    expect(normalizeInputRole(null)).toBeNull();
    expect(normalizeInputRole(undefined)).toBeNull();
    expect(normalizeInputRole("")).toBeNull();
    expect(normalizeInputRole("   ")).toBeNull();
  });
});

describe("hasRole / inputWithRole / videoInputOf", () => {
  const inputs = [
    { nodeId: "1", role: "positive" },
    { nodeId: "2", role: "vid" },
    { nodeId: "3", role: null },
    { nodeId: "4", role: "env" },
  ];
  it("matches through aliases on both sides", () => {
    expect(hasRole({ role: "vid" }, "video")).toBe(true);
    expect(hasRole({ role: "video" }, "vid")).toBe(true);
    expect(hasRole({ role: "positive" }, "prompt", "negative")).toBe(true);
    expect(hasRole({ role: null }, "prompt")).toBe(false);
    expect(hasRole({ role: "env" }, "image")).toBe(false);
  });
  it("finds the first input of a role", () => {
    expect(inputWithRole(inputs, "location")?.nodeId).toBe("4");
    expect(inputWithRole(inputs, "prompt")?.nodeId).toBe("1");
    expect(inputWithRole(inputs, "seed")).toBeUndefined();
    expect(inputWithRole(undefined, "seed")).toBeUndefined();
  });
  it("the video input is what a chain_from_prev scene needs", () => {
    expect(videoInputOf(inputs)?.nodeId).toBe("2");
    expect(videoInputOf([{ role: "image" }])).toBeUndefined();
  });
});

describe("isPromptLike", () => {
  it("a prompt role is the prompt whatever the label says", () => {
    expect(isPromptLike({ role: "prompt", kind: "text", label: "Negative" })).toBe(true);
    expect(isPromptLike({ role: "positive", kind: "textarea", label: "x" })).toBe(true);
  });
  it("any other role is never the prompt", () => {
    expect(isPromptLike({ role: "negative", kind: "textarea", label: "Prompt" })).toBe(false);
    expect(isPromptLike({ role: "character", kind: "image", label: "prompt" })).toBe(false);
  });
  it("a legacy role-less schema falls back to the label and kind", () => {
    expect(isPromptLike({ role: null, kind: "textarea", label: "CLIP Text Encode" })).toBe(true);
    expect(isPromptLike({ role: null, kind: "text", label: "Positive prompt" })).toBe(true);
    expect(isPromptLike({ role: null, kind: "text", label: "Negative prompt" })).toBe(false);
    expect(isPromptLike({ role: null, kind: "number", label: "prompt" })).toBe(false);
    expect(isPromptLike({ role: null, kind: "text", label: "Steps" })).toBe(false);
  });
});

describe("roleLabel", () => {
  it("names the media roles the way the history drawer shows them", () => {
    expect(roleLabel("char")).toBe("Character ref");
    expect(roleLabel("location")).toBe("Location ref");
    expect(roleLabel("img")).toBe("Ref image");
    expect(roleLabel("video")).toBe("Video input");
    expect(roleLabel("sfx")).toBe("Audio input");
    expect(roleLabel("steps")).toBe("steps");
    expect(roleLabel(null)).toBe("");
  });
});
