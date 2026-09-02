// The agent's side of the leaf chrome: `set_bypassed`, `set_node_color`, `set_node_collapsed`
// (names frozen in docs/drive-commands.md). Each runs through the kit — `run` hands over the
// CURRENT graph and snapshots for undo, `settle` is the one mutation funnel — so a command
// can do exactly what the toolbar button does and nothing the toolbar cannot.

import { registerDriveCommands, type DriveKit, type RFNode } from "./drive-registry.js";
import { bool, isLeaf, isTintable, normalizeHex, patchLeaf } from "./node-chrome.js";

/** A scene or an asset by id; a Beat, note or reroute is refused, naming the right verb. */
function leafOf(kit: DriveKit, ns: RFNode[], id: unknown, verb: string): RFNode {
  const n = kit.find(ns, id);
  if (kit.isContainer(n)) throw new Error(`"${n.id}" is a Beat — ${verb} applies to scenes and assets (Beats take set_color / set_collapsed)`);
  if (!isLeaf(n.data)) throw new Error(`"${n.id}" is a ${n.data.kind} — ${verb} applies to scenes and assets`);
  return n;
}

registerDriveCommands({
  set_bypassed: (args, kit) =>
    kit.run((ns, es) => {
      const n = leafOf(kit, ns, args.id, "bypass");
      const bypassed = bool(args.bypassed, "bypassed");
      kit.settle(patchLeaf(ns, n.id, { bypassed }), es, { reparent: false });
      return { id: n.id, bypassed };
    }),

  set_node_color: (args, kit) =>
    kit.run((ns, es) => {
      const n = kit.find(ns, args.id);
      if (kit.isContainer(n)) throw new Error(`"${n.id}" is a Beat — Beats take set_color`);
      if (!isTintable(n.data)) throw new Error(`"${n.id}" is a ${n.data.kind} — it has no header to tint`);
      let color: string | undefined;
      if (args.color !== null && args.color !== undefined) {
        const hex = normalizeHex(kit.str(args.color, "color"));
        if (!hex) throw new Error(`color must be a hex colour like #60a5fa (or null to clear), not "${String(args.color)}"`);
        color = hex;
      }
      kit.settle(patchLeaf(ns, n.id, { color }), es, { reparent: false });
      return { id: n.id, color: color ?? null };
    }),

  set_node_collapsed: (args, kit) =>
    kit.run((ns, es) => {
      const n = leafOf(kit, ns, args.id, "collapse-to-header");
      const collapsed = bool(args.collapsed, "collapsed");
      kit.settle(patchLeaf(ns, n.id, { collapsed }), es, { reparent: false });
      return { id: n.id, collapsed };
    }),
});
