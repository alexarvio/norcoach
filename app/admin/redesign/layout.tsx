import { redirect } from "next/navigation";
import { requireCoach } from "../../lib/auth";
import { getData } from "../../lib/db";
import { startTiming } from "../../lib/timing";
import { readRail, type StampedRail } from "./loaders";
import RailFrame from "./RailFrame";
import "./rail.css";

// The rail stays, only the page swaps (22 Nov, Alex: "if we have to touch the rail… to make it a proper product, then
// yes"; docs/rail-layout-plan.md). Every view under /admin/redesign used to draw the rail itself, so each click drew it
// again on the server and nothing moved until the whole new page was in. Now this layout draws it once, and a layout
// is not drawn again on a move (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/layout.md):
// a click shows the view's outline (its loading.tsx) at once beside a rail that never left, and RailFrame keeps the
// rail's counts fresh in the background (/api/admin/rail). router.refresh() and a server action draw it again, so a
// save or a read on return (RefreshOnReturn) brings a new read with them.
// The rail's read is handed over as a promise, not awaited, so the page streams beside it; RailFrame reads it with
// use() under its own Suspense. Which paths wear the frame is RailFrame's to say (a layout never knows its path).
export const dynamic = "force-dynamic";

export default async function RedesignLayout({ children }: { children: React.ReactNode }) {
  const coach = await requireCoach();
  // A new coach sees the welcome steps first (loadRail's gate, here before anything streams).
  if (getData().users.find((u) => u.id === coach.id)?.onboarding) redirect("/auth/coach-setup");
  // Timed as its own screen (app/lib/timing.ts, /api/timing): the rail's fetches and loadRail, as each page timed them.
  const t = startTiming("rail");
  t.client(null);
  const rail: Promise<StampedRail | null> = t.time("read", () => readRail(coach, t)).then(
    (r) => t.end(r),
    (e) => {
      // A failed read draws the rail's outline; RailFrame asks /api/admin/rail in its place.
      console.error("rail read failed", e);
      t.end(null);
      return null;
    }
  );
  return <RailFrame rail={rail}>{children}</RailFrame>;
}
