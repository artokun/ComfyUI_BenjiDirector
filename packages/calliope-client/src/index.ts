// Typed client for Calliope's HTTP API (https://github.com/benjiyaya/Calliope, MIT).
//
// Calliope is a SEPARATE process we do not ship, install, or supervise. Everything here
// therefore has to treat "not running" as an ordinary, expected state rather than an error
// condition — the Director pane renders a setup card in that case instead of an editor, so
// a missing backend must be reportable rather than throwable.
//
// Phase 2 fills in the generated surface from Calliope's own /openapi.json. What is here
// now is the part that has to exist before anything else can: where it lives, and whether
// it is there at all.

/** Calliope's own default, from its `config.py` (`host` 127.0.0.1, `port` 8247). */
export const DEFAULT_CALLIOPE_BASE_URL = "http://127.0.0.1:8247";

export interface CalliopeConfig {
  baseUrl: string;
  /** Bounds a hung backend. A half-open socket must not wedge the pane. */
  timeoutMs: number;
}

export function resolveConfig(partial: Partial<CalliopeConfig> = {}): CalliopeConfig {
  return {
    baseUrl: (partial.baseUrl ?? DEFAULT_CALLIOPE_BASE_URL).replace(/\/+$/, ""),
    timeoutMs: partial.timeoutMs ?? 8000,
  };
}

/**
 * What `GET /api/health` reports. Calliope answers
 * `{"status":"ok","version":"1.2.1","dry_run":...}`.
 */
export interface CalliopeHealth {
  status: string;
  version?: string;
  dry_run?: boolean;
}

export type ReachabilityState =
  | { reachable: true; baseUrl: string; health: CalliopeHealth }
  /**
   * `reason` is for a human reading a setup card. It is deliberately NOT an error subclass:
   * an unreachable Calliope is a state the UI renders, not an exception the UI catches.
   */
  | { reachable: false; baseUrl: string; reason: string };

/**
 * Probe Calliope without throwing.
 *
 * Distinguishes the three outcomes that need different copy on the setup card: nothing
 * listening, something listening that is not Calliope, and Calliope answering.
 */
export async function probe(config: CalliopeConfig): Promise<ReachabilityState> {
  const { baseUrl, timeoutMs } = config;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/api/health`, { signal: abort.signal });
    if (!res.ok) {
      return { reachable: false, baseUrl, reason: `responded ${res.status}` };
    }
    const health = (await res.json()) as CalliopeHealth;
    if (typeof health?.status !== "string") {
      return { reachable: false, baseUrl, reason: "something is listening, but it is not Calliope" };
    }
    return { reachable: true, baseUrl, health };
  } catch (err) {
    const reason =
      err instanceof Error && err.name === "AbortError"
        ? `no answer within ${timeoutMs}ms`
        : "nothing listening";
    return { reachable: false, baseUrl, reason };
  } finally {
    clearTimeout(timer);
  }
}

export * from "./client.js";
export * from "./events.js";
