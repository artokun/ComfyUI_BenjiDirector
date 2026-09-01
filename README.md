# BenjiDirector

An agent-driven long-form video editor, as a module inside the
[ComfyUI MCP agent panel](https://github.com/artokun/comfyui-mcp-panel).

You get a **nested scene graph** the agent can drive end to end while the chat stays visible
beside it — so you can watch it build a sequence and reach in and change anything by hand,
on the same graph, at the same time.

Rendering is done by **[Calliope](https://github.com/benjiyaya/Calliope)** (MIT, © Benjiyaya),
used headless: we drive its HTTP API and render our own editor rather than embedding its
frontend. Calliope owns the content — projects, beats, scenes, characters, jobs. This module
owns the topology — what is nested in what, and which continuity rails cross which boundary.

> **Status: WIP.** Nothing here is installable yet. See `docs/diagrams/` for the approach.
>
> Setup is a first-class goal, not an afterthought: the target is that a user installs the
> panel and this works, without hand-assembling a Python venv to get there.

## Layout

| path | what it is |
| --- | --- |
| `packages/graph-core` | the container / boundary-port algebra. No React, no Calliope, no ComfyUI. |
| `packages/calliope-client` | typed client for Calliope's API, plus its reachability probe |
| `packages/director-app` | the editor — React + React Flow, built to one ES module |
| `packages/director-tools` | tool definitions as data; the host does the registering |
| `panel/pane.js` | the side-panel content-provider |
| `scripts/sync-to-panel.mjs` | build + vendor the artifacts into a panel checkout |

`graph-core` is ported from the group/subgraph work in `ifr-node-lab`, with the IFR domain
stripped out. Its one load-bearing idea is that **boundary port ids are derived, never
minted** — `${containerId}::${childPortId}` — which is what makes reconciling a boundary
idempotent, and what lets your rail labels and ordering survive dragging a scene in or out.

## Develop

```bash
npm install
npm test          # vitest
npm run typecheck # tsc --build
npm run build
```

To try it against a local panel checkout:

```bash
node scripts/sync-to-panel.mjs --panel ../comfyui-mcp-panel
```

## Who builds this

We do. This is a full build on our side — Calliope is used as-is, through its public API,
and the integration work does not ask anything of the Calliope maintainers.

What we *do* want from that side is correction: if this module drives Calliope in a way that
is wrong, unidiomatic, or about to be broken by an upcoming change, an issue saying so is
worth more than a PR. If we need something Calliope does not expose, we open the PR upstream
ourselves rather than forking or patching around it.

Two things worth knowing before touching the code:

- **`graph-core` is the part with teeth.** It has real tests and they are mutation-checked.
  Change behaviour there and expect a test to go red; if none does, the test is the bug.
- **Tool names are declared upstream.** The panel validates every tool name against a
  hash-pinned vocabulary, so a new tool needs a matching change in `comfyui-mcp` before it
  can exist. Adding one here alone will not work.

## License

MIT. Calliope is a separate MIT project by Benjiyaya and is not vendored here.
