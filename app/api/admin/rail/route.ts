import { NextResponse } from "next/server";
import { getRequestUser } from "../../../lib/auth";
import { getData } from "../../../lib/db";
import { isTimezone } from "../../../lib/timezones";
import { setViewZone } from "../../../lib/viewZone";
import { readRail } from "../../../admin/redesign/loaders";
import { startTiming } from "../../../lib/timing";

// The rail's data alone (22 Nov, docs/rail-layout-plan.md): the rail is drawn once by app/admin/redesign/layout.tsx and
// never again on a move, so RailFrame asks here after each navigation to keep its counts fresh. The same read as the
// layout's (readRail: the coach-wide door fetches, then loadRail), stamped with when it began, so the newest wins.
// The signed-in coach read from the request (with Clerk on, the proxy does not run on /api; /api/timing, /api/export).
//   GET /api/admin/rail  → { rail: RailData, at: number }
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const user = await getRequestUser(request);
  if (!user || user.pending || user.must_change_password || user.role !== "coach") return NextResponse.json({ error: "Not signed in" }, { status: 401, headers: NO_STORE });
  // A new coach is sent to the welcome steps by the layout; their rail is never drawn, so nothing is read for it here.
  if (getData().users.find((u) => u.id === user.id)?.onboarding) return NextResponse.json({ error: "Onboarding" }, { status: 409, headers: NO_STORE });
  // Where the coach is looking from, as requireCoach sets it for a page (viewZone.ts).
  try {
    const raw = request.headers.get("cookie")?.split(/;\s*/).find((c) => c.startsWith("ironline_tz="))?.slice("ironline_tz=".length) ?? "";
    const zone = decodeURIComponent(raw);
    setViewZone(zone && isTimezone(zone) ? zone : null);
  } catch {}
  // Timed as its own screen (24 Nov: the browser waits about a second on it, the layout's same read 60ms; /api/timing).
  const t = startTiming("rail.api");
  t.client(null);
  const rail = await t.time("read", () => readRail(user, t));
  t.end(rail);
  return NextResponse.json(rail, { headers: NO_STORE });
}
