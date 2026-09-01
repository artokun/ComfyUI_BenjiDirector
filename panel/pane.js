// The Director's side-panel content-provider.
//
// This is the whole of BenjiDirector's contact surface with comfyui-mcp-panel. The panel's
// side-panel shell (`web/js/cmcp-sidepanel-ui.js`) owns the overlay, the tab bar, the search
// row, the dock, the ✕, Escape and backdrop close; a provider supplies the body and nothing
// else. CivitAI, Apps, Training and RunPod are all the same shape — this one just lives in a
// different repo.
//
// The contract, verbatim from the shell's own header:
//   { key, label, icon, hasSearch, searchPlaceholder, mount(bodyEl), onSearch(v, opts),
//     subnavExtras(), drive, driveKind, update(), onActivate(), onDeactivate(),
//     teardown(), escapeBlocked() }
//
// TWO TRAPS THAT COST OTHER PROVIDERS TIME — both are silent:
//
//   1. `label` MUST be lazy. The shell's TABS array is built at module scope, which runs at
//      import time, BEFORE the i18n catalog has loaded. A plain string captures the English
//      fallback permanently and no translation can ever appear, however complete the catalog
//      gets. The shell uses a getter; the module manifest uses a function. Either defers the
//      lookup to the moment it is read, which is the point.
//
//   2. Everything the agent can reach goes through `drive`, and the shell gates it on the
//      ACTIVE tab's `driveKind`. That means a drive call doubles as an is-it-open probe: the
//      throw is load-bearing, not an inconvenience. Do not soften it into a no-op.

/**
 * @param {object} ctx   host capability bag (api, callTool, marked, DOMPurify, openUrl, …)
 * @param {object} shell { body, searchEl, subnav, close, applyDock, switchTab, isDocked, … }
 * @param {object} opts  per-open seed passed through `tabOpts`
 */
export function createDirectorContent(ctx, shell, opts = {}) {
  let handle = null;
  let mountEl = null;

  /** Refuse in the shell's own idiom: a sentence a person can act on. */
  const notMounted = () => {
    throw new Error("director pane not open");
  };

  return {
    key: "director",
    // Resolved by the host against its catalog; never a captured literal. See trap 1.
    label: "Director",
    icon: "pi-video",
    driveKind: "director",
    hasSearch: false,

    mount(bodyEl) {
      mountEl = bodyEl;
      // Phase 3: dynamic-import the vendored bundle and call mountDirector(bodyEl, …).
      // Kept lazy so opening a DIFFERENT tab never pays for React.
    },

    onActivate() {},
    onDeactivate() {},

    teardown() {
      try {
        handle?.teardown?.();
      } finally {
        handle = null;
        mountEl = null;
      }
    },

    // The agent-facing surface. Every method must tolerate being called when the pane was
    // closed underneath it — the orchestrator unmounts these tools on close, but a call
    // already in flight can still land.
    drive: {
      outline: (...a) => (handle ? handle.drive.outline(...a) : notMounted()),
    },
  };
}
