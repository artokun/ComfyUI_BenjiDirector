import { describe, expect, it } from "vitest";
import { bestMatch, enumsOf, resolveModels, resolveSummary, squash, type Graph, type ObjectInfo } from "./comfy-models.js";

// The names below are REAL: the left-hand side is what Calliope's own example workflows ask
// for, the right-hand side is what the machine this was written on actually has. A resolver
// that cannot bridge those two is a resolver that ships a workflow which fails on first run.

const info: ObjectInfo = {
  UNETLoader: {
    input: {
      required: {
        unet_name: [["krea2_turbo_fp8_scaled.safetensors", "krea2_turbo_fp8.safetensors", "flux1-dev-fp8.safetensors", "z_image_turbo_bf16.safetensors"], {}],
        weight_dtype: [["default", "fp8_e4m3fn"], {}],
      },
    },
  },
  CLIPLoader: { input: { required: { clip_name: [["qwen3vl_4b_fp8_scaled.safetensors", "qwen_3_4b.safetensors"], {}], type: [["krea2", "sd3"], {}] } } },
  VAELoader: { input: { required: { vae_name: [["qwen_image_vae.safetensors", "ae.safetensors"], {}] } } },
  LoraLoaderModelOnly: { input: { required: { lora_name: [["Krea2\\krea2_turbo_lora_rank_64_bf16.safetensors"], {}], strength_model: [["FLOAT", { default: 1 }]] } } },
  KSampler: { input: { required: { seed: ["INT", { default: 0 }], steps: ["INT", { default: 8 }] } } },
  CLIPTextEncode: { input: { required: { text: ["STRING", { multiline: true }] } } },
};

describe("enumsOf", () => {
  it("keeps the inputs that are a LIST of choices and drops the ones that are a type name", () => {
    const enums = enumsOf(info);
    expect(enums.get("UNETLoader")?.get("unet_name")).toHaveLength(4);
    expect(enums.get("UNETLoader")?.get("weight_dtype")).toEqual(["default", "fp8_e4m3fn"]);
    // A TYPE is `["INT", {…}]` — a string first. An ENUM is `[[…], {…}]` — a list first. Only
    // the second is a set of files, and confusing them would rewrite a seed into the word "INT".
    expect(enums.get("KSampler")).toBeUndefined();
    expect(enums.get("CLIPTextEncode")).toBeUndefined();
  });
});

describe("squash", () => {
  it("drops the extension, the case and every separator", () => {
    expect(squash("Krea-2-Turbo.safetensors")).toBe("krea2turbo");
    expect(squash("krea2\\Krea2-realism-V2.safetensors")).toBe("krea2krea2realismv2");
    expect(squash("qwen_image_vae.safetensors")).toBe("qwenimagevae");
  });
});

describe("bestMatch", () => {
  const unet = ["krea2_turbo_fp8_scaled.safetensors", "krea2_turbo_fp8.safetensors", "flux1-dev-fp8.safetensors"];

  it("takes an exact name unchanged", () => {
    expect(bestMatch("flux1-dev-fp8.safetensors", unet)).toBe("flux1-dev-fp8.safetensors");
  });

  it("bridges the naming a model is published under to the file this box has", () => {
    // The real case: Calliope's example asks for this, and no box in the world has that exact
    // filename for a quantised build.
    expect(bestMatch("Krea-2-Turbo.safetensors", unet)).toBe("krea2_turbo_fp8.safetensors");
  });

  it("prefers the LEAST embellished candidate, because extra words are extra opinions", () => {
    expect(bestMatch("krea2_turbo.safetensors", unet)).toBe("krea2_turbo_fp8.safetensors");
  });

  it("matches across folders — a model that moved is the same model", () => {
    expect(bestMatch("krea2_turbo_lora_rank_64_bf16.safetensors", ["Krea2\\krea2_turbo_lora_rank_64_bf16.safetensors"])).toBe("Krea2\\krea2_turbo_lora_rank_64_bf16.safetensors");
  });

  it("refuses rather than guessing, because a wrong model that loads is worse than a missing one", () => {
    expect(bestMatch("krea2\\Krea2-realism-V2.safetensors", unet)).toBeUndefined();
    expect(bestMatch("some-model-nobody-has.safetensors", unet)).toBeUndefined();
  });

  it("will not match on a stub of a name", () => {
    expect(bestMatch("v2.safetensors", unet)).toBeUndefined();
  });
});

describe("resolveModels", () => {
  const graph: Graph = {
    "10": { class_type: "UNETLoader", inputs: { unet_name: "Krea-2-Turbo.safetensors", weight_dtype: "default" } },
    "11": { class_type: "CLIPLoader", inputs: { clip_name: "qwen3vl_4b_fp8_scaled.safetensors", type: "krea2" } },
    "12": { class_type: "VAELoader", inputs: { vae_name: "qwen_image_vae.safetensors" } },
    "23": { class_type: "KSampler", inputs: { seed: ["5", 0], steps: 8, model: ["10", 0] } },
  };

  it("rewrites what it can, leaves an exact name alone, and never touches a LINK", () => {
    const r = resolveModels(graph, enumsOf(info));
    expect(r.graph["10"]?.inputs?.unet_name).toBe("krea2_turbo_fp8.safetensors");
    expect(r.graph["11"]?.inputs?.clip_name).toBe("qwen3vl_4b_fp8_scaled.safetensors");
    expect(r.graph["23"]?.inputs?.seed).toEqual(["5", 0]);
    expect(r.substitutions).toEqual([{ nodeId: "10", classType: "UNETLoader", input: "unet_name", from: "Krea-2-Turbo.safetensors", to: "krea2_turbo_fp8.safetensors" }]);
    expect(r.missing).toEqual([]);
  });

  it("does NOT mutate the starter, which is a module constant a second install re-reads", () => {
    const before = JSON.stringify(graph);
    resolveModels(graph, enumsOf(info));
    expect(JSON.stringify(graph)).toBe(before);
  });

  it("reports a model this machine does not have instead of substituting something near it", () => {
    const withLora: Graph = { ...graph, "15": { class_type: "LoraLoaderModelOnly", inputs: { lora_name: "krea2\\Krea2-realism-V2.safetensors", strength_model: 1 } } };
    const r = resolveModels(withLora, enumsOf(info));
    expect(r.missing).toEqual([{ nodeId: "15", classType: "LoraLoaderModelOnly", input: "lora_name", wanted: "krea2\\Krea2-realism-V2.safetensors", options: 1 }]);
    // …and the graph keeps the name it asked for, so the report and the graph agree.
    expect(r.graph["15"]?.inputs?.lora_name).toBe("krea2\\Krea2-realism-V2.safetensors");
  });

  it("leaves a class ComfyUI does not know alone rather than emptying it", () => {
    const custom: Graph = { "99": { class_type: "SomeCustomPackNode", inputs: { model: "whatever.safetensors" } } };
    const r = resolveModels(custom, enumsOf(info));
    expect(r.graph["99"]?.inputs?.model).toBe("whatever.safetensors");
    expect(r.missing).toEqual([]);
  });

  it("says in one line what a person has to do about it", () => {
    expect(resolveSummary({ graph, substitutions: [], missing: [] })).toBe("every model matched exactly");
    const r = resolveModels({ ...graph, "15": { class_type: "LoraLoaderModelOnly", inputs: { lora_name: "nope.safetensors" } } }, enumsOf(info));
    expect(resolveSummary(r)).toContain("1 not installed: nope.safetensors");
    expect(resolveSummary(r)).toContain("1 model matched");
  });
});
