import { redirect } from "next/navigation";
import { getSessionUser } from "../../lib/auth";
import { isWaitingCoach } from "../../lib/coachSignUp";
import { getData } from "../../lib/db";
import { getCoachProfile } from "../../lib/queries";
import { CoachWaiting } from "./CoachWaiting";

// Where a coach who signed up waits for a yes (26 Nov, Alex: approval back, the staff admin's Sign-ups; it was gone
// from 17 Nov, Alex: "I don't see why I have to accept them"). Only while they wait and the switch asks for one
// (isWaitingCoach): anyone else goes on to /auth/continue, which lets a coach in once nobody needs to say yes. Read again
// every 20 seconds, so a yes takes them on by itself.
export const dynamic = "force-dynamic";

export default async function WaitingPage() {
  const me = await getSessionUser();
  if (!me) redirect("/login");
  if (me.role !== "coach" || !isWaitingCoach(me.id)) redirect("/auth/continue");
  const row = getData().users.find((u) => u.id === me.id);
  const profile = getCoachProfile(me.id);
  const name = profile?.display_name?.trim() || row?.pending?.name?.trim() || me.email;
  return <CoachWaiting name={name} email={me.email} photo={profile?.avatar_path ?? null} />;
}
