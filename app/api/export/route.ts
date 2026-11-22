import { NextResponse } from "next/server";
import { getRequestUser } from "../../lib/auth";
import { getData } from "../../lib/db";
import { CHAT_TABLE, fetchChatExport, withChatKey } from "../../lib/chat/rows";
import { fetchNotesExport, NOTES_TABLE, withNotesKey } from "../../lib/notes/rows";
import { fetchFoodExport, withFoodKeys } from "../../lib/food/rows";
import { fetchCheckInsExport, withCheckInKeys } from "../../lib/checkins/rows";
import { fetchTicksOfClients, withTickKey } from "../../lib/sets/rows";

// Settings, Your data (27 Oct, Alex): everything a coach's coaching holds, as one file they keep. Every row of every
// table that belongs to one of their clients (by client_id), their own rows (by coach_id: the library, programmes,
// the calendar, invoices, profile, plans), and their clients themselves. Never anyone else's, never the sign-in tables
// (users, sign-in locks), and never another coach's. Photos and videos are named by their paths; the files stay in
// storage. JSON, one key a table, so it reads anywhere.
//   /api/export  → norcoach-export-2026-10-27.json
export const dynamic = "force-dynamic";

/** Tables that are about sign-in or the company, never part of a coach's export. */
// notes-door: the notifications' outbox and its dead letters (NOTES_STORE=pg) are the store's plumbing, their rows in the table.
const LEFT_OUT = new Set(["users", "login_lock_events", "support_messages", "join_requests", "coach_reset_applied", "workspace_reset_applied", "sessions_migrated", "_seq", "notes_outbox", "notes_outbox_dead", "notes_shadow_totals"]);

export async function GET(request: Request) {
  const user = await getRequestUser(request);
  if (!user || user.pending || user.role !== "coach") return NextResponse.json({ error: "Not found" }, { status: 404 });
  // food-door: the food diary's lists from fetchFoodExport below (withFoodKeys)
  // checkins-door: the check-in figures and notes from fetchCheckInsExport below (withCheckInKeys)
  const data = getData() as unknown as Record<string, unknown>; // chat-door: the chat's rows are swapped in from fetchChatExport below; notes-door: the notifications from fetchNotesExport
  const clientIds = new Set((getData().clients ?? []).filter((c) => c.coach_id === user.id).map((c) => c.id));
  // The chat through its door (Step 5), in its place among the tables, so the file is as it was.
  const exported = await fetchChatExport([...clientIds], "export");
  // The notifications through theirs (quest 7), in their place the same way.
  const notes = await fetchNotesExport([...clientIds], "export");
  // The food diary through its door (quest 8 part 1): in memory the store's own lists; with FOOD_STORE=pg its rows of
  // these clients put in their keys' places (withFoodKeys).
  const food = await fetchFoodExport([...clientIds], "export");
  // The check-in figures and notes through theirs (quest 9): in memory the store's own lists; with CHECKINS_STORE=pg the
  // rows of these clients put in their keys' places (withCheckInKeys). The figures have no client_id or coach_id, so the
  // filter below leaves them out in both modes, as it always has (a question for Alex: docs/database-plan.md), so with
  // CHECKINS_STORE=pg only the notes are read.
  const checkIns = await fetchCheckInsExport([...clientIds], "export", ["notes"]);
  // The cardio ticks through the sets' door (quest 10, with the sets since 22 Nov): a tick carries its client_id, so the
  // filter below keeps these clients' as it always has; with SETS_STORE=pg their rows put in their key's place (withTickKey).
  const ticks = await fetchTicksOfClients("export", [...clientIds]);
  const out: Record<string, unknown> = {};
  // chat-door: chat rows come from fetchChatExport
  // notes-door: the notifications from fetchNotesExport, their key put in its place with NOTES_STORE=pg (withNotesKey)
  // With CHAT_STORE=pg the store has no chat key: withChatKey puts it where it would be, so the file reads as before.
  // food-door: the food diary's keys from fetchFoodExport (withFoodKeys; the store's own in memory mode).
  // checkins-door: the check-in keys from fetchCheckInsExport (withCheckInKeys; the store's own in memory mode).
  // sets-door: the logged sets have no client_id or coach_id, so this filter leaves every one out in both modes, as it
  // always has (a question for Alex: docs/database-plan.md); with SETS_STORE=pg the store holds no set_logs key at all.
  // The cardio ticks from fetchTicksOfClients (withTickKey; the store's own in memory mode).
  for (const [table, stored] of Object.entries(withTickKey(withCheckInKeys(withFoodKeys(withNotesKey(withChatKey(data, exported.rows), notes), food), checkIns), ticks))) {
    const rows = table === CHAT_TABLE ? exported.rows : table === NOTES_TABLE ? notes : stored;
    if (LEFT_OUT.has(table) || !Array.isArray(rows)) continue;
    const mine = rows.filter((r) => {
      if (!r || typeof r !== "object") return false;
      const row = r as Record<string, unknown>;
      if (table === "clients") return clientIds.has(row.id as number);
      if (typeof row.client_id === "number") return clientIds.has(row.client_id);
      return row.coach_id === user.id;
    });
    if (mine.length) out[table] = mine;
  }
  const day = new Date().toISOString().slice(0, 10);
  const body = JSON.stringify({ exported: new Date().toISOString(), coach: user.email, clients: clientIds.size, tables: out }, null, 2);
  return new NextResponse(body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="norcoach-export-${day}.json"`,
      "Cache-Control": "no-store",
    },
  });
}
