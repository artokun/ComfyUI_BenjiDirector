# Agent playbook — working a film through the Director

This is how the agent is meant to use the Director's tools, in the order a film gets made.
The tools mount when the Director pane opens (`panel_module open director`) and unmount when
it closes; while it is open the chat stays beside the canvas, and everything the agent does
shows up there for the user to adjust by hand.

The one rule underneath all of it: **this agent is the only model in the loop.** Calliope's
own LLM features (its chat harness, `generate-story`, `generate-script`, per-scene prompt
rewriting) are never called. The agent writes the story, the scenes and the prompts itself,
through ordinary CRUD, and Calliope renders.

## 1. Orient

- `panel_module status` — is the pane open, is Calliope reachable.
- `panel_director_project list` → `open` the one to work on (or `create` one from the
  user's premise, then `open` it). `current` tells you which project the canvas shows.
- `panel_director_story read` — the whole bundle: beats, characters, locations, items.
- `panel_director_scene list` — the scenes with the estimated total duration.
- `panel_director_graph outline` — how it all sits on the canvas.

## 2. Build the story

Write it yourself, from the premise:

1. Characters and locations first (`panel_director_story character_add` / `location_add`),
   each with a `consistency_prompt` — the phrase every generation of that asset repeats.
   That phrase is what keeps a face the same across twenty shots; spend words on it.
2. Beats (`beat_add`, in order). A Beat is a container on the canvas; promote one to a
   subgraph (`panel_director_subgraph promote`) when its continuity — which character,
   which location, which last frame — should be visible as rails.
3. Scenes (`panel_director_scene add`) inside beats: `heading`, `action_text`, `dialog`,
   `duration_sec`, `character_ids`, `location_id`, and `chain_from_prev: true` where the
   shot should start from the previous shot's last frame. `order_index` is the cut order.
   `reorder` with the full id list to re-cut.

## 3. Author the prompts

Calliope's precedence is: explicit prompt on the render request → a saved draft that is
still fresh → its own model. Keep it at the first two:

- `panel_director_scene set_prompt` stores a draft stamped against the scene's current
  text. **Edit the scene text afterwards and the draft goes stale** — set it again.
- Or pass `prompts` (scene id → text) straight into `panel_director_render
  videos_generate`, which needs no draft at all.
- `panel_director_render preview_prompt` shows what a scene would send right now.

A good shot prompt repeats the character's consistency phrase, names the location, states
the action in one clause, and gives the camera one instruction. Keep dialog out of the
image prompt unless the model renders text.

## 4. Render

- `panel_director_render assets_generate` first (portraits, environment plates), then
  `videos_generate` for the scenes. Both enqueue and return; nothing blocks.
- `panel_director_render wait` blocks until the project's jobs settle (bounded; pass
  `timeout_s`). Then `jobs_list` / `job_get` for what failed, `job_retry` to try again.
- `export` concatenates the finished clips into the film.

Rendering goes to the ComfyUI the user is looking at, on the same queue as their own work.
Never cancel jobs you did not enqueue.

## 5. Work the canvas with the user

Anything the user drags, renames, pins or re-wires is written back to Calliope as it
settles, and anything the agent writes through the tools is merged back onto the canvas
without disturbing their layout. Two things are the user's, not the agent's:

- The cut order. It is never inferred from where things sit on the canvas.
- Deleting a project. `panel_director_project delete` exists; do not call it unasked.

If a write does not land — Calliope refuses it, or accepts and ignores it — the canvas
snaps back and says why in the note bar. Read the note before retrying.
