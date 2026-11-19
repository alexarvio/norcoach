import fs from "fs";
import path from "path";
import { PutObjectCommand, HeadObjectCommand, ListObjectsV2Command, DeleteObjectsCommand, S3Client } from "@aws-sdk/client-s3";
import { DATA_DIR, getData, STORE_MODE } from "./db";
import { deleteAllUnder } from "./storage";
import { CHAT_PG } from "./chat/mode";
import { fetchAllChat, withChatKey } from "./chat/rows";
import { NOTES_PG } from "./notes/mode";
import { fetchAllNotes, notesBackupCopy, withNotesKey } from "./notes/rows";
import { FOOD_PG } from "./food/mode";
import { fetchFoodExport, withFoodKeys } from "./food/rows";

// Nightly copy of everything on the volume to a bucket that is not the
// volume: the JSON store as a dated snapshot, the uploads folder mirrored
// file by file. Runs from instrumentation.ts on a timer; nothing in the
// app waits on it. Without the BACKUP_* variables it does nothing, so a
// dev machine never uploads its test data anywhere.
//
// Layout in the bucket:
//   snapshots/YYYY-MM-DD/ironline.json   one per day, the last KEEP kept
//   uploads/<same path as on the volume>  written once, skipped after
//   latest.json                           the newest snapshot again, for
//                                         an import script to find
//   pg/YYYY-MM-DD/<run>/                  Postgres mode: the database read
//                                         from Postgres itself, a gzip
//                                         NDJSON file a table and its
//                                         manifest.json (pg/backup.ts); put
//                                         back with scripts/restore-pg-backup.mjs.
//                                         <run> is when the run started
//                                         (2026-11-17T03-15-00-000Z): every
//                                         boot runs one too, and a run cut off
//                                         must never mix its parts with an
//                                         earlier run's under that manifest

const KEEP_SNAPSHOTS = 30;

function client(): { s3: S3Client; bucket: string } | null {
  const { BACKUP_BUCKET, BACKUP_ENDPOINT, BACKUP_REGION, BACKUP_ACCESS_KEY_ID, BACKUP_SECRET_ACCESS_KEY } = process.env;
  if (!BACKUP_BUCKET || !BACKUP_ENDPOINT || !BACKUP_ACCESS_KEY_ID || !BACKUP_SECRET_ACCESS_KEY) return null;
  return {
    bucket: BACKUP_BUCKET,
    s3: new S3Client({
      region: BACKUP_REGION || "auto",
      endpoint: BACKUP_ENDPOINT,
      credentials: { accessKeyId: BACKUP_ACCESS_KEY_ID, secretAccessKey: BACKUP_SECRET_ACCESS_KEY },
    }),
  };
}

/**
 * Removes a folder of uploads ("progress/9/") from the backup's mirror, which
 * otherwise keeps every file forever: an erased client's photos must not live
 * on here. Snapshots of the store still hold their rows until they age out
 * (KEEP_SNAPSHOTS days).
 */
export async function deleteBackupUploads(folder: string): Promise<number> {
  const c = client();
  if (!c) return 0;
  return deleteAllUnder(c.s3, c.bucket, `uploads/${folder}`);
}

export function backupConfigured(): boolean {
  return client() != null;
}

const localDate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

async function exists(s3: S3Client, bucket: string, key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

/** Today's snapshot is in the bucket (19 Nov): the nightly clean-up of read reminders deletes only once it is, so what
 *  goes is in the night's copy. False when it can't tell (no bucket, an error). */
export async function backupTakenToday(): Promise<boolean> {
  const c = client();
  if (!c) return false;
  return exists(c.s3, c.bucket, `snapshots/${localDate()}/ironline.json`);
}

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

export type BackupResult = {
  snapshot: string;
  uploadsCopied: number;
  uploadsSkipped: number;
  pruned: number;
  /** The database's own backup (Postgres mode): where, how many tables and rows, and files pruned. */
  pg: { prefix: string; tables: number; rows: number; pruned: number } | null;
  /** CHAT_STORE=pg: the chat's read failed, so today's JSON snapshot was skipped (snapshot ""); the rest ran. */
  chatReadFailed?: true;
};

/**
 * One full run. Throws on a failure the caller should log. With CHAT_STORE=pg one run at a time (a run asked while one
 * goes gets that one's answer): each holds a chat connection for its whole read of the table.
 */
export function runBackup(): Promise<BackupResult | null> {
  if (!CHAT_PG && !NOTES_PG && !FOOD_PG) return runBackupOnce();
  const g = globalThis as unknown as { __norcoachBackupRun?: Promise<BackupResult | null> | null };
  if (g.__norcoachBackupRun) return g.__norcoachBackupRun;
  const run = runBackupOnce().finally(() => {
    g.__norcoachBackupRun = null;
  });
  g.__norcoachBackupRun = run;
  return run;
}

async function runBackupOnce(): Promise<BackupResult | null> {
  const c = client();
  if (!c) return null;
  const { s3, bucket } = c;
  const day = localDate();

  // 1. The store itself, as today's snapshot and as latest.
  // Exported from the in-memory store rather than read from ironline.json, so
  // it is the same complete snapshot whether the data lives in the file or
  // in Postgres.
  // With CHAT_STORE=pg the chat is not in memory: its rows are read from the table (one snapshot) and put in their key's
  // place, so latest.json stays the whole store any build can import (Step 5's cut-over). Should that read fail, the
  // JSON is not written today (yesterday's latest.json stays, whole) and the rest still runs: the uploads and, above all,
  // the database's own backup (step 4), which holds the chat's table itself.
  let store: unknown = null;
  let chatReadFailed = false;
  if (CHAT_PG) {
    try {
      // chat-door: the store copied whole, the chat read from its table when it is not in memory
      // notes-door: the notifications swapped in below when they are in Postgres (NOTES_STORE=pg)
      // food-door: the food diary swapped in below when it is in Postgres (FOOD_STORE=pg)
      store = withChatKey(getData() as unknown as Record<string, unknown>, await fetchAllChat("backup"));
    } catch (error) {
      chatReadFailed = true;
      console.error("[backup] the chat could not be read from Postgres: today's JSON snapshot skipped, the rest goes on:", error instanceof Error ? error.message : error);
      import("@sentry/nextjs")
        .then((S) => S.captureMessage("Backup: the chat could not be read; the JSON snapshot was skipped", { level: "error", tags: { alert: "backup-chat-read" } }))
        .catch(() => {});
    }
  } else store = getData();
  // The notifications the same with NOTES_STORE=pg (quest 7): read from the table with the ops still queued laid over,
  // put in their key's place, and the outbox left out of the copy (its ops are in the rows now).
  if (NOTES_PG && !chatReadFailed) {
    try {
      // notes-door: the store copied whole, the notifications read from their table
      store = notesBackupCopy(withNotesKey((store ?? getData()) as unknown as Record<string, unknown>, await fetchAllNotes("backup")));
    } catch (error) {
      chatReadFailed = true;
      console.error("[backup] the notifications could not be read from Postgres: today's JSON snapshot skipped, the rest goes on:", error instanceof Error ? error.message : error);
      import("@sentry/nextjs")
        .then((S) => S.captureMessage("Backup: the notifications could not be read; the JSON snapshot was skipped", { level: "error", tags: { alert: "backup-notes-read" } }))
        .catch(() => {});
    }
  }
  // The food diary the same with FOOD_STORE=pg (quest 8 part 1): its seven tables read in one snapshot, put in their keys'
  // places (withFoodKeys). In memory mode nothing changes here: the store holds them.
  if (FOOD_PG && !chatReadFailed) {
    try {
      // food-door: the store copied whole, the food diary read from its tables
      store = withFoodKeys((store ?? getData()) as unknown as Record<string, unknown>, await fetchFoodExport("all", "backup"));
    } catch (error) {
      chatReadFailed = true;
      console.error("[backup] the food diary could not be read from Postgres: today's JSON snapshot skipped, the rest goes on:", error instanceof Error ? error.message : error);
      import("@sentry/nextjs")
        .then((S) => S.captureMessage("Backup: the food diary could not be read; the JSON snapshot was skipped", { level: "error", tags: { alert: "backup-food-read" } }))
        .catch(() => {});
    }
  }
  const snapshot = `snapshots/${day}/ironline.json`;
  if (!chatReadFailed) {
    const body = Buffer.from(JSON.stringify(store, null, 2));
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: snapshot, Body: body, ContentType: "application/json" }));
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "latest.json", Body: body, ContentType: "application/json" }));
  }

  // 2. Uploads, mirrored. A file that is already there is left alone, so a
  //    night's run costs one HEAD per file and one PUT per new file.
  const uploadsRoot = path.join(DATA_DIR, "uploads");
  let copied = 0;
  let skipped = 0;
  for (const file of walk(uploadsRoot)) {
    const key = `uploads/${path.relative(uploadsRoot, file).split(path.sep).join("/")}`;
    if (await exists(s3, bucket, key)) {
      skipped++;
      continue;
    }
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: fs.readFileSync(file) }));
    copied++;
  }

  // 3. Keep the last KEEP_SNAPSHOTS days of the store; uploads are never pruned.
  const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: "snapshots/" }));
  const days = Array.from(new Set((listed.Contents ?? []).map((o) => o.Key?.split("/")[1]).filter((d): d is string => !!d))).sort();
  const old = days.slice(0, Math.max(0, days.length - KEEP_SNAPSHOTS));
  let pruned = 0;
  if (old.length > 0) {
    const keys = (listed.Contents ?? []).filter((o) => old.includes(o.Key?.split("/")[1] ?? "")).map((o) => ({ Key: o.Key! }));
    if (keys.length > 0) {
      await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys } }));
      pruned = keys.length;
    }
  }

  // 4. Postgres mode: the database's own backup, read from Postgres (17 Nov; pg/backup.ts), under
  //    pg/YYYY-MM-DD/<run>/, the last KEEP_SNAPSHOTS days kept as the snapshots are. Last, so a failure here never
  //    costs the rest.
  let pg: BackupResult["pg"] = null;
  if (STORE_MODE === "postgres") {
    const { pg: connection } = await import("./pg/direct");
    const { dumpPostgres } = await import("./pg/backup");
    const db = await connection();
    if (db) {
      const prefix = `pg/${day}/${new Date().toISOString().replace(/[:.]/g, "-")}/`;
      const manifest = await dumpPostgres(db, async (name, body, type) => {
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: prefix + name, Body: body, ContentType: type }));
      });
      // Listed in pages: a month of days is far more than one listing's 1000 keys.
      const keys: string[] = [];
      let token: string | undefined;
      do {
        const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: "pg/", ContinuationToken: token }));
        for (const o of page.Contents ?? []) if (o.Key) keys.push(o.Key);
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      const gone = pgBackupsToPrune(keys);
      for (let i = 0; i < gone.length; i += 1000) {
        await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: gone.slice(i, i + 1000).map((Key) => ({ Key })) } }));
      }
      pg = { prefix, tables: manifest.tables.length, rows: manifest.tables.reduce((n, t) => n + t.rows, 0), pruned: gone.length };
    }
  }

  return { snapshot: chatReadFailed ? "" : snapshot, uploadsCopied: copied, uploadsSkipped: skipped, pruned, pg, ...(chatReadFailed ? { chatReadFailed: true as const } : {}) };
}

/**
 * The Postgres backups' keys that can go (pg/<day>/<run>/<file>). A run is finished once its manifest.json is there.
 * In a day, every run older than its newest finished one goes, finished or not (a newer one may still be running);
 * across days, the last KEEP_SNAPSHOTS days that hold a finished run are kept, and every day before them goes, so a
 * string of failed days never pushes a good backup out.
 */
function pgBackupsToPrune(keys: string[]): string[] {
  const days = new Map<string, Map<string, { keys: string[]; finished: boolean }>>();
  for (const key of keys) {
    const [, day, run, ...rest] = key.split("/");
    if (!day || !run) continue;
    // pg/<day>/<file>, from before runs had folders, as a run of its own named "" (older than any other).
    const runId = rest.length ? run : "";
    const file = rest.length ? rest.join("/") : run;
    let runs = days.get(day);
    if (!runs) days.set(day, (runs = new Map()));
    let entry = runs.get(runId);
    if (!entry) runs.set(runId, (entry = { keys: [], finished: false }));
    entry.keys.push(key);
    if (file === "manifest.json") entry.finished = true;
  }
  const gone = new Set<string>();
  for (const runs of days.values()) {
    const finished = [...runs].filter(([, r]) => r.finished).map(([id]) => id).sort();
    const newest = finished[finished.length - 1];
    if (newest === undefined) continue;
    for (const [id, r] of runs) if (id < newest) for (const key of r.keys) gone.add(key);
  }
  const goodDays = [...days].filter(([, runs]) => [...runs.values()].some((r) => r.finished)).map(([day]) => day).sort();
  if (goodDays.length > KEEP_SNAPSHOTS) {
    const oldestKept = goodDays[goodDays.length - KEEP_SNAPSHOTS];
    for (const [day, runs] of days) if (day < oldestKept) for (const r of runs.values()) for (const key of r.keys) gone.add(key);
  }
  return [...gone];
}

/** When the next 03:15 (server local time) falls, in ms from now. */
export function msUntilNextRun(now = new Date()): number {
  const next = new Date(now);
  next.setHours(3, 15, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}
