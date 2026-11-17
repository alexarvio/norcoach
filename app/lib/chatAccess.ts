import "server-only";
import { getRequestUser, isOwner, type SessionUser } from "./auth";
import { billingAccess } from "./billing";
import { touchPresence } from "./presence";
import { coachOwnsClient } from "./tenancy";

// Who may do what in a chat, for its own routes (17 Nov, Alex: the coach's phone chat "didn't load for a few seconds,
// maybe 10", and a message then sat on Sending). The chats read, send, mark seen and say Typing… through plain route
// handlers (app/api/chat/*) instead of server actions: Next runs a page's server actions one at a time, so a send
// waited behind every read, read mark and typing signal before it, and an action that revalidated a path sent the
// whole page back with it. These are the same checks the actions make (lib/auth.ts), read from the request, so they
// hold whether or not Clerk's middleware ran on it. None redirects: a refusal is null, and the route says 401.

/** The signed-in user on this request, let in (not waiting on a new password or the owner), or null. */
export async function chatUser(request: Request): Promise<SessionUser | null> {
  // A change asked from another site is refused, as Next refuses a server action whose Origin is not this host.
  if (request.method !== "GET" && !sameOrigin(request)) return null;
  const user = await getRequestUser(request).catch(() => null);
  if (!user || user.must_change_password || user.pending) return null;
  touchPresence(user);
  return user;
}

/** The request came from this app's own pages: its Origin (sent with every fetch that changes something) is this host. */
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const host = (request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "").split(",")[0].trim().toLowerCase();
  try {
    return !!host && new URL(origin).host.toLowerCase() === host;
  } catch {
    return false;
  }
}

/** The chat this user may use, as requireClientAccess decides: a coach's own client, a client their own (the id asked for ignored). */
export function chatClientOf(user: SessionUser, requested: number): number | null {
  if (user.role === "coach") return Number.isInteger(requested) && coachOwnsClient(user.id, requested) ? requested : null;
  return user.client_id ?? null;
}

/** The coach's side of one client's chat, as coachForClient decides for a read (a coach still to subscribe is not let in;
 *  a read-only one is, since the chat stays open then, docs/DESIGN-RULES-ADMIN.md §9). */
export function coachChatOf(user: SessionUser, clientId: number, open = false): number | null {
  if (user.role !== "coach" || !Number.isInteger(clientId) || !coachOwnsClient(user.id, clientId)) return null;
  if (!open && billingAccess(user.id, isOwner(user)).state === "subscribe") return null;
  return clientId;
}
