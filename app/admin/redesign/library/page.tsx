import { requireCoach } from "../../../lib/auth";
import { startTiming } from "../../../lib/timing";
import { loadChatDock } from "../loaders";
import { fetchChatDock } from "../../../lib/chat/rows";
import ChatDock from "../ChatDock";
import "../messages/messages.css";
import LibraryDraft from "./LibraryDraft";
import { loadLibrary } from "./load";
import "../../../components/ui/ui.css";
import "../training/draft.css";
import "../training/trn.css";
import "../measurements/measurements.css";
import "../rail.css";
import "./library.css";

// The coach's Library (5 Oct; 21 Oct, Alex: just the exercises and their demos): every exercise of theirs by muscle
// group, each with a video or a link. Training's header and the shared hairline cards (trn.css, measurements.css).
//   /library
export const dynamic = "force-dynamic";

export default async function LibraryPage() {
  // Each loader timed (app/lib/timing.ts, /api/timing): measuring only, the props are what they were.
  const t = startTiming("library");
  const coach = await t.time("auth", () => requireCoach());
  // The chat first (Step 5, app/lib/chat/rows.ts): the chat list's alone (the rail reads its own, in the layout).
  const chat = { dock: await t.time("chat", () => fetchChatDock(coach.id, "page.library")) };
  return t.end(
    <>
      <ChatDock chats={t.time("chatDock", () => loadChatDock(coach, chat.dock))} />
      <div className="rd-page">
        <LibraryDraft data={t.time("library", () => loadLibrary(coach.id))} />
      </div>
    </>
  );
}
