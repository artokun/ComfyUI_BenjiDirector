// A scene's render status, from the live jobs store. Foundation stub renders the "rendered"
// tag when a clip exists; the live unit lights up queued / rendering / failed.

import { calliopeRef } from "./calliope-bind.js";
import { renderStatusOf, useJobs } from "./live.js";

export function RenderBadge({ id, videoPath }: { id: string; videoPath?: string }) {
  const jobs = useJobs();
  const ref = calliopeRef(id);
  const status = ref?.kind === "scene" ? renderStatusOf(jobs, ref.id, !!videoPath) : videoPath ? "rendered" : null;
  if (!status) return null;
  return <span className={`bd-badge is-${status}`}>{status}</span>;
}
