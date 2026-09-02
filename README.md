# BenjiDirector

An agent-driven long-form video editor, as a module inside the
[ComfyUI MCP agent panel](https://github.com/artokun/comfyui-mcp-panel).

You get a **nested scene graph** the agent can drive end to end while the chat stays visible
beside it — so you can watch it build a sequence and reach in and change anything by hand,
on the same graph, at the same time.

Rendering is done by **[Calliope](https://github.com/benjiyaya/Calliope)** (MIT, © Benjiyaya),
used headless through [our fork](https://github.com/artokun/Calliope): we drive its HTTP API
and render our own editor rather than embedding its frontend. Calliope owns the content — projects, beats, scenes, characters, jobs. This module
owns the topology — what is nested in what, and which continuity rails cross which boundary.

> **Status: working prototype, not yet released.** The editor runs live inside the ComfyUI
> agent panel, loads a Calliope project onto the canvas and writes edits back, and the
> agent has ten tools that mount with the pane, one of which brings Calliope up. See
> `docs/diagrams/` for the approach, `docs/agent-playbook.md` for how the agent is meant
> to work a film, and the sections below for what exists today.
>
> Setup is a first-class goal, not an afterthought: the target is that a user installs the
> panel and this works, without hand-assembling a Python venv to get there.

## What works today

- **The canvas** (`packages/director-app`): Scenes, Character/Location/Item assets, and Beats
  as groups or subgraphs. Typed wires (text / ref / image / video), rails you can rename,
  reorder and author from a `+` slot, the yellow pin that puts a node on a collapsed Beat's
  face as a compact control, colours, resizable containers, a searchable right-click palette,
  pick-up-and-carry wires with drop-to-palette auto-wiring, edge midpoint menus (insert /
  delete / reroute-TBD), blueprints (save a subgraph, stamp copies), undo/redo, repair.
- **The agent path**: `mountDirector().drive(name, args)` runs the mouse's own code for every
  command — the editor mints ids and refuses type mismatches. In comfyui-mcp
  (`feat/benjidirector-seam`), `panel_module` opens the pane, which MOUNTS
  `panel_director_graph` / `panel_director_link` / `panel_director_subgraph`; closing it
  unmounts them and the client is told the tool list changed. The panel pushes
  `pane_state` on open / switch / close and on reconnect. `panel_pane` reads, closes and docks
  whichever pane is showing.
- **The algebra** (`packages/graph-core`): promote / dissolve / reconcile with derived boundary
  ids, 49 tests, mutation-checked.
- **Calliope binding** (`calliope-bind.ts`, `calliope-sync.ts`, `topology.ts`): pick a
  project and the canvas becomes it — Beats as containers, scenes parented by `beat_id`,
  Character/Location refs and `chain_from_prev` as wires. Edits write back as a diff on
  every settle: heading and duration to the row, a scene's Beat to `beat_id`, a continuity
  wire to `chain_from_prev`, a Character or Location wire to `character_ids` / `location_id`,
  a Beat or asset rename to its own row, position and pin to `video_settings.director`. A node
  the canvas invents gets its row FIRST and takes that row's id; deleting one asks before it
  deletes the row, and undo goes back through the same write-back. Every write is
  checked against the row Calliope returns — a 200 is not evidence it landed — and a change
  it would not keep is snapped back with the reason shown. Beat-level state Calliope cannot
  store (subgraph-ness, collapse, colour, box, rail labels) lives in a per-project sidecar.
- **The Calliope tools**: `panel_director_project` / `_story` / `_scene` / `_workflow` /
  `_render` reach Calliope through the pane, which re-reads the project after a mutation and
  MERGES it so an agent edit never costs the layout. This agent authors the story and the
  prompts; Calliope's own model is never in the loop (`scene set_prompt` stamps the draft
  against the scene's current text hash, `videos_generate` carries explicit prompts).

## What is next

The node context menu, a prompt-quality pass against Calliope's own templates, and a
first film rendered end to end on camera. The first fork-only fix is in: Calliope 1.2.1's
scene PATCH silently ignored an explicit `null`, so a scene could not leave its Beat — the
module still detects and reverts an ignored write, and the fork's `main` clears the field
properly.

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

## Run Calliope

One command, idempotent, pinned to a commit of **our fork** (`artokun/Calliope`, upstream
`benjiyaya/Calliope`) — the fork carries the fixes this module needs before they land
upstream, and is where we are free to deviate:

```bash
npm run calliope:up
```

It clones Calliope into `~/.comfyui-mcp/calliope` (or `--dir <existing checkout>`), makes
the venv, installs the backend, starts it detached on `127.0.0.1:8247`, and waits for
`/api/health`. If Calliope already answers on that port it says so and starts nothing.
`npm run calliope:check` only probes; `--stop` stops what it started. Needs git and
Python 3.11+; ffmpeg only for exporting a film. No LLM endpoint is needed — the agent in
the panel is the only model in the loop.

## Working on a unit

Twenty features are being built in parallel. Read `docs/worker-notes.md` (ownership rules,
slots/panels/drive registries, how to verify) and `docs/drive-commands.md` (the command
vocabulary, frozen) before touching code.

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

We do. This is a full build on our side — Calliope is used through its public API, from a
fork we maintain, and the integration work does not ask anything of the Calliope
maintainers. The fork exists so this module never waits: fixes land there first, and it is
where we are free to deviate as the Director grows past what Calliope's own UI needs.

What we *do* want from upstream is correction: if this module drives Calliope in a way that
is wrong, unidiomatic, or about to be broken by an upcoming change, an issue saying so is
worth more than a PR. Fixes that make sense for everyone go up as PRs when they fit.

Two things worth knowing before touching the code:

- **`graph-core` is the part with teeth.** It has real tests and they are mutation-checked.
  Change behaviour there and expect a test to go red; if none does, the test is the bug.
- **Tool names are declared upstream.** The panel validates every tool name against a
  hash-pinned vocabulary, so a new tool needs a matching change in `comfyui-mcp` before it
  can exist. Adding one here alone will not work.

## License

MIT. Calliope is a separate MIT project by Benjiyaya and is not vendored here.
