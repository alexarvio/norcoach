import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { clerkOn } from "../../lib/clerk";
import { getSessionUser } from "../../lib/auth";
import { normaliseCode } from "../../lib/joinRequests";
import { OtherAccountScreen } from "../../login/OtherAccountScreen";

// A sign-up of one kind that came back with an account of the other (27 Nov, Alex: Client on Sign in "logs me into a
// coach account"; /auth/continue sends them here): says whose account it is, never lands in it.
export const dynamic = "force-dynamic";

export default async function OtherAccountPage({ searchParams }: { searchParams: Promise<{ as?: string; code?: string }> }) {
  if (!clerkOn()) redirect("/login");
  const user = await getSessionUser();
  if (!user) redirect("/auth/continue");
  const { as, code } = await searchParams;
  // Only while it really is the other kind; anything else goes on as a sign-in does.
  if (!((as === "client" && user.role === "coach") || (as === "coach" && user.role === "client"))) redirect("/auth/continue");
  // A coach's code from their link (/join/<code>), so Use another email comes back to it: in the address when a signed-in
  // visit carried it, else in the client sign-up's note.
  let joinCode = normaliseCode(code ?? "");
  if (!joinCode && as === "client") {
    try {
      const intent = JSON.parse(decodeURIComponent((await cookies()).get("ironline_intent")?.value ?? "")) as { code?: unknown };
      if (typeof intent?.code === "string") joinCode = normaliseCode(intent.code);
    } catch {}
  }
  return <OtherAccountScreen as={as} email={user.email ?? null} code={joinCode} />;
}
