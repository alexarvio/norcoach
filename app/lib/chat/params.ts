// A new message's statement parameters, made from the store row exactly as the writer maps it (store.ts toRecord, then
// cleanJson), so the insert writes what a save would have (Step 5). Shared by the write shadow (shadow.ts, on the shadow
// tables) and, with CHAT_STORE=pg, the door itself (rows.ts, on chat_messages).

import type { ChatRow } from "../db";
import { chat_messages, once_keys } from "../pg/schema";
import { cleanJson, toRecord } from "../pg/store";
import { msInstant, stampInstant } from "../pg/stamps";
import type { InsertParams } from "./statements";

type Row = Record<string, unknown>;

export function insertParams(
  row: ChatRow,
  replyTo: number | null,
  once: { key: string; at: number; result?: unknown } | null,
  meal: { date: string; meal: string } | null
): InsertParams {
  const record = JSON.parse(cleanJson(toRecord(chat_messages, row as unknown as Row)) ?? "null") as Row;
  const extra = { ...((record.extra as Row | null) ?? {}) };
  // The statement decides the reply itself (kept only when that message is in this chat).
  delete extra.reply_to;
  const onceRow: Row | null = once ? { key: once.key, at: once.at, ...(once.result === undefined ? {} : { result: once.result }) } : null;
  const onceRecord = onceRow ? (JSON.parse(cleanJson(toRecord(once_keys, onceRow)) ?? "null") as Row) : null;
  return {
    id: Number(record.id),
    client_id: Number(record.client_id),
    sender: String(record.sender),
    text: record.text as string | null,
    media_path: record.media_path as string | null,
    media_type: record.media_type as string | null,
    created_at: record.created_at as string | null,
    extra: Object.keys(extra).length ? JSON.stringify(extra) : null,
    replyTo,
    createdAtTz: stampInstant(row.created_at),
    once:
      onceRecord && once
        ? {
            key: String(onceRecord.key),
            at: Number(onceRecord.at),
            extra: onceRecord.extra == null ? null : JSON.stringify(onceRecord.extra),
            createdAt: msInstant(once.at),
            result: onceRecord.result == null ? null : JSON.stringify(onceRecord.result),
          }
        : null,
    meal,
  };
}
