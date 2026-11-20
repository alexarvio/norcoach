import { requireCoach } from "../../../lib/auth";
import { touchPresence } from "../../../lib/presence";
import { startTiming } from "../../../lib/timing";
import { fetchClientTabChat, fetchCoachChat } from "../../../lib/chat/rows";
import { fetchClientTabFood, fetchCoachFood } from "../../../lib/food/rows";
import { fetchClientTabCheckIns, fetchCoachCheckIns } from "../../../lib/checkins/rows";
import { dropUnusedAutoWeightPg } from "../../../lib/queries";
import { loadHome, loadMeasurements, loadMeetings, loadMessages, loadNutrition, loadPictures, fetchPictureNotes, loadPlan, loadRail, loadTraining, pickClient, loadInvoices, loadDots } from "../loaders";
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
import "../home/home.css";
import "./messages.css";
import "../invoices/invoices.css";
import "../ncdialog.css";
import "../rail.css";

// The redesign drafts, opened on Messages. Read-only: nothing here saves.
// Local only, not for live.
//   /admin/redesign/messages?client=ID
export const dynamic = "force-dynamic";

export default async function MessagesRedesignPage({ searchParams }: { searchParams: Promise<{ client?: string; week?: string; program?: string; phase?: string; tab?: string }> }) {
  // Each loader timed (app/lib/timing.ts, /api/timing): measuring only, the props are what they were.
  const t = startTiming("messages");
  const coach = await t.time("auth", () => requireCoach());
  const params = await searchParams;
  const { client, firstName } = t.time("pickClient", () => pickClient(coach.id, params.client));
  t.client(client?.id);
  t.time("presence", () => touchPresence(coach, client ? `${firstName} · Messages` : "Clients"));
  if (!client) {
    const noClientsChat = await t.time("chat", () => fetchCoachChat([coach.id], "page.noClients.messages"));
    const noClientsFood = await t.time("food", () => fetchCoachFood([coach.id], "page.noClients.messages"));
    const noClientsCheckIns = await t.time("checkins", () => fetchCoachCheckIns([coach.id], "page.noClients.messages"));
    return t.end(<NoClients rail={t.time("rail", () => loadRail(coach, noClientsChat, noClientsFood, noClientsCheckIns))} />);
  }
  // The chat first (Step 5, app/lib/chat/rows.ts): the coach's view for the rail and the dots, the client's thread.
  const chat = await t.time("chat", () => fetchClientTabChat(coach.id, client.id, "page.tab.messages"));
  // The notes the Shape update reads (quest 7, app/lib/notes/rows.ts), fetched first as the chat is.
  const notes = await t.time("notes", () => fetchPictureNotes(client.id, "page.tab.messages"));
  // The food diary (quest 8 part 1, app/lib/food/rows.ts), fetched first as the chat is.
  const food = await t.time("food", () => fetchClientTabFood(coach.id, client.id, "page.tab.messages"));
  // The check-in figures (quest 9, app/lib/checkins/rows.ts), fetched first as the food is; with CHECKINS_STORE=pg the
  // untouched auto Weight line goes first, under the client's lock (a render can't wait for a transaction).
  await t.time("checkins.drop", () => dropUnusedAutoWeightPg(client.id));
  const ck = await t.time("checkins", () => fetchClientTabCheckIns(coach.id, client.id, "page.tab.messages"));
  return t.end(
    <RedesignShell
      clientId={client.id}
      clientName={client.name ?? "Client"}
      firstName={firstName}
      rail={t.time("rail", () => loadRail(coach, chat.coach, food, ck))}
      dots={t.time("dots", () => loadDots(client.id, chat.coach, food, ck))}
      initialTab={tabFromParams(params.tab, "messages")}
      home={t.time("home", () => loadHome(client.id, chat, food, ck))}
      training={t.time("training", () => loadTraining(coach.id, client.id, params, chat.thread, ck))}
      nutrition={t.time("nutrition", () => loadNutrition(client.id, params, chat.thread, food))}
      measurements={t.time("measurements", () => loadMeasurements(client.id, params, ck))}
      pictures={t.time("pictures", () => loadPictures(client.id, chat.thread, notes, ck))}
      meetings={t.time("meetings", () => loadMeetings(client.id, food, ck))}
      plan={t.time("plan", () => loadPlan(client.id, food, ck))}
      messages={t.time("messages", () => loadMessages(client.id, chat.thread, food))}
      invoices={t.time("invoices", () => loadInvoices(coach.id, client.id))}
    />
  );
}
