import { requireCoach } from "../../../lib/auth";
import { touchPresence } from "../../../lib/presence";
import { startTiming } from "../../../lib/timing";
import { fetchClientTabChat } from "../../../lib/chat/rows";
import { fetchClientTabFood } from "../../../lib/food/rows";
import { fetchClientTabCheckIns } from "../../../lib/checkins/rows";
import { fetchClientTabSets } from "../../../lib/sets/rows";
import { dropUnusedAutoWeightPg } from "../../../lib/queries";
import { loadHome, loadMeasurements, loadMeetings, loadMessages, loadNutrition, loadPictures, fetchPictureNotes, loadPlan, railBits, loadTraining, pickClient, loadInvoices, loadDots } from "../loaders";
import RedesignShell from "../RedesignShell";
import { tabFromParams } from "../tabs";
import NoClients from "../NoClients";
import "../../../components/ui/ui.css";
import "../training/draft.css";
import "../nutrition/nutrition.css";
import "../measurements/measurements.css";
import "../pictures/pictures.css";
import "../meetings/meetings.css";
import "../plan/plan.css";
import "./home.css";
import "../messages/messages.css";
import "../invoices/invoices.css";
import "../ncdialog.css";
import "../rail.css";
import "../look-hairline.css";
import "../training/training-hairline.css";
import LookFlag from "../LookFlag";

// The redesign drafts, opened on Home. Read-only: nothing here saves.
// Local only, not for live.
//   /admin/redesign/home?client=ID
export const dynamic = "force-dynamic";

export default async function HomeRedesignPage({ searchParams }: { searchParams: Promise<{ client?: string; week?: string; program?: string; phase?: string; tab?: string }> }) {
  // Each loader timed (app/lib/timing.ts, /api/timing): measuring only, the props are what they were.
  const t = startTiming("home");
  const coach = await t.time("auth", () => requireCoach());
  const params = await searchParams;
  const { client, firstName } = t.time("pickClient", () => pickClient(coach.id, params.client));
  t.client(client?.id);
  // Where the coach is (the presence board) and Home's look are the visit's, written once the page is on screen
  // (visitClient from RedesignShell, 22 Nov): a rail hover prefetches this page, a render no visit can be told from.
  if (!client) {
    t.time("presence", () => touchPresence(coach, "Clients"));
    return t.end(<NoClients />);
  }
  // The chat first (Step 5, app/lib/chat/rows.ts): the coach's view for the rail and the dots, the client's thread.
  const chat = await t.time("chat", () => fetchClientTabChat(coach.id, client.id, "page.tab.home"));
  // The notes the Shape update reads (quest 7, app/lib/notes/rows.ts), fetched first as the chat is.
  const notes = await t.time("notes", () => fetchPictureNotes(client.id, "page.tab.home"));
  // The food diary (quest 8 part 1, app/lib/food/rows.ts), fetched first as the chat is.
  const food = await t.time("food", () => fetchClientTabFood(coach.id, client.id, "page.tab.home"));
  // The check-in figures (quest 9, app/lib/checkins/rows.ts), fetched first as the food is; with CHECKINS_STORE=pg the
  // untouched auto Weight line goes first, under the client's lock (a render can't wait for a transaction).
  await t.time("checkins.drop", () => dropUnusedAutoWeightPg(client.id));
  const ck = await t.time("checkins", () => fetchClientTabCheckIns(coach.id, client.id, "page.tab.home"));
  // The logged sets (quest 10, app/lib/sets/rows.ts), fetched first as the check-ins are.
  const sr = await t.time("sets", () => fetchClientTabSets("page.tab.home", coach.id, client.id));
  // What the shell drew from the rail (22 Nov, the rail drawn once by the layout): the coach's unit and the client's face.
  const bits = t.time("railBits", () => railBits(coach.id, client.id));
  return t.end(
    <>
    {/* ?look=hairline: the admin in the client app's language, as a preview (17 Oct). */}
    <LookFlag />
    <RedesignShell
      clientId={client.id}
      clientName={client.name ?? "Client"}
      firstName={firstName}
      units={bits.units}
      clientPhoto={bits.photo}
      dots={t.time("dots", () => loadDots(client.id, chat.coach, food, ck, sr))}
      initialTab={tabFromParams(params.tab, "home")}
      visitRoute="home"
      home={t.time("home", () => loadHome(client.id, chat, food, ck, sr))}
      training={t.time("training", () => loadTraining(coach.id, client.id, params, chat.thread, ck, sr))}
      nutrition={t.time("nutrition", () => loadNutrition(client.id, params, chat.thread, food, sr))}
      measurements={t.time("measurements", () => loadMeasurements(client.id, params, ck, sr))}
      pictures={t.time("pictures", () => loadPictures(client.id, chat.thread, notes, ck))}
      meetings={t.time("meetings", () => loadMeetings(client.id, food, ck, sr))}
      plan={t.time("plan", () => loadPlan(client.id, food, ck, sr))}
      messages={t.time("messages", () => loadMessages(client.id, chat.thread, food))}
      invoices={t.time("invoices", () => loadInvoices(coach.id, client.id))}
    />
    </>
  );
}
