// The asset picker a media tile opens: tabs, search, and a grid of what this input can accept.
//
// Ported from Calliope's `omni/AssetPickerModal.svelte`. The tabs are filtered by the input's
// media kind — a `(Input:video)` node is offered clips and uploads, never character sheets —
// because a picker that offers a PNG to a LoadVideo node is a 400 waiting to happen.
//
// Rendered as an overlay inside `.bd-root` (absolute, not fixed: the panel's own container has
// a transform, and `fixed` would resolve against it), reusing the modal chrome from modal.tsx.

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../icons.jsx";
import { baseName, mediaKindOfOption, type AssetOption, type MediaKind } from "./types.js";

export type AssetTab = AssetOption["kind"];

const TAB_LABELS: Record<AssetTab, string> = {
  character: "Characters",
  location: "Environments",
  item: "Items",
  clip: "Clips",
  upload: "Uploads",
};

/** Which tabs an input of this media kind may pick from. */
export function tabsForMediaKind(kind: MediaKind): AssetTab[] {
  if (kind === "video") return ["clip", "upload"];
  if (kind === "audio") return ["upload"];
  return ["character", "location", "item", "upload"];
}

/** What a file picker should accept for this media kind. */
export function acceptForKind(kind: MediaKind): string {
  if (kind === "audio") return "audio/*";
  if (kind === "video") return "video/*,.mp4,.webm,.mov,.mkv";
  return "image/*";
}

export interface AssetPickerProps {
  open: boolean;
  title: string;
  assets: AssetOption[];
  /** The path currently set on the input, so the picker can show it as chosen. */
  value?: string;
  mediaKind: MediaKind;
  allowUpload?: boolean;
  uploadingName?: string | null;
  /** A URL the pane can put in an <img>/<video> for a Calliope path. */
  fileUrl(path: string): string;
  onSelect(path: string): void;
  onClear(): void;
  onUpload?(file: File): void;
  onClose(): void;
}

export function AssetPicker({ open, title, assets, value, mediaKind, allowUpload = false, uploadingName = null, fileUrl, onSelect, onClear, onUpload, onClose }: AssetPickerProps) {
  const tabs = useMemo(() => tabsForMediaKind(mediaKind), [mediaKind]);
  const usable = useMemo(() => {
    // The same path can arrive twice (a scene clip that was also uploaded); one tile each.
    const seen = new Set<string>();
    return assets.filter((a) => mediaKindOfOption(a) === mediaKind && !seen.has(a.path) && (seen.add(a.path), true));
  }, [assets, mediaKind]);
  const [tab, setTab] = useState<AssetTab>(tabs[0] ?? "upload");
  const [query, setQuery] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);

  // On OPENING: clear the search and land on the tab holding the current value, else the first
  // tab that has anything in it — an empty tab as the opening view reads as "no assets at all".
  // Keyed on the transition, not on `open`: the asset list is rebuilt by the parent on every
  // render, so an effect that re-ran on identity would wipe what the user had typed.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setQuery("");
      const current = usable.find((a) => a.path === value);
      const withItems = tabs.find((t) => usable.some((a) => a.kind === t));
      setTab((current && tabs.includes(current.kind) ? current.kind : undefined) ?? withItems ?? tabs[0] ?? "upload");
    }
    wasOpen.current = open;
  }, [open, tabs, usable, value]);

  // A workflow swap can turn an image input into a video one while this stays mounted; a tab
  // that is no longer offered would render one list under another list's header.
  useEffect(() => {
    if (tabs.length && !tabs.includes(tab)) setTab(tabs[0] as AssetTab);
  }, [tab, tabs]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, open]);

  if (!open) return null;

  const q = query.trim().toLowerCase();
  const visible = usable.filter((a) => a.kind === tab && (!q || a.label.toLowerCase().includes(q) || baseName(a.path).toLowerCase().includes(q)));
  const countFor = (t: AssetTab) => usable.filter((a) => a.kind === t).length;
  const emptyHint = q
    ? `No matches for “${query.trim()}”.`
    : tab === "character"
      ? "No character sheets yet — generate them in Assets."
      : tab === "location"
        ? "No environment images yet — generate them in Assets."
        : tab === "item"
          ? "No item images yet — generate them in Assets."
          : tab === "clip"
            ? "No scene clips in this film yet."
            : allowUpload
              ? "No uploads yet. Use “Upload new…” below."
              : "No uploads yet.";

  return (
    <div className="bd-modal-backdrop" onPointerDown={onClose}>
      <div className="bd-modal bd-rc-picker" role="dialog" aria-modal="true" aria-label={title} onPointerDown={(e) => e.stopPropagation()}>
        <div className="bd-modal-title">{title}</div>
        <div className="bd-rc-picker-head">
          {tabs.length > 1 ? (
            <div className="bd-rc-picker-tabs" role="tablist" aria-label="Asset type">
              {tabs.map((t) => (
                <button type="button" key={t} role="tab" aria-selected={tab === t} className={`bd-rc-tab${tab === t ? " is-active" : ""}`} onClick={() => setTab(t)}>
                  {TAB_LABELS[t]}
                  <span className="bd-rc-tab-count">{countFor(t)}</span>
                </button>
              ))}
            </div>
          ) : null}
          <label className="bd-rc-search">
            <Icon name="search" />
            <input className="bd-input" placeholder="Search assets…" value={query} aria-label="Search assets" onChange={(e) => setQuery(e.target.value)} />
          </label>
        </div>

        {visible.length ? (
          <div className="bd-rc-grid">
            {visible.map((a) => (
              <button type="button" key={a.id} className={`bd-rc-asset${a.path === value ? " is-on" : ""}`} title={a.path} onClick={() => onSelect(a.path)}>
                <span className="bd-rc-asset-thumb">
                  {mediaKindOfOption(a) === "video" ? (
                    <video className="bd-rc-asset-media" src={`${fileUrl(a.thumbPath ?? a.path)}#t=0.1`} muted playsInline preload="metadata" />
                  ) : mediaKindOfOption(a) === "audio" ? (
                    <Icon name="zap" size={18} />
                  ) : (
                    <img className="bd-rc-asset-media" src={fileUrl(a.thumbPath ?? a.path)} alt="" loading="lazy" />
                  )}
                  {a.path === value ? (
                    <span className="bd-rc-asset-check">
                      <Icon name="check" size={12} />
                    </span>
                  ) : null}
                </span>
                <span className="bd-rc-asset-name">{a.label}</span>
              </button>
            ))}
          </div>
        ) : (
          <p className="bd-hint bd-rc-empty">{emptyHint}</p>
        )}

        <div className="bd-modal-actions bd-rc-picker-actions">
          {allowUpload && onUpload ? (
            <>
              <input
                ref={fileRef}
                type="file"
                className="bd-rc-file"
                accept={acceptForKind(mediaKind)}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) onUpload(file);
                }}
              />
              <button type="button" className="bd-btn" disabled={!!uploadingName} onClick={() => fileRef.current?.click()}>
                <Icon name="upload" /> {uploadingName ? `Uploading ${uploadingName}…` : "Upload new…"}
              </button>
            </>
          ) : null}
          <span className="bd-spacer" />
          <button type="button" className="bd-btn" onClick={onClear} disabled={!value}>
            Clear
          </button>
          <button type="button" className="bd-btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
