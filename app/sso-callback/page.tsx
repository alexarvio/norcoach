import { redirect } from "next/navigation";
import { AuthenticateWithRedirectCallback } from "@clerk/nextjs";
import { clerkOn } from "../lib/clerk";

// Back from Apple or Google: Clerk finishes the sign-in (or the sign-up, for
// an account it doesn't know yet) and goes on to /auth/continue. Drawn per
// request, never at build time: without Clerk (no keys on the server) there
// is no ClerkProvider to render its callback in, so it goes to the login.
// ?as=client or ?as=coach (27 Nov): from a sign-up, carried on, so an account of the other kind says so there
// (/auth/other-account) on a sign-up Clerk finishes here too, never only on a sign-in it finished straight away.
export const dynamic = "force-dynamic";

export default async function SsoCallbackPage({ searchParams }: { searchParams: Promise<{ as?: string }> }) {
  if (!clerkOn()) redirect("/login");
  const { as } = await searchParams;
  if (as === "client" || as === "coach") {
    const to = `/auth/continue?as=${as}`;
    return <AuthenticateWithRedirectCallback signInForceRedirectUrl={to} signUpForceRedirectUrl={to} signInFallbackRedirectUrl={to} signUpFallbackRedirectUrl={to} />;
  }
  return <AuthenticateWithRedirectCallback signInFallbackRedirectUrl="/auth/continue" signUpFallbackRedirectUrl="/auth/continue" />;
}
