// The workout as one scrolling sheet (15 Nov, Alex: docs/boards/workout-sheet-a-mockup.html), on test: decided here, on
// the server, and handed down to the Training tab; off, the pager stays exactly as it is.

import { getData } from "./db";
import { getClient } from "./queries";
import { isOwner } from "./auth";

/**
 * The sheet for this client: WORKOUT_SHEET=all turns it on for everyone; else the clients in WORKOUT_SHEET_CLIENTS
 * (ids or sign-in emails, comma separated) and every client of the owner's coach account (OWNER_EMAIL), so Alex's test clients get it.
 */
export function workoutSheetOn(clientId: number): boolean {
  if (process.env.WORKOUT_SHEET?.trim().toLowerCase() === "all") return true;
  // Ids or sign-in emails, comma separated (15 Nov: a test client coached by someone else is named by its email).
  const listed = (process.env.WORKOUT_SHEET_CLIENTS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (listed.includes(String(clientId))) return true;
  const login = getData().users.find((u) => u.role === "client" && u.client_id === clientId)?.email?.toLowerCase();
  if (login && listed.includes(login)) return true;
  const coachId = getClient(clientId)?.coach_id;
  if (coachId == null) return false;
  const coach = getData().users.find((u) => u.id === coachId && u.role === "coach");
  return isOwner(coach);
}
