import AdminShell from "../AdminShell";
import AdminSidebar from "../AdminSidebar";
import CoachProfileEditor from "../CoachProfileEditor";
import { isOwner, requireCoach } from "../../lib/auth";
import { getCoachProfileView, listCoachEmails } from "../../lib/queries";
import { fetchCoachChat } from "../../lib/chat/rows";
import { fetchCoachFood } from "../../lib/food/rows";
import { fetchCoachCheckIns } from "../../lib/checkins/rows";
import { fetchEverySet } from "../../lib/sets/rows";

// "Your profile": the coach writes what their clients read from the Account
// tab, with a live phone preview beside the form. The owner can open any
// coach's profile with ?coachId=.
export const dynamic = "force-dynamic";

export default async function CoachProfilePage({ searchParams }: { searchParams: Promise<{ coachId?: string }> }) {
  const coach = await requireCoach();
  const params = await searchParams;
  const owner = isOwner(coach);
  const asked = Number(params.coachId);
  const coachId = owner && Number.isInteger(asked) && asked > 0 && getCoachProfileView(asked) ? asked : coach.id;
  const profile = getCoachProfileView(coachId);
  const coaches = owner ? listCoachEmails() : [];
  // The chat first (Step 5, app/lib/chat/rows.ts), for the sidebar's dots.
  const chat = await fetchCoachChat([coach.id], "page.oldAdmin.profile");
  // The food diary the same (quest 8 part 1), for the sidebar's feed.
  const food = await fetchCoachFood([coach.id], "page.oldAdmin.profile");
  const ck = await fetchCoachCheckIns([coach.id], "page.oldAdmin.profile");
  // The logged sets (quest 10): everything, as the old admin reads them.
  const sr = await fetchEverySet("page.oldAdmin.profile");

  return (
    <AdminShell sidebar={<AdminSidebar coachId={coach.id} coachEmail={coach.email} selectedId={null} view="profile" isOwner={owner} chat={chat} food={food} ck={ck} sr={sr} />}>
      <div className="ad-pad">
        {profile ? (
          <CoachProfileEditor key={coachId} profile={profile} coaches={coaches} currentCoachId={coach.id} />
        ) : (
          <p className="empty-note">This account has no coach profile.</p>
        )}
      </div>
    </AdminShell>
  );
}
