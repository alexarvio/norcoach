import { notFound } from "next/navigation";
import { isOwner, requireCoach } from "../../../lib/auth";
import { getCoachProfileView, getCoachSettings, listCoachAccounts, listCoachEmails } from "../../../lib/queries";
import { ensureJoinCode } from "../../../lib/joinRequests";
import { fetchCoachChat, fetchCoachPageChat } from "../../../lib/chat/rows";
import { fetchCoachFood } from "../../../lib/food/rows";
import { fetchCoachCheckIns, fetchEveryCheckIn } from "../../../lib/checkins/rows";
import { fetchCoachSets, fetchEverySet } from "../../../lib/sets/rows";
import { listSupportThreads } from "../../../lib/support";
import { billingOn, billingView } from "../../../lib/billing";
import { startTiming } from "../../../lib/timing";
import { loadChatDock, loadRail } from "../loaders";
import RedesignRail from "../RedesignRail";
import ChatDock from "../ChatDock";
import CoachesDraft, { type CoachRow } from "./CoachesDraft";
import "../messages/messages.css";
import "../../../components/ui/ui.css";
import "../training/draft.css";
import "../training/trn.css";
import "../measurements/measurements.css";
import "../rail.css";
import "./coaches.css";

// The owner's Coaches in the redesign (22 Oct, Alex: the old /admin?view=coaches in the new style): every coach
// account, how many clients each has and when one last logged something (no sign-ups to let in since 17 Nov: a coach is in
// at once, lib/coachSignUp.ts), the
// coaches' Support threads (23 Oct, SupportInbox, lib/support.ts), and the owner's account actions (CoachesPanel's
// own, see ./actions.ts). Never any client's name or data. Owner only.
//   /admin/redesign/coaches
export const dynamic = "force-dynamic";

export default async function CoachesPage() {
  // Each loader timed (app/lib/timing.ts, /api/timing): measuring only, the props are what they were.
  const t = startTiming("coaches");
  const coach = await t.time("auth", () => requireCoach());
  if (!isOwner(coach)) notFound();
  // The chat first (Step 5, app/lib/chat/rows.ts): the rail's view and the chat list's, and every coach's for their last activity.
  const chat = await t.time("chat", () => fetchCoachPageChat(coach.id, "page.coaches"));
  const everyCoach = await t.time("chatAll", () => fetchCoachChat(listCoachEmails().map((c) => c.id), "page.coaches.accounts"));
  // The food diary the same (quest 8 part 1): the rail's coach, and every coach's for their last activity.
  const food = await t.time("food", () => fetchCoachFood([coach.id], "page.coaches"));
  const everyCoachFood = await t.time("foodAll", () => fetchCoachFood(listCoachEmails().map((c) => c.id), "page.coaches.accounts"));
  // The check-in figures the same (quest 9): the rail's coach, and every client for each coach's last activity.
  const ck = await t.time("checkins", () => fetchCoachCheckIns([coach.id], "page.coaches"));
  // The logged sets (quest 10, app/lib/sets/rows.ts), fetched first as the check-ins are.
  const sr = await t.time("sets", () => fetchCoachSets("page.coaches", [coach.id]));
  const everyCheckIn = await t.time("checkinsAll", () => fetchEveryCheckIn("page.coaches.accounts"));
  const everySet = await t.time("setsAll", () => fetchEverySet("page.coaches.accounts"));
  const accounts: CoachRow[] = t.time("coachAccounts", () =>
    listCoachAccounts(everyCoach, everyCoachFood, everyCheckIn, everySet)
      .map((c) => {
        const b = billingView(c.id, c.id === coach.id);
        const view = getCoachProfileView(c.id);
        // To find a coach by (18 Nov): their business, their Norcode (made here if they have none yet) and their face.
        return { ...c, name: view?.displayName ?? c.email, business: getCoachSettings(c.id).business?.business_name?.trim() ?? "", code: ensureJoinCode(c.id), photo: view?.avatarPath ?? null, owner: c.id === coach.id, pays: b.required, billing: b.pill };
      }),
  );
  return t.end(
    <div className="rd-frame">
      <RedesignRail rail={t.time("rail", () => loadRail(coach, chat.coach, food, ck, sr))} clientId={0} />
      <ChatDock chats={t.time("chatDock", () => loadChatDock(coach, chat.dock))} />
      <div className="rd-page">
        <CoachesDraft accounts={accounts} support={t.time("supportThreads", () => listSupportThreads())} billingOn={billingOn()} />
      </div>
    </div>
  );
}
