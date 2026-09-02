// [U22] The workflows the Director ships, and installing them into Calliope.
//
// Calliope renders nothing until a workflow is registered, and registering one by hand means
// exporting API-format JSON from ComfyUI, finding Calliope's Settings → Workflows, and knowing
// that a node's TITLE is what makes it an input. That is a wall between opening the panel and
// seeing a picture, so the panel ships past it: one image workflow, built from core ComfyUI
// nodes only, with its model names resolved to whatever this machine actually has.
//
// Core nodes only is the load-bearing constraint. A starter that needed a custom pack would
// fail on a fresh install with an error about a node the user has never installed — every class
// below (UNETLoader, CLIPLoader, VAELoader, CLIPTextEncode, EmptyLatentImage, KSampler,
// VAEDecode, SaveImage, and the Primitive* value nodes) is built into ComfyUI.
//
// The tagged Primitive nodes are not decoration. Calliope reads a workflow's inputs from node
// TITLES — `(Input:prompt)` — and takes each one's default from `inputs.value` / `.text`, so a
// role needs its own value node. Wiring width and height straight onto the latent would give
// Calliope one node with two roles, which it cannot express.

import type { CalliopeClient, WorkflowRow } from "@benjidirector/calliope-client";
import { enumsOf, resolveModels, type Graph, type MissingModel, type ObjectInfo, type Substitution } from "./comfy-models.js";
import assetReference from "./workflows/asset-reference.json" with { type: "json" };

export interface Starter {
  /** Stable id, so a second install can recognise what it already registered. */
  id: string;
  name: string;
  kind: "image" | "video";
  description: string;
  graph: Graph;
}

export const STARTERS: readonly Starter[] = [
  {
    id: "bd-asset-reference",
    name: "Director · Asset reference",
    kind: "image",
    description:
      "Text to image for character sheets, location plates and item references. Prompt, negative, width, height and seed are its inputs; it saves one image.",
    graph: assetReference as unknown as Graph,
  },
];

export interface InstalledStarter {
  starter: Starter;
  workflow: WorkflowRow | null;
  substitutions: Substitution[];
  missing: MissingModel[];
  error: string | null;
  /** It was already registered under this name, so nothing was created. */
  skipped: boolean;
}

export interface InstallReport {
  installed: InstalledStarter[];
  /** True when at least one enabled image workflow now exists. */
  ready: boolean;
}

/** Calliope's name for a starter, and how a re-install recognises it. */
export const starterName = (s: Starter): string => s.name;

/**
 * Register every starter this Calliope does not already have.
 *
 * A starter whose models are MISSING is not registered. Registering it would put a workflow in
 * the picker that fails at render time with a validation error naming a file the user does not
 * have — the report says what to download instead, which is a thing a person can act on.
 */
export async function installStarters(
  client: CalliopeClient,
  info: ObjectInfo,
  opts: { existing?: readonly WorkflowRow[]; only?: readonly string[] } = {},
): Promise<InstallReport> {
  const enums = enumsOf(info);
  const existing = opts.existing ?? ((await client.workflows.list()) as WorkflowRow[]);
  const byName = new Set(existing.map((w) => w.name));
  const installed: InstalledStarter[] = [];

  for (const starter of STARTERS) {
    if (opts.only && !opts.only.includes(starter.id)) continue;
    const resolved = resolveModels(starter.graph, enums);
    if (byName.has(starterName(starter))) {
      installed.push({ starter, workflow: null, substitutions: resolved.substitutions, missing: resolved.missing, error: null, skipped: true });
      continue;
    }
    if (resolved.missing.length) {
      installed.push({
        starter,
        workflow: null,
        substitutions: resolved.substitutions,
        missing: resolved.missing,
        error: `not registered — this ComfyUI has no ${resolved.missing.map((m) => m.wanted).join(", ")}`,
        skipped: false,
      });
      continue;
    }
    try {
      // Analyze FIRST — not to send the result (Calliope derives the schema itself on create)
      // but because it is the one call that says whether Calliope can READ this graph. A
      // starter it cannot find an input or an output in would register and then render nothing,
      // and the failure would surface much later wearing a different face.
      const analysis = (await client.workflows.analyze({ workflow_json: resolved.graph as unknown as Record<string, unknown> })) as {
        inputs?: unknown[];
        outputs?: unknown[];
      };
      if (!analysis.inputs?.length || !analysis.outputs?.length) {
        throw new Error(`Calliope read no ${!analysis.inputs?.length ? "inputs" : "outputs"} from the graph — its (Input:role) titles did not survive`);
      }
      const row = (await client.workflows.create({
        name: starterName(starter),
        kind: starter.kind,
        description: starter.description,
        workflow_json: resolved.graph as unknown as Record<string, unknown>,
      } as never)) as WorkflowRow;
      installed.push({ starter, workflow: row, substitutions: resolved.substitutions, missing: [], error: null, skipped: false });
    } catch (err) {
      installed.push({
        starter,
        workflow: null,
        substitutions: resolved.substitutions,
        missing: resolved.missing,
        error: err instanceof Error ? err.message : String(err),
        skipped: false,
      });
    }
  }

  const after = (await client.workflows.list()) as WorkflowRow[];
  return { installed, ready: after.some((w) => w.kind === "image" && w.is_enabled !== false) };
}

/** What to tell a human after an install. One line per starter, no jargon. */
export function installSummary(report: InstallReport): string {
  const lines = report.installed.map((i) => {
    if (i.skipped) return `${i.starter.name}: already registered`;
    if (i.error) return `${i.starter.name}: ${i.error}`;
    const swapped = i.substitutions.length ? ` (${i.substitutions.map((s) => `${s.from} → ${s.to}`).join(", ")})` : "";
    return `${i.starter.name}: registered${swapped}`;
  });
  return lines.join("\n");
}
