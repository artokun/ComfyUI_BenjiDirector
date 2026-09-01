// The node palette — a searchable, keyboard-driven picker in the spirit of ifr-node-lab's
// cmdk menu, without the dependency. It opens on right-click, and when a wire is dropped on
// empty canvas so the new node can be auto-wired to what you were dragging.
//
// Matching is a subsequence match ("scn" finds "Scene"), which is what a fuzzy palette feels
// like without a ranking library; ties keep declaration order so the list stays stable.

import { useEffect, useMemo, useRef, useState } from "react";

export interface PaletteItem {
  id: string;
  label: string;
  icon?: string;
  hint?: string;
  group: string;
  disabled?: boolean;
}

export interface PaletteProps {
  x: number;
  y: number;
  title: string;
  items: PaletteItem[];
  onPick(item: PaletteItem): void;
  onClose(): void;
}

function matches(query: string, label: string): boolean {
  const q = query.toLowerCase();
  const l = label.toLowerCase();
  if (!q) return true;
  if (l.includes(q)) return true;
  let i = 0;
  for (const ch of l) if (ch === q[i]) i += 1;
  return i === q.length;
}

export function Palette({ x, y, title, items, onPick, onClose }: PaletteProps) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const visible = useMemo(() => items.filter((it) => matches(query, it.label)), [items, query]);
  const groups = useMemo(() => {
    const m = new Map<string, PaletteItem[]>();
    for (const it of visible) m.set(it.group, [...(m.get(it.group) ?? []), it]);
    return [...m.entries()];
  }, [visible]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    setCursor(0);
  }, [query]);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDoc, true);
    return () => document.removeEventListener("mousedown", onDoc, true);
  }, [onClose]);

  const pick = (it: PaletteItem | undefined) => {
    if (!it || it.disabled) return;
    onPick(it);
  };

  return (
    <div
      ref={rootRef}
      className="bd-palette nodrag nopan"
      style={{ left: x, top: y }}
      onContextMenu={(e) => e.preventDefault()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="bd-palette-head">{title}</div>
      <input
        ref={inputRef}
        className="bd-palette-input"
        placeholder="Search…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setCursor((c) => Math.min(c + 1, Math.max(visible.length - 1, 0)));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setCursor((c) => Math.max(c - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            pick(visible[cursor]);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <div className="bd-palette-list">
        {visible.length === 0 ? <div className="bd-palette-empty">nothing matches</div> : null}
        {groups.map(([group, its]) => (
          <div key={group}>
            <div className="bd-palette-group">{group}</div>
            {its.map((it) => {
              const idx = visible.indexOf(it);
              return (
                <button
                  type="button"
                  key={it.id}
                  className={`bd-palette-item${idx === cursor ? " is-cursor" : ""}${it.disabled ? " is-disabled" : ""}`}
                  disabled={it.disabled}
                  onMouseEnter={() => setCursor(idx)}
                  onClick={() => pick(it)}
                  title={it.hint}
                >
                  <span className="bd-palette-icon">{it.icon ?? "•"}</span>
                  <span className="bd-palette-label">{it.label}</span>
                  {it.hint ? <span className="bd-palette-hint">{it.hint}</span> : null}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
