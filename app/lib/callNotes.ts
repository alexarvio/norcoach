import "server-only";
import { getData } from "./db";
import { fetchClientNotes, writeNote } from "./notes/rows";
import { CLIENT_NOTES_MAX } from "./notes/pick";

// A call cancelled before the client has seen it booked (22 Nov, Alex: "if I cancel it right after does the client only
// get the pop up of cancelled call or both of them in a row… I do want that"): its booking notification goes, unread, so
// the bell and the pop-up never say "booked" and "cancelled" one after the other about a call that is gone. A booking
// made under two minutes before is taken back outright: no "Cancelled your call" either (the client's lock screen may
// still hold the booking's push; nothing can call that back). A series' booking goes only when every call of it goes.

/** How long after booking a cancellation is a change of mind, said nothing about. */
const FRESH_MS = 2 * 60 * 1000;

/**
 * Before the calls are removed: drops the client's unread booking notes for them. "fresh" when every one dropped was
 * written under two minutes ago (the caller then sends no cancellation), "dropped" when any went, "none" otherwise.
 */
export async function dropUnreadBookings(clientId: number | null | undefined, cancelledIds: number[]): Promise<"fresh" | "dropped" | "none"> {
  if (clientId == null || !cancelledIds.length) return "none";
  const gone = new Set(cancelledIds.map(Number));
  const meetings = getData().meetings;
  const notes = (await fetchClientNotes(clientId, "action.callCancel")).newest(clientId, CLIENT_NOTES_MAX);
  const now = Date.now();
  let dropped = 0;
  let fresh = 0;
  for (const n of notes) {
    if (n.read || n.action_ref == null || !gone.has(n.action_ref)) continue;
    if (!/^scheduled /i.test(n.message)) continue;
    // A series' one note points at one of its calls: it goes only when the whole series does.
    if (/^scheduled \d+ /i.test(n.message)) {
      const call = meetings.find((m) => m.id === n.action_ref);
      const series = call?.series_id != null ? meetings.filter((m) => m.series_id === call.series_id && m.client_id === clientId && m.status !== "cancelled") : [];
      if (series.some((m) => !gone.has(m.id))) continue;
    }
    writeNote({ op: "delete", clientId, id: n.id });
    dropped++;
    if (now - Date.parse(n.created_at) < FRESH_MS) fresh++;
  }
  if (!dropped) return "none";
  return fresh === dropped ? "fresh" : "dropped";
}
