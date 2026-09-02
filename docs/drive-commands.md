# Drive commands — the editor's command vocabulary

Every command here runs the same code the mouse runs. The editor mints ids and validates
connections; a command cannot do what a hand cannot. A module registers commands with
`registerDriveCommands()` (`src/drive-registry.ts`); the built-in ones live in
`DirectorApp.tsx`. The agent reaches a command only once comfyui-mcp's tool layer forwards it
(`src/orchestrator/director-tools.ts` there) — new NAMES are editor-side first, tool-side
second, and tool *names* must never be invented here (the panel pins its tool vocabulary).

Args are a flat object. Ids come from `outline`. Positions are absolute canvas coordinates.

## Built-in (DirectorApp)

| command | args | returns |
|---|---|---|
| `outline` | — | `{nodes[], edges[], blueprints[]}` (see `outline.ts`) |
| `read_node` | `id` | node summary |
| `add_node` | `kind` (scene/character/location/item/note), `x`, `y`, `label?` | `{id, label}` |
| `remove_node` | `id` | `{removed[]}` (cascades to descendants) |
| `move_node` | `id`, `x`, `y` | `{id, position}` |
| `set_title` | `id`, `label` | |
| `set_color` | `id`, `color` | Beat colour (leaf colours: `set_node_color`) |
| `set_collapsed` | `id`, `collapsed` | any Beat — a plain group collapses to a header card with proxy handles |
| `set_parent` | `id`, `parent_id \| null` | |
| `set_pin` | `id`, `promoted` | |
| `connect` | `source_handle`, `target_handle` | `{id, type}` |
| `disconnect` | `edge_id` or `target_handle` | `{removed}` |
| `repair` | — | |
| `promote` / `dissolve` / `reconcile` | `id` | |
| `set_rail_label` | `id`, `port_id`, `label` | |
| `reorder_rail` | `id`, `side`, `from`, `to` | |
| `group` | `node_ids[]`, `label?` | `{id}` |
| `save_blueprint` / `list_blueprints` / `apply_blueprint` | see DirectorApp | |
| `calliope` | `ns`, `op` (dotted), `args[]` | client result; refreshes after a mutation |
| `scene_set_prompt` | `project_id`, `scene_id`, `prompt` | |
| `project_open` / `project_current` / `project_refresh` | `project_id?` | |

## Planned by units (register these exact names; args are frozen here)

| unit | command | args |
|---|---|---|
| U2 | `set_bypassed` | `id`, `bypassed: boolean` |
| U2 | `set_node_color` | `id`, `color: string \| null` |
| U2 | `set_node_collapsed` | `id`, `collapsed: boolean` (leaf collapse-to-header) |
| U3 | `duplicate` | `ids[]` → `{ids[]}` (new ids) |
| U3 | `copy` / `paste` | `ids[]` / `x`, `y` → `{ids[]}` |
| U3 | `select` | `ids[]` (empty clears) |
| U4 | `export_graph` / `import_graph` | — / `json: string` |
| U4 | `save_named` / `load_named` / `list_saves` / `delete_save` | `name` |
| U4 | `clear` / `reset_demo` | — |
| U5 | `delete_container` | `id`, `mode: "all" \| "shell"` |
| U7 | `update_blueprint` / `delete_blueprint` | `blueprint_id`, `id?` / `blueprint_id` |
| U8a | `fit_view` | `ids?[]` |
| U8b | `reroute` | `edge_id`, `x`, `y` → `{id}` |
| U9 | `add_note` / `set_note` | `x`, `y`, `text` / `id`, `text` |
| U12 | `inspect` | `id` (opens the inspector on a node); internal-only `if_unselected` re-selects only while nothing else is |
| U14 | `assets_generate` etc. go through `calliope` (`assets.generate`) — no new command |
| U15 | `render_scene` | `scene_id` (opens the composer on a scene) |
| U21 | `set_expanded` | `id`, `expanded?` (omit to toggle) — opens a card's editable body |
| U21 | `set_duration` | `id`, `seconds` → `{id, durationSec}` |
| U21 | `reorder_scene` | `id`, `to` — the CUT (`order_index`); `to` counts the film WITHOUT the moved scene |
| U21 | `move_to_beat` | `id`, `beat` (a container id, or `null` for no Beat) |
| U22 | `install_workflows` | — → registers the shipped workflows, resolving model names against this ComfyUI |
| U22 | `workflows_status` | — → what is registered, and whether each starter's models are on this machine |
| U22 | `generate_asset` | `id?` (a character/location/item node; omit for every one missing an image), `prompt?` |
| U21 | `timeline` | — → `{duration, durationClock, mutedSec, cut[], rows[], clips[]}`, the dopesheet as data |

Tool-side mapping (comfyui-mcp, U20): graph commands become `panel_director_graph` actions,
container/blueprint commands `panel_director_subgraph` actions, everything Calliope-shaped
stays on `panel_director_*` tools that already exist. **Actions only — no new tool names.**
