// The invite's own addresses (22 Nov), one place for the page, its Apple and Google callback and the screen:
//   /invite?c=<signed client>&__clerk_ticket=<Clerk's invitation ticket>
// The callback carries the ticket under its own name (t), so nothing on the way back reads it as Clerk's. It lives
// under /sso-callback, never /invite: the iPhone app claims /invite/* (its universal links), and a redirect back from
// Apple or Google there would open in the app, which holds none of Safari's sign-in.

export function inviteHref(token: string | null | undefined, ticket: string | null | undefined): string {
  const q = new URLSearchParams();
  if (token) q.set("c", token);
  if (ticket) q.set("__clerk_ticket", ticket);
  const s = q.toString();
  return s ? `/invite?${s}` : "/invite";
}

export function inviteCallbackHref(token: string | null | undefined, ticket: string | null | undefined): string {
  const q = new URLSearchParams();
  if (token) q.set("c", token);
  if (ticket) q.set("t", ticket);
  const s = q.toString();
  return s ? `/sso-callback/invite?${s}` : "/sso-callback/invite";
}
