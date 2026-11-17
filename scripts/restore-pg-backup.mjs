// Puts the database's own backup (17 Nov; app/lib/pg/backup.ts, pg/<YYYY-MM-DD>/<run>/ in the backup bucket) back
// into an EMPTY database. Nothing is ever written over: it stops before touching anything when a table already holds
// rows. A day can hold several runs (one after every boot, one nightly), each in its own folder named by when it
// started; only a run with its manifest.json finished, and the newest finished one is the day's backup.
//
// Usage, from the repo root:
//   node scripts/restore-pg-backup.mjs <backup> <target database>
//
//   <backup>   a folder holding manifest.json and the .ndjson.gz files of one run, as copied out of the bucket's
//              pg/<YYYY-MM-DD>/<run>/ (e.g. `aws s3 cp --recursive s3://<bucket>/pg/2026-11-17/ ./restore-2026-11-17/
//              --endpoint-url <endpoint>`: a folder of a day's runs takes its newest finished one), or
//              bucket:<YYYY-MM-DD> to read that day's newest finished run straight from the bucket
//              (bucket:<YYYY-MM-DD>/<run> for another), with BACKUP_BUCKET, BACKUP_ENDPOINT, BACKUP_REGION,
//              BACKUP_ACCESS_KEY_ID and BACKUP_SECRET_ACCESS_KEY set in the shell.
//   <target>   postgres://user:password@host:port/database (a new, empty database), or pglite:<folder> for a
//              rehearsal on this machine in a new folder.
//
// What it does, in order:
//   1. reads the manifest (written last by the backup, so a run without one did not finish and is refused);
//   2. refuses if any table in the target's public schema holds a row;
//   3. runs the app's migrations (./drizzle), as the server does at boot, so the tables are this checkout's;
//   4. refuses if the backup was made after a migration this checkout doesn't have (by its created_at, as drizzle's
//      migrator tells them apart; a different hash, a file's line endings changed, is only a warning), or holds a
//      table or a column the migrated database lacks (a row would lose that value): check out the code the backup was
//      made with first;
//   5. inserts every row, in one transaction, as Postgres wrote it (row_to_json in, json_populate_recordset out), into
//      the backup's own columns alone, so a column a newer migration added takes its default;
//   6. sets each serial column's sequence past its highest id (push_subscriptions, password_resets);
//   7. counts every table against the manifest, and rolls everything back when one differs.
// drizzle.__drizzle_migrations is not copied: step 3 writes it for the migrations it ran, and step 4 checks that the
// backup's are among them.
//
// It never reads .env files: the target is only ever the URL given here.

import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";
import zlib from "zlib";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = path.join(ROOT, "drizzle");
const BATCH_ROWS = 500;
const BATCH_BYTES = 8 * 1024 * 1024;

const say = (m) => console.log(`[restore] ${m}`);
const fail = (m) => {
  console.error(`[restore] refused: ${m}`);
  process.exit(1);
};
const q = (name) => `"${String(name).replace(/"/g, '""')}"`;

const [, , source, target] = process.argv;
if (!source || !target) {
  console.error("Usage: node scripts/restore-pg-backup.mjs <backup folder | bucket:YYYY-MM-DD> <postgres://… | pglite:<folder>>");
  process.exit(2);
}

// ---- The backup ------------------------------------------------------------------------------------------------

async function openBackup(src) {
  if (src.startsWith("bucket:")) {
    const [day, givenRun] = src.slice("bucket:".length).split("/");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) fail(`"${day}" is not a day (YYYY-MM-DD)`);
    const { BACKUP_BUCKET, BACKUP_ENDPOINT, BACKUP_REGION, BACKUP_ACCESS_KEY_ID, BACKUP_SECRET_ACCESS_KEY } = process.env;
    if (!BACKUP_BUCKET || !BACKUP_ENDPOINT || !BACKUP_ACCESS_KEY_ID || !BACKUP_SECRET_ACCESS_KEY) fail("bucket: needs BACKUP_BUCKET, BACKUP_ENDPOINT, BACKUP_ACCESS_KEY_ID and BACKUP_SECRET_ACCESS_KEY");
    const { S3Client, GetObjectCommand, ListObjectsV2Command } = await import("@aws-sdk/client-s3");
    const s3 = new S3Client({
      region: BACKUP_REGION || "auto",
      endpoint: BACKUP_ENDPOINT,
      credentials: { accessKeyId: BACKUP_ACCESS_KEY_ID, secretAccessKey: BACKUP_SECRET_ACCESS_KEY },
    });
    let run = givenRun;
    if (!run) {
      // The day's newest run that finished (its manifest written last).
      const finished = [];
      let token;
      do {
        const page = await s3.send(new ListObjectsV2Command({ Bucket: BACKUP_BUCKET, Prefix: `pg/${day}/`, ContinuationToken: token }));
        for (const o of page.Contents ?? []) {
          const m = /^pg\/[^/]+\/([^/]+)\/manifest\.json$/.exec(o.Key ?? "");
          if (m) finished.push(m[1]);
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      if (!finished.length) fail(`no finished run (a manifest.json) under pg/${day}/ in the bucket`);
      run = finished.sort()[finished.length - 1];
      say(`pg/${day}/: ${finished.length} finished ${finished.length === 1 ? "run" : "runs"}, taking the newest, ${run}`);
    }
    const prefix = `pg/${day}/${run}/`;
    const get = async (name) => (await s3.send(new GetObjectCommand({ Bucket: BACKUP_BUCKET, Key: prefix + name }))).Body;
    let manifest;
    try {
      manifest = JSON.parse(await (await get("manifest.json")).transformToString());
    } catch (e) {
      fail(`no readable ${prefix}manifest.json in the bucket (${e instanceof Error ? e.message : e})`);
    }
    return { manifest, open: async (name) => (await get(name)).pipe(zlib.createGunzip()) };
  }
  let folder = path.resolve(src);
  if (!fs.existsSync(path.join(folder, "manifest.json")) && fs.existsSync(folder)) {
    // A day's folder of runs: its newest finished one.
    const runs = fs
      .readdirSync(folder, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(folder, e.name, "manifest.json")))
      .map((e) => e.name)
      .sort();
    if (runs.length) {
      say(`${folder}: ${runs.length} finished ${runs.length === 1 ? "run" : "runs"}, taking the newest, ${runs[runs.length - 1]}`);
      folder = path.join(folder, runs[runs.length - 1]);
    }
  }
  const file = path.join(folder, "manifest.json");
  if (!fs.existsSync(file)) fail(`no manifest.json in ${folder}`);
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  return {
    manifest,
    open: async (name) => {
      const part = path.join(folder, name);
      if (!fs.existsSync(part)) fail(`${name} is in the manifest but not in ${folder}`);
      return fs.createReadStream(part).pipe(zlib.createGunzip());
    },
  };
}

async function* linesOf(stream) {
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) if (line) yield line;
}

// ---- The target ------------------------------------------------------------------------------------------------

async function connect(url) {
  if (url.startsWith("pglite:")) {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    const client = new PGlite(url.slice("pglite:".length));
    await client.waitReady;
    return {
      query: (text, params) => client.query(text, params),
      migrate: () => migrate(drizzle(client), { migrationsFolder: MIGRATIONS }),
      close: () => client.close(),
    };
  }
  if (!/^postgres(ql)?:\/\//.test(url)) fail(`the target must be postgres://… or pglite:<folder>, not "${url}"`);
  const { default: pg } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return {
    query: (text, params) => client.query(text, params),
    migrate: () => migrate(drizzle(client), { migrationsFolder: MIGRATIONS }),
    close: () => client.end(),
  };
}

async function publicTables(db) {
  const { rows } = await db.query(`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`);
  return rows.map((r) => r.name);
}

async function filledTables(db) {
  const filled = [];
  for (const name of await publicTables(db)) {
    const { rows } = await db.query(`SELECT EXISTS (SELECT 1 FROM public.${q(name)}) AS filled`);
    if (rows[0].filled) filled.push(name);
  }
  return filled;
}

// ---- The restore -----------------------------------------------------------------------------------------------

const backup = await openBackup(source);
const { manifest } = backup;
if (manifest?.format !== 1 || !Array.isArray(manifest.tables)) fail("the manifest is not one this script knows (format 1)");
const data = manifest.tables.filter((t) => t.schema === "public");
const migrations = manifest.tables.find((t) => t.schema === "drizzle" && t.name === "__drizzle_migrations");
say(`backup made ${manifest.made_at} (Postgres ${manifest.server_version ?? "?"}): ${data.length} tables, ${data.reduce((n, t) => n + t.rows, 0)} rows`);

const db = await connect(target);
try {
  // 2. Empty, before anything is changed.
  const before = await filledTables(db);
  if (before.length) fail(`the target is not empty: ${before.join(", ")} hold rows. Restore only into a new, empty database.`);

  // 3. This checkout's tables.
  await db.migrate();
  say("migrations run");
  const after = await filledTables(db);
  if (after.length) fail(`the migrations left rows in ${after.join(", ")}; nothing restored`);

  // 4. The backup fits this checkout.
  if (migrations) {
    // Told apart by created_at (the journal's folderMillis), as drizzle's migrator does; the hash is the .sql file's
    // bytes, which line endings or an edited comment change, so a different one is only said.
    const applied = new Map((await db.query(`SELECT hash, created_at FROM drizzle.__drizzle_migrations`)).rows.map((r) => [String(r.created_at), r.hash]));
    const unknown = [];
    const changed = [];
    for (const name of migrations.parts) for await (const line of linesOf(await backup.open(name))) {
      const { hash, created_at } = JSON.parse(line);
      const at = String(created_at);
      if (!applied.has(at)) unknown.push(at);
      else if (applied.get(at) !== hash) changed.push(at);
    }
    if (unknown.length) fail(`the backup's database had migrations this checkout doesn't (created_at ${unknown.join(", ")}): check out the code it was made with`);
    if (changed.length) console.warn(`[restore] note: the migrations of created_at ${changed.join(", ")} have another hash here (their file's bytes differ, line endings perhaps); restoring all the same`);
  }
  for (const t of data) {
    const { rows } = await db.query(`SELECT column_name AS name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [t.name]);
    if (!rows.length) fail(`the backup holds the table ${t.name}, which this checkout's migrations don't make`);
    const have = new Set(rows.map((r) => r.name));
    const missing = t.columns.map((c) => c.name).filter((c) => !have.has(c));
    if (missing.length) fail(`${t.name} in the backup has columns this checkout lacks (${missing.join(", ")})`);
  }

  // 5–7. Everything or nothing.
  await db.query("BEGIN");
  try {
    for (const t of data) {
      const table = `public.${q(t.name)}`;
      // The backup's columns alone: one a newer migration added takes its default, never a NULL (a NOT NULL one would fail).
      const cols = t.columns.map((c) => q(c.name)).join(", ");
      let batch = [];
      let bytes = 0;
      let inserted = 0;
      const send = async () => {
        if (!batch.length) return;
        await db.query(`INSERT INTO ${table} (${cols}) SELECT ${cols} FROM json_populate_recordset(NULL::${table}, $1::json)`, [`[${batch.join(",")}]`]);
        inserted += batch.length;
        batch = [];
        bytes = 0;
      };
      for (const name of t.parts) {
        for await (const line of linesOf(await backup.open(name))) {
          batch.push(line);
          bytes += line.length;
          if (batch.length >= BATCH_ROWS || bytes >= BATCH_BYTES) await send();
        }
      }
      await send();
      say(`${t.name}: ${inserted} rows`);
    }
    const serials = (
      await db.query(`SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND column_default LIKE 'nextval(%'`)
    ).rows;
    for (const { t, c } of serials) {
      await db.query(`SELECT setval(pg_get_serial_sequence($1, $2), COALESCE((SELECT MAX(${q(c)}) FROM public.${q(t)}), 0) + 1, false)`, [`public.${q(t)}`, c]);
    }
    const wrong = [];
    for (const t of data) {
      const { rows } = await db.query(`SELECT count(*)::int AS n FROM public.${q(t.name)}`);
      if (rows[0].n !== t.rows) wrong.push(`${t.name} ${rows[0].n} of ${t.rows}`);
    }
    if (wrong.length) throw new Error(`the counts differ from the manifest: ${wrong.join(", ")}`);
    await db.query("COMMIT");
  } catch (e) {
    await db.query("ROLLBACK").catch(() => {});
    console.error(`[restore] failed, nothing kept: ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  }
  if (!process.exitCode) say(`done: ${data.length} tables, every count as in the manifest`);
} finally {
  await db.close();
}
