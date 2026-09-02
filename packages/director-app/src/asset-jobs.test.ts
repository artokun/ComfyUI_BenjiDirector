import { describe, expect, it } from "vitest";
import type { CharacterRow, JobRow, LocationRow, WorkflowInput, WorkflowRow } from "@benjidirector/calliope-client";
import {
  assetOptionsFrom,
  compactInputValues,
  entityKey,
  generateAllMissingPlan,
  generateOnePlan,
  imagePathOf,
  imageWorkflows,
  isPromptLikeInput,
  jobStateOf,
  latestImageJobFor,
  mergeJobs,
  missingRequiredInputs,
  normalizeInputRole,
  promptFor,
  seedInputDefaults,
  templateFor,
  uploadTarget,
  workflowHasPromptInput,
  type AssetItemRow,
  type EntityLists,
} from "./asset-jobs.js";
import { characterSheetTemplate, itemReferenceTemplate, locationReferenceTemplate } from "./asset-prompt-templates.js";

// Rows as Calliope 1.2.1 returns them for the seeded project (see calliope-bind.test.ts).
const nadia: CharacterRow = { id: 1, name: "Nadia", role: null, age: null, appearance: null, personality: null, portrait_path: null, sheet_path: null, consistency_prompt: "same woman" };
const mara: CharacterRow = { id: 2, name: "Mara", role: "handler", age: "40s", appearance: "grey coat", personality: "dry", portrait_path: "C:/a/portrait.png", sheet_path: "C:/a/mara-sheet.png", consistency_prompt: null };
const rooftop: LocationRow = { id: 1, name: "Rooftop, night", description: null, reference_image_path: null, consistency_prompt: null };
const garage: LocationRow = { id: 2, name: "Garage", description: "oil-stained concrete", reference_image_path: "C:/a/garage.png", consistency_prompt: "  " };
const knife: AssetItemRow = { id: 5, name: "Knife", description: "bone handle", reference_image_path: "C:/a/knife.png", consistency_prompt: null };
const lists: EntityLists = { characters: [nadia, mara], locations: [rooftop, garage], items: [knife] };

const job = (id: number, extra: Partial<JobRow>): JobRow => ({
  id,
  project_id: 1,
  scene_id: null,
  kind: "image",
  workflow_id: 7,
  status: "done",
  payload: {},
  output_paths: [],
  error: null,
  created_at: "2026-09-01T00:00:00Z",
  started_at: null,
  completed_at: null,
  retry_count: 0,
  ...extra,
});

describe("latestImageJobFor", () => {
  const jobs = [
    job(10, { payload: { character_id: 1 }, status: "done" }),
    job(12, { payload: { character_id: 1 }, status: "failed" }),
    job(11, { payload: { character_id: 1 }, status: "running" }),
    job(13, { payload: { character_id: 2 }, status: "pending" }),
    job(14, { kind: "video", scene_id: 3, payload: { character_id: 1 }, status: "running" }),
    job(15, { payload: { location_id: 1 }, status: "pending" }),
    job(16, { payload: { item_id: "5" }, status: "running" }),
  ];

  it("picks the highest-id IMAGE job whose payload names the entity", () => {
    expect(latestImageJobFor(jobs, { kind: "character", id: 1 })?.id).toBe(12);
    expect(latestImageJobFor(jobs, { kind: "character", id: 2 })?.id).toBe(13);
    expect(latestImageJobFor(jobs, { kind: "location", id: 1 })?.id).toBe(15);
  });

  it("tolerates a stringified id in the payload and ignores other kinds", () => {
    expect(latestImageJobFor(jobs, { kind: "item", id: 5 })?.id).toBe(16);
    expect(latestImageJobFor(jobs, { kind: "location", id: 2 })).toBeUndefined();
    // The video job (14) names character 1 but is not an image job.
    expect(latestImageJobFor([jobs[4]!], { kind: "character", id: 1 })).toBeUndefined();
  });

  it("maps a job to what the card shows", () => {
    expect(jobStateOf(undefined)).toBeNull();
    expect(jobStateOf(job(1, { status: "pending" }))).toBe("generating");
    expect(jobStateOf(job(1, { status: "running" }))).toBe("generating");
    expect(jobStateOf(job(1, { status: "failed" }))).toBe("failed");
    expect(jobStateOf(job(1, { status: "done" }))).toBeNull();
  });

  it("mergeJobs unions by id with the incoming list winning", () => {
    const merged = mergeJobs([job(1, { status: "pending" }), job(2, { status: "pending" })], [job(1, { status: "done" }), job(3, { status: "pending" })]);
    expect(merged.map((j) => [j.id, j.status])).toEqual([
      [1, "done"],
      [2, "pending"],
      [3, "pending"],
    ]);
  });
});

describe("generateAllMissingPlan", () => {
  it("is the three scoped calls AssetsStage makes, in order, each missing_only", () => {
    const plan = generateAllMissingPlan(lists, 7);
    expect(plan).toEqual([
      { missing_only: true, asset_target: "sheet", workflow_id: 7, character_ids: [1, 2], input_values: {} },
      { missing_only: true, asset_target: "sheet", workflow_id: 7, character_ids: [], location_ids: [1, 2], input_values: {} },
      { missing_only: true, asset_target: "sheet", workflow_id: 7, character_ids: [], location_ids: [], item_ids: [5], input_values: {} },
    ]);
    // Characters-only has NO location_ids key at all: on the backend a present-but-empty
    // `location_ids` and an absent one are different scoping rules.
    expect("location_ids" in plan[0]!).toBe(false);
    expect("item_ids" in plan[1]!).toBe(false);
  });

  it("stays three bodies with empty lists — an empty id list is a backend no-op", () => {
    const plan = generateAllMissingPlan({ characters: [], locations: [], items: [] }, 3);
    expect(plan).toHaveLength(3);
    expect(plan[0]!.character_ids).toEqual([]);
    expect(plan[2]!.item_ids).toEqual([]);
  });

  it("takes a per-tab workflow and compacted input values", () => {
    const plan = generateAllMissingPlan(lists, 7, {
      location: { workflowId: 9, inputValues: { "3": "", "4": 1024, "5": null } },
      item: { inputValues: { "8": "C:/ref.png" } },
    });
    expect(plan[0]!.workflow_id).toBe(7);
    expect(plan[1]!.workflow_id).toBe(9);
    expect(plan[1]!.input_values).toEqual({ "4": 1024 });
    expect(plan[2]!.workflow_id).toBe(7);
    expect(plan[2]!.input_values).toEqual({ "8": "C:/ref.png" });
  });
});

describe("generateOnePlan", () => {
  it("scopes a character to itself and pins the sheet target", () => {
    expect(generateOnePlan({ kind: "character", id: 1 }, { workflowId: 7, inputValues: { "9": 42, "3": "" }, prompt: "  same woman  " })).toEqual({
      missing_only: false,
      asset_target: "sheet",
      workflow_id: 7,
      input_values: { "9": 42 },
      character_ids: [1],
      location_ids: [],
      prompt: "same woman",
    });
  });

  it("empties character_ids for a location, and both for an item", () => {
    expect(generateOnePlan({ kind: "location", id: 2 }, { workflowId: 7 })).toEqual({ missing_only: false, asset_target: "sheet", workflow_id: 7, input_values: {}, character_ids: [], location_ids: [2] });
    expect(generateOnePlan({ kind: "item", id: 5 }, { workflowId: 7 })).toEqual({ missing_only: false, asset_target: "sheet", workflow_id: 7, input_values: {}, character_ids: [], location_ids: [], item_ids: [5] });
  });

  it("omits a blank prompt so the backend falls back to the saved one", () => {
    expect("prompt" in generateOnePlan({ kind: "character", id: 1 }, { workflowId: 7, prompt: "   " })).toBe(false);
    expect("prompt" in generateOnePlan({ kind: "character", id: 1 }, { workflowId: 7, prompt: null })).toBe(false);
  });
});

describe("upload target and image path", () => {
  it("names the column an upload is PATCHed into", () => {
    expect(uploadTarget("character")).toBe("sheet_path");
    expect(uploadTarget("location")).toBe("reference_image_path");
    expect(uploadTarget("item")).toBe("reference_image_path");
  });

  it("reads the image from the same column — a character's portrait is not its sheet", () => {
    expect(imagePathOf("character", nadia)).toBeNull();
    expect(imagePathOf("character", mara)).toBe("C:/a/mara-sheet.png");
    expect(imagePathOf("character", { ...mara, sheet_path: null })).toBeNull();
    expect(imagePathOf("location", garage)).toBe("C:/a/garage.png");
    expect(imagePathOf("item", knife)).toBe("C:/a/knife.png");
    expect(imagePathOf("item", { ...knife, reference_image_path: "" })).toBeNull();
  });

  it("entityKey is stable and kind-qualified", () => {
    expect(entityKey("character", 1)).toBe("character:1");
    expect(entityKey("location", 1)).not.toBe(entityKey("character", 1));
  });
});

describe("workflow inputs", () => {
  const inp = (nodeId: string, extra: Partial<WorkflowInput>): WorkflowInput => ({ nodeId, label: nodeId, role: null, kind: "text", ...extra });
  const schema: WorkflowInput[] = [
    inp("6", { label: "Prompt", role: "prompt", kind: "textarea", required: true }),
    inp("7", { label: "Negative", role: "neg", kind: "textarea", required: true }),
    inp("9", { label: "Seed", role: "seed", kind: "number", defaultValue: 42 }),
    inp("12", { label: "Reference", role: "image", kind: "image", required: true }),
    inp("13", { label: "Width", role: "w", kind: "number", defaultValue: "" }),
  ];

  it("normalizes role aliases the way Calliope's parser does", () => {
    expect(normalizeInputRole("Positive")).toBe("prompt");
    expect(normalizeInputRole("neg")).toBe("negative");
    expect(normalizeInputRole("sheet")).toBe("character");
    expect(normalizeInputRole("env")).toBe("location");
    expect(normalizeInputRole("custom")).toBe("custom");
    expect(normalizeInputRole(null)).toBeNull();
  });

  it("finds the prompt input by role, then by Calliope's legacy label fallback", () => {
    expect(isPromptLikeInput(inp("1", { role: "prompt" }))).toBe(true);
    expect(isPromptLikeInput(inp("1", { role: "positive", kind: "number" }))).toBe(true);
    expect(isPromptLikeInput(inp("1", { role: "negative", kind: "textarea" }))).toBe(false);
    expect(isPromptLikeInput(inp("1", { role: "seed", kind: "textarea" }))).toBe(false);
    expect(isPromptLikeInput(inp("1", { label: "CLIP Text Encode (Positive)", kind: "text" }))).toBe(true);
    expect(isPromptLikeInput(inp("1", { label: "Negative prompt", kind: "textarea" }))).toBe(false);
    expect(isPromptLikeInput(inp("1", { label: "Any", kind: "textarea" }))).toBe(true);
    expect(isPromptLikeInput(inp("1", { label: "Any", kind: "image" }))).toBe(false);
    expect(workflowHasPromptInput(schema)).toBe(true);
    expect(workflowHasPromptInput([inp("9", { role: "seed", kind: "number" })])).toBe(false);
    expect(workflowHasPromptInput(null)).toBe(false);
  });

  it("compacts blanks and seeds non-empty defaults without clobbering set values", () => {
    expect(compactInputValues({ a: "", b: "  ", c: null, d: undefined, e: 0, f: "x", g: false })).toEqual({ e: 0, f: "x", g: false });
    expect(compactInputValues(null)).toEqual({});
    expect(seedInputDefaults(schema, { "9": 7 })).toEqual({ "9": 7 });
    expect(seedInputDefaults(schema)).toEqual({ "9": 42 });
  });

  it("required validation skips the hidden prompt roles and treats blank as missing", () => {
    expect(missingRequiredInputs(schema, {}).map((i) => i.nodeId)).toEqual(["12"]);
    expect(missingRequiredInputs(schema, { "12": "  " }).map((i) => i.nodeId)).toEqual(["12"]);
    expect(missingRequiredInputs(schema, { "12": "C:/ref.png" })).toEqual([]);
    expect(missingRequiredInputs(schema, {}, []).map((i) => i.nodeId)).toEqual(["6", "7", "12"]);
  });

  it("imageWorkflows keeps enabled image workflows in Calliope's order", () => {
    const wf = (id: number, kind: "image" | "video", is_enabled: boolean): WorkflowRow => ({ id, name: `wf${id}`, kind, is_enabled, prompt_profile: "prose", description: null, input_schema: [], output_schema: [] });
    expect(imageWorkflows([wf(3, "image", true), wf(2, "video", true), wf(1, "image", false), wf(5, "image", true)]).map((w) => w.id)).toEqual([3, 5]);
    expect(imageWorkflows(null)).toEqual([]);
  });

  it("assetOptionsFrom lists only entities that already have an image", () => {
    expect(assetOptionsFrom(lists)).toEqual([
      { id: "character:2", label: "Mara · sheet", path: "C:/a/mara-sheet.png", kind: "character" },
      { id: "location:2", label: "Garage · environment", path: "C:/a/garage.png", kind: "location" },
      { id: "item:5", label: "Knife · item", path: "C:/a/knife.png", kind: "item" },
    ]);
    expect(assetOptionsFrom(null)).toEqual([]);
  });
});

describe("prompts", () => {
  it("draft wins, then the saved prompt, then the template; whitespace is not a prompt", () => {
    expect(promptFor("character", nadia, "draft text")).toBe("draft text");
    expect(promptFor("character", nadia, "")).toBe("");
    expect(promptFor("character", nadia)).toBe("same woman");
    expect(promptFor("character", mara)).toBe(characterSheetTemplate(mara));
    expect(promptFor("location", garage)).toBe(locationReferenceTemplate(garage));
    expect(promptFor("item", knife)).toBe(itemReferenceTemplate(knife));
    expect(templateFor("location", rooftop)).toBe(locationReferenceTemplate(rooftop));
  });

  it("templates match Calliope's promptTemplates.ts field for field", () => {
    const sheet = characterSheetTemplate(mara);
    expect(sheet.startsWith("CHARACTER SHEET — Mara\nRole: handler. Age: 40s.\nAppearance: grey coat\nPersonality cues (visual only): dry\n\nLayout:")).toBe(true);
    const bare = characterSheetTemplate(nadia);
    expect(bare.startsWith("CHARACTER SHEET — Nadia\nRole: character. Age: unspecified age.\nAppearance: no appearance notes yet\n\nLayout:")).toBe(true);
    expect(locationReferenceTemplate(rooftop)).toContain("ENVIRONMENT REFERENCE — Rooftop, night\nDescription: no description yet\n");
    expect(itemReferenceTemplate({ name: null, description: null })).toContain("ITEM REFERENCE — Unnamed item");
    // Calliope's own quirk, ported deliberately: a whitespace-only name is TRUTHY, so it trims
    // to empty instead of falling back to "Unnamed item". Parity with the backend beats tidiness.
    expect(itemReferenceTemplate({ name: "  ", description: null }).startsWith("ITEM REFERENCE — \n")).toBe(true);
  });
});
