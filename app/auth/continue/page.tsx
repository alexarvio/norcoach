import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { clerkIdentity, clerkOn } from "../../lib/clerk";
import { findUserByEmail, getSessionUser } from "../../lib/auth";
import { NATIVE_COOKIE } from "../../lib/quietLoad";
import { letCoachIn } from "../../lib/coachSignUp";

// Every sign-in through Clerk ends here: our own account for this person,
// and where it lives. Someone who came through the coach sign-up and has no
// account yet says who they are next (About you), and is in.
export const dynamic = "force-dynamic";

// The page they were sent to sign in from (?next=, proxy.ts), when it fits the account (26 Oct, Alex: the coach phone
// app, /coach, signed in to the admin): a coach back to the phone app or an admin screen, a client to their app. A
// path on this site only, never another address.
function backTo(next: string | undefined, role: string): string | null {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return null;
  const path = next.split(/[?#]/)[0];
  const fits = role === "client" ? path === "/client" || path.startsWith("/client/") : path === "/coach" || path.startsWith("/coach/") || path.startsWith("/admin");
  return fits ? next : null;
}

export default async function ContinuePage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  if (!clerkOn()) redirect("/login");
  const { next } = await searchParams;
  const user = await getSessionUser();
  // A coach signing in inside the phone app goes straight to its coach screens (17 Nov, Alex: the admin showed first).
  const inApp = (await cookies()).get(NATIVE_COOKIE)?.value === "1";
  // A coach still waiting from when sign-ups were approved by hand is let in now (17 Nov, Alex: no approval).
  if (user?.pending) letCoachIn(user.id);
  if (user) redirect(backTo(next, user.role) ?? (user.role === "client" ? "/client" : inApp ? "/coach" : "/admin/redesign"));

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
  // A coach sign-up: who they are, next.
  if (intent?.coach && email && !findUserByEmail(email)) redirect("/auth/coach-details");
  redirect("/auth/no-account");
}
