// [U22] Resolve a shipped workflow's model names against the ComfyUI it will actually run on.
//
// A workflow in API format hard-codes the FILENAME of every checkpoint, CLIP, VAE and LoRA it
// loads. That name is true on the machine the workflow was exported from and nowhere else:
// Calliope's own examples ask for `Krea-2-Turbo.safetensors`, and this box has the same model
// as `krea2_turbo_fp8_scaled.safetensors`. Shipping a starter workflow without resolving those
// names ships one that fails on the first run with a validation error naming a file the user
// has never heard of.
//
// So before a starter is registered its model references are matched against the enums in
// ComfyUI's own `/object_info` — the same list the node's dropdown shows. What matched exactly
// is left alone, what matched loosely is SUBSTITUTED and reported, and what matched nothing is
// reported as missing rather than quietly registered to fail later.

/** ComfyUI's `/object_info`, as much of it as this module reads. */
export interface ObjectInfo {
  [classType: string]: { input?: { required?: Record<string, unknown>; optional?: Record<string, unknown> } } | undefined;
}

/** A node in an API-format workflow. A value that is an array is a LINK, never a filename. */
export interface GraphNode {
  class_type?: string;
  inputs?: Record<string, unknown>;
  _meta?: { title?: string };
}
export type Graph = Record<string, GraphNode>;

export interface Substitution {
  nodeId: string;
  classType: string;
  input: string;
  from: string;
  to: string;
}

export interface MissingModel {
  nodeId: string;
  classType: string;
  input: string;
  wanted: string;
  /** How many the box does have for that slot, so the message can say "of 14". */
  options: number;
}

export interface ResolveResult {
  graph: Graph;
  substitutions: Substitution[];
  missing: MissingModel[];
}

/**
 * class → input → the values ComfyUI will accept there.
 *
 * An enum input is declared as `[[...options], {…}]`; everything else (`["INT", {…}]`) is a
 * type name and not a list of files. Only the enums can be resolved against, which is exactly
 * right: they are the dropdowns, and a dropdown is where a filename lives.
 */
export function enumsOf(info: ObjectInfo): Map<string, Map<string, string[]>> {
  const out = new Map<string, Map<string, string[]>>();
  for (const [cls, def] of Object.entries(info)) {
    const groups = [def?.input?.required, def?.input?.optional];
    const per = new Map<string, string[]>();
    for (const group of groups) {
      for (const [name, spec] of Object.entries(group ?? {})) {
        if (!Array.isArray(spec) || !Array.isArray(spec[0])) continue;
        const options = (spec[0] as unknown[]).filter((v): v is string => typeof v === "string");
        if (options.length) per.set(name, options);
      }
    }
    if (per.size) out.set(cls, per);
  }
  return out;
}

/** Lowercase, drop the extension, drop every separator. `krea2\Krea-2-Turbo.safetensors` → `krea2krea2turbo`. */
export function squash(name: string): string {
  return name
    .replace(/\.[a-z0-9]+$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/** The basename, squashed — what a match should really be about when the folders differ. */
const squashBase = (name: string): string => squash(name.replace(/^.*[\\/]/, ""));

/**
 * The best candidate for `wanted`, or undefined.
 *
 * Exact first, then the whole squashed name, then the BASENAME squashed — a model that moved
 * into a subfolder is the same model. After that, one squashed name containing the other counts
 * (`krea2turbo` inside `krea2turbofp8scaled` is a quantised build of the model asked for), and
 * the SHORTEST such candidate wins because it is the least embellished. Nothing looser: a
 * wrong model that loads is worse than a missing one that says so.
 */
export function bestMatch(wanted: string, options: readonly string[]): string | undefined {
  if (options.includes(wanted)) return wanted;
  const w = squash(wanted);
  const wb = squashBase(wanted);
  const exact = options.filter((o) => squash(o) === w || squashBase(o) === wb);
  if (exact.length) return exact.sort((a, b) => a.length - b.length)[0];
  if (wb.length < 4) return undefined;
  const containing = options.filter((o) => {
    const ob = squashBase(o);
    return ob.includes(wb) || wb.includes(ob);
  });
  if (!containing.length) return undefined;
  return containing.sort((a, b) => squashBase(a).length - squashBase(b).length || a.length - b.length)[0];
}

/**
 * Rewrite a graph's model references to names this ComfyUI has.
 *
 * The graph is copied, never mutated: a starter is a module-level constant and a second install
 * must see the shipped names, not the last box's.
 */
export function resolveModels(graph: Graph, enums: ReadonlyMap<string, ReadonlyMap<string, string[]>>): ResolveResult {
  const substitutions: Substitution[] = [];
  const missing: MissingModel[] = [];
  const out: Graph = {};
  for (const [nodeId, node] of Object.entries(graph)) {
    const cls = node.class_type ?? "";
    const per = enums.get(cls);
    if (!per || !node.inputs) {
      out[nodeId] = node;
      continue;
    }
    const inputs: Record<string, unknown> = { ...node.inputs };
    for (const [name, value] of Object.entries(node.inputs)) {
      // An array is a LINK to another node, never a filename.
      if (typeof value !== "string") continue;
      const options = per.get(name);
      if (!options) continue;
      if (options.includes(value)) continue;
      const hit = bestMatch(value, options);
      if (hit) {
        inputs[name] = hit;
        substitutions.push({ nodeId, classType: cls, input: name, from: value, to: hit });
      } else {
        missing.push({ nodeId, classType: cls, input: name, wanted: value, options: options.length });
      }
    }
    out[nodeId] = { ...node, inputs };
  }
  return { graph: out, substitutions, missing };
}

/**
 * ComfyUI's `/object_info`, from the origin the panel is served by.
 *
 * The panel runs INSIDE ComfyUI, so a relative path reaches the right server without anyone
 * configuring anything — and without a cross-origin request ComfyUI does not allow by default.
 * `base` is for the dev harness and for the day the panel is served from somewhere else.
 */
export async function fetchObjectInfo(base = "", fetchImpl: typeof fetch = fetch): Promise<ObjectInfo> {
  const res = await fetchImpl(`${base.replace(/\/$/, "")}/object_info`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`ComfyUI did not answer /object_info (${res.status})`);
  return (await res.json()) as ObjectInfo;
}

/** One line a human can act on: what was swapped, and what is not on this machine. */
export function resolveSummary(r: ResolveResult): string {
  const parts: string[] = [];
  if (r.substitutions.length) parts.push(`${r.substitutions.length} model${r.substitutions.length === 1 ? "" : "s"} matched to what this ComfyUI has`);
  if (r.missing.length) parts.push(`${r.missing.length} not installed: ${r.missing.map((m) => m.wanted).join(", ")}`);
  return parts.join(" · ") || "every model matched exactly";
}
