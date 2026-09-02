// The dopesheet: a persistent multitrack timeline under the canvas.
//
// It is a VIEW of the graph, never a second copy of it — `timeline-model` derives every row and
// clip from the nodes on each render, and every edit here goes back through the one mutation
// funnel the canvas uses. So the sheet cannot drift from the cards above it.
//
// What you can do on it, and where each edit lands:
//
//   drag a clip's right edge   → `duration_sec` on the scene row
//   drag a clip sideways       → the CUT (`order_index`), through Calliope's reorder route
//   drag a clip onto a Beat    → `beat_id`, the same write the canvas makes when you drag a
//                                card into a Beat
//   click                      → selects the node, so the inspector and the canvas follow
//   double-click               → frames that node on the canvas
//
// The sideways drag is the one thing the canvas deliberately refuses. `calliope-sync` will not
// infer `order_index` from geometry, because tidying a canvas must never re-cut a film. Here it
// is not an inference: moving a clip along a time axis IS the user saying "this plays later".

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNodes, useReactFlow, useStoreApi } from "@xyflow/react";
import { useActions } from "./actions.js";
import { calliopeRef } from "./calliope-bind.js";
import { useDirector } from "./director-context.js";
import { Icon } from "./icons.js";
import { useJobs, progressFor, renderStatusOf, latestJob } from "./live.js";
import { registerSlot } from "./slots.jsx";
import {
  buildTimeline,
  clock,
  cutIndexAt,
  rulerStep,
  type TimelineClip,
  type TimelineModel,
  type TimelineNode,
  type TimelineRow,
} from "./timeline-model.js";
import "./styles/u21-timeline.css";

const STORE_KEY = "benjidirector/timeline";
const ROW_H = 34;
const HEAD_H = 34;
const RULER_H = 22;
const MIN_H = HEAD_H + RULER_H + ROW_H + 8;
const MAX_H = 520;
const GUTTER = 148;
const MIN_PPS = 1;
const MAX_PPS = 60;
/** Below this a sideways drag is a click that wobbled, not a re-cut. */
const DRAG_SLOP = 4;

interface Prefs {
  height: number;
  open: boolean;
  pps: number | null; // null = fit the film to the track
}
const DEFAULT_PREFS: Prefs = { height: 208, open: true, pps: null };

function readPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return DEFAULT_PREFS;
    const v = JSON.parse(raw) as Partial<Prefs>;
    return {
      height: typeof v.height === "number" ? Math.min(MAX_H, Math.max(MIN_H, v.height)) : DEFAULT_PREFS.height,
      open: v.open !== false,
      pps: typeof v.pps === "number" ? Math.min(MAX_PPS, Math.max(MIN_PPS, v.pps)) : null,
    };
  } catch {
    // A private window, or storage the browser refuses. The sheet still works.
    return DEFAULT_PREFS;
  }
}

const writePrefs = (p: Prefs) => {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(p));
  } catch {
    /* nothing to do: the sheet is not worth an error dialog */
  }
};

/**
 * Everything the sheet reads from a node, as one string.
 *
 * The model is rebuilt only when this changes, so the hundreds of position updates a drag emits
 * do not re-derive the whole film every frame. Position IS in the key, but rounded: the cut
 * falls back to x order for scenes with no `order_index`, and a whole pixel is as fine as that
 * ordering can matter.
 */
function sheetKey(nodes: readonly TimelineNode[]): string {
  const parts: string[] = [];
  for (const n of nodes) {
    const d = n.data as
      | { kind?: string; label?: string; heading?: string; durationSec?: number; orderIndex?: number; bypassed?: boolean; color?: string; videoPath?: string; collapsed?: boolean }
      | undefined;
    if (!d) continue;
    if (d.kind === "scene") {
      parts.push(`s|${n.id}|${n.parentId ?? ""}|${d.heading ?? d.label ?? ""}|${d.durationSec ?? ""}|${d.orderIndex ?? ""}|${d.bypassed ? 1 : 0}|${d.color ?? ""}|${d.videoPath ?? ""}|${n.selected ? 1 : 0}|${Math.round(n.position?.x ?? 0)}`);
    } else if (d.kind === "beat") {
      parts.push(`b|${n.id}|${n.type ?? ""}|${d.label ?? ""}|${d.color ?? ""}|${d.collapsed ? 1 : 0}`);
    }
  }
  return parts.join("\n");
}

/** What a drag is doing, while it is doing it. Never written to the graph until it ends. */
interface Drag {
  id: string;
  kind: "move" | "resize";
  startX: number;
  startY: number;
  x: number;
  y: number;
  /** The clip as it stood when the drag began. */
  clip: TimelineClip;
  moved: boolean;
}

export function TimelineDock() {
  const nodes = useNodes();
  const actions = useActions();
  const jobs = useJobs();
  const { selectedNodeIds } = useDirector();
  const { fitView } = useReactFlow();
  const store = useStoreApi();

  const [prefs, setPrefs] = useState<Prefs>(readPrefs);
  const [trackWidth, setTrackWidth] = useState(720);
  const [playhead, setPlayhead] = useState(0);
  const [drag, setDrag] = useState<Drag | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const key = sheetKey(nodes as unknown as TimelineNode[]);
  // `key` stands in for `nodes` deliberately: every field the model reads is in it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const model: TimelineModel = useMemo(() => buildTimeline(nodes as unknown as TimelineNode[]), [key]);
  const save = useCallback((next: Partial<Prefs>) => {
    setPrefs((cur) => {
      const merged = { ...cur, ...next };
      writePrefs(merged);
      return merged;
    });
  }, []);

  // The track's own width, so "fit" means fit and the ruler is not guessing.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setTrackWidth(el.clientWidth || 720));
    ro.observe(el);
    setTrackWidth(el.clientWidth || 720);
    return () => ro.disconnect();
  }, [prefs.open]);

  const fitPps = model.duration > 0 ? Math.max(MIN_PPS, (trackWidth - GUTTER - 24) / model.duration) : 12;
  const pps = Math.min(MAX_PPS, Math.max(MIN_PPS, prefs.pps ?? fitPps));
  const canvasWidth = Math.max(trackWidth - GUTTER, model.duration * pps + 24);

  // ── edits ───────────────────────────────────────────────────────────────────────────────

  const select = useCallback(
    (id: string, additive: boolean) => {
      const { triggerNodeChanges, nodeLookup } = store.getState();
      const changes = [...nodeLookup.values()].flatMap((n) => {
        const want = n.id === id ? true : additive ? !!n.selected : false;
        return !!n.selected === want ? [] : [{ id: n.id, type: "select" as const, selected: want }];
      });
      if (changes.length) triggerNodeChanges(changes);
    },
    [store],
  );

  const commitResize = useCallback(
    (clip: TimelineClip, seconds: number) => {
      const next = Math.max(1, Math.round(seconds));
      if (next === clip.durationSec) return;
      actions?.updateNode(clip.id, { durationSec: next });
    },
    [actions],
  );

  const commitMove = useCallback(
    (clip: TimelineClip, seconds: number, rowId: string | null) => {
      // A row change is a Beat change; the cut index is read from where the clip was dropped.
      if (rowId && rowId !== clip.rowId && rowId !== "film") {
        actions?.moveToBeat(clip.id, rowId === "loose" ? null : rowId);
        return;
      }
      const to = cutIndexAt(model.clips, clip.id, seconds);
      if (to === clip.cut) return;
      actions?.reorderScene(clip.id, to);
    },
    [actions, model.clips],
  );

  // Pointer capture, so a drag that leaves the dock still ends on this element.
  const onClipDown = useCallback(
    (e: React.PointerEvent, clip: TimelineClip, kind: Drag["kind"]) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      setDrag({ id: clip.id, kind, startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY, clip, moved: false });
    },
    [],
  );

  const onClipMove = useCallback((e: React.PointerEvent) => {
    setDrag((d) => {
      if (!d) return d;
      const moved = d.moved || Math.abs(e.clientX - d.startX) > DRAG_SLOP || Math.abs(e.clientY - d.startY) > DRAG_SLOP;
      return { ...d, x: e.clientX, y: e.clientY, moved };
    });
  }, []);

  const rowAt = useCallback(
    (clientY: number): string | null => {
      const el = scrollRef.current;
      if (!el) return null;
      const top = el.getBoundingClientRect().top + RULER_H - el.scrollTop;
      const i = Math.floor((clientY - top) / ROW_H);
      return model.rows[i]?.id ?? null;
    },
    [model.rows],
  );

  const onClipUp = useCallback(
    (e: React.PointerEvent) => {
      const d = drag;
      setDrag(null);
      if (!d) return;
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        /* the capture is already gone; the drop still counts */
      }
      if (!d.moved) {
        select(d.id, e.shiftKey || e.metaKey || e.ctrlKey);
        return;
      }
      const dSec = (d.x - d.startX) / pps;
      if (d.kind === "resize") commitResize(d.clip, d.clip.durationSec + dSec);
      else commitMove(d.clip, d.clip.start + dSec + d.clip.durationSec / 2, rowAt(d.y));
    },
    [drag, pps, select, commitResize, commitMove, rowAt],
  );

  // A drag the browser cancels (Escape, a lost pointer) must not commit anything.
  useEffect(() => {
    if (!drag) return;
    const cancel = () => setDrag(null);
    window.addEventListener("pointercancel", cancel);
    return () => window.removeEventListener("pointercancel", cancel);
  }, [drag]);

  const onGripDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = prefs.height;
      const move = (ev: PointerEvent) => save({ height: Math.min(MAX_H, Math.max(MIN_H, startH + (startY - ev.clientY))) });
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [prefs.height, save],
  );

  const scrub = useCallback(
    (e: React.PointerEvent) => {
      const el = scrollRef.current;
      if (!el) return;
      const x = e.clientX - el.getBoundingClientRect().left - GUTTER + el.scrollLeft;
      setPlayhead(Math.max(0, Math.min(model.duration, x / pps)));
    },
    [model.duration, pps],
  );

  // ── the sheet ───────────────────────────────────────────────────────────────────────────

  if (!prefs.open) {
    return (
      <section className="bd-tl is-shut" data-testid="timeline">
        <button type="button" className="bd-tl-toggle" onClick={() => save({ open: true })} title="Show the timeline">
          <Icon name="chevronUp" size={13} />
          <span>Timeline</span>
          <span className="bd-tl-total">{clock(model.duration)}</span>
        </button>
      </section>
    );
  }

  const step = rulerStep(model.duration, pps);
  const ticks: number[] = [];
  for (let t = 0; t <= model.duration + step; t += step) ticks.push(t);

  return (
    <section className="bd-tl" style={{ height: prefs.height }} data-testid="timeline">
      <div className="bd-tl-grip" onPointerDown={onGripDown} title="Drag to resize" />
      <header className="bd-tl-head">
        <button type="button" className="bd-tl-caret" onClick={() => save({ open: false })} title="Hide the timeline">
          <Icon name="chevronDown" size={13} />
        </button>
        <Icon name="film" size={13} />
        <span className="bd-tl-title">Timeline</span>
        <span className="bd-tl-total" data-testid="timeline-total">
          {clock(model.duration)}
        </span>
        {model.mutedSec > 0 ? (
          <span className="bd-tl-muted" title="Muted scenes keep their slot here; a render skips them">
            {clock(model.mutedSec)} muted
          </span>
        ) : null}
        <span className="bd-tl-grow" />
        <span className="bd-tl-play" data-testid="timeline-playhead-clock">
          {clock(playhead)}
        </span>
        <button type="button" className="bd-iconbtn" title="Zoom out" onClick={() => save({ pps: Math.max(MIN_PPS, pps / 1.5) })}>
          <Icon name="minus" size={13} />
        </button>
        <button type="button" className="bd-iconbtn" title="Fit the film" onClick={() => save({ pps: null })}>
          <Icon name="maximize" size={13} />
        </button>
        <button type="button" className="bd-iconbtn" title="Zoom in" onClick={() => save({ pps: Math.min(MAX_PPS, pps * 1.5) })}>
          <Icon name="plus" size={13} />
        </button>
      </header>

      {/* ONE scroller. The gutter is sticky inside it rather than a second scrolling column:
          two scrollers would keep their own scrollTop, and the moment a film had more rows than
          the dock is tall the labels would stop lining up with the rows they name. */}
      <div className="bd-tl-body" ref={scrollRef}>
        <div className="bd-tl-inner">
          <div className="bd-tl-gutter" style={{ width: GUTTER }}>
            <div className="bd-tl-rulerpad" style={{ height: RULER_H }} />
            {model.rows.map((row) => (
              <RowHead key={row.id} row={row} selected={!!row.nodeId && selectedNodeIds.includes(row.nodeId)} onSelect={row.nodeId ? () => select(row.nodeId as string, false) : undefined} />
            ))}
          </div>

          <div className="bd-tl-canvas" style={{ width: canvasWidth, height: RULER_H + model.rows.length * ROW_H }}>
            <div className="bd-tl-ruler" style={{ height: RULER_H }} onPointerDown={scrub} onPointerMove={(e) => e.buttons === 1 && scrub(e)}>
              {ticks.map((t) => (
                <span key={t} className="bd-tl-tick" style={{ left: t * pps }}>
                  <i />
                  <b>{clock(t)}</b>
                </span>
              ))}
            </div>

            {model.rows.map((row, i) => (
              <div
                key={row.id}
                className={`bd-tl-row is-${row.kind}${drag?.moved && rowAt(drag.y) === row.id ? " is-drop" : ""}`}
                style={{ top: RULER_H + i * ROW_H, height: ROW_H }}
                data-row={row.id}
              >
                {/* The Beat's own span, drawn behind its clips: the shorter timeline it owns. */}
                {row.kind !== "film" ? <span className="bd-tl-span" style={{ left: row.start * pps, width: Math.max(2, (row.end - row.start) * pps), background: row.color ? `color-mix(in srgb, ${row.color} 18%, transparent)` : undefined }} /> : null}
                {row.clipIds.map((id) => {
                  const clip = model.clips.find((c) => c.id === id);
                  if (!clip) return null;
                  return (
                    <Clip
                      key={id}
                      clip={clip}
                      row={row}
                      pps={pps}
                      jobs={jobs}
                      drag={drag && drag.id === id ? drag : null}
                      onDown={onClipDown}
                      onMove={onClipMove}
                      onUp={onClipUp}
                      onReveal={() => void fitView({ nodes: [{ id }], padding: 0.4, duration: 240 })}
                    />
                  );
                })}
              </div>
            ))}

            <div className="bd-tl-playhead" style={{ left: playhead * pps, height: RULER_H + model.rows.length * ROW_H }} data-testid="timeline-playhead" />
          </div>
        </div>
      </div>
    </section>
  );
}

function RowHead({ row, selected, onSelect }: { row: TimelineRow; selected: boolean; onSelect?: () => void }) {
  const body = (
    <>
      <Icon name={row.kind === "film" ? "film" : row.kind === "beat" ? "layers" : "split"} size={12} />
      <span className="bd-tl-rowname" title={row.label}>
        {row.label}
      </span>
      <span className="bd-tl-rowlen">{clock(row.end - row.start)}</span>
    </>
  );
  const cls = `bd-tl-rowhead is-${row.kind}${selected ? " is-on" : ""}`;
  return onSelect ? (
    <button type="button" className={cls} style={{ height: ROW_H }} onClick={onSelect} data-rowhead={row.id} title={row.collapsed ? `${row.label} — collapsed on the canvas` : row.label}>
      {body}
      {row.collapsed ? <Icon name="chevronRight" size={11} /> : null}
    </button>
  ) : (
    <div className={cls} style={{ height: ROW_H }} data-rowhead={row.id}>
      {body}
    </div>
  );
}

function Clip({
  clip,
  row,
  pps,
  jobs,
  drag,
  onDown,
  onMove,
  onUp,
  onReveal,
}: {
  clip: TimelineClip;
  row: TimelineRow;
  pps: number;
  jobs: ReturnType<typeof useJobs>;
  drag: Drag | null;
  onDown: (e: React.PointerEvent, clip: TimelineClip, kind: Drag["kind"]) => void;
  onMove: (e: React.PointerEvent) => void;
  onUp: (e: React.PointerEvent) => void;
  onReveal: () => void;
}) {
  const status = clip.sceneId !== null ? renderStatusOf(jobs, clip.sceneId, clip.hasClip) : clip.hasClip ? "rendered" : null;
  const job = clip.sceneId !== null && status === "rendering" ? latestJob(jobs, (j) => j.kind === "video" && j.scene_id === clip.sceneId) : undefined;
  const pct = job ? (progressFor(jobs, job.id)?.pct ?? null) : null;

  // The drag is a PREVIEW: nothing is written until the pointer comes up.
  const dSec = drag?.moved ? (drag.x - drag.startX) / pps : 0;
  const left = (clip.start + (drag?.kind === "move" ? dSec : 0)) * pps;
  const width = Math.max(6, (clip.durationSec + (drag?.kind === "resize" ? dSec : 0)) * pps);
  const shown = Math.max(1, Math.round(clip.durationSec + (drag?.kind === "resize" ? dSec : 0)));

  return (
    <div
      className={`bd-tl-clip${clip.selected ? " is-on" : ""}${clip.bypassed ? " is-muted" : ""}${drag ? " is-dragging" : ""}${status ? ` is-${status}` : ""}`}
      style={{ left, width, borderColor: clip.color ?? undefined }}
      data-clip={clip.id}
      data-row={row.id}
      title={`${clip.label} · ${shown}s${status ? ` · ${status}` : ""}\ndrag to re-cut, drag the right edge to re-time`}
      onPointerDown={(e) => onDown(e, clip, "move")}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onReveal();
      }}
    >
      {pct !== null ? <span className="bd-tl-progress" style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} /> : null}
      <span className="bd-tl-cliplabel">{clip.label}</span>
      <span className="bd-tl-clipsec">{shown}s</span>
      <span
        className="bd-tl-handle"
        title="Drag to change this scene's duration"
        data-handle={clip.id}
        onPointerDown={(e) => onDown(e, clip, "resize")}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onDoubleClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}

/** A scene node's Calliope id, or null. Exported for the drive commands. */
export const sceneIdOfNode = (nodeId: string): number | null => {
  const ref = calliopeRef(nodeId);
  return ref?.kind === "scene" ? ref.id : null;
};

registerSlot("footer", TimelineDock, { id: "u21-timeline", order: 10 });
