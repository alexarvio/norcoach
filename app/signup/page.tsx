import { redirect } from "next/navigation";
import { clerkOn } from "../lib/clerk";
import { passwordsOnHint } from "../lib/clerkPasswords";
import { getSessionUser } from "../lib/auth";
import { CoachSignUpFlow } from "../login/ClerkFlows";

// A coach makes their own account (sign-in through Clerk only) and is in at
// once, no owner's approval (17 Nov, Alex; lib/coachSignUp.ts).
export const dynamic = "force-dynamic";

export default async function SignUpPage() {
  if (!clerkOn()) redirect("/login");
  const user = await getSessionUser();
  // Signed in already: their admin, unless it is a client's account (27 Nov), which says so (/auth/other-account).
  if (user) redirect("/auth/continue?as=coach");
  return <CoachSignUpFlow passwordsHint={await passwordsOnHint()} />;
}
