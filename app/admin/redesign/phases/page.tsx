import { requireCoach } from "../../../lib/auth";
import { startTiming } from "../../../lib/timing";
import { loadChatDock, loadPhaseNeeds } from "../loaders";
import { fetchCoachPageChat } from "../../../lib/chat/rows";
import { fetchCoachFood } from "../../../lib/food/rows";
import { fetchCoachCheckIns } from "../../../lib/checkins/rows";
import { fetchCoachSets } from "../../../lib/sets/rows";
import ChatDock from "../ChatDock";
import "../messages/messages.css";
import PhasesOverview from "./PhasesOverview";
import { loadPhasesOverview } from "./load";
import "../../../components/ui/ui.css";
import "../training/draft.css";
import "../training/trn.css";
import "../home/home.css";
import "../feed/feed.css";
import "../nutrition/nutrition.css";
import "../measurements/measurements.css";
import "../plan/plan.css";
import "../ncdialog.css";
import "../rail.css";
import "./phases.css";

// Every client's phases and events on one timeline (redrawn 14 Oct; the
// Plan's timeline since 21 Oct): ending soon as a list to act on, the
// clients' lanes below, the rail on the left.
//   /phases
export const dynamic = "force-dynamic";

export default async function PhasesPage() {
  // Each loader timed (app/lib/timing.ts, /api/timing): measuring only, the props are what they were.
  const t = startTiming("phases");
  const coach = await t.time("auth", () => requireCoach());
  // The chat first (Step 5, app/lib/chat/rows.ts): the rail's view and the chat list's.
  const chat = await t.time("chat", () => fetchCoachPageChat(coach.id, "page.phases"));
  // The food diary the rail's feed reads (quest 8 part 1), fetched first as the chat is.
  const food = await t.time("food", () => fetchCoachFood([coach.id], "page.phases"));
  // The check-in figures the rail's feed reads (quest 9, app/lib/checkins/rows.ts), fetched first as the food is.
  const ck = await t.time("checkins", () => fetchCoachCheckIns([coach.id], "page.phases"));
  // The logged sets (quest 10, app/lib/sets/rows.ts), fetched first as the check-ins are.
  const sr = await t.time("sets", () => fetchCoachSets("page.phases", [coach.id]));
  return t.end(
    <>
      <ChatDock chats={t.time("chatDock", () => loadChatDock(coach, chat.dock))} />
      <div className="rd-page">
        <PhasesOverview data={t.time("phasesOverview", () => loadPhasesOverview(coach.id, sr))} needs={t.time("phaseNeeds", () => loadPhaseNeeds(coach.id, chat.coach, food, ck, sr))} now={Date.now()} />
      </div>
    </>
  );
}
