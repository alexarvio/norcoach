import { clerkClient } from "@clerk/nextjs/server";
import { getData, persist } from "./db";
import { isReviewClient, phaseHasBegun } from "./appLock";
import { isReviewEmail } from "./reviewAccount";
import { brandColour } from "./brandColour";
import { coachCard, ensureJoinCode } from "./joinRequests";
import { mailConfigured, sendClientWelcomeEmail, sendCoachWelcomeEmail, type ClientWelcome } from "./mail";

// The welcome emails (25 Nov, Alex: docs/boards/welcome-email-mockup.html, "Yes, build them"), in the code email's dark
// frame (lib/mail.ts):
//   a client's, from their coach by name, the moment they are let in: the coach accepting their request
//     (acceptJoinRequestAction), or their first sign-in after the coach's invite (clerkUserRow linking a client login no
//     Clerk account had claimed, whose app was never opened, so the accounts from before the switch never get one);
//   a coach's, from Norcoach, the first time they save Your business at sign-up (saveWelcomeBusinessAction), marked on
//     the coach so going Back and saving again sends nothing.
// Both through Resend: nothing goes until RESEND_API_KEY and MAIL_FROM are set. Never awaited by the step that sends
// them: a slow or failed email never holds anyone up.

const siteUrl = () => (process.env.APP_URL ?? "https://app.norcoachapp.com").replace(/\/$/, "");

/** How a Clerk account signs in, for the email's last line: the button they used when they have no password, else
 *  their email. Null when Clerk can't say. */
async function signInOf(clerkUserId: string | null | undefined, email: string): Promise<ClientWelcome["signIn"]> {
  if (!clerkUserId) return email ? { email } : null;
  try {
    const user = await (await clerkClient()).users.getUser(clerkUserId);
    if (!user.passwordEnabled) {
      const providers = user.externalAccounts.map((a) => String(a.provider ?? ""));
      if (providers.some((p) => p.includes("apple"))) return { with: "apple" };
      if (providers.some((p) => p.includes("google"))) return { with: "google" };
    }
  } catch {
    // Clerk out of reach: the email they were invited or asked with still signs them in by a code.
  }
  return email ? { email } : null;
}

/** The client's welcome, from their coach, once a client whichever way they came in (marked before it goes, so accept
 *  and a first sign-in can't both send it); never to the App Review account or a client from before the lock (its first
 *  sweep opened their app, `before`). Resolves false rather than throwing. */
export async function sendClientWelcome(clientId: number, to: string, clerkUserId?: string | null): Promise<boolean> {
  try {
    return await welcomeClient(clientId, to, clerkUserId);
  } catch (error) {
    console.error("[welcome] client", clientId, error instanceof Error ? error.message : error);
    return false;
  }
}

async function welcomeClient(clientId: number, to: string, clerkUserId?: string | null): Promise<boolean> {
  if (!mailConfigured() || !to || isReviewEmail(to)) return false;
  const data = getData();
  const client = data.clients.find((c) => c.id === clientId);
  if (!client || client.coach_id == null || client.welcome_sent_at || client.app_opened_by === "before" || isReviewClient(clientId)) return false;
  client.welcome_sent_at = new Date().toISOString();
  persist();
  ensureJoinCode(client.coach_id);
  const card = coachCard(client.coach_id);
  const coachUser = data.users.find((u) => u.id === client.coach_id);
  if (!card || !coachUser) return false;
  const colour = coachUser.coach_settings?.brand?.color ? brandColour(coachUser.coach_settings.brand.color) : null;
  return sendClientWelcomeEmail({
    to,
    replyTo: coachUser.email ?? null,
    first: client.name.trim().split(/\s+/)[0] || client.name,
    coachName: card.name,
    coachFirst: card.first,
    business: card.business,
    brand: colour ? { hex: colour.hex, ink: colour.ink } : null,
    open: !!client.app_opened_at || phaseHasBegun(clientId),
    signIn: await signInOf(clerkUserId, to),
    url: `${siteUrl()}/client`,
  }).catch(() => false);
}

/** The coach's welcome, once: marked on the coach the moment it is first asked for, so a second save never sends it
 *  again (a failed send is not tried again; the coach is in either way). */
export async function sendCoachWelcomeOnce(coachId: number): Promise<boolean> {
  try {
    return await welcomeCoach(coachId);
  } catch (error) {
    console.error("[welcome] coach", coachId, error instanceof Error ? error.message : error);
    return false;
  }
}

async function welcomeCoach(coachId: number): Promise<boolean> {
  if (!mailConfigured()) return false;
  const user = getData().users.find((u) => u.id === coachId && u.role === "coach");
  if (!user?.email || user.coach_settings?.welcome_sent_at) return false;
  user.coach_settings = { ...(user.coach_settings ?? {}), welcome_sent_at: new Date().toISOString() };
  persist();
  const code = ensureJoinCode(coachId);
  const first = coachCard(coachId)?.first ?? "";
  return sendCoachWelcomeEmail({ to: user.email, first, code, url: `${siteUrl()}/feed` }).catch(() => false);
}
