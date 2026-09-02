// Selection ergonomics and the minimap (U8a).
//
// Three things, all reachable without editing the editor: a floating pill over the canvas that
// says what is selected and offers the two things you always want next (wrap it, look at it), a
// Snap/Fit pair in the toolbar, and the minimap React Flow needs rendered as its own child.
//
// The pill is a VIEW. Every button it has goes through `drive`, the same entry point the agent
// uses, so a wrap done by hand and a wrap done by a tool call are the same wrap. The pure half
// — colours, labels, the marquee rule, the snap switch — is `selection-model.ts`, under test.

import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { MiniMap, useReactFlow, useStoreApi } from "@xyflow/react";
import { GROUP_TYPE, SUBGRAPH_TYPE } from "@benjidirector/graph-core";
import { useDirector } from "./director-context.jsx";
import { registerDriveCommands, type DriveArgs, type DriveHandler, type DriveKit } from "./drive-registry.js";
import { Icon, type IconName } from "./icons.jsx";
import { registerSlot } from "./slots.jsx";
import {
  describeSelection,
  marqueeOvercatch,
  minimapNodeClass,
  paneRectToFlow,
  toggleSnap,
  useSnapToGrid,
  type Box,
  type MarqueeCandidate,
} from "./selection-model.js";
import "./styles/u8a-selection-minimap.css";

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const isBeatType = (type: string | undefined): boolean => type === GROUP_TYPE || type === SUBGRAPH_TYPE;
const frame = (): Promise<void> =>
  new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });

type FitOpts = { nodes?: { id: string }[]; padding?: number; duration?: number };

/**
 * `fitView` lives on a hook, and a drive command is a module-level function. The canvas overlay
 * publishes the current one here while it is mounted; a command that arrives before the editor
 * has painted says so rather than reaching for a stale instance.
 */
let fitViewFn: ((opts?: FitOpts) => Promise<boolean>) | null = null;

// ── the floating pill ────────────────────────────────────────────────────────────────────

/**
 * A marquee in PARTIAL mode selects everything the box touches — and a box drawn around the
 * scenes inside a Beat always touches the Beat. Selecting the container as well as its children
 * is never what the drag meant: "group these two" would become "group the Beat". So when the
 * marquee ends, a container the box did not swallow WHOLE is let go again, and the leaves stay.
 */
function useMarqueeDiscipline(): void {
  const store = useStoreApi();
  useEffect(() => {
    let pending: Box | null = null;
    let raf = 0;
    const correct = (box: Box) => {
      const { transform, nodeLookup, triggerNodeChanges } = store.getState();
      const flow = paneRectToFlow(box, transform);
      const candidates: MarqueeCandidate[] = [];
      for (const node of nodeLookup.values()) {
        if (!node.selected || !isBeatType(node.type)) continue;
        candidates.push({
          id: node.id,
          selected: true,
          strict: true,
          box: {
            x: node.internals.positionAbsolute.x,
            y: node.internals.positionAbsolute.y,
            width: node.measured?.width ?? 0,
            height: node.measured?.height ?? 0,
          },
        });
      }
      const drop = marqueeOvercatch(flow, candidates);
      if (drop.length) triggerNodeChanges(drop.map((id) => ({ id, type: "select" as const, selected: false })));
    };
    const unsubscribe = store.subscribe((s) => {
      if (s.userSelectionRect) {
        const { x, y, width, height } = s.userSelectionRect;
        pending = { x, y, width, height };
        return;
      }
      const box = pending;
      pending = null;
      // A click, not a drag: React Flow's own click path already set the selection.
      if (!box || box.width < 3 || box.height < 3) return;
      // One frame, so the selection changes the marquee dispatched have landed on the graph
      // before the correction reads back which nodes came out of it selected.
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => correct(box));
    });
    return () => {
      cancelAnimationFrame(raf);
      unsubscribe();
    };
  }, [store]);
}

function PillButton({ onClick, title, icon, children, primary }: { onClick: () => void; title: string; icon: IconName; children: ReactNode; primary?: boolean }) {
  return (
    <button type="button" className={primary ? "bd-selpill-btn is-primary" : "bd-selpill-btn"} title={title} onClick={onClick}>
      <Icon name={icon} /> {children}
    </button>
  );
}

function SelectionOverlay() {
  const { selectedNodeIds, setNote, drive } = useDirector();
  const { fitView } = useReactFlow();
  useMarqueeDiscipline();

  // Publish fitView for the drive commands, for as long as the canvas is up.
  const fitRef = useRef(fitView);
  fitRef.current = fitView;
  useEffect(() => {
    const fn = (opts?: FitOpts) => fitRef.current(opts);
    fitViewFn = fn;
    return () => {
      if (fitViewFn === fn) fitViewFn = null;
    };
  }, []);

  const ids = selectedNodeIds;
  const fail = useCallback((e: unknown) => setNote(message(e)), [setNote]);

  const onGroup = useCallback(() => {
    void drive("group", { node_ids: ids }).catch(fail);
  }, [drive, fail, ids]);

  const onSubgraph = useCallback(() => {
    void (async () => {
      const made = (await drive("group", { node_ids: ids })) as { id?: unknown } | null;
      const id = typeof made?.id === "string" ? made.id : null;
      if (!id) throw new Error("the Beat was not created");
      // `group` returns as soon as the mutation is QUEUED, so the Beat is not on the canvas
      // yet. Wait until the editor has it before asking for the promote — a settle is a render
      // away, and the alternative is a promote that cannot find its own container.
      for (let i = 0; i < 30; i++) {
        try {
          await drive("read_node", { id });
          break;
        } catch {
          await frame();
        }
      }
      await drive("promote", { id });
    })().catch(fail);
  }, [drive, fail, ids]);

  const onFit = useCallback(() => {
    void drive("fit_view", { ids }).catch(fail);
  }, [drive, fail, ids]);

  if (!ids.length) return null;
  return (
    <div className="bd-selpill" data-testid="selection-pill" role="toolbar" aria-label="Selection">
      <span className="bd-selpill-count">{describeSelection(ids.length)}</span>
      <span className="bd-selpill-sep" />
      <PillButton onClick={onGroup} title="Wrap the selection in a new Beat" icon="layers">
        Group
      </PillButton>
      <PillButton onClick={onSubgraph} title="Wrap the selection in a Beat and promote it — its crossings become rails" icon="split">
        Subgraph
      </PillButton>
      <PillButton onClick={onFit} title="Frame the selection" icon="maximize" primary>
        Fit
      </PillButton>
    </div>
  );
}

// ── toolbar: the snap switch, and fit-all ────────────────────────────────────────────────

function SnapAndFit() {
  const snap = useSnapToGrid();
  const { setNote, drive } = useDirector();
  return (
    <>
      <button
        type="button"
        className={snap ? "bd-snap-toggle is-on" : "bd-snap-toggle"}
        aria-pressed={snap}
        title={snap ? "Snap to the 18px grid: on" : "Snap to the 18px grid: off"}
        onClick={() => toggleSnap()}
      >
        <Icon name="grid" /> Snap
      </button>
      <button type="button" title="Frame every node" onClick={() => void drive("fit_view").catch((e) => setNote(message(e)))}>
        <Icon name="maximize" /> Fit all
      </button>
    </>
  );
}

// ── the minimap, rendered by DirectorApp as a child of <ReactFlow> ───────────────────────

/**
 * Node colour is a CLASS, not a fill: the stylesheet maps each to a `--bd-*` token, so the
 * minimap follows the theme instead of freezing three hex values into a component.
 */
export function DirectorMiniMap() {
  return (
    <MiniMap
      className="bd-minimap"
      nodeClassName={minimapNodeClass}
      nodeBorderRadius={3}
      pannable
      zoomable
      ariaLabel="Canvas minimap"
    />
  );
}

// ── drive ────────────────────────────────────────────────────────────────────────────────

function idList(args: DriveArgs, kit: DriveKit, key: string): string[] {
  const raw = args[key];
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error(`${key} must be an array of node ids`);
  return (raw as unknown[]).map((v) => kit.str(v, `${key}[]`));
}

const fit_view: DriveHandler = async (args, kit) => {
  const ids = idList(args, kit, "ids");
  if (!fitViewFn) throw new Error("the canvas is not mounted yet");
  if (!ids.length) {
    await fitViewFn({ padding: 0.18, duration: 240 });
    return { fitted: "all" };
  }
  const known = new Set(kit.nodesRef.current.map((n) => n.id));
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length) throw new Error(`no node "${missing[0]}" — read the outline for ids`);
  await fitViewFn({ nodes: ids.map((id) => ({ id })), padding: 0.25, duration: 240 });
  return { fitted: ids };
};

// `select` is U3's (`clipboard.drive.ts`) — ONE implementation, not two that must be kept
// identical. Two copies returning different keys is what made the agent surface's result shape
// depend on module load order.
registerDriveCommands({ fit_view });

registerSlot("canvas-overlay", SelectionOverlay, { id: "u8a-selection", order: 20 });
registerSlot("toolbar-right", SnapAndFit, { id: "u8a-snap-fit", order: 40 });
