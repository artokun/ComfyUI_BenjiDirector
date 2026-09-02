// Duration budget — a port of Calliope's `lib/durationBudget.ts`, which itself mirrors the
// backend's `calliope.agent.prompts` helpers. The numbers matter because the agent drafts the
// story to THESE counts: a "2 minutes" film is ten beats and seventeen scenes, and the New
// project form shows that before anything is written.
//
// One addition over Calliope's: a clock form ("1:30") parses, since that is how people type a
// runtime when they are not reading a preset.

/** Seconds a free-text target duration asks for. Never NaN; the floor is 15 s. */
export function estimateTargetSeconds(targetDuration: string | null | undefined): number {
  const text = (targetDuration || "").trim().toLowerCase();
  if (!text) return 30;

  // "1:30", "0:45" — minutes:seconds.
  const clock = text.match(/^(\d+):(\d{1,2})$/);
  if (clock) return Math.max(15, Number(clock[1]) * 60 + Number(clock[2]));

  const scenesM = text.match(/(\d+)\s*scenes?/);
  if (scenesM && !/min|sec/.test(text)) {
    return Math.max(30, Number(scenesM[1]) * 8);
  }

  let minutes = 0;
  let seconds = 0;
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*(min|mins|minutes?|m)\b/g)) {
    minutes += Number(m[1]);
  }
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*(sec|secs|seconds?|s)\b/g)) {
    seconds += Number(m[1]);
  }
  if (minutes || seconds) return Math.max(15, Math.round(minutes * 60 + seconds));

  const bare = text.match(/\b(\d+(?:\.\d+)?)\b/);
  if (bare) {
    const n = Number(bare[1]);
    if (text.includes("medium") || n >= 2) {
      if (n <= 30) return Math.round(n * 60);
    }
    if (n <= 180) return Math.round(n);
  }

  if (text.includes("medium")) return 120;
  if (text.includes("short") || text.includes("brief")) return 30;
  if (text.includes("long") || text.includes("feature")) return 180;
  return 60;
}

/** ~12 s of narrative weight per beat; 4 at least, 60 at most. */
export function recommendBeatCount(targetDuration: string | null | undefined): number {
  const secs = estimateTargetSeconds(targetDuration);
  return Math.max(4, Math.min(60, Math.round(secs / 12)));
}

/** ~7 s per scene; 4 at least, 90 at most. */
export function recommendSceneCount(targetDuration: string | null | undefined): number {
  const secs = estimateTargetSeconds(targetDuration);
  return Math.max(4, Math.min(90, Math.round(secs / 7)));
}

/** "2:00", "0:45" — for the budget hint. */
export function formatSeconds(secs: number): string {
  const s = Math.max(0, Math.round(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The one-line hint under the duration field: "≈ 2:00 · 10 beats · 17 scenes". */
export function budgetHint(targetDuration: string | null | undefined): string {
  const secs = estimateTargetSeconds(targetDuration);
  return `≈ ${formatSeconds(secs)} · ${recommendBeatCount(targetDuration)} beats · ${recommendSceneCount(targetDuration)} scenes`;
}
