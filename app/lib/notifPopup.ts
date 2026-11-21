import "server-only";
import { categorize, clockToZone, isListed, titleAndBody, type NotificationCategory } from "./notificationTypes";
import { describeMessageLink, getCoachFirstName, getNotifications, listClientEvents, listMeetings, listVideoReplies, notificationLink } from "./queries";
import { noFoodRows } from "./food/rows";
import { isEventTypeId } from "./eventTypes";
import { groupOfNotification } from "./notifGroups";
import { pushGroupOn } from "./notifPrefs";
import type { ClientNotes } from "./notes/rows";
import type { PopupNote } from "../client/NotifPopup";

// The notification pop-up (19 Nov, Alex: A of docs/boards/notification-popup-mockup.html): a push tapped (/client?n=<id>)
// opens the app on that notification in a card, then the other unread ones that buzzed, newest after it. The server
// hands the candidates; the phone keeps only those since it was last in the app (NotifPopup's own stamp) and five at most.

/** How many others the page sends; the phone cuts to five in all. */
const OTHERS_MAX = 12;

/** Whether a notification went to the lock screen when it was written (logCoachActivity's `push`): a programme or phase
 *  going live, a video reply, a call booked, moved or cancelled, To focus on, an invoice sent, a shape update's reminder.
 *  The rows keep no mark of it, so it is read from what they are. */
function buzzed(n: { kind: string; message: string; action_tab: string | null }, category: NotificationCategory): boolean {
  if (n.kind === "programme" || n.action_tab === "video") return true;
  // A new weight goal, and a series of calls moved or cancelled, push too though the bell files them elsewhere.
  if (/^set a weight goal/i.test(n.message)) return true;
  if (/^(your calls moved|cancelled \d+ calls)/i.test(n.message)) return true;
  if (category === "meeting_booked" || category === "meeting_changed" || category === "focus") return true;
  if (category === "invoice") return /^sent\b/i.test(n.message);
  return /^time for your shape update/i.test(n.message);
}

/** Whether the client's switches let this one's push through (a group missing is on; null is always on). */
function groupLetThrough(clientId: number, x: { kind: string; action_tab: string | null; message: string; dedupe_key: string | null }): boolean {
  const g = groupOfNotification({ kind: x.kind, action_tab: x.action_tab, message: x.message, dedupe_key: x.dedupe_key });
  return g == null || pushGroupOn(clientId, g);
}

/**
 * The pop-up's notes for a push's ?n=: the one tapped first, then the other unread ones that buzzed, newest first (the
 * phone cuts them to those since it was last open). Null when there is nothing to pop up: no ?n=, not this client's, a
 * message from the coach (it opens the chat, as before), an old report, or a row the list doesn't show. The page passes
 * null itself in the coach's phone preview and while the app is locked.
 */
export function popupNotesFor(clientId: number, n: string | undefined, notes: ClientNotes, phoneTz: string | null = null): PopupNote[] | null {
  const id = Number(n);
  if (!n || !Number.isInteger(id)) return null;
  const all = getNotifications(notes, clientId, 500);
  const tapped = all.find((x) => x.id === id);
  if (!tapped || !isListed(tapped)) return null;
  const coachFirst = getCoachFirstName(clientId);
  // What the list works out for a row (NotificationsPanel in client/page.tsx): the call or event an older row didn't carry,
  // an event's own colour, a video reply to watch, the exact thing to land on.
  const videoReplies = listVideoReplies(clientId);
  const allEvents = listClientEvents(clientId);
  const allMeetings = listMeetings(clientId).filter((m) => m.status !== "cancelled");
  const recapped = listMeetings(clientId)
    .filter((m) => (m.summary ?? "").trim())
    .sort((x, y) => (x.date < y.date ? 1 : -1));
  const refOf = (row: (typeof all)[number], category: NotificationCategory): number | null => {
    if (row.action_ref != null) return row.action_ref;
    if (category === "meeting_notes") return recapped.find((m) => m.date <= row.created_at.slice(0, 10))?.id ?? null;
    if (category === "event_added") {
      const title = row.message.replace(/^Added to your calendar:\s*/, "").trim();
      return [...allEvents].reverse().find((e) => e.title.trim() === title)?.id ?? null;
    }
    if (category === "meeting_booked") {
      const day = row.created_at.slice(0, 10);
      return [...allMeetings].filter((m) => m.date >= day).sort((x, y) => (x.date < y.date ? -1 : 1))[0]?.id ?? null;
    }
    return null;
  };
  const view = (row: (typeof all)[number]): PopupNote => {
    const category = categorize(row);
    const { title, body } = titleAndBody(clockToZone(row.message, phoneTz), coachFirst);
    const actionRef = refOf(row, category);
    const event = category === "event_added" || category === "event_changed" ? allEvents.find((e) => e.id === actionRef) ?? null : null;
    return {
      id: row.id,
      category,
      eventType: event && isEventTypeId(event.kind) ? event.kind : null,
      title,
      body,
      createdAt: row.created_at,
      actionTab: row.action_tab,
      actionRef,
      videoReply: row.action_tab === "video" ? videoReplies.find((r) => r.id === row.action_ref) ?? null : null,
      link: category === "pics_reviewed" ? describeMessageLink(noFoodRows("page.client"), clientId, { kind: "photos" }) : notificationLink(clientId, row),
    };
  };
  const others = all
    // Only what reached the phone (19 Nov): a group switched off never buzzed.
    .filter((x) => x.id !== id && !x.read && isListed(x) && buzzed(x, categorize(x)) && groupLetThrough(clientId, x))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : b.id - a.id))
    .slice(0, OTHERS_MAX);
  return [view(tapped), ...others.map(view)];
}
