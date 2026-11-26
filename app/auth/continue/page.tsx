import { cookies, headers } from "next/headers";
import { hostOf, isStaffHost, safeStaffNext } from "../../lib/staffHost";
import { redirect } from "next/navigation";
import { clerkIdentity, clerkOn } from "../../lib/clerk";
import { findUserByEmail, getSessionUser } from "../../lib/auth";
import { NATIVE_COOKIE } from "../../lib/quietLoad";
import { letCoachInOrWait } from "../../lib/coachSignUp";
import { latestRequestFor } from "../../lib/joinRequests";
import { isAdminPath } from "../../admin/redesign/paths";

// Every sign-in through Clerk ends here: our own account for this person,
// and where it lives. Someone who came through the coach sign-up and has no
// account yet says who they are next (About you), and is in. Anyone else with
// no account yet joins a coach by their code (18 Nov, Alex: /auth/join), the
// screen they wait on until the coach says yes.
export const dynamic = "force-dynamic";

// The page they were sent to sign in from (?next=, proxy.ts), when it fits the account (26 Oct, Alex: the coach phone
// app, /coach, signed in to the admin): a coach back to the phone app or an admin screen, a client to their app. A
// path on this site only, never another address.
function backTo(next: string | undefined, role: string): string | null {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return null;
  const path = next.split(/[?#]/)[0];
  const fits = role === "client" ? path === "/client" || path.startsWith("/client/") : path === "/coach" || path.startsWith("/coach/") || isAdminPath(path);
  return fits ? next : null;
}

export default async function ContinuePage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  if (!clerkOn()) redirect("/login");
  const { next } = await searchParams;
  // On the staff admin's host (admin.norcoachapp.com, 26 Nov): never a coach's or client's setup or sign-up, and no
  // users row needed. Signed in, the staff home (or the staff page they were sent to sign in from); requireStaff there
  // decides whether they are on staff.
  if (isStaffHost(hostOf(await headers()))) {
    if (!(await clerkIdentity())) redirect("/login");
    // A plain path on this site only (safeStaffNext: printable ASCII, this origin, never the sign-in or the API).
    redirect(safeStaffNext(next) ?? "/");
  }
  const user = await getSessionUser();
  // A coach signing in inside the phone app goes straight to its coach screens (17 Nov, Alex: the admin showed first).
  const inApp = (await cookies()).get(NATIVE_COOKIE)?.value === "1";
  // A coach still waiting is let in now (17 Nov, Alex: no approval), unless the staff admin asks for a yes (26 Nov,
  // its Sign-ups): then the waiting screen until someone on staff says it.
  if (user?.pending && letCoachInOrWait(user.id) === "waiting") redirect("/auth/waiting");
  if (user) redirect(backTo(next, user.role) ?? (user.role === "client" ? "/client" : inApp ? "/coach" : "/clients"));

  const who = await clerkIdentity();
  if (!who) redirect("/login");
  const jar = await cookies();
  type Intent = { coach?: boolean };
  let intent: Intent | null;
  try {
    intent = JSON.parse(decodeURIComponent(jar.get("ironline_intent")?.value ?? "")) as Intent;
  } catch {
    intent = null;
  }
  const email = who.emails[0];
  // Waiting on a coach, or told no: their join screen, whatever an old sign-up cookie says.
  const asked = latestRequestFor(who.userId);
  if (email && (asked?.status === "open" || asked?.status === "declined")) redirect("/auth/join");
  // A coach sign-up: who they are, next.
  if (intent?.coach && email && !findUserByEmail(email)) redirect("/auth/coach-setup");
  // Everyone else: a client joining a coach, About you and the coach's code, or the request they are waiting on.
  redirect(email ? "/auth/join" : "/auth/no-account");
}
