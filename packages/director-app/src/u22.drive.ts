// [U22] Assets, for the agent.
//
// The same three verbs the panel's buttons call, so a person and the agent reach one
// implementation: install the shipped workflows, ask what this ComfyUI can render, and queue
// an image for a character, location or item.
//
// `assets_generate` already existed as a raw `calliope` passthrough. It gets a name here
// because the passthrough makes the agent responsible for knowing the route, the body shape and
// which workflow is an enabled image one — three things it can get wrong silently. This asks
// for a NODE and does the rest.

import { calliopeRef } from "./calliope-bind.js";
import { fetchObjectInfo, resolveModels, enumsOf } from "./comfy-models.js";
import { registerDriveCommands, type DriveHandler } from "./drive-registry.js";
import { installStarters, installSummary, STARTERS } from "./starter-workflows.js";
import type { AssetData } from "./model.js";
import { imageWorkflows } from "./asset-jobs.js";
import type { WorkflowRow } from "@benjidirector/calliope-client";

/** `character` | `location` | `item` from a node, so the agent names a card, not a table. */
function entityOf(node: { id: string; data: unknown }): { kind: "character" | "location" | "item"; id: number } {
  const d = node.data as AssetData;
  if (d?.kind !== "asset") throw new Error("that node is not a character, location or item");
  const ref = calliopeRef(node.id);
  if (!ref || ref.kind === "scene" || ref.kind === "beat") throw new Error(`${d.label} has no Calliope row yet — it is on the canvas only`);
  return { kind: ref.kind, id: ref.id };
}

/**
 * Register the shipped workflows, resolving their model names against this ComfyUI.
 *
 * Reports what it swapped and what is not installed rather than returning a bare "ok": the
 * agent's next sentence to the user is only as good as what it is told here.
 */
const install_workflows: DriveHandler = async (_args, kit) => {
  const info = await fetchObjectInfo();
  const report = await installStarters(kit.client, info);
  kit.setNote(report.ready ? "the starter workflow is registered — assets can generate" : "no image workflow is registered");
  return {
    ready: report.ready,
    summary: installSummary(report),
    installed: report.installed.map((i) => ({
      name: i.starter.name,
      registered: !!i.workflow,
      workflow_id: i.workflow?.id ?? null,
      skipped: i.skipped,
      error: i.error,
      substitutions: i.substitutions.map((s) => ({ from: s.from, to: s.to })),
      missing: i.missing.map((m) => m.wanted),
    })),
  };
};

/**
 * What this machine can render right now: the enabled image workflows, and — for each shipped
 * starter that is NOT registered — whether its models are even here.
 */
const workflows_status: DriveHandler = async (_args, kit) => {
  const rows = (await kit.client.workflows.list()) as WorkflowRow[];
  const images = imageWorkflows(rows);
  let enums: ReturnType<typeof enumsOf> | null = null;
  try {
    enums = enumsOf(await fetchObjectInfo());
  } catch {
    // ComfyUI is not answering; the registered list is still worth reporting.
  }
  return {
    registered: rows.map((w) => ({ id: w.id, name: w.name, kind: w.kind, enabled: w.is_enabled !== false })),
    image_ready: images.length > 0,
    starters: STARTERS.map((s) => {
      const known = rows.some((w) => w.name === s.name);
      const check = enums ? resolveModels(s.graph, enums) : null;
      return {
        id: s.id,
        name: s.name,
        registered: known,
        missing_models: check ? check.missing.map((m) => m.wanted) : null,
        substitutions: check ? check.substitutions.map((x) => ({ from: x.from, to: x.to })) : null,
      };
    }),
  };
};

/**
 * Queue an image for one asset node, or for every one that has none.
 *
 * `id` names a node. Without it, every character, location and item missing an image is
 * queued — the panel's "Generate all missing", reached by name.
 */
const generate_asset: DriveHandler = async (args, kit) => {
  const pid = kit.loadedProjectRef.current;
  if (pid === null) throw new Error("no Calliope project is open — nothing here has a row to render into");
  const rows = (await kit.client.workflows.list()) as WorkflowRow[];
  const wf = imageWorkflows(rows)[0];
  if (!wf) throw new Error("no enabled image workflow — run install_workflows first");

  if (args.id === undefined || args.id === null) {
    const body = { missing_only: true, asset_target: "sheet" as const, workflow_id: wf.id };
    await kit.client.assets.generate(pid, body as never);
    kit.setNote(`queued images for everything without one, with "${wf.name}"`);
    await kit.refreshProject();
    return { queued: "all-missing", workflow_id: wf.id };
  }

  const node = kit.find(kit.nodesRef.current, args.id);
  const { kind, id } = entityOf(node);
  const body: Record<string, unknown> = {
    missing_only: false,
    asset_target: "sheet",
    workflow_id: wf.id,
    character_ids: kind === "character" ? [id] : [],
    location_ids: kind === "location" ? [id] : [],
    item_ids: kind === "item" ? [id] : [],
  };
  if (typeof args.prompt === "string" && args.prompt.trim()) body.prompt = args.prompt;
  await kit.client.assets.generate(pid, body as never);
  kit.setNote(`queued an image for ${(node.data as AssetData).label}`);
  await kit.refreshProject();
  return { queued: node.id, kind, calliope_id: id, workflow_id: wf.id };
};

registerDriveCommands({ install_workflows, workflows_status, generate_asset });
