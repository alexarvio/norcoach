import { notFound } from "next/navigation";
import { isOwner, requireCoach } from "../../../lib/auth";
import { getCoachProfileView, listCoachAccounts, listCoachEmails } from "../../../lib/queries";
import { fetchCoachChat, fetchCoachPageChat } from "../../../lib/chat/rows";
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
  const accounts: CoachRow[] = t.time("coachAccounts", () =>
    listCoachAccounts(everyCoach)
      .map((c) => {
        const b = billingView(c.id, c.id === coach.id);
        return { ...c, name: getCoachProfileView(c.id)?.displayName ?? c.email, owner: c.id === coach.id, pays: b.required, billing: b.pill };
      }),
  );
  return t.end(
    <div className="rd-frame">
      <RedesignRail rail={t.time("rail", () => loadRail(coach, chat.coach))} clientId={0} />
      <ChatDock chats={t.time("chatDock", () => loadChatDock(coach, chat.dock))} />
      <div className="rd-page">
        <CoachesDraft accounts={accounts} support={t.time("supportThreads", () => listSupportThreads())} billingOn={billingOn()} />
      </div>
    </div>
  );
}
