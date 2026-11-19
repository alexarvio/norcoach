// Every change to the notifications, as data (quest 7): the op the door is handed, and what it does to a list of rows.
// The code is queries.ts's own, moved here verbatim (logCoachActivity's duplicate check, replace, merge and insert;
// dropCoachActivity; the three read marks; the reminders' tick-off; a chat message's note reworded or removed), so
// memory mode does exactly what it did. The same function runs on the store (memory mode), on a view's rows to lay
// the writes still queued over what Postgres answered (pg mode), on the drainer's locked row for a replace or a merge,
// on a memory boot's leftover queue, and in the shadow for what each statement must answer.

import type { NoteRow } from "../db";
import { keyedRow } from "./pick";

/** How a new note meets an older one with its key: none (`plain`), left as it is, its words replaced, or joined. */
export type InsertMode = "plain" | "keep" | "replace" | "merge";

export type NoteOp =
  /** A new note. In memory mode its id and stamp are taken as it goes in (0 and "" until then); in pg mode at enqueue. */
  | { op: "insert"; row: NoteRow; mode: InsertMode; detail?: string }
  | { op: "drop"; clientId: number; key: string }
  | { op: "read"; clientId: number; id: number }
  | { op: "readCoachNotes"; clientId: number }
  /** `upTo` (pg mode, set at enqueue): the highest id handed out then, so a row written later by another way (the
   *  reminder job's own statements) is never marked by a read queued before it. Memory mode: none, every row. */
  | { op: "readAll"; clientId: number; upTo?: number }
  | { op: "tickOff"; clientId: number; ids: number[] }
  | { op: "reword"; clientId: number; id: number; text: string }
  | { op: "delete"; clientId: number; id: number };

export type Outcome = "inserted" | "kept" | "replaced" | "merged" | "changed" | "none";

/** The list being changed: read fresh, and replaced whole where the code filtered it (a delete). */
export type Holder = { get(): NoteRow[]; set(rows: NoteRow[]): void };

/** Where a new note's id and stamp come from: memory's counter and clock, or the op's own (pg mode, replays). */
export type Clock = { alloc(): number; now(): string };

/** The op's client, for ordering and for the views' overlay. */
export const opClient = (op: NoteOp) => (op.op === "insert" ? op.row.client_id : op.clientId);

/** The words a merge leaves: the detail joined to the day's others, the last four kept. logCoachActivity's, verbatim. */
export function mergedMessage(message: string, detail: string): string {
  const colon = message.indexOf(": ");
  const base = colon > 0 ? message.slice(0, colon) : message;
  const details = colon > 0 ? message.slice(colon + 2).split(" · ") : [];
  if (!details.includes(detail)) details.push(detail);
  return `${base}: ${details.slice(-4).join(" · ")}`;
}

export function applyOp(holder: Holder, op: NoteOp, clock: Clock): { outcome: Outcome; row?: NoteRow } {
  switch (op.op) {
    case "insert": {
      const r = op.row;
      const rows = holder.get();
      const dup = op.mode !== "plain" && r.dedupe_key ? keyedRow(rows, r.client_id, r.dedupe_key) : null;
      if (dup) {
        if (op.mode === "replace") {
          dup.message = r.message;
          dup.created_at = clock.now();
          dup.read = false;
          if (r.action_ref != null) dup.action_ref = r.action_ref;
          return { outcome: "replaced", row: dup };
        }
        if (op.mode === "merge" && op.detail) {
          dup.message = mergedMessage(dup.message, op.detail);
          dup.created_at = clock.now();
          dup.read = false;
          if (r.action_ref != null) dup.action_ref = r.action_ref;
          return { outcome: "merged", row: dup };
        }
        return { outcome: "kept", row: dup };
      }
      // In this order, as logCoachActivity wrote it (a whole-store JSON keeps its keys' order).
      const id = clock.alloc();
      const row: NoteRow = {
        id,
        client_id: r.client_id,
        message: r.message,
        created_at: clock.now(),
        kind: r.kind,
        read: false,
        action_tab: r.action_tab ?? null,
        action_label: r.action_label ?? null,
        action_ref: r.action_ref ?? null,
        dedupe_key: r.dedupe_key ?? null,
        ...(r.message_id != null ? { message_id: r.message_id } : {}),
      };
      rows.push(row);
      return { outcome: "inserted", row };
    }
    case "drop": {
      const rows = holder.get();
      const note = keyedRow(rows, op.clientId, op.key);
      if (!note) return { outcome: "none" };
      holder.set(rows.filter((a) => a !== note));
      return { outcome: "changed", row: note };
    }
    case "read": {
      const entry = holder.get().find((a) => a.id === op.id && a.client_id === op.clientId);
      if (!entry) return { outcome: "none" };
      entry.read = true;
      return { outcome: "changed", row: entry };
    }
    case "readCoachNotes": {
      let changed = false;
      holder.get().forEach((a) => {
        if (a.client_id === op.clientId && a.kind === "coach_note" && !a.read) {
          a.read = true;
          changed = true;
        }
      });
      return { outcome: changed ? "changed" : "none" };
    }
    case "readAll": {
      holder.get().forEach((a) => {
        if (a.client_id === op.clientId && (op.upTo == null || a.id <= op.upTo)) a.read = true;
      });
      return { outcome: "changed" };
    }
    case "tickOff": {
      const ids = new Set(op.ids);
      let changed = false;
      for (const a of holder.get()) {
        if (a.client_id !== op.clientId || a.kind !== "reminder" || a.read || !a.dedupe_key || !ids.has(a.id)) continue;
        a.read = true;
        changed = true;
      }
      return { outcome: changed ? "changed" : "none" };
    }
    case "reword": {
      const note = holder.get().find((a) => a.id === op.id && a.client_id === op.clientId);
      if (!note) return { outcome: "none" };
      note.message = op.text;
      return { outcome: "changed", row: note };
    }
    case "delete": {
      const rows = holder.get();
      const note = rows.find((a) => a.id === op.id && a.client_id === op.clientId);
      if (!note) return { outcome: "none" };
      holder.set(rows.filter((a) => a !== note));
      return { outcome: "changed", row: note };
    }
    default: {
      const never: never = op;
      throw new Error(`[notes] unknown op ${(never as { op: string }).op}`);
    }
  }
}

/** A list in a box, for applying ops to rows that aren't the store's (a view's, the drainer's, the shadow's). */
export function boxOf(rows: NoteRow[]): Holder & { rows: NoteRow[] } {
  const box = {
    rows,
    get: () => box.rows,
    set: (next: NoteRow[]) => {
      box.rows = next;
    },
  };
  return box;
}

/** An op's own id and stamp (pg mode: taken at enqueue), for a replay or an overlay. */
export const opClock = (op: NoteOp): Clock => ({
  alloc: () => (op.op === "insert" ? op.row.id : 0),
  now: () => (op.op === "insert" ? op.row.created_at : new Date().toISOString()),
});
