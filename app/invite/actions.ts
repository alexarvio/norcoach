"use server";

import { clerkClient } from "@clerk/nextjs/server";
import { clerkIdentity, clerkOn, deleteClerkUser } from "../lib/clerk";
import { getSessionUser, getUserForClient } from "../lib/auth";
import { readInviteToken } from "../lib/inviteToken";
import { latestRequestFor } from "../lib/joinRequests";

/** How new a Clerk account must be to count as the one Apple or Google just made on this invite. */
const JUST_MADE_MS = 15 * 60 * 1000;

/**
 * `Use {email}` on an invite after Apple or Google came back with another address (22 Nov): the Clerk account just made
 * on the way is taken away, so no stray account is left behind with nothing of ours in it. Only when that is all it is:
 * no account of ours linked to it, no request to a coach, made in the last 15 minutes, and not the invited address. Any
 * other account is only signed out, by the screen. True when it was taken away.
 */
export async function dropStrayInviteAccountAction(token: string): Promise<boolean> {
  if (!clerkOn()) return false;
  const who = await clerkIdentity().catch(() => null);
  if (!who) return false;
  if (await getSessionUser().catch(() => null)) return false;
  const clientId = readInviteToken(token);
  const invited = clientId != null ? getUserForClient(clientId)?.email?.trim().toLowerCase() : null;
  if (invited && who.emails.includes(invited)) return false;
  if (latestRequestFor(who.userId)) return false;
  try {
    const user = await (await clerkClient()).users.getUser(who.userId);
    if (Date.now() - user.createdAt > JUST_MADE_MS) return false;
  } catch {
    return false;
  }
  await deleteClerkUser(who.userId);
  return true;
}
