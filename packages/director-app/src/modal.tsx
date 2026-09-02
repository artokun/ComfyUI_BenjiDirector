// One modal for everyone: confirm, prompt, choose.
//
// Rendered inside `.bd-root` (absolute, not fixed — the panel's own overlay has a transform,
// and `position: fixed` resolves against it). Promise-based so callers read like a sentence:
//   if (!(await modal.confirm({ title: "Delete Beat 1?", danger: true }))) return;
//
// [U3] "Inside .bd-root" is a PORTAL, not a hope: the provider wraps the root rather than
// living in it, so rendering the view in place put it under <body>, where not one `--bd-*`
// token resolves — measured: backdrop and panel `rgba(0,0,0,0)`, text `rgb(0,0,0)`, an
// invisible dialog over the canvas. The tokens are declared ON `.bd-root`, so the view has to
// be a descendant of it to be styled at all.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}
export interface PromptOptions {
  title: string;
  body?: ReactNode;
  label?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
}
export interface ChooseOption {
  id: string;
  label: string;
  hint?: string;
  danger?: boolean;
}
export interface ChooseOptions {
  title: string;
  body?: ReactNode;
  options: ChooseOption[];
  cancelLabel?: string;
}

export interface ModalApi {
  confirm(o: ConfirmOptions): Promise<boolean>;
  prompt(o: PromptOptions): Promise<string | null>;
  choose(o: ChooseOptions): Promise<string | null>;
}

type Pending =
  | { kind: "confirm"; o: ConfirmOptions; resolve: (v: boolean) => void }
  | { kind: "prompt"; o: PromptOptions; resolve: (v: string | null) => void }
  | { kind: "choose"; o: ChooseOptions; resolve: (v: string | null) => void };

const ModalContext = createContext<ModalApi | null>(null);

/** The modal API. Outside a provider every call resolves to "cancelled" rather than throwing. */
export function useModal(): ModalApi {
  const api = useContext(ModalContext);
  return useMemo(
    () =>
      api ?? {
        confirm: async () => false,
        prompt: async () => null,
        choose: async () => null,
      },
    [api],
  );
}

export function ModalProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const queue = useRef<Pending[]>([]);
  const next = useCallback(() => setPending(queue.current.shift() ?? null), []);
  const enqueue = useCallback(
    (p: Pending) => {
      queue.current.push(p);
      setPending((cur) => cur ?? queue.current.shift() ?? null);
    },
    [],
  );
  const api = useMemo<ModalApi>(
    () => ({
      confirm: (o) => new Promise((resolve) => enqueue({ kind: "confirm", o, resolve })),
      prompt: (o) => new Promise((resolve) => enqueue({ kind: "prompt", o, resolve })),
      choose: (o) => new Promise((resolve) => enqueue({ kind: "choose", o, resolve })),
    }),
    [enqueue],
  );
  const finish = useCallback(
    (value: unknown) => {
      const p = pending;
      if (!p) return;
      (p.resolve as (v: unknown) => void)(value);
      next();
    },
    [next, pending],
  );
  return (
    <ModalContext.Provider value={api}>
      {children}
      {pending ? <ModalView pending={pending} finish={finish} /> : null}
    </ModalContext.Provider>
  );
}

function ModalView({ pending, finish }: { pending: Pending; finish: (v: unknown) => void }) {
  const [text, setText] = useState(pending.kind === "prompt" ? (pending.o.defaultValue ?? "") : "");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        finish(pending.kind === "confirm" ? false : null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [finish, pending.kind]);
  const cancel = () => finish(pending.kind === "confirm" ? false : null);
  // The root is in the DOM before any modal can open (the provider's children rendered on
  // mount), so this resolves on the first render that has something to show. No root — a unit
  // test rendering the provider alone — falls back to rendering in place.
  const host = typeof document === "undefined" ? null : document.querySelector(".bd-root");
  const view = (
    <div className="bd-modal-backdrop" onPointerDown={cancel}>
      <div className="bd-modal" role="dialog" aria-modal="true" onPointerDown={(e) => e.stopPropagation()}>
        <div className="bd-modal-title">{pending.o.title}</div>
        {pending.o.body ? <div className="bd-modal-body">{pending.o.body}</div> : null}
        {pending.kind === "prompt" ? (
          <label className="bd-modal-field">
            {pending.o.label ? <span>{pending.o.label}</span> : null}
            <input
              className="bd-input"
              autoFocus
              value={text}
              placeholder={pending.o.placeholder}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") finish(text.trim() || null);
              }}
            />
          </label>
        ) : null}
        {pending.kind === "choose" ? (
          <div className="bd-modal-choices">
            {pending.o.options.map((opt) => (
              <button type="button" key={opt.id} className={`bd-btn${opt.danger ? " is-danger" : ""}`} onClick={() => finish(opt.id)}>
                <span>{opt.label}</span>
                {opt.hint ? <span className="bd-hint">{opt.hint}</span> : null}
              </button>
            ))}
          </div>
        ) : null}
        <div className="bd-modal-actions">
          <button type="button" className="bd-btn" onClick={cancel}>
            {(pending.kind === "choose" ? pending.o.cancelLabel : pending.kind === "confirm" ? pending.o.cancelLabel : undefined) ?? "Cancel"}
          </button>
          {pending.kind === "confirm" ? (
            <button type="button" className={`bd-btn is-primary${pending.o.danger ? " is-danger" : ""}`} autoFocus onClick={() => finish(true)}>
              {pending.o.confirmLabel ?? "OK"}
            </button>
          ) : null}
          {pending.kind === "prompt" ? (
            <button type="button" className="bd-btn is-primary" onClick={() => finish(text.trim() || null)}>
              {pending.o.confirmLabel ?? "OK"}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
  return host ? createPortal(view, host) : view;
}
