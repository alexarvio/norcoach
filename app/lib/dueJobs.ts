import { applyDueProgramDeployments } from "./queries";

// The root layout's every-request job, at most once a minute per server (23 Oct, Alex: the admin felt slow; it took
// ~220 ms on every page). applyDueProgramDeployments re-runs the progression of every exercise something touched since
// it last ran, and every client's in full at start and once a day (runProgressPass, 17 Nov), as a safety net (a logged
// set moves its own targets at once), mends old data and deploys what is due: a schedule still goes live within the
// minute. True when it ran.
const MIN_GAP_MS = 60_000;
const g = globalThis as unknown as { _ironlineDueAt?: number };

export function applyDueProgramDeploymentsSometimes(): boolean {
  const now = Date.now();
  if (g._ironlineDueAt && now - g._ironlineDueAt < MIN_GAP_MS) return false;
  g._ironlineDueAt = now;
  applyDueProgramDeployments();
  return true;
}
