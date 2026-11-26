import { requireCoach } from "../../../lib/auth";
import { getBusinessBoard } from "../../../lib/businessBoard";
import { startTiming } from "../../../lib/timing";
import { loadChatDock } from "../loaders";
import { fetchChatDock } from "../../../lib/chat/rows";
import ChatDock from "../ChatDock";
import BusinessDraft from "./BusinessDraft";
import "../messages/messages.css";
import "../../../components/ui/ui.css";
import "../training/draft.css";
import "../training/trn.css";
import "../measurements/measurements.css";
import "../home/home.css";
import "../rail.css";
import "./business.css";

// The coach's Business (21 Oct, Alex: built from the Business mockup): the business in numbers, nothing about the
// clients' bodies. What changed since the last visit, three figures, money and clients by month, who owes, the plans
// ending and who isn't billed by itself. One read (app/lib/businessBoard.ts), the rail on the left.
//   /business
export const dynamic = "force-dynamic";

export default async function BusinessPage() {
  // Each loader timed (app/lib/timing.ts, /api/timing): measuring only, the props are what they were.
  const t = startTiming("business");
  const coach = await t.time("auth", () => requireCoach());
  // The chat first (Step 5, app/lib/chat/rows.ts): the chat list's alone (the rail reads its own, in the layout).
  const chat = { dock: await t.time("chat", () => fetchChatDock(coach.id, "page.business")) };
  // The visit is noted once the page is on screen (26 Nov; visitView from RailFrame, /api/admin/visit), never here: the
  // rail draws this page ahead in the background (RedesignRail's warm views). Since reads the visit before this one
  // as the note will leave it (businessBoardData's sinceOf), so a page drawn before the note says the same.
  const board = t.time("businessBoard", () => getBusinessBoard(coach.id));
  return t.end(
    <>
      <ChatDock chats={t.time("chatDock", () => loadChatDock(coach, chat.dock))} />
      <div className="rd-page">
        <BusinessDraft board={board} />
      </div>
    </>
  );
}
