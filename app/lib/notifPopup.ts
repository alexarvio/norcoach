import "server-only";
import { categorize, clockToZone, isListed, titleAndBody, type NotificationCategory } from "./notificationTypes";
import { describeMessageLink, getCoachFirstName, getNotifications, getWeightGoalViews, listActivePhotoSlots, listClientEvents, listClientInvoices, listMeetings, listPhotoUploads, listVideoReplies, listWeightGoals, notificationLink } from "./queries";
import { noFoodRows } from "./food/rows";
import { isEventTypeId } from "./eventTypes";
import { groupOfNotification } from "./notifGroups";
import { pushGroupOn } from "./notifPrefs";
import type { ClientNotes } from "./notes/rows";
import type { PopupNote, PopupThing } from "../client/NotifPopup";
import { getData } from "./db";
import { getCoachFocus } from "./focus";
import { inZone } from "./viewZone";
import { isMeetingTypeId } from "./meetingTypes";
import type { CheckInRows } from "./checkins/rows";

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
export function popupNotesFor(clientId: number, n: string | undefined, notes: ClientNotes, phoneTz: string | null = null, ck: CheckInRows | null = null): PopupNote[] | null {
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
      thing: thingOf(clientId, row, category, actionRef, phoneTz, ck),
    };
  };
  const others = all
    // Only what reached the phone (19 Nov): a group switched off never buzzed.
    .filter((x) => x.id !== id && !x.read && isListed(x) && buzzed(x, categorize(x)) && groupLetThrough(clientId, x))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : b.id - a.id))
    .slice(0, OTHERS_MAX);
  return [view(tapped), ...others.map(view)];
}

// ---- The thing a notification is about (22 Nov, Alex: "C is so good… build them"; docs/boards/notification-popup-kinds-mockup.html)
// Read from what the notification points at (its action_ref, else its words), never stored on it. Null when it can't be
// found any more (a call deleted, a programme removed): the pop-up then shows the coach's words as before.

type ThingRow = { message: string; kind: string; action_tab: string | null; dedupe_key: string | null; created_at: string };

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const weeksOf = (from: string, to: string) => Math.max(1, Math.round((daysBetween(from, to) + 1) / 7));

function thingOf(clientId: number, row: ThingRow, category: NotificationCategory, ref: number | null, phoneTz: string | null, ck: CheckInRows | null): PopupThing | null {
  try {
    const data = getData();
    const m = row.message;
    if (category === "video_reply") {
      const r = listVideoReplies(clientId).find((x) => x.id === ref);
      if (!r) return null;
      const frame = r.theirs ? (r.theirsPhoto ? r.theirs : `${r.theirs}${r.theirs.includes("?") ? "&" : "?"}poster=1`) : null;
      return { kind: "video", frame, words: r.replyNote?.trim() || null, exercise: r.exerciseName, sentOn: r.theirsAt ? r.theirsAt.slice(0, 10) : null };
    }
    if (/^your coach published a new plan/i.test(m)) {
      // By what it points at; a row written before it pointed (no ref), by the name in its words.
      const named = m.match(/^your coach published a new plan: (.+?). check it out$/i)?.[1]?.trim();
      const p = data.training_programs.find((x) => x.client_id === clientId && (ref != null ? x.id === ref : !!named && x.name?.trim() === named));
      if (!p) return null;
      const perWeek = data.program_days.filter((d) => d.client_id === clientId && d.week_number === p.start_week && !d.is_rest).length;
      const phase = data.client_phases.find((x) => x.program_id === p.id && x.client_id === clientId);
      return { kind: "programme", name: p.name?.trim() || "Your programme", weeks: p.total_weeks, perWeek, from: phase?.start_week ?? null };
    }
    if (/^your coach set new nutrition targets/i.test(m)) {
      const named = m.match(/^your coach set new nutrition targets: (.+?). check them out$/i)?.[1]?.trim();
      const ph = data.client_phases.find((x) => x.client_id === clientId && (ref != null ? x.id === ref : !!named && x.track === "nutrition" && x.name.trim() === named));
      const t = ph?.nutrition?.day_targets?.training;
      if (!ph || !t) return null;
      const kcal = Math.round((t.protein ?? 0) * 4 + (t.carbs ?? 0) * 4 + (t.fats ?? 0) * 9);
      if (!kcal) return null;
      return { kind: "targets", name: ph.name, kcal, protein: t.protein, carbs: t.carbs, fat: t.fats };
    }
    const phaseWords = m.match(/^your coach set a new (training|nutrition|lifestyle) phase/i);
    if (phaseWords) {
      const named = m.match(/^your coach set a new w+ phase: (.+)$/i)?.[1]?.trim();
      const ph = data.client_phases.find((x) => x.client_id === clientId && (ref != null ? x.id === ref : !!named && x.track === phaseWords[1].toLowerCase() && x.name.trim() === named));
      if (!ph) return null;
      const to = ph.open_ended ? null : ph.end_week;
      return { kind: "phase", track: ph.track, name: ph.name, from: ph.start_week, to, weeks: to ? weeksOf(ph.start_week, to) : null };
    }
    if (category === "meeting_booked" || category === "meeting_changed" || /^cancelled \d+ calls/i.test(m)) {
      const call = data.meetings.find((x) => x.id === ref && x.client_id === clientId);
      if (!call) return null;
      const state = /^cancelled/i.test(m) ? "cancelled" : /moved/i.test(m) ? "moved" : "booked";
      const series = m.match(/^scheduled (\d+) (weekly|biweekly|monthly) meetings/i);
      // A series: its first call still to come, and its last.
      let first = call;
      let last: string | null = null;
      if (series && call.series_id != null) {
        const all = data.meetings.filter((x) => x.series_id === call.series_id && x.client_id === clientId && x.status !== "cancelled").sort((a, b) => (a.date === b.date ? (a.time < b.time ? -1 : 1) : a.date < b.date ? -1 : 1));
        const day = row.created_at.slice(0, 10);
        first = all.find((x) => x.date >= day) ?? all[0] ?? call;
        last = all.length ? all[all.length - 1].date : null;
      }
      const from = first.tz || phoneTz || "";
      const at = from && phoneTz ? inZone(first.date, first.time, from, phoneTz) : { date: first.date, time: first.time };
      const lastAt = last && from && phoneTz ? inZone(last, first.time, from, phoneTz).date : last;
      const type = (first as { meeting_type?: string }).meeting_type;
      const every = series ? { weekly: "Every week", biweekly: "Every 2 weeks", monthly: "Every 4 weeks" }[series[2].toLowerCase() as "weekly" | "biweekly" | "monthly"] : null;
      return {
        kind: "call",
        state,
        date: at.date,
        time: first.all_day ? "" : at.time,
        minutes: first.duration_minutes,
        topic: first.topic?.trim() || first.summary_title?.trim() || "",
        type: isMeetingTypeId(type) ? type : "checkin",
        every,
        count: series ? Number(series[1]) : (m.match(/^cancelled (\d+) calls/i) ? Number(m.match(/^cancelled (\d+) calls/i)![1]) : null),
        last: lastAt,
      };
    }
    if (category === "focus") {
      const goals = (getCoachFocus(clientId)?.goals ?? []).map((g) => g.text.trim()).filter(Boolean).slice(0, 3);
      return goals.length ? { kind: "focus", goals } : null;
    }
    if (category === "weight_goal") {
      const view = ck ? getWeightGoalViews(ck, clientId).find((v) => v.id === ref) : null;
      if (view) return { kind: "goal", target: view.targetKg, unit: view.unit, byDate: view.byDate, now: view.nowKg, toGo: view.toGoKg };
      const g = listWeightGoals(clientId).find((x) => x.id === ref);
      return g ? { kind: "goal", target: g.target_kg, unit: g.unit, byDate: g.by_date, now: null, toGo: null } : null;
    }
    if (category === "invoice") {
      const inv = listClientInvoices(clientId).find((x) => x.id === ref);
      if (!inv) return null;
      const what = inv.lines[0]?.description?.trim() || "";
      return { kind: "invoice", number: inv.number, what, total: inv.total, currency: inv.currency, due: inv.dueDate };
    }
    if (/^time for your shape update/i.test(m)) {
      const period = row.dedupe_key?.match(/^photos-remind:(\d{4}-\d{2}-\d{2}):/)?.[1];
      if (!period) return null;
      const slots = [...listActivePhotoSlots(clientId)].sort((a, b) => a.order_index - b.order_index);
      if (!slots.length) return null;
      const ups = listPhotoUploads(slots.map((s) => s.id)).filter((u) => u.period === period);
      const photoOf = (id: number) => ups.filter((u) => u.slot_id === id).sort((a, b) => (a.uploaded_at < b.uploaded_at ? 1 : -1))[0]?.file_path ?? null;
      return { kind: "shape", angles: slots.slice(0, 6).map((s) => ({ label: s.label, photo: photoOf(s.id) })) };
    }
    return null;
  } catch {
    return null;
  }
}
