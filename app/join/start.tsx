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
  if (await getSessionUser()) redirect("/auth/continue");
  if (await clerkIdentity()) redirect(`/auth/join${code ? `?code=${code}` : ""}`);
  return <ClientSignUpFlow passwordsHint={await passwordsOnHint()} code={code} />;
}
