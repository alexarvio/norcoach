import { applyDueProgramDeployments, dueSetScope } from "./queries";
import { SETS_PG } from "./sets/mode";
import { fetchAllSets, fetchSetsForClients, setsForDueJobNow } from "./sets/rows";

// The root layout's every-request job, at most once a minute per server (23 Oct, Alex: the admin felt slow; it took
// ~220 ms on every page). applyDueProgramDeployments re-runs the progression of every exercise something touched since
// it last ran, and every client's in full at start and once a day (runProgressPass, 17 Nov), as a safety net (a logged
// set moves its own targets at once), mends old data and deploys what is due: a schedule still goes live within the
// minute. True when it ran.
const MIN_GAP_MS = 60_000;
const g = globalThis as unknown as { _ironlineDueAt?: number; _ironlineDueRunning?: boolean };

export function applyDueProgramDeploymentsSometimes(): boolean {
  const now = Date.now();
  if (g._ironlineDueAt && now - g._ironlineDueAt < MIN_GAP_MS) return false;
  g._ironlineDueAt = now;
  // Memory mode: at once, on the store's own sets, as before (sets/rows.ts setsForDueJobNow).
  if (!SETS_PG) {
    void applyDueProgramDeployments(setsForDueJobNow("job.due", dueSetScope())).catch((e) => console.error("[due] the 12 h discards failed:", e instanceof Error ? e.message : e));
    return true;
  }
  // SETS_STORE=pg (quest 10): the sets it reads fetched first (every set on a full pass of the weight rule, else the
  // clients dueSetScope names), then the same body; behind the page, never into it, one run at a time. The body is told
  // what the view holds (`covers`): the weight rule decides again as it runs and never takes a partial view for every
  // set (runProgressPassPg). Every set failing to read leaves the full pass for the next tick and runs the rest on the
  // named clients (deployments, the 12 h ends, the open phases' weeks); a failed narrow fetch skips the tick, said once.
  if (g._ironlineDueRunning) return false;
  g._ironlineDueRunning = true;
  void (async () => {
    try {
      const scope = dueSetScope();
      let sr: Awaited<ReturnType<typeof fetchAllSets>> | null = null;
      let covers: Set<number> | null = null;
      if (scope.all) {
        try {
          sr = await fetchAllSets("job.progress.full");
        } catch (e) {
          console.error("[due] every set couldn't be read for the weight rule's full pass (left for the next tick):", e instanceof Error ? e.message : e);
        }
      }
      if (!sr) {
        sr = await fetchSetsForClients("job.due", scope.clients);
        covers = new Set(scope.clients);
      }
      await applyDueProgramDeployments(sr, covers);
    } catch (e) {
      console.error("[due] the minute's job was skipped:", e instanceof Error ? e.message : e);
    } finally {
      g._ironlineDueRunning = false;
    }
  })();
  return true;
}
