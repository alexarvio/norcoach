import { requireCoach } from "../../../lib/auth";
import { touchPresence } from "../../../lib/presence";
import { startTiming } from "../../../lib/timing";
import { fetchClientTabChat, fetchCoachChat } from "../../../lib/chat/rows";
import { fetchClientTabFood, fetchCoachFood } from "../../../lib/food/rows";
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
    return t.end(<NoClients rail={t.time("rail", () => loadRail(coach, noClientsChat, noClientsFood))} />);
  }
  // The chat first (Step 5, app/lib/chat/rows.ts): the coach's view for the rail and the dots, the client's thread.
  const chat = await t.time("chat", () => fetchClientTabChat(coach.id, client.id, "page.tab.messages"));
  // The notes the Shape update reads (quest 7, app/lib/notes/rows.ts), fetched first as the chat is.
  const notes = await t.time("notes", () => fetchPictureNotes(client.id, "page.tab.messages"));
  // The food diary (quest 8 part 1, app/lib/food/rows.ts), fetched first as the chat is.
  const food = await t.time("food", () => fetchClientTabFood(coach.id, client.id, "page.tab.messages"));
  return t.end(
    <RedesignShell
      clientId={client.id}
      clientName={client.name ?? "Client"}
      firstName={firstName}
      rail={t.time("rail", () => loadRail(coach, chat.coach, food))}
      dots={t.time("dots", () => loadDots(client.id, chat.coach, food))}
      initialTab={tabFromParams(params.tab, "messages")}
      home={t.time("home", () => loadHome(client.id, chat, food))}
      training={t.time("training", () => loadTraining(coach.id, client.id, params, chat.thread))}
      nutrition={t.time("nutrition", () => loadNutrition(client.id, params, chat.thread, food))}
      measurements={t.time("measurements", () => loadMeasurements(client.id, params))}
      pictures={t.time("pictures", () => loadPictures(client.id, chat.thread, notes))}
      meetings={t.time("meetings", () => loadMeetings(client.id, food))}
      plan={t.time("plan", () => loadPlan(client.id, food))}
      messages={t.time("messages", () => loadMessages(client.id, chat.thread, food))}
      invoices={t.time("invoices", () => loadInvoices(coach.id, client.id))}
    />
  );
}
