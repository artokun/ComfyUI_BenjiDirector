import { describe, expect, it } from "vitest";
import {
  checkWorkflowShape,
  classToInputKind,
  classToOutputKind,
  fileStem,
  INPUT_ROLE_ALIASES,
  normalizeInputRole,
  normalizeOutputRole,
  parseTitleTag,
  previewWorkflow,
  suggestProfile,
  type ApiWorkflow,
} from "./workflow-json.js";

// A small API-format graph the way ComfyUI's "Save (API Format)" writes it: keyed by node id,
// `_meta.title` carrying the role tags Calliope's parser reads.
const API: ApiWorkflow = {
  "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "flux.safetensors" }, _meta: { title: "Load Checkpoint" } },
  "6": { class_type: "CLIPTextEncode", inputs: { text: "a cat on a roof", clip: ["4", 1] }, _meta: { title: "Positive Prompt (Input:prompt)" } },
  "7": { class_type: "LoadImage", inputs: { image: "ref.png" }, _meta: { title: "Character sheet (Input:sheet)" } },
  "9": { class_type: "PrimitiveInt", inputs: { value: 42 }, _meta: { title: "(Input:seed)" } },
  "3": { class_type: "KSampler", inputs: { seed: 1, steps: 20 } },
  "8": { class_type: "VHS_VideoCombine", inputs: { images: ["3", 0] }, _meta: { title: "Final (Output:vid)" } },
};

describe("checkWorkflowShape", () => {
  it("accepts an API-format object of class_type + inputs nodes, from text or a parsed value", () => {
    const fromText = checkWorkflowShape(JSON.stringify(API));
    expect(fromText.ok).toBe(true);
    if (fromText.ok) expect(fromText.nodeCount).toBe(6);
    const fromValue = checkWorkflowShape(API);
    expect(fromValue.ok && fromValue.json["6"]?.class_type).toBe("CLIPTextEncode");
  });

  it("refuses empty text, broken JSON, arrays and scalars with a reason", () => {
    expect(checkWorkflowShape("   ")).toEqual({ ok: false, error: expect.stringMatching(/paste or drop/i) });
    expect(checkWorkflowShape("{ nope")).toEqual({ ok: false, error: expect.stringMatching(/not valid json/i) });
    expect(checkWorkflowShape("[1,2]")).toEqual({ ok: false, error: expect.stringMatching(/object keyed by node id/i) });
    expect(checkWorkflowShape("42")).toEqual({ ok: false, error: expect.stringMatching(/object keyed by node id/i) });
    expect(checkWorkflowShape("{}")).toEqual({ ok: false, error: expect.stringMatching(/no nodes/i) });
  });

  it("names a UI-format export (nodes / links) as the mistake it is", () => {
    const ui = { last_node_id: 9, nodes: [{ id: 1, type: "KSampler" }], links: [], version: 0.4 };
    const r = checkWorkflowShape(JSON.stringify(ui));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Save \(API Format\)/);
  });

  it("names the first node that is not an API node", () => {
    expect(checkWorkflowShape({ "1": "x" })).toEqual({ ok: false, error: "Node #1 is not an object." });
    expect(checkWorkflowShape({ "1": { inputs: {} } })).toEqual({ ok: false, error: expect.stringMatching(/Node #1 has no class_type/) });
    expect(checkWorkflowShape({ "1": { class_type: "KSampler" } })).toEqual({ ok: false, error: expect.stringMatching(/Node #1 \(KSampler\) has no inputs/) });
    expect(checkWorkflowShape({ "1": { class_type: "KSampler", inputs: [] } }).ok).toBe(false);
  });
});

describe("parseTitleTag", () => {
  it("reads kind, role and the display label with the tag stripped", () => {
    expect(parseTitleTag("Positive Prompt (Input:prompt)")).toEqual({ kind: "input", role: "prompt", label: "Positive Prompt" });
    expect(parseTitleTag("Final (Output:video)")).toEqual({ kind: "output", role: "video", label: "Final" });
  });
  it("falls back to the role, then the kind, when the title is only a tag", () => {
    expect(parseTitleTag("(Input:seed)")).toEqual({ kind: "input", role: "seed", label: "seed" });
    expect(parseTitleTag("(Output)")).toEqual({ kind: "output", role: null, label: "output" });
  });
  it("is case-insensitive and lowercases the role as written (aliases are not normalised here)", () => {
    expect(parseTitleTag("Neg (INPUT:Negative)")).toEqual({ kind: "input", role: "negative", label: "Neg" });
    expect(parseTitleTag("Ref (input:CHAR)").role).toBe("char");
  });
  it("returns no kind for an untagged or empty title", () => {
    expect(parseTitleTag("Load Checkpoint")).toEqual({ kind: null, role: null, label: "Load Checkpoint" });
    expect(parseTitleTag("")).toEqual({ kind: null, role: null, label: "" });
    expect(parseTitleTag(undefined)).toEqual({ kind: null, role: null, label: "" });
  });
});

describe("role aliases", () => {
  it("maps every alias in the table to its canonical input role", () => {
    for (const [canonical, aliases] of Object.entries(INPUT_ROLE_ALIASES)) {
      expect(normalizeInputRole(canonical)).toBe(canonical);
      for (const a of aliases) expect(normalizeInputRole(a), `${a} → ${canonical}`).toBe(canonical);
    }
  });
  it("covers the aliases Calliope documents", () => {
    expect(normalizeInputRole("positive")).toBe("prompt");
    expect(normalizeInputRole("neg")).toBe("negative");
    expect(normalizeInputRole("w")).toBe("width");
    expect(normalizeInputRole("H")).toBe("height");
    for (const a of ["char", "portrait", "sheet", "face", "ref"]) expect(normalizeInputRole(a)).toBe("character");
    for (const a of ["loc", "environment", "env", "background", "scene"]) expect(normalizeInputRole(a)).toBe("location");
    expect(normalizeInputRole("img")).toBe("image");
    expect(normalizeInputRole("vid")).toBe("video");
    for (const a of ["sound", "sfx"]) expect(normalizeInputRole(a)).toBe("audio");
    for (const a of ["dur", "length", "seconds"]) expect(normalizeInputRole(a)).toBe("duration");
  });
  it("passes an unknown role through lowercased, and null through as null", () => {
    expect(normalizeInputRole("Style")).toBe("style");
    expect(normalizeInputRole(null)).toBeNull();
    expect(normalizeInputRole("")).toBeNull();
  });
  it("normalises output roles too", () => {
    expect(normalizeOutputRole("img")).toBe("image");
    expect(normalizeOutputRole("VID")).toBe("video");
    expect(normalizeOutputRole("mask")).toBe("mask");
  });
});

describe("class_type → kind (registry mirror)", () => {
  it("knows the stock loaders and encoders", () => {
    expect(classToInputKind("LoadImage")).toBe("image");
    expect(classToInputKind("Load Image From Url (mtb)")).toBe("image_url");
    expect(classToInputKind("VHS_LoadAudio")).toBe("audio");
    expect(classToInputKind("VHS_LoadVideo")).toBe("video");
    expect(classToInputKind("KSampler")).toBe("number");
    expect(classToInputKind("CLIPTextEncode")).toBe("textarea");
  });
  it("guesses from the name for anything else, and falls back to text", () => {
    expect(classToInputKind("MyVideoLoader")).toBe("video");
    expect(classToInputKind("AudioThing")).toBe("audio");
    expect(classToInputKind("LoadLatent")).toBe("image");
    expect(classToInputKind("SeedGenerator")).toBe("number");
    expect(classToInputKind("PromptStyler")).toBe("textarea");
    expect(classToInputKind("Something")).toBe("text");
  });
  it("classifies outputs", () => {
    expect(classToOutputKind("VHS_VideoCombine")).toBe("video");
    expect(classToOutputKind("SaveImage")).toBe("image");
    expect(classToOutputKind("PreviewAny")).toBe("other");
  });
});

describe("previewWorkflow", () => {
  const p = previewWorkflow(API);

  it("lists the (Input:…) titled nodes in file order with normalised roles, kinds and defaults", () => {
    expect(p.inputs).toEqual([
      { nodeId: "6", label: "Positive Prompt", role: "prompt", kind: "textarea", defaultValue: "a cat on a roof", required: true },
      { nodeId: "7", label: "Character sheet", role: "character", kind: "image", required: true },
      { nodeId: "9", label: "seed", role: "seed", kind: "number", defaultValue: 42, required: true },
    ]);
  });
  it("lists the (Output:…) nodes, letting an explicit role decide the kind", () => {
    expect(p.outputs).toEqual([{ nodeId: "8", label: "Final", role: "video", kind: "video" }]);
    const forced = previewWorkflow({ "1": { class_type: "SaveVideo", inputs: {}, _meta: { title: "(Output:img)" } } });
    expect(forced.outputs[0]).toMatchObject({ role: "image", kind: "image" });
  });
  it("ignores untitled and untagged nodes", () => {
    expect(p.inputs.map((i) => i.nodeId)).not.toContain("3");
    expect(p.inputs.map((i) => i.nodeId)).not.toContain("4");
  });
  // The one place the local preview can disagree with Calliope: JS walks integer-like keys in
  // numeric order, Python walks them in the file's order. Pinned so the divergence stays
  // documented behaviour rather than a surprise when the analysis lands and the rows re-sort.
  it("walks integer-like node ids in NUMERIC order, which is not always the file's order", () => {
    const outOfOrder = JSON.parse('{"10":{"class_type":"CLIPTextEncode","inputs":{},"_meta":{"title":"(Input:prompt)"}},"2":{"class_type":"PrimitiveInt","inputs":{},"_meta":{"title":"(Input:seed)"}}}') as ApiWorkflow;
    expect(previewWorkflow(outOfOrder).inputs.map((i) => i.nodeId)).toEqual(["2", "10"]);
    // Non-integer keys keep insertion order, so those DO match the file.
    const named = JSON.parse('{"b":{"class_type":"CLIPTextEncode","inputs":{},"_meta":{"title":"(Input:prompt)"}},"a":{"class_type":"PrimitiveInt","inputs":{},"_meta":{"title":"(Input:seed)"}}}') as ApiWorkflow;
    expect(previewWorkflow(named).inputs.map((i) => i.nodeId)).toEqual(["b", "a"]);
  });

  it("suggests the prose profile unless a MiniMaxH3* node is present", () => {
    expect(p.suggestedProfile).toBe("prose");
    const h3: ApiWorkflow = { ...API, "20": { class_type: "MiniMaxH3ReferenceToVideo", inputs: {} } };
    expect(suggestProfile(h3)).toBe("minimax_h3_ref");
    expect(previewWorkflow(h3).suggestedProfile).toBe("minimax_h3_ref");
  });
});

describe("fileStem", () => {
  it("drops the .json extension, any path, and surrounding whitespace", () => {
    expect(fileStem("LTX Ref-to-Video.json")).toBe("LTX Ref-to-Video");
    expect(fileStem("wf.JSON")).toBe("wf");
    expect(fileStem("C:\\wf\\flux keyframe.json")).toBe("flux keyframe");
    expect(fileStem("/tmp/a/b/clip.json")).toBe("clip");
    expect(fileStem("  spaced .json")).toBe("spaced");
  });
  it("leaves a name without the extension alone", () => {
    expect(fileStem("workflow_api")).toBe("workflow_api");
    expect(fileStem("")).toBe("");
  });
});
