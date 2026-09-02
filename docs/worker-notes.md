# Worker notes — building a unit in parallel with twenty others

Read this before touching code. The rules exist so that twenty branches merge.

## Where things go

- New feature = new files under `packages/director-app/src/` (one `.tsx` view + one pure `.ts`
  module with vitest tests where there is logic). CSS in `src/styles/<unit>.css`, imported by
  your module; never edit `styles.css` (the design unit owns it). Use `--bd-*` tokens only.
- Add UI through **slots** (`src/slots.tsx`: `registerSlot("toolbar-right", MyButton)`) and
  **panels** (`src/panels.ts`: `registerPanel({...})`). Do not add JSX to `DirectorApp.tsx`.
- Add agent commands through **`registerDriveCommands`** (`src/drive-registry.ts`), using the
  names frozen in `docs/drive-commands.md`. Register at module import time; import your module
  from `src/index.tsx` on the line marked for your unit (`// U<n>`).
- Editor state you need: `useDirector()` (`src/director-context.tsx`) — client, project rows,
  selection, `refresh()`, `setNote()`, `drive()`. Editor mutations: `useActions()` or a drive
  command. **Every graph mutation goes through `withCurrent → settle`** (via the kit's `run` +
  `settle` or an action); never `setNodes` directly from a module.
- Icons: `<Icon name="…" />` from `src/icons.tsx`. No emoji, anywhere.
- Modals: `useModal()` from `src/modal.tsx`. No `window.prompt/confirm`.
- Ids: `mintId(prefix)` from `model.ts`, never `Date.now()`.
- Calliope: `useDirector().client`; after any mutation call `refresh()`. Multipart uploads via
  `client.playground.upload(file)`. Never call `/api/agent/*` or `generate-story/script`.

## File ownership (edit only your region)

| file | owner |
|---|---|
| `DirectorApp.tsx` `decorate()` | U6 |
| `DirectorApp.tsx` measurement effect + RF interaction props | U1 (values), U8a (selection props) |
| `DirectorApp.tsx` `settle()` / `loadProject` / `refreshProject` | U13 |
| `DirectorApp.tsx` keyboard | U3 |
| `nodes.tsx` leaf nodes (`SceneNode`, `AssetNode`) | U2 (U10 fills `<RenderBadge/>`) |
| `container-toolbar.tsx` | U5 (delete), U7 (blueprint), U19 (icons) — distinct lines |
| `nodes.tsx` `GroupNode` / `RailHub` | U6 |
| `faces.tsx` | U9 |
| `blueprints.ts` | U7 |
| `calliope-sync.ts` | U13 |
| `topology.ts` | U4 (v2 extras) |
| `live.ts` | U10 (replace the stub bodies, keep the exports) |
| `dynamic-form/` | U15 (replace the placeholder, keep the props) |
| `styles.css` | U19 |
| `calliope-client` | additive only; keep `client.test.ts` green |

## Verify

```bash
npm run typecheck && npm test        # tsc --build + vitest (node; use // @vitest-environment jsdom per file when you need DOM)
npx playwright install chromium      # once per machine; cached globally
npm run e2e                          # headless Chromium against the dev harness (demo project, no Calliope)
```
Write `e2e/<unit>.spec.ts`; drive the real DOM. `e2e/helpers.ts` gives you `waitForDemo(page)`,
`drive(page, name, args)` (the agent's drive API, exposed as `window.__director` in the harness)
and `shot(page, "<unit>")` (a full-page PNG into `e2e/out/`). Mock Calliope with
`page.route("**/api/**", …)` and the row fixtures in `packages/director-app/src/calliope-bind.test.ts`.
Open your PNG with the Read tool and LOOK at it before you call the feature done.

Disk is tight on this machine: `df -h /c` before `npm install`; if free space is under 12 GB,
wait (sleep 60 and re-check, up to 20 times) rather than filling it. Remove your worktree
(`git worktree remove --force`) the moment your PR is up.

## Ship

```bash
git add -A && git commit -m "feat(<unit>): …"
git push -u origin feat/<slug>
gh pr create --base main --title "…" --body "…"
cd .. && git worktree remove --force .worktrees/<slug>   # frees node_modules
```
