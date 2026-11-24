import { requireCoach } from "../../../lib/auth";
import { getFeedBoard, noteFeedLooked } from "../../../lib/feedBoard";
import { headers } from "next/headers";
import { startTiming } from "../../../lib/timing";
import { loadChatDock } from "../loaders";
import { fetchCoachPageChat } from "../../../lib/chat/rows";
import { fetchCoachFood } from "../../../lib/food/rows";
import { fetchCoachCheckIns } from "../../../lib/checkins/rows";
import { fetchCoachSets } from "../../../lib/sets/rows";
import ChatDock from "../ChatDock";
import FeedDraft from "./FeedDraft";
import "../messages/messages.css";
import "../../../components/ui/ui.css";
import "../training/draft.css";
import "../training/trn.css";
import "../measurements/measurements.css";
import "../home/home.css";
import "../rail.css";
import "./feed.css";

// The coach's Feed (21 Oct, Alex: built from the Feed mockup): every client at once. What happened since the last
// visit, Needs you (a task a row, each with its action), Clients (a row a client: their last 14 days, this week's
// sessions, when they were last active, at most two state pills) and Activity (a log, New over Earlier). Money lives
// on Business. One read (app/lib/feedBoard.ts), the rail on the left.
//   /feed            ?cat=training|nutrition|lifestyle|meetings|messages opens Activity on that kind
export const dynamic = "force-dynamic";

export default async function FeedPage({ searchParams }: { searchParams: Promise<{ cat?: string }> }) {
  // Each loader timed (app/lib/timing.ts, /api/timing): measuring only, the props are what they were.
  const t = startTiming("feed");
  const coach = await t.time("auth", () => requireCoach());
  // The visit is noted first, so Since and New read from the visit before this one; before the chat, too, whose view
  // holds what came after that visit (Step 5's cut-over: the Feed's Since reads only that).
  // A hover-prefetch from the rail is not a visit (22 Nov): only a real navigation notes the look.
  const prefetching = (await headers()).has("next-router-prefetch");
  if (!prefetching) await t.time("noteFeedLooked", () => noteFeedLooked(coach.id));
  // The chat first (Step 5, app/lib/chat/rows.ts): the one view the Feed, the rail and the chat list share.
  const chat = await t.time("chat", () => fetchCoachPageChat(coach.id, "page.feed"));
  // The food diary the Feed and the rail read (quest 8 part 1), fetched first as the chat is.
  const food = await t.time("food", () => fetchCoachFood([coach.id], "page.feed"));
  // The check-in figures the rail's feed reads (quest 9, app/lib/checkins/rows.ts), fetched first as the food is.
  const ck = await t.time("checkins", () => fetchCoachCheckIns([coach.id], "page.feed"));
  // The logged sets (quest 10, app/lib/sets/rows.ts), fetched first as the check-ins are.
  const sr = await t.time("sets", () => fetchCoachSets("page.feed", [coach.id]));
  const params = await searchParams;
  const board = await t.time("feedBoard", () => getFeedBoard(coach.id, chat.coach, food, ck, sr));
  // eslint-disable-next-line react-hooks/purity -- a server render reads the clock once, on purpose: the waits in Needs you count from it, the same on the server and in the browser
  const now = Date.now();
  return t.end(
    <>
      <ChatDock chats={t.time("chatDock", () => loadChatDock(coach, chat.dock))} />
      <div className="rd-page">
        <FeedDraft board={board} now={now} kind={params.cat ?? null} />
      </div>
    </>
  );
}
