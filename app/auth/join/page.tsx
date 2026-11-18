import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { currentUser } from "@clerk/nextjs/server";
import { clerkIdentity, clerkOn } from "../../lib/clerk";
import { getSessionUser } from "../../lib/auth";
import { coachCard, latestRequestFor, normaliseCode } from "../../lib/joinRequests";
import JoinFlow from "../../login/JoinFlow";

// Joining a coach (18 Nov, Alex: docs/boards/client-signup-mockup.html): for someone signed in to Clerk with no account
// here yet. About you and the coach's code; once sent, the wait, here every time they open the app until the coach
// says yes (then /auth/continue takes them into it). The name comes filled in from Apple or Google, the code from the
// coach's link (?code=, or the sign-up's intent cookie through Apple's and Google's round trips).
export const dynamic = "force-dynamic";

export default async function JoinCoachPage({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  if (!clerkOn()) redirect("/login");
  if (await getSessionUser()) redirect("/auth/continue");
  const who = await clerkIdentity();
  const email = who?.emails[0];
  if (!who || !email) redirect("/login");

  const { code: asked } = await searchParams;
  let fromIntent = "";
  try {
    const intent = JSON.parse(decodeURIComponent((await cookies()).get("ironline_intent")?.value ?? "")) as { code?: unknown };
    if (typeof intent?.code === "string") fromIntent = intent.code;
  } catch {}

  const latest = latestRequestFor(who.userId);
  const waiting = latest?.status === "open" ? coachCard(latest.coach_id) : null;
  const clerk = await currentUser().catch(() => null);
  const sent = latest && latest.status !== "withdrawn" ? latest : null;
  return (
    <JoinFlow
      email={email}
      first={sent?.first_name ?? clerk?.firstName ?? ""}
      last={sent?.last_name ?? clerk?.lastName ?? ""}
      birthdate={sent?.birthdate ?? ""}
      code={normaliseCode(asked || fromIntent || "")}
      waitingFor={waiting}
      declined={latest?.status === "declined"}
    />
  );
}
