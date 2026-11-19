import { requireCoach } from "../../../lib/auth";
import { touchPresence } from "../../../lib/presence";
import { startTiming } from "../../../lib/timing";
import { fetchClientTabChat, fetchCoachChat } from "../../../lib/chat/rows";
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
  t.time("presence", () => touchPresence(coach, client ? `${firstName} · Home` : "Clients"));
  if (!client) {
    const noClientsChat = await t.time("chat", () => fetchCoachChat([coach.id], "page.noClients.home"));
    return t.end(<NoClients rail={t.time("rail", () => loadRail(coach, noClientsChat))} />);
  }
  // The chat first (Step 5, app/lib/chat/rows.ts): the coach's view for the rail and the dots, the client's thread.
  const chat = await t.time("chat", () => fetchClientTabChat(coach.id, client.id, "page.tab.home"));
  // The notes the Shape update reads (quest 7, app/lib/notes/rows.ts), fetched first as the chat is.
  const notes = await t.time("notes", () => fetchPictureNotes(client.id, "page.tab.home"));
  return t.end(
    <>
    {/* ?look=hairline: the admin in the client app's language, as a preview (17 Oct). */}
    <LookFlag />
    <RedesignShell
      clientId={client.id}
      clientName={client.name ?? "Client"}
      firstName={firstName}
      rail={t.time("rail", () => loadRail(coach, chat.coach))}
      dots={t.time("dots", () => loadDots(client.id, chat.coach))}
      initialTab={tabFromParams(params.tab, "home")}
      home={t.time("home", () => loadHome(client.id, chat))}
      training={t.time("training", () => loadTraining(coach.id, client.id, params, chat.thread))}
      nutrition={t.time("nutrition", () => loadNutrition(client.id, params, chat.thread))}
      measurements={t.time("measurements", () => loadMeasurements(client.id, params))}
      pictures={t.time("pictures", () => loadPictures(client.id, chat.thread, notes))}
      meetings={t.time("meetings", () => loadMeetings(client.id))}
      plan={t.time("plan", () => loadPlan(client.id))}
      messages={t.time("messages", () => loadMessages(client.id, chat.thread))}
      invoices={t.time("invoices", () => loadInvoices(coach.id, client.id))}
    />
    </>
  );
}
