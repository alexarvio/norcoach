import { redirect } from "next/navigation";
import { clerkOn } from "../../lib/clerk";
import { normaliseCode } from "../../lib/joinRequests";
import { SignOutNow } from "../../login/ClerkFlows";

// Signing out through Clerk happens in the browser (it holds the session);
// every "Sign out" in the app lands here when Clerk is on.
// ?to=join (with the coach's ?code=) or ?to=signup (27 Nov): back to that sign-up once signed out, from Use another
// email (/auth/other-account).
export default async function SignOutPage({ searchParams }: { searchParams: Promise<{ deleted?: string; to?: string; code?: string }> }) {
  if (!clerkOn()) redirect("/login");
  const { deleted, to, code } = await searchParams;
  const joinCode = normaliseCode(code ?? "");
  const back = deleted ? "/login?deleted=1" : to === "join" ? (joinCode ? `/join/${encodeURIComponent(joinCode)}` : "/join") : to === "signup" ? "/signup" : "/login";
  return <SignOutNow to={back} />;
}
