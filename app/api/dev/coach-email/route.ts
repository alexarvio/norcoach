import { NextResponse } from "next/server";
import { getData, persist } from "../../../lib/db";
import { deleteCoachAccount } from "../../../lib/auth";

// Local development only: gives the local coach login (COACH_EMAIL, a made-up
// address) a real email, so signing in through Clerk with an email code
// reaches it. Removes a test sign-up with that email first (a coach who
// signed up themselves: no password of ours and no clients; pending or, since
// 17 Nov, let straight in), with everything made for it, and drops any old
// Clerk link so the next sign-in links afresh. Refuses anywhere but a dev machine.
//   GET http://localhost:3000/api/dev/coach-email?to=you@example.com
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (process.env.NODE_ENV === "production" || process.env.RAILWAY_ENVIRONMENT) return new NextResponse("Not here.", { status: 403 });
  const to = new URL(req.url).searchParams.get("to")?.trim().toLowerCase() ?? "";
  const from = process.env.COACH_EMAIL?.trim().toLowerCase() ?? "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to) || !from) return NextResponse.json({ ok: false, error: "bad email" }, { status: 400 });
  const data = getData();
  const coach = data.users.find((u) => u.role === "coach" && u.email === from);
  if (!coach) return NextResponse.json({ ok: false, error: "no local coach with COACH_EMAIL" }, { status: 404 });
  // A test sign-up: a coach on that email who signed up themselves (no password of ours) and has no clients.
  const testSignUps = data.users.filter((u) => u.email === to && u.role === "coach" && u.id !== coach.id && !u.password_hash && !data.clients.some((c) => c.coach_id === u.id));
  const other = data.users.find((u) => u.email === to && !testSignUps.includes(u));
  if (other) return NextResponse.json({ ok: false, error: "that email already has a real account" }, { status: 409 });
  // The Clerk sign-in behind it stays: it is the one the local coach links to next (deleteCoachAccount would delete it).
  const removed = testSignUps.filter((u) => {
    delete u.clerk_user_id;
    return deleteCoachAccount(u.id);
  }).length;
  coach.email = to;
  delete coach.clerk_user_id;
  persist();
  return NextResponse.json({ ok: true, coachId: coach.id, removedSignUps: removed });
}
