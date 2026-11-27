import { NextResponse } from "next/server";
import { getRequestUser, isOwner } from "../../../lib/auth";
import { billingAccess } from "../../../lib/billing";
import { listClients } from "../../../lib/queries";
import { isTimezone } from "../../../lib/timezones";
import { setViewZone } from "../../../lib/viewZone";
import { fetchThread } from "../../../lib/chat/rows";
import { fetchClientCheckIns } from "../../../lib/checkins/rows";
import { fetchClientSets } from "../../../lib/sets/rows";
import { loadTrainingWeek } from "../../../admin/redesign/loaders";
import { startTiming } from "../../../lib/timing";

// One week of a client's Training tab alone (27 Nov, Alex: "switching from week to week in the training section was a
// bit slow, glitched a bit"): its sessions, duplicates, rogue sessions and what Apply and Copy would change, as the
// page's draft holds them (loadTrainingWeek), so a week switched to on screen swaps in place instead of reading every
// tab of the page again. A route, not a server action: Next runs actions one at a time, so a week warmed ahead would
// wait behind an autosave. The signed-in coach read from the request (with Clerk on, the proxy does not run on /api),
// and only one of their own clients, as the page picks them (pickClient): another coach's client is a 404, never read.
// The reads are the Training tab's own (page.tab.training), for the one client, whole, as the tab reads that client.
//   GET /api/admin/training-week?client=ID&program=ID&week=N  → TrainingWeek
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const user = await getRequestUser(request);
  if (!user || user.pending || user.must_change_password || user.role !== "coach") return NextResponse.json({ error: "Not signed in" }, { status: 401, headers: NO_STORE });
  // Not subscribed: the page itself sends them to the subscribe screen, so nothing is read for it here.
  if (billingAccess(user.id, isOwner(user)).state === "subscribe") return NextResponse.json({ error: "Subscribe" }, { status: 403, headers: NO_STORE });
  const url = new URL(request.url);
  const clientId = Number(url.searchParams.get("client"));
  const program = url.searchParams.get("program") ?? undefined;
  const week = url.searchParams.get("week") ?? undefined;
  if (!Number.isInteger(clientId) || !listClients(user.id).some((c) => c.id === clientId)) return NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE });
  // Where the coach is looking from, as requireCoach sets it for a page (viewZone.ts), so dates read as the page's.
  try {
    const raw = request.headers.get("cookie")?.split(/;\s*/).find((c) => c.startsWith("ironline_tz="))?.slice("ironline_tz=".length) ?? "";
    const zone = decodeURIComponent(raw);
    setViewZone(zone && isTimezone(zone) ? zone : null);
  } catch {}
  const t = startTiming("training.week");
  t.client(clientId);
  const path = "page.tab.training" as const;
  const thread = await t.time("chat", () => fetchThread(clientId, path));
  const ck = await t.time("checkins", () => fetchClientCheckIns(clientId, path));
  const sr = await t.time("sets", () => fetchClientSets(path, clientId));
  const out = t.time("week", () => loadTrainingWeek(user.id, clientId, { program, week }, thread, ck, sr));
  t.end(out);
  if (!out) return NextResponse.json({ error: "No such week" }, { status: 404, headers: NO_STORE });
  return NextResponse.json(out, { headers: NO_STORE });
}
