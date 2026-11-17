import fs from "fs";
import os from "os";
import path from "path";
import zlib from "zlib";
import { sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";

// The database's own backup (17 Nov, the safety net), beside the nightly JSON snapshot of the store (lib/backup.ts).
// The JSON snapshot is the in-memory store: it leaves out the tables queried directly (push_subscriptions,
// password_resets) and would miss every table that later moves out of memory. This one is read from Postgres itself:
// every table of the public schema and drizzle.__drizzle_migrations, row by row as Postgres writes it
// (row_to_json), in one read-only snapshot, so the tables agree with one another.
//
// Each table is gzip NDJSON, one row a line, in parts of PART_ROWS rows (so memory holds one part's compressed bytes
// at most, read FETCH_ROWS at a time through a cursor), then manifest.json, written last: the tables, their columns,
// key, row counts and parts. A run's backup without a manifest did not finish. scripts/restore-pg-backup.mjs puts one
// back into an empty database.
//
// The parts go to a temp folder while the transaction reads, and up to the bucket only once it has ended: an upload
// inside it would hold its locks on every table for as long as the bucket takes, and a deploy's migration (ALTER
// TABLE) would wait behind them, then every save behind the migration.

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyDb = PgDatabase<any, any, any>;

const FETCH_ROWS = 1000;
const PART_ROWS = 50_000;

export type DumpTable = {
  schema: string;
  name: string;
  columns: { name: string; type: string }[];
  /** The primary key's columns, in order; empty when it has none (read in ctid order then). */
  key: string[];
  rows: number;
  parts: string[];
};

export type DumpManifest = {
  format: 1;
  made_at: string;
  server_version: string | null;
  tables: DumpTable[];
};

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

const rowsOf = <T>(result: unknown): T[] => ((result as { rows?: T[] }).rows ?? []) as T[];

/** One part file as it is written: lines in, gzip bytes collected. */
class Part {
  private gz = zlib.createGzip();
  private chunks: Buffer[] = [];
  rows = 0;
  constructor() {
    this.gz.on("data", (chunk: Buffer) => this.chunks.push(chunk));
  }
  write(line: string) {
    this.gz.write(line + "\n");
    this.rows++;
  }
  finish(): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      this.gz.on("error", reject);
      this.gz.on("end", () => resolve(Buffer.concat(this.chunks)));
      this.gz.end();
    });
  }
}

/**
 * Reads every table and hands each finished file to `put` (its name, its bytes), the manifest last. Works on
 * node-postgres and PGlite alike. The read runs in one REPEATABLE READ, READ ONLY transaction.
 */
export async function dumpPostgres(db: AnyDb, put: (name: string, body: Buffer, type: string) => Promise<void>): Promise<DumpManifest> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "norcoach-pg-backup-"));
  try {
    const written: string[] = [];
    const manifest = await readAll(db, (name, body) => {
      fs.writeFileSync(path.join(dir, name), body);
      written.push(name);
    });
    // The transaction has ended: nothing in the database waits on the uploads.
    for (const name of written) await put(name, fs.readFileSync(path.join(dir, name)), "application/gzip");
    await put("manifest.json", Buffer.from(JSON.stringify(manifest, null, 2)), "application/json");
    return manifest;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The read itself, in its transaction: each finished part handed to `keep`, the manifest returned. */
function readAll(db: AnyDb, keep: (name: string, body: Buffer) => void): Promise<DumpManifest> {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"));
    const version = rowsOf<{ server_version?: string }>(await tx.execute(sql.raw("SHOW server_version")))[0]?.server_version ?? null;
    const listed = rowsOf<{ schema: string; name: string }>(
      await tx.execute(
        sql.raw(
          `SELECT table_schema AS schema, table_name AS name FROM information_schema.tables
           WHERE table_type = 'BASE TABLE' AND (table_schema = 'public' OR (table_schema = 'drizzle' AND table_name = '__drizzle_migrations'))
           ORDER BY table_schema DESC, table_name`
        )
      )
    );
    const tables: DumpTable[] = [];
    for (const { schema, name } of listed) {
      const columns = rowsOf<{ name: string; type: string }>(
        await tx.execute(
          sql`SELECT column_name AS name, data_type AS type FROM information_schema.columns
              WHERE table_schema = ${schema} AND table_name = ${name} ORDER BY ordinal_position`
        )
      );
      const key = rowsOf<{ name: string }>(
        await tx.execute(
          sql`SELECT a.attname AS name FROM pg_index i
              JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
              WHERE i.indrelid = (quote_ident(${schema}) || '.' || quote_ident(${name}))::regclass AND i.indisprimary
              ORDER BY array_position(i.indkey, a.attnum)`
        )
      ).map((r) => r.name);
      const order = key.length ? key.map((k) => `t.${quote(k)}`).join(", ") : "t.ctid";
      const file = `${schema}.${name}`;
      await tx.execute(sql.raw(`DECLARE norcoach_backup NO SCROLL CURSOR FOR SELECT row_to_json(t)::text AS j FROM ${quote(schema)}.${quote(name)} t ORDER BY ${order}`));
      const parts: string[] = [];
      let rows = 0;
      let part = new Part();
      const flush = async () => {
        const partName = `${file}.${String(parts.length).padStart(3, "0")}.ndjson.gz`;
        keep(partName, await part.finish());
        parts.push(partName);
        part = new Part();
      };
      for (;;) {
        const batch = rowsOf<{ j: string }>(await tx.execute(sql.raw(`FETCH FORWARD ${FETCH_ROWS} FROM norcoach_backup`)));
        if (!batch.length) break;
        for (const r of batch) {
          part.write(r.j);
          rows++;
          if (part.rows >= PART_ROWS) await flush();
        }
      }
      await tx.execute(sql.raw("CLOSE norcoach_backup"));
      // A table with no rows still has its one (empty) part, so the restore reads the same way for every table.
      if (part.rows > 0 || parts.length === 0) await flush();
      tables.push({ schema, name, columns, key, rows, parts });
    }
    const manifest: DumpManifest = {
      format: 1,
      made_at: new Date().toISOString(),
      server_version: version,
      tables,
    };
    return manifest;
  });
}
