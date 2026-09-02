import { describe, expect, it } from "vitest";
import { classifyAll, classifyInput, clampTo, DURATION_RANGE, mediaKindOfInput, parseResolution, RESOLUTION_PRESETS, RESOLUTION_RANGE, resolutionLabel, SEED_RANGE, snapTo, stepValue } from "./classify.js";
import type { DynamicInput } from "./types.js";

const inp = (nodeId: string, role: string | null, kind: DynamicInput["kind"] = "text", extra: Partial<DynamicInput> = {}): DynamicInput => ({
  nodeId,
  label: `Node ${nodeId}`,
  role,
  kind,
  required: true,
  ...extra,
});

// A MiniMax-style video workflow as Calliope reports it: prompt / negative / width / height /
// duration / seed / character / location / video.
const schema: DynamicInput[] = [
  inp("10", "prompt", "textarea"),
  inp("11", "negative", "textarea"),
  inp("12", "width", "number", { defaultValue: 1280 }),
  inp("13", "height", "number", { defaultValue: 720 }),
  inp("14", "duration", "number", { defaultValue: 5 }),
  inp("15", "seed", "number", { defaultValue: 0 }),
  inp("16", "character", "image"),
  inp("17", "location", "image"),
  inp("18", "video", "video"),
  inp("19", "steps", "number", { defaultValue: 20 }),
  inp("20", null, "text", { label: "Sampler" }),
];

describe("classifyInput", () => {
  it("routes each canonical role to its zone and widget", () => {
    expect(classifyInput(inp("1", "prompt", "textarea"))).toMatchObject({ zone: "composer", widget: "prompt", role: "prompt" });
    expect(classifyInput(inp("1", "negative", "textarea"))).toMatchObject({ zone: "composer", widget: "negative" });
    expect(classifyInput(inp("1", "character", "image"))).toMatchObject({ zone: "media", widget: "mediaTile" });
    expect(classifyInput(inp("1", "location", "image"))).toMatchObject({ zone: "media" });
    expect(classifyInput(inp("1", "image", "image"))).toMatchObject({ zone: "media" });
    expect(classifyInput(inp("1", "video", "video"))).toMatchObject({ zone: "media" });
    expect(classifyInput(inp("1", "audio", "audio"))).toMatchObject({ zone: "media" });
    expect(classifyInput(inp("1", "width", "number"))).toMatchObject({ zone: "control", widget: "resolution" });
    expect(classifyInput(inp("1", "height", "number"))).toMatchObject({ zone: "control", widget: "resolution" });
    expect(classifyInput(inp("1", "duration", "number"))).toMatchObject({ zone: "control", widget: "duration" });
    expect(classifyInput(inp("1", "seed", "number"))).toMatchObject({ zone: "control", widget: "seed" });
  });

  it("folds aliases before routing — positive is the prompt, env is a media tile, seconds is duration", () => {
    expect(classifyInput(inp("1", "positive", "textarea")).widget).toBe("prompt");
    expect(classifyInput(inp("1", "neg", "textarea")).widget).toBe("negative");
    expect(classifyInput(inp("1", "env", "image")).zone).toBe("media");
    expect(classifyInput(inp("1", "seconds", "number")).widget).toBe("duration");
    expect(classifyInput(inp("1", "w", "number")).widget).toBe("resolution");
  });

  it("a media role on a text node is still a media tile (a path field is a picker)", () => {
    expect(classifyInput(inp("1", "character", "text")).zone).toBe("media");
    expect(classifyInput(inp("1", "video", "text")).zone).toBe("media");
  });

  it("a media KIND with no role goes to the tray, not to Advanced as a raw path", () => {
    expect(classifyInput(inp("1", null, "image")).zone).toBe("media");
    expect(classifyInput(inp("1", null, "image_url")).zone).toBe("media");
    expect(classifyInput(inp("1", null, "audio")).zone).toBe("media");
    expect(classifyInput(inp("1", null, "video")).zone).toBe("media");
  });

  it("unknown roles fall to Advanced by kind, never dropped", () => {
    expect(classifyInput(inp("1", "steps", "number"))).toMatchObject({ zone: "advanced", widget: "number", role: "steps" });
    expect(classifyInput(inp("1", "cfg", "text"))).toMatchObject({ zone: "advanced", widget: "text" });
    expect(classifyInput(inp("1", null, "number", { label: "Frames" }))).toMatchObject({ zone: "advanced", widget: "number" });
  });

  it("a role-less textarea is the prompt by the legacy label rule", () => {
    expect(classifyInput(inp("1", null, "textarea", { label: "CLIP Text Encode" }))).toMatchObject({ zone: "composer", widget: "prompt", role: "prompt" });
    expect(classifyInput(inp("1", null, "text", { label: "Negative" })).zone).toBe("advanced");
  });
});

describe("classifyAll", () => {
  const c = classifyAll(schema);

  it("picks the prompt and negative boxes", () => {
    expect(c.prompt?.input.nodeId).toBe("10");
    expect(c.negative?.input.nodeId).toBe("11");
  });

  it("collects the media tray in schema order", () => {
    expect(c.media.map((m) => m.input.nodeId)).toEqual(["16", "17", "18"]);
  });

  it("pairs width + height into one Resolution pill and keeps them OUT of the control list", () => {
    expect(c.resolutionPair?.width.input.nodeId).toBe("12");
    expect(c.resolutionPair?.height.input.nodeId).toBe("13");
    expect(c.control.map((x) => x.widget)).toEqual(["duration", "seed"]);
  });

  it("a lone width is a control stepper, not a pair", () => {
    const one = classifyAll([inp("12", "width", "number"), inp("14", "duration", "number")]);
    expect(one.resolutionPair).toBeNull();
    expect(one.control.map((x) => [x.input.nodeId, x.widget])).toEqual([
      ["12", "resolution"],
      ["14", "duration"],
    ]);
  });

  it("everything else lands in Advanced", () => {
    expect(c.advanced.map((x) => x.input.nodeId)).toEqual(["19", "20"]);
  });

  it("a second prompt-like input is shown under Advanced rather than lost", () => {
    const two = classifyAll([inp("1", "prompt", "textarea"), inp("2", "positive", "textarea"), inp("3", "negative", "textarea"), inp("4", "neg", "textarea")]);
    expect(two.prompt?.input.nodeId).toBe("1");
    expect(two.negative?.input.nodeId).toBe("3");
    expect(two.advanced.map((x) => x.input.nodeId)).toEqual(["2", "4"]);
    expect(two.advanced.every((x) => x.zone === "advanced" && x.widget === "text")).toBe(true);
  });

  it("every input lands in exactly one place", () => {
    const placed = [c.prompt, c.negative, ...c.media, ...c.control, ...c.advanced, c.resolutionPair?.width, c.resolutionPair?.height].filter(Boolean).map((x) => x!.input.nodeId);
    expect([...placed].sort()).toEqual(schema.map((i) => i.nodeId).sort());
    expect(new Set(placed).size).toBe(schema.length);
  });

  it("tolerates an absent schema", () => {
    expect(classifyAll(undefined)).toEqual({ prompt: null, negative: null, media: [], control: [], advanced: [], resolutionPair: null });
  });
});

describe("mediaKindOfInput", () => {
  it("the role decides, then the kind, and refs are images", () => {
    expect(mediaKindOfInput(inp("1", "video", "text"))).toBe("video");
    expect(mediaKindOfInput(inp("1", "audio", "text"))).toBe("audio");
    expect(mediaKindOfInput(inp("1", null, "video"))).toBe("video");
    expect(mediaKindOfInput(inp("1", "character", "image"))).toBe("image");
    expect(mediaKindOfInput(inp("1", "image", "image_url"))).toBe("image");
  });
});

describe("resolution", () => {
  it("has the two presets and labels a pair by preset or as W×H", () => {
    expect(RESOLUTION_PRESETS.map((p) => p.label)).toEqual(["720p", "1080p"]);
    expect(resolutionLabel(1280, 720)).toBe("720p");
    expect(resolutionLabel("1920", "1080")).toBe("1080p");
    expect(resolutionLabel(1024, 576)).toBe("1024×576");
    expect(resolutionLabel(undefined, 720)).toBeNull();
    expect(resolutionLabel("", "")).toBeNull();
  });
  it("parses a WxH value from the preset select", () => {
    expect(parseResolution("1280x720")).toEqual({ width: 1280, height: 720 });
    expect(parseResolution("1920×1080")).toEqual({ width: 1920, height: 1080 });
    expect(parseResolution("custom")).toBeNull();
    expect(parseResolution(undefined)).toBeNull();
  });
});

describe("numeric steppers", () => {
  it("resolution steps by 64 within 256–4096", () => {
    expect(RESOLUTION_RANGE).toEqual({ min: 256, max: 4096, step: 64 });
    expect(stepValue(1280, 1, RESOLUTION_RANGE)).toBe(1344);
    expect(stepValue(1280, -1, RESOLUTION_RANGE)).toBe(1216);
    expect(stepValue(4096, 1, RESOLUTION_RANGE)).toBe(4096);
    expect(stepValue(256, -1, RESOLUTION_RANGE)).toBe(256);
    // Off-grid input snaps onto the grid.
    expect(stepValue(1000, 1, RESOLUTION_RANGE)).toBe(1088);
    expect(snapTo(1000, RESOLUTION_RANGE)).toBe(1024);
  });
  it("duration is 1–30 and seed is a non-negative integer", () => {
    expect(DURATION_RANGE).toEqual({ min: 1, max: 30, step: 1 });
    expect(stepValue(5, 1, DURATION_RANGE)).toBe(6);
    expect(stepValue(30, 1, DURATION_RANGE)).toBe(30);
    expect(stepValue(1, -1, DURATION_RANGE)).toBe(1);
    expect(stepValue(0, -1, SEED_RANGE)).toBe(0);
    expect(stepValue(SEED_RANGE.max, 1, SEED_RANGE)).toBe(SEED_RANGE.max);
  });
  it("an unset value steps from the floor", () => {
    expect(stepValue(undefined, 1, DURATION_RANGE)).toBe(1);
    expect(stepValue("", 1, DURATION_RANGE)).toBe(1);
    expect(stepValue(undefined, -1, DURATION_RANGE)).toBe(1);
    expect(stepValue("abc", 1, RESOLUTION_RANGE)).toBe(256);
  });
  it("clamps NaN to the floor", () => {
    expect(clampTo(Number.NaN, DURATION_RANGE)).toBe(1);
    expect(clampTo(99, DURATION_RANGE)).toBe(30);
  });
});
