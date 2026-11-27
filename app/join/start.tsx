import { redirect } from "next/navigation";
import { clerkIdentity, clerkOn } from "../lib/clerk";
import { getSessionUser } from "../lib/auth";
import { passwordsOnHint } from "../lib/clerkPasswords";
import { normaliseCode } from "../lib/joinRequests";
import { ClientSignUpFlow } from "../login/ClerkFlows";

/** /join and /join/<code>: the client sign-up, or, signed in already, on to the join screens or the app. */
export async function joinStart(rawCode: string) {
  if (!clerkOn()) redirect("/login");
  const code = normaliseCode(rawCode);
  // Signed in already: their app, unless it is a coach's account (27 Nov), which says so (/auth/other-account).
  if (await getSessionUser()) redirect(`/auth/continue?as=client${code ? `&code=${code}` : ""}`);
  if (await clerkIdentity()) redirect(`/auth/join${code ? `?code=${code}` : ""}`);
  return <ClientSignUpFlow passwordsHint={await passwordsOnHint()} code={code} />;
}
