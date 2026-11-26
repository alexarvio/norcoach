import { NextResponse } from "next/server";
import { getRequestUser } from "../../../lib/auth";
import { getData } from "../../../lib/db";
import { noteHomeLooked } from "../../../lib/homeBoard";
import { touchPresence } from "../../../lib/presence";
import { coachOwnsClient } from "../../../lib/tenancy";
import { isVisitRoute, isVisitView, ROUTE_WHERE } from "../../../admin/redesign/visit";
import { noteFeedLooked } from "../../../lib/feedBoard";
import { noteBusinessLooked } from "../../../lib/businessBoard";

// The visit to a client's screens (22 Nov; app/admin/redesign/visit.ts): where the coach is on the presence board and
// the look Home's Since counts from, written once the page is on screen, never by the render a rail hover prefetches.
// A route of its own, not a server action, so it never queues in front of a save or a refresh. The signed-in coach
// read from the request, as /api/admin/rail (with Clerk on, the proxy does not run on /api). The open door: a read-only
// coach still reads every screen, and a visit is no change. A client not the coach's, or a route that isn't one, is
// ignored; nothing comes back.
// A coach-wide view (26 Nov): the Feed or Business on screen, its look noted (noteFeedLooked, noteBusinessLooked) as
// each page's render did before the rail drew them ahead.
//   POST /api/admin/visit  { clientId: number, route: VisitRoute }  → 204
//   POST /api/admin/visit  { view: "feed" | "business" }            → 204
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
  const user = await getRequestUser(request);
  if (!user || user.pending || user.must_change_password || user.role !== "coach") return new NextResponse(null, { status: 401, headers: NO_STORE });
  let body: { clientId?: unknown; route?: unknown; view?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return new NextResponse(null, { status: 400, headers: NO_STORE });
  }
  if (isVisitView(body.view)) {
    if (body.view === "feed") noteFeedLooked(user.id);
    else noteBusinessLooked(user.id);
    return new NextResponse(null, { status: 204, headers: NO_STORE });
  }
  const id = Number(body.clientId);
  if (!Number.isInteger(id) || !isVisitRoute(body.route) || !coachOwnsClient(user.id, id)) return new NextResponse(null, { status: 204, headers: NO_STORE });
  const name = getData().clients.find((c) => c.id === id)?.name ?? "";
  const firstName = name.split(" ")[0] || "the client";
  touchPresence(user, `${firstName} · ${ROUTE_WHERE[body.route]}`);
  noteHomeLooked(id);
  return new NextResponse(null, { status: 204, headers: NO_STORE });
}
