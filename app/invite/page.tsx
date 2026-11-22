import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { clerkIdentity, clerkOn } from "../lib/clerk";
import { getSessionUser, getUserForClient } from "../lib/auth";
import { readInviteToken } from "../lib/inviteToken";
import { getClient, getCoachProfile, getCoachProfileView, getCoachSettings } from "../lib/queries";
import { passwordsOnHint } from "../lib/clerkPasswords";
import { NATIVE_COOKIE } from "../lib/quietLoad";
import { InviteFlow, InviteOtherAccount } from "../login/ClerkFlows";
import type { InviteCoach } from "../login/InviteScreen";
import type { InApp } from "../login/SignInScreens";
import ForgetKept from "../login/ForgetKept";

// Where a client's invite link lands (Clerk sends the email). Clerk adds
// __clerk_ticket to the address; ?c= is ours, signed, and says who it is
// for, so the screen can show their coach and fill in their email.
//   /invite?c=12.ab34…&__clerk_ticket=…
// Since 22 Nov (Alex: "we need to have them create an account because they need to log in"): the client sign-up's
// Create your account, the coach over it and the invited email filled in, a password chosen with the ticket (no code),
// or Apple and Google with that address. Our account for them is found by that verified email (lib/clerk.ts), so once
// in they are the coach's client, no code and no request: /auth/continue, then their app.
export const dynamic = "force-dynamic";

/** The phone app this page is in, as the sign-in page reads it (app/login/page.tsx). */
async function inApp(): Promise<InApp> {
  if ((await cookies()).get(NATIVE_COOKIE)?.value !== "1") return null;
  return /iPhone|iPad|iPod/.test((await headers()).get("user-agent") ?? "") ? "ios" : "android";
}

/** The client's coach for the invite: name, first name, business and the picture by the link's own token. */
function inviteCoach(coachId: number, token: string): InviteCoach {
  const view = getCoachProfileView(coachId);
  const name = view?.displayName?.trim() || getCoachProfile(coachId)?.display_name?.trim() || "Coach";
  const v = view?.avatarPath ? (view.avatarPath.split("v=")[1] ?? "") : "";
  return {
    name,
    first: name.split(/\s+/)[0] || name,
    business: getCoachSettings(coachId).business?.business_name?.trim() ?? "",
    photo: view?.avatarPath ? `/invite/photo?c=${encodeURIComponent(token)}${v ? `&v=${encodeURIComponent(v)}` : ""}` : null,
  };
}

export default async function InvitePage({ searchParams }: { searchParams: Promise<{ c?: string; __clerk_ticket?: string }> }) {
  if (!clerkOn()) redirect("/login");
  // Signed in with an account of ours (just now, by the invite, or from before): on into it, Home for a client.
  // A Clerk account taken away a moment ago can still be on the request for up to a minute: read as no one.
  if (await getSessionUser().catch(() => null)) redirect("/auth/continue");
  const params = await searchParams;
  const token = params.c ?? null;
  const ticket = params.__clerk_ticket ?? null;
  const clientId = readInviteToken(token);
  const client = clientId != null ? getClient(clientId) : null;
  const email = client ? (getUserForClient(client.id)?.email ?? null) : null;
  const coach = client?.coach_id != null && token ? inviteCoach(client.coach_id, token) : null;

  // Back from Apple or Google with another address: no account of ours behind it. Said, never a stray account left
  // waiting on a coach's code (/auth/continue would send it to /auth/join).
  const who = await clerkIdentity().catch(() => null);
  // The invited address after all, its account of ours linked elsewhere: /auth/continue says what it is.
  if (who && email && who.emails.includes(email.trim().toLowerCase())) redirect("/auth/continue");
  // No invited address to hold it to (the client deleted since, a bad link): on as any new account, to the code screen.
  if (who && !email) redirect("/auth/continue");
  if (who) return <InviteOtherAccount token={token} ticket={ticket} coach={coach} email={email} signedInAs={who.emails[0] ?? null} />;

  return (
    <>
      {/* Signing in always lands on Home (18 Nov): what this device kept for the last account goes. */}
      <ForgetKept />
      <InviteFlow token={token} ticket={ticket} email={email} coach={coach} passwordsHint={await passwordsOnHint()} app={await inApp()} />
    </>
  );
}
