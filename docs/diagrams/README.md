# Diagrams

WIP approach sketches. Source is `.mmd` (Mermaid) so they stay editable; the `.png`
next to each is what gets posted.

| | what it answers |
| --- | --- |
| `01-overview` | Where does everything run, and what talks to what |
| `02-module-system` | Why Director is module #1 of a system rather than a one-off tab |
| `03-scene-graph` | The nested Beat/Scene graph, and what a promoted rail is |
| `04-tool-lifecycle` | How the agent's tools appear and disappear with the pane |

## Re-rendering

```bash
npx -y @mermaid-js/mermaid-cli@11 -i docs/diagrams/01-overview.mmd -o docs/diagrams/01-overview.png -b "#313338" -s 2
```

`-b "#313338"` is Discord's dark message background, so posted images sit flush with
the channel instead of floating on a white card.

Two mermaid quirks worth knowing before editing these:

- **Nested `direction` is ignored** whenever a subgraph has edges crossing its boundary,
  which is most of the time. Trying to control aspect ratio that way does not work —
  restructure the graph instead, or split it into more, smaller diagrams.
- **Edge labels lose their last glyph** at some widths (`REST · SSE` rendered as
  `REST · SSI`). Every edge label here is padded with `&nbsp;` on both sides to avoid it.
