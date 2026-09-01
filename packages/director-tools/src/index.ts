// MCP tool DEFINITIONS, as data.
//
// This package deliberately does NOT import the MCP SDK and does not register anything.
// It exports descriptions and handlers; `comfyui-mcp` owns registration, because that is
// where the tool-vocabulary ratchet lives and a tool name has to be declared upstream
// before it can exist at all.
//
// Two constraints from the host repo shape everything here, and neither is negotiable:
//
//   1. Every multi-purpose tool takes a FLAT `action` enum. A discriminated union renders
//      as zero parameters in the MCP schema and silently breaks dispatch, so per-action
//      requiredness is checked inside the handler instead — testing `=== undefined`, never
//      falsiness, because 0 and "" are legitimate values.
//   2. The browser is authoritative. Handlers never mint node ids and never compute a graph
//      result themselves; they forward a command over the bridge and return what the editor
//      says. That is what keeps an agent edit and a mouse edit on exactly one code path.

/** The bridge call a handler is given. Mirrors the panel envelope: `{ rid, cmd, ...args }`. */
export type BridgeCall = (
  message: { cmd: string } & Record<string, unknown>,
  timeoutMs?: number,
) => Promise<unknown>;

export interface ToolContext {
  /** Send a command to the live Director pane and await its rid-correlated reply. */
  call: BridgeCall;
}

/**
 * One tool, described independently of any server.
 *
 * `schema` is a JSON Schema object rather than a zod instance so this package stays free of
 * a validator dependency; the host converts it at registration time.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  handler: (ctx: ToolContext, args: Record<string, unknown>) => Promise<unknown>;
  /**
   * Mountable tools are enabled only while the Director pane is open, and disabled again
   * when it closes. A tool that is always present — the entry point — sets this false, or
   * the feature becomes unreachable the moment the pane is shut.
   */
  mountable: boolean;
}

/** Every tool this module contributes. Populated in Phase 5. */
export const DIRECTOR_TOOLS: readonly ToolDefinition[] = [];

/** Names only — what the host has to append to its panel vocabulary baseline. */
export const DIRECTOR_TOOL_NAMES: readonly string[] = DIRECTOR_TOOLS.map((t) => t.name);
