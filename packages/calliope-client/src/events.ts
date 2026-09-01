// Calliope's live updates: Server-Sent Events at GET /api/events.
//
// There is no WebSocket. The stream keeps a 20-event replay backlog and sends a comment
// every 15s as keepalive. Observed kinds: job.started, job.progress, job.completed,
// job.failed, asset.ready, agent.thinking. The pane subscribes to drive node badges and the
// job strip; an agent that wants to block uses the render tool's `wait` action instead —
// a bounded call, not an open stream it would have to be trusted to close.
//
// Browser-only by nature (`EventSource`). The server-side tool package never imports this.

export interface CalliopeEvent {
  kind: string;
  data: Record<string, unknown>;
  /** Wall-clock arrival, for ordering when the payload carries none. */
  at: number;
}

export interface EventSubscription {
  close(): void;
  readonly connected: boolean;
}

/**
 * Subscribe. Reconnection is EventSource's own; we surface state changes so the pane can show
 * "live" / "reconnecting" honestly rather than a badge that froze when the socket did.
 */
export function subscribeEvents(
  baseUrl: string,
  onEvent: (e: CalliopeEvent) => void,
  onState?: (state: "open" | "reconnecting" | "closed") => void,
): EventSubscription {
  if (typeof EventSource === "undefined") {
    onState?.("closed");
    return { close() {}, connected: false };
  }
  const es = new EventSource(`${baseUrl.replace(/\/+$/, "")}/api/events`);
  let connected = false;
  es.onopen = () => {
    connected = true;
    onState?.("open");
  };
  es.onerror = () => {
    connected = false;
    // EventSource retries on its own; CLOSED means it has given up.
    onState?.(es.readyState === EventSource.CLOSED ? "closed" : "reconnecting");
  };
  const deliver = (kind: string, raw: string) => {
    let data: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object") data = parsed as Record<string, unknown>;
      // Calliope wraps as { type, data } on the default channel; unwrap when it does.
      if (typeof data.type === "string" && data.data && typeof data.data === "object") {
        kind = data.type;
        data = data.data as Record<string, unknown>;
      }
    } catch {
      data = { raw };
    }
    onEvent({ kind, data, at: Date.now() });
  };
  es.onmessage = (m) => deliver("message", String(m.data));
  for (const k of ["job.started", "job.progress", "job.completed", "job.failed", "asset.ready", "agent.thinking"]) {
    es.addEventListener(k, (m) => deliver(k, String((m as MessageEvent).data)));
  }
  return {
    close() {
      es.close();
      connected = false;
      onState?.("closed");
    },
    get connected() {
      return connected;
    },
  };
}
