import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobRow, SceneRow, StoryBundle } from "@benjidirector/calliope-client";
import { subscribeEvents } from "@benjidirector/calliope-client";
import {
  JobsStore,
  LIVE,
  currentJobOf,
  jobLabel,
  jobsStateFrom,
  lastFailureOf,
  latestJob,
  parseTime,
  progressValue,
  renderStatusOf,
  synthesize,
  type JobsSource,
} from "./live.js";

// Rows as Calliope 1.2.1 returns them from GET /api/jobs (`_job_public`: payload and
// output_paths already parsed).
const job = (id: number, extra: Partial<JobRow> = {}): JobRow => ({
  id,
  project_id: 1,
  scene_id: null,
  kind: "video",
  workflow_id: null,
  status: "pending",
  payload: {},
  output_paths: [],
  error: null,
  created_at: "2026-09-01T10:00:00Z",
  started_at: null,
  completed_at: null,
  retry_count: 0,
  ...extra,
});

/** An SSE frame as `event_bus.format_sse` writes it: the whole `{type,data,ts}` in `data:`. */
const frame = (type: string, data: Record<string, unknown>, ts = "2026-09-01T10:00:01+00:00") => JSON.stringify({ type, data, ts });

const ev = (kind: string, data: Record<string, unknown>) => ({ kind, data, at: Date.now() });

/** A client the store can poll. Records the calls so the timing tests can count them. */
interface Source extends JobsSource {
  rows: JobRow[];
  paused: boolean;
  listCalls: number;
}
function source(rows: JobRow[] = [], paused = false): Source {
  const client: Source = {
    baseUrl: "",
    rows,
    paused,
    listCalls: 0,
    jobs: {
      list: async () => {
        client.listCalls++;
        return client.rows;
      },
      queueStatus: async () => ({ paused: client.paused }),
    },
  };
  return client;
}

describe("progress attribution (ported from Calliope's jobProgress.ts)", () => {
  let store: JobsStore;
  beforeEach(() => {
    store = new JobsStore();
  });
  afterEach(() => store.stop());

  const pct = (id: number) => store.getSnapshot().progress.get(id)?.pct;

  it("job.created queues at 0% with the worker's label", () => {
    store.handleEvent(ev("job.created", { job_id: 7, kind: "video", message: "Scene · SC-03" }));
    expect(store.getSnapshot().progress.get(7)).toEqual({ pct: 0, message: "Scene · SC-03" });
  });

  it("job.created with no message still says Queued", () => {
    store.handleEvent(ev("job.created", { job_id: 7 }));
    expect(store.getSnapshot().progress.get(7)?.message).toBe("Queued");
  });

  it("a job.progress with NO job_id is attributed to the single running job", () => {
    store.handleEvent(ev("job.started", { job_id: 7, message: "Scene · SC-03" }));
    // The worker's real payload: a prompt id and a message, no job id and no percent.
    store.handleEvent(ev("job.progress", { prompt_id: "abcdef12", message: "Waiting on ComfyUI (abcdef12…)" }));
    expect(pct(7)).toBeCloseTo(synthesize(0), 6);
    expect(pct(7)).toBeCloseTo(7.6, 6);
    expect(store.getSnapshot().progress.get(7)?.message).toBe("Waiting on ComfyUI (abcdef12…)");
  });

  it("synthetic ticks approach the 95 cap and never reach it", () => {
    store.handleEvent(ev("job.started", { job_id: 7 }));
    let prev = 0;
    for (let i = 0; i < 400; i++) {
      store.handleEvent(ev("job.progress", { prompt_id: "p" }));
      const now = pct(7)!;
      expect(now).toBeGreaterThan(prev);
      expect(now).toBeLessThan(LIVE.TICK_CAP);
      prev = now;
    }
    expect(prev).toBeGreaterThan(94);
  });

  it("honours a numeric percent — 0–1 is scaled, 0–100 is taken as-is, both capped at 95", () => {
    store.handleEvent(ev("job.started", { job_id: 7 }));
    store.handleEvent(ev("job.progress", { job_id: 7, percent: 0.42 }));
    expect(pct(7)).toBe(42);
    store.handleEvent(ev("job.progress", { job_id: 7, percent: 63.5 }));
    expect(pct(7)).toBe(63.5);
    // The export runner sends up to 99; the store never shows a completion it was not told about.
    store.handleEvent(ev("job.progress", { job_id: 7, percent: 99 }));
    expect(pct(7)).toBe(LIVE.TICK_CAP);
    // `progress` and `value` are honoured too; 1 is one-of-one, not one percent.
    expect(progressValue({ progress: 1 })).toBe(LIVE.TICK_CAP);
    expect(progressValue({ value: "0.5" })).toBe(50);
    expect(progressValue({ message: "no number here" })).toBeNull();
  });

  it("with two running jobs an id-less tick goes to the most recently started", () => {
    store.handleEvent(ev("job.started", { job_id: 7 }));
    store.handleEvent(ev("job.started", { job_id: 8 }));
    store.handleEvent(ev("job.progress", { prompt_id: "p" }));
    expect(pct(8)).toBeCloseTo(7.6, 6);
    expect(pct(7)).toBe(0);
    // When the newest finishes, the remaining one is again the only candidate.
    store.handleEvent(ev("job.completed", { job_id: 8 }));
    store.handleEvent(ev("job.progress", { prompt_id: "p" }));
    expect(pct(7)).toBeCloseTo(7.6, 6);
  });

  it("drops a tick it cannot attribute rather than crediting an arbitrary job", () => {
    // Two rows arrive running from a poll — no job.started, so there is no last-started hint.
    store.applyRows([job(7, { status: "running" }), job(8, { status: "running" })]);
    store.handleEvent(ev("job.progress", { prompt_id: "p" }));
    expect(store.getSnapshot().progress.size).toBe(0);
  });

  it("a poll that says the job ended takes it out of the attribution set", () => {
    // The `job.completed` frame can be missed (a dropped stream, a reconnect past the backlog)
    // and the poll is then the only thing that says the job ended. Without it the next id-less
    // tick is credited to a job that already finished, and its bar creeps on after the badge
    // has gone green.
    store.applyRows([job(7, { status: "pending" })]);
    store.handleEvent(ev("job.started", { job_id: 7 }));
    expect(store.getSnapshot().running).toEqual([7]);
    store.applyRows([job(7, { status: "done", output_paths: ["/out/a.mp4"] })]);
    expect(store.getSnapshot().running).toEqual([]);
    store.handleEvent(ev("job.progress", { prompt_id: "p" }));
    expect(pct(7), "no tick is credited to a finished job").toBe(0);
  });

  it("an explicit job_id always wins over the attribution heuristic", () => {
    store.handleEvent(ev("job.started", { job_id: 7 }));
    store.handleEvent(ev("job.started", { job_id: 8 }));
    store.handleEvent(ev("job.progress", { job_id: 7, percent: 30 }));
    expect(pct(7)).toBe(30);
    expect(pct(8)).toBe(0);
  });

  it("job.completed pins 100 and keeps the entry for 6 s", () => {
    vi.useFakeTimers();
    try {
      store.handleEvent(ev("job.started", { job_id: 7 }));
      store.handleEvent(ev("job.progress", { prompt_id: "p" }));
      store.handleEvent(ev("job.completed", { job_id: 7, outputs: ["/out/sc3.mp4"], message: "Scene · SC-03 · 1 file(s)" }));
      expect(pct(7)).toBe(100);
      vi.advanceTimersByTime(LIVE.DONE_KEEP_MS - 1);
      expect(pct(7)).toBe(100);
      vi.advanceTimersByTime(2);
      expect(store.getSnapshot().progress.has(7)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("job.failed keeps the last percent plus the error for 10 s", () => {
    vi.useFakeTimers();
    try {
      store.handleEvent(ev("job.started", { job_id: 7 }));
      store.handleEvent(ev("job.progress", { job_id: 7, percent: 40 }));
      store.handleEvent(ev("job.failed", { job_id: 7, error: "CUDA out of memory" }));
      expect(store.getSnapshot().progress.get(7)).toMatchObject({ pct: 40, error: "CUDA out of memory" });
      vi.advanceTimersByTime(LIVE.DONE_KEEP_MS + 100);
      expect(store.getSnapshot().progress.has(7), "outlives a done entry").toBe(true);
      vi.advanceTimersByTime(LIVE.FAILED_KEEP_MS);
      expect(store.getSnapshot().progress.has(7)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("job.deleted drops both the entry and the row", () => {
    store.applyRows([job(7, { status: "pending" }), job(8, { status: "pending" })]);
    store.handleEvent(ev("job.created", { job_id: 7 }));
    store.handleEvent(ev("job.deleted", { job_id: 7 }));
    expect(store.getSnapshot().progress.has(7)).toBe(false);
    expect(store.getSnapshot().jobs.map((j) => j.id)).toEqual([8]);
  });

  it("a terminal event moves the row it holds, so the badge does not wait for the next poll", () => {
    store.applyRows([job(7, { status: "running", scene_id: 3 })]);
    store.handleEvent(ev("job.completed", { job_id: 7, outputs: ["/out/sc3.mp4"] }));
    const s = store.getSnapshot();
    expect(s.byId.get(7)?.status).toBe("done");
    expect(s.byId.get(7)?.output_paths).toEqual(["/out/sc3.mp4"]);
    expect(s.running).toEqual([]);
  });

  it("ignores an event with no job id instead of throwing", () => {
    for (const kind of ["job.created", "job.started", "job.completed", "job.failed", "job.deleted"]) {
      expect(() => store.handleEvent(ev(kind, { message: "no id" }))).not.toThrow();
    }
    expect(() => store.handleEvent(ev("agent.thinking", { message: "hi" }))).not.toThrow();
    expect(store.getSnapshot().progress.size).toBe(0);
  });
});

describe("a replayed frame from the 20-event backlog is applied once", () => {
  // Calliope replays its last 20 events to every new subscriber, so a reconnect re-delivers
  // frames the pane already acted on. A doubled synthetic tick would advance progress twice.
  class FakeEventSource {
    static readonly CLOSED = 2;
    readyState = 1;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((m: { data: string }) => void) | null = null;
    private readonly handlers = new Map<string, Array<(m: { data: string }) => void>>();
    closed = false;
    constructor(readonly url: string) {
      last = this;
    }
    addEventListener(kind: string, fn: (m: { data: string }) => void) {
      this.handlers.set(kind, [...(this.handlers.get(kind) ?? []), fn]);
    }
    emit(kind: string, data: string) {
      for (const fn of this.handlers.get(kind) ?? []) fn({ data });
    }
    close() {
      this.closed = true;
      this.readyState = FakeEventSource.CLOSED;
    }
  }
  let last: FakeEventSource | null = null;

  beforeEach(() => {
    last = null;
    (globalThis as Record<string, unknown>).EventSource = FakeEventSource;
  });
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).EventSource;
  });

  it("dedupes by the server timestamp, so the second copy does not advance the bar", () => {
    const store = new JobsStore();
    const states: string[] = [];
    const sub = subscribeEvents(
      "http://127.0.0.1:8247",
      (e) => store.handleEvent(e),
      (s) => states.push(s),
    );
    expect(last).toBeTruthy();
    last!.onopen?.();
    expect(states).toEqual(["open"]);

    last!.emit("job.started", frame("job.started", { job_id: 7, message: "Scene · SC-03" }, "2026-09-01T10:00:01+00:00"));
    const tick = frame("job.progress", { prompt_id: "abcdef12", message: "Waiting on ComfyUI…" }, "2026-09-01T10:00:02+00:00");
    last!.emit("job.progress", tick);
    const once = store.getSnapshot().progress.get(7)?.pct;
    expect(once).toBeCloseTo(7.6, 6);

    // The very same frame again — what the backlog replays on reconnect.
    last!.emit("job.progress", tick);
    expect(store.getSnapshot().progress.get(7)?.pct).toBe(once);

    // A genuinely new tick (a later ts) still moves it.
    last!.emit("job.progress", frame("job.progress", { prompt_id: "abcdef12" }, "2026-09-01T10:00:03+00:00"));
    expect(store.getSnapshot().progress.get(7)!.pct).toBeGreaterThan(once!);

    sub.close();
    expect(last!.closed).toBe(true);
    store.stop();
  });

  it("reports reconnecting while EventSource retries and closed once it gives up", () => {
    const states: string[] = [];
    const sub = subscribeEvents("http://127.0.0.1:8247", () => undefined, (s) => states.push(s));
    last!.readyState = 0;
    last!.onerror?.();
    expect(states).toEqual(["reconnecting"]);
    last!.readyState = FakeEventSource.CLOSED;
    last!.onerror?.();
    expect(states).toEqual(["reconnecting", "closed"]);
    sub.close();
  });
});

describe("the 5 s poll fallback", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // The numbers ARE the contract (Calliope's own web UI polls at 5 s and lingers on a terminal
  // state for 6 s / 10 s). Pinned as literals so a changed constant is a red test, not a test
  // that quietly moves with it.
  it("polls every 5 s and keeps terminal entries for 6 s / 10 s", () => {
    expect(LIVE.POLL_MS).toBe(5_000);
    expect(LIVE.DONE_KEEP_MS).toBe(6_000);
    expect(LIVE.FAILED_KEEP_MS).toBe(10_000);
    expect(LIVE.TICK_CAP).toBe(95);
  });

  it("reads the rows immediately, then every 5 s, and stops on stop()", async () => {
    const store = new JobsStore();
    const client = source([job(1, { status: "running", scene_id: 3 })]);
    store.start({ client, projectId: 1, events: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.listCalls).toBe(1);
    expect(store.getSnapshot().running).toEqual([1]);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(client.listCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(client.listCalls).toBe(2);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(client.listCalls).toBe(5);

    store.stop();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(client.listCalls, "no poll outlives the session").toBe(5);
    expect(store.getSnapshot().jobs, "a stopped store shows no other film's queue").toEqual([]);
  });

  it("picks up the queue's paused flag", async () => {
    const store = new JobsStore();
    const client = source([], true);
    store.start({ client, projectId: 1, events: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot().paused).toBe(true);
    client.paused = false;
    await vi.advanceTimersByTimeAsync(LIVE.POLL_MS);
    expect(store.getSnapshot().paused).toBe(false);
    store.stop();
  });

  it("refetches at once on a job event — the event names the id, the row carries the truth", async () => {
    const store = new JobsStore();
    const client = source([job(1, { status: "running", scene_id: 3 })]);
    store.start({ client, projectId: 1, events: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.listCalls).toBe(1);

    client.rows = [job(1, { status: "done", scene_id: 3, output_paths: ["/out/a.mp4"] })];
    store.handleEvent(ev("job.completed", { job_id: 1, outputs: ["/out/a.mp4"] }));
    await vi.advanceTimersByTimeAsync(0);
    expect(client.listCalls, "no waiting for the 5 s tick").toBe(2);
    expect(store.getSnapshot().byId.get(1)?.status).toBe("done");

    // An image job.created carries no project_id, so the refetch is the only way it lands.
    store.handleEvent(ev("asset.ready", { job_id: 1, paths: ["/out/a.png"] }));
    await vi.advanceTimersByTimeAsync(0);
    expect(client.listCalls).toBe(3);
    store.stop();
  });

  it("keeps the last known rows when a poll fails, and recovers on the next tick", async () => {
    const store = new JobsStore();
    const client = source([job(1, { status: "running" })]);
    store.start({ client, projectId: 1, events: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot().jobs).toHaveLength(1);

    const boom = vi.fn(async () => {
      throw new Error("connection refused");
    });
    const good = client.jobs.list;
    client.jobs.list = boom;
    await vi.advanceTimersByTimeAsync(LIVE.POLL_MS);
    expect(boom).toHaveBeenCalled();
    expect(store.getSnapshot().jobs, "a dropped backend does not blank the strip").toHaveLength(1);

    client.jobs.list = good;
    await vi.advanceTimersByTimeAsync(LIVE.POLL_MS);
    expect(store.getSnapshot().jobs).toHaveLength(1);
    store.stop();
  });

  it("switching project throws the previous film's rows away before the first poll lands", async () => {
    const store = new JobsStore();
    const a = source([job(1, { status: "running" })]);
    store.start({ client: a, projectId: 1, events: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot().jobs).toHaveLength(1);

    const b = source([job(9, { status: "pending" })]);
    store.start({ client: b, projectId: 2, events: false });
    expect(store.getSnapshot().jobs, "cleared synchronously").toEqual([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot().jobs.map((j) => j.id)).toEqual([9]);
    store.stop();
  });

  it("start() for the same client and project does not open a second poll loop", async () => {
    const store = new JobsStore();
    const client = source([]);
    store.start({ client, projectId: 1, events: false });
    store.start({ client, projectId: 1, events: false });
    await vi.advanceTimersByTimeAsync(LIVE.POLL_MS + 1);
    expect(client.listCalls).toBe(2);
    store.stop();
  });
});

describe("renderStatusOf", () => {
  const state = (rows: JobRow[]) => jobsStateFrom(rows);

  it("lights the badge from the scene's latest video job", () => {
    expect(renderStatusOf(state([job(1, { kind: "video", scene_id: 3, status: "pending" })]), 3, false)).toBe("queued");
    expect(renderStatusOf(state([job(1, { kind: "video", scene_id: 3, status: "running" })]), 3, false)).toBe("rendering");
    expect(renderStatusOf(state([job(1, { kind: "video", scene_id: 3, status: "failed" })]), 3, false)).toBe("failed");
  });

  it("says rendered from a finished job's outputs before the re-read lands video_path", () => {
    const rows = [job(1, { kind: "video", scene_id: 3, status: "done", output_paths: ["/out/sc3.mp4"] })];
    expect(renderStatusOf(state(rows), 3, false)).toBe("rendered");
    // A done job with nothing to show is not a render.
    expect(renderStatusOf(state([job(1, { kind: "video", scene_id: 3, status: "done" })]), 3, false)).toBeNull();
  });

  it("an existing clip is rendered even with no job at all, and no job with no clip is nothing", () => {
    expect(renderStatusOf(state([]), 3, true)).toBe("rendered");
    expect(renderStatusOf(state([]), 3, false)).toBeNull();
  });

  it("the newest job wins, so a retry replaces the old failure", () => {
    const rows = [job(1, { kind: "video", scene_id: 3, status: "failed" }), job(2, { kind: "video", scene_id: 3, status: "running" })];
    expect(renderStatusOf(state(rows), 3, false)).toBe("rendering");
    expect(renderStatusOf(state([...rows].reverse()), 3, false), "order in the array must not matter").toBe("rendering");
  });

  it("ignores another scene's job and a non-video job on this scene", () => {
    const rows = [job(1, { kind: "video", scene_id: 4, status: "running" }), job(2, { kind: "image", scene_id: 3, status: "running" })];
    expect(renderStatusOf(state(rows), 3, false)).toBeNull();
    expect(latestJob(state(rows), (j) => j.scene_id === 4)?.id).toBe(1);
  });
});

describe("what the strip picks out of the queue", () => {
  it("shows the most recently started running job", () => {
    const s = jobsStateFrom([
      job(1, { status: "running", started_at: "2026-09-01T10:00:00Z" }),
      job(2, { status: "running", started_at: "2026-09-01T10:00:09Z" }),
      job(3, { status: "pending" }),
    ]);
    expect(currentJobOf(s)?.id).toBe(2);
    expect(s.running).toEqual([1, 2]);
    expect(s.queued).toEqual([3]);
    expect(currentJobOf(jobsStateFrom([job(3, { status: "pending" })]))).toBeUndefined();
  });

  it("reads a zoneless SQLite stamp as UTC, not as local time", () => {
    // Calliope's rows carry `CURRENT_TIMESTAMP` with no zone marker. Date.parse would call it
    // local and skew it by the offset, which is what puts a "3m ago" hours out.
    expect(parseTime("2026-09-01 10:00:00")).toBe(Date.UTC(2026, 8, 1, 10, 0, 0));
    expect(parseTime("2026-09-01T10:00:00")).toBe(Date.UTC(2026, 8, 1, 10, 0, 0));
    expect(parseTime("2026-09-01 10:00:00.250")).toBe(Date.UTC(2026, 8, 1, 10, 0, 0, 250));
    // An explicit zone is honoured as given, and junk is null rather than NaN.
    expect(parseTime("2026-09-01T10:00:00Z")).toBe(Date.UTC(2026, 8, 1, 10, 0, 0));
    expect(parseTime(null)).toBeNull();
    expect(parseTime("")).toBeNull();
    expect(parseTime("not a date")).toBeNull();
  });

  it("orders running jobs by INSTANT, so a stream-patched ISO row cannot jump the queue", () => {
    // The store stamps a row it patches with an ISO `T…Z`; the poll brings SQLite's " " form.
    // Compared as text every "T" sorts after every " ", so job 1 would always look newest.
    const s = jobsStateFrom([
      job(1, { status: "running", started_at: "2026-09-01T10:00:00.000Z" }),
      job(2, { status: "running", started_at: "2026-09-01 10:00:09" }),
    ]);
    expect(currentJobOf(s)?.id).toBe(2);
    // A row with no start time never outranks one that has it.
    const t = jobsStateFrom([job(1, { status: "running", started_at: "2026-09-01 10:00:00" }), job(2, { status: "running", started_at: null })]);
    expect(currentJobOf(t)?.id).toBe(1);
    // With no times at all the newer id wins, whichever order the rows arrive in.
    const u = [job(1, { status: "running", started_at: null }), job(2, { status: "running", started_at: null })];
    expect(currentJobOf(jobsStateFrom(u))?.id).toBe(2);
    expect(currentJobOf(jobsStateFrom([...u].reverse()))?.id).toBe(2);
  });

  it("shows the newest failure, unless a newer job for the same scene has superseded it", () => {
    const failed = job(1, { status: "failed", scene_id: 3, error: "CUDA out of memory" });
    expect(lastFailureOf(jobsStateFrom([failed]))?.error).toBe("CUDA out of memory");
    // A retry mints a new row for the same scene: the old failure must not outlive its fix.
    expect(lastFailureOf(jobsStateFrom([failed, job(2, { status: "running", scene_id: 3 })]))).toBeUndefined();
    // A newer job for a DIFFERENT scene does not clear it.
    expect(lastFailureOf(jobsStateFrom([failed, job(2, { status: "running", scene_id: 4 })]))?.job.id).toBe(1);
  });

  it("names a job the way Calliope's worker does", () => {
    const scenes = [{ id: 3, heading: "SC-03 · The call comes", order_index: 2 }] as unknown as SceneRow[];
    const story = { characters: [{ id: 5, name: "Nadia" }], locations: [{ id: 2, name: "Rooftop" }], items: [] } as unknown as StoryBundle;
    expect(jobLabel(job(1, { kind: "export" }))).toBe("Export film");
    expect(jobLabel(job(1, { scene_id: 3 }), { scenes })).toBe("Scene · SC-03 · The call comes");
    expect(jobLabel(job(1, { scene_id: 3 }))).toBe("Scene #3");
    expect(jobLabel(job(1, { kind: "image", payload: { character_id: 5, asset_target: "portrait" } }), { story })).toBe("Nadia · portrait");
    expect(jobLabel(job(1, { kind: "image", payload: { character_id: 5 } }), { story })).toBe("Nadia · sheet");
    expect(jobLabel(job(1, { kind: "image", payload: { location_id: 2 } }), { story })).toBe("Rooftop · environment");
    expect(jobLabel(job(1, { kind: "image", payload: { location_id: 99 } }), { story })).toBe("#99 · environment");
  });
});
