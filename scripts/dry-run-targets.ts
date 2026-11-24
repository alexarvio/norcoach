// A dry run of the fresh weight rule (24 Nov, Alex: docs/boards/target-rule-mockup.html; lib/targetRule.ts freshLane),
// on a COPY of a local store: it loads the copy into memory, runs the minute job's pass as the server's first pass after
// a boot runs it (applyDueProgramDeployments, a full pass), and says what it would change. It writes nothing back: the
// store's save is a stub that only counts, and the store is never the JSON file (STORE=postgres, so persist() writes no
// file). Only a pglite folder copied somewhere of its own, never a folder a server has open, never Postgres:
//   DRY_COPY=<copied pglite folder> TZ=Europe/Amsterdam npx tsx scripts/dry-run-targets.ts
// Or a backup's JSON snapshot (24 Nov: latest.json from the backups bucket, downloaded to a folder of its own):
//   DRY_JSON=<snapshot .json> TZ=Europe/Amsterdam npx tsx scripts/dry-run-targets.ts
// Its output holds real data: keep it on the machine.

import fs from "fs";
import Module from "module";
import os from "os";
import path from "path";

const json = process.env.DRY_JSON ? path.resolve(process.env.DRY_JSON) : null;
const copy = path.resolve(process.env.DRY_COPY ?? "");
const here = path.resolve(__dirname, "..");
const refused = [path.join(here, ".pglite-local"), path.resolve(here, "..", "ironline-verify", ".pglite-verify")];
if (json && !fs.existsSync(json)) {
  console.error("DRY_JSON names no file.");
  process.exit(2);
}
if (!json && (!process.env.DRY_COPY || !fs.existsSync(path.join(copy, "PG_VERSION")))) {
  console.error("DRY_COPY=<a copied pglite folder> is needed.");
  process.exit(2);
}
if (!json && refused.some((r) => path.relative(r, copy) === "" || !path.relative(r, copy).startsWith(".."))) {
  console.error("Only on a copy: that folder is one a server uses. Copy it somewhere else first.");
  process.exit(2);
}
if (!json && fs.existsSync(path.join(copy, "postmaster.pid"))) {
  console.error("The copy holds a postmaster.pid: it was copied while open. Copy it again from a closed folder.");
  process.exit(2);
}
process.env.STORE = "postgres";
process.env.DATABASE_URL = `pglite:${copy}`;
process.env.DATA_DIR = path.join(os.tmpdir(), "norcoach-dry-run-data");
for (const k of ["SETS_STORE", "CHAT_STORE", "NOTES_STORE", "FOOD_STORE", "CHECKINS_STORE", "SETS_SHADOW", "CHAT_SHADOW", "CHECKINS_SHADOW", "FOOD_SHADOW"]) delete process.env[k];

// "server-only" is nothing outside Next's server bundle.
const empty = path.join(os.tmpdir(), "norcoach-server-only-empty.cjs");
if (!fs.existsSync(empty)) fs.writeFileSync(empty, "");
const M = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
const resolve = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "server-only" ? empty : resolve.call(this, request, ...rest);
};

type Gyms = Record<string, { kg: number | null; coach_kg?: number | null }> | undefined;
type Snap = { kg: number | null; coach: number | null | undefined; gyms: Gyms };

async function loadRaw(db: typeof import("../app/lib/db")): Promise<unknown> {
  if (json) return JSON.parse(fs.readFileSync(json, "utf8"));
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const pg = new PGlite(copy);
  const pdb = drizzle(pg);
  // The copy brought up to this build's schema (on the copy alone), as the server's connect does.
  await migrate(pdb, { migrationsFolder: path.join(here, "drizzle") });
  const store = await import("../app/lib/pg/store");
  void db;
  type AnyDb = Parameters<typeof store.loadStore>[0];
  const raw = await store.loadStore(pdb as unknown as AnyDb);
  await pg.close();
  return raw;
}

async function main() {
  const db = await import("../app/lib/db");
  const raw = await loadRaw(db);
  const { data } = db.prepareStore(raw as Parameters<typeof db.prepareStore>[0]);
  let saves = 0;
  // The save stubbed: nothing reaches a database or a file.
  db.installStore(data, async () => {
    saves++;
  });
  const q = await import("../app/lib/queries");
  const sets = await import("../app/lib/sets/rows");

  const d = db.getData();
  const prior = (d as unknown as { targets_recomputed_v1?: { at: string; rows: number; lanes: number } }).targets_recomputed_v1;
  const setList = (d as unknown as { set_logs?: { logged_at: string }[] }).set_logs ?? [];
  const latest = setList.reduce((m, s) => (s.logged_at > m ? s.logged_at : m), "");
  console.log(`copy: ${d.clients.length} clients, ${d.workout_assignments.length} rows, ${setList.length} sets (the latest ${latest || "none"}), ${d.workout_assignments.filter((wa) => wa.coach_kg !== undefined).length} rows raised by the rule (coach_kg)`);
  console.log(`client 9: ${d.clients.find((c) => c.id === 9)?.name ?? "not in the copy"}`);
  if (prior && !Array.isArray(prior) && typeof prior.at === "string") console.log(`the copy already holds a first fresh pass's record (${prior.at}: ${prior.rows} rows, ${prior.lanes} lanes); dropped in memory so this pass makes its own`);
  else if (prior) console.log(`the copy holds targets_recomputed_v1 in another shape (${Array.isArray(prior) ? "a list" : typeof prior}); dropped in memory`);
  delete (d as unknown as Record<string, unknown>).targets_recomputed_v1;

  const snap = new Map<number, Snap>();
  for (const wa of d.workout_assignments) snap.set(wa.id, { kg: wa.target_weight_kg, coach: wa.coach_kg, gyms: wa.gym_targets ? JSON.parse(JSON.stringify(wa.gym_targets)) : undefined });

  await q.applyDueProgramDeployments(sets.setsForDueJobNow("job.due", { all: true, clients: [] }));

  const rec = (d as unknown as { targets_recomputed_v1?: { rows: number; lanes: number; changes: { rowId: number; lane: number | null; before: number | null; after: number | null; coach_kg_before?: number | null }[] } }).targets_recomputed_v1;
  if (!rec) {
    console.log("the pass made no record (no full pass ran)");
    return;
  }
  const dayOf = new Map(d.program_days.map((pd) => [pd.id, pd]));
  const rowOf = new Map(d.workout_assignments.map((wa) => [wa.id, wa]));
  const where = (rowId: number) => {
    const wa = rowOf.get(rowId);
    const day = wa && dayOf.get(wa.program_day_id);
    const client = day && d.clients.find((c) => c.id === day.client_id);
    const ex = wa && d.exercises.find((e) => e.id === wa.exercise_id);
    const variation = wa?.variation_id != null ? ex?.variations?.find((v) => v.id === wa.variation_id)?.name : null;
    const prog = day && d.training_programs.find((p) => p.client_id === day.client_id && day.week_number >= p.start_week && day.week_number < p.start_week + p.total_weeks);
    const week = day ? (prog ? day.week_number - prog.start_week + 1 : day.week_number) : null;
    return { clientId: day?.client_id ?? null, client: client?.name ?? "?", exercise: `${ex?.name ?? "?"}${variation ? ` (${variation})` : ""}`, week, session: day?.label ?? `day ${day?.day_of_week}`, reps: wa?.reps ?? "", coachNow: wa?.coach_kg };
  };
  const ch = rec.changes;
  const up = ch.filter((c) => c.before != null && c.after != null && c.after > c.before).length;
  const down = ch.filter((c) => c.before != null && c.after != null && c.after < c.before).length;
  const blank = ch.filter((c) => c.after == null).length;
  const filled = ch.filter((c) => c.before == null && c.after != null).length;
  console.log(`\nthe pass: ${rec.rows} rows, ${rec.lanes} lanes would change${rec.lanes > ch.length ? ` (the first ${ch.length} kept in the record)` : ""}`);
  console.log(`  down ${down} | up ${up} | to blank ${blank} | blank filled ${filled} | home lane ${ch.filter((c) => c.lane == null).length} | gym lanes ${ch.filter((c) => c.lane != null).length}`);

  // Every row's weights before against after, so a change the record didn't take (another part of the job) shows too.
  let other = 0;
  for (const wa of d.workout_assignments) {
    const b = snap.get(wa.id);
    if (!b) continue;
    const same = b.kg === wa.target_weight_kg && b.coach === wa.coach_kg && JSON.stringify(b.gyms ?? null) === JSON.stringify(wa.gym_targets ?? null);
    if (!same && !ch.some((c) => c.rowId === wa.id)) other++;
  }
  console.log(`  rows changed outside the rule's record (resets carried, other mends): ${other}; saves asked (stubbed, nothing written): ${saves}`);

  const fmt = (c: (typeof ch)[number]) => {
    const w = where(c.rowId);
    return `  ${w.client} | ${w.exercise} | week ${w.week} ${w.session} | ${w.reps} | ${c.lane == null ? "home" : `gym ${c.lane}`}: ${c.before ?? "blank"} → ${c.after ?? "blank"}${c.coach_kg_before !== undefined ? ` (coach_kg before ${c.coach_kg_before})` : ""}`;
  };
  console.log("\na sample of 15:");
  const step = Math.max(1, Math.floor(ch.length / 15));
  for (let i = 0; i < ch.length && i / step < 15; i += step) console.log(fmt(ch[i]));

  console.log("\nclient 9, Flat Chest Press Machine:");
  const alex = ch.filter((c) => {
    const w = where(c.rowId);
    return w.clientId === 9 && /flat chest press machine/i.test(w.exercise);
  });
  if (!alex.length) console.log("  no change");
  for (const c of alex) console.log(fmt(c));
  // And where those rows stand, changed or not, for a look.
  console.log("\nclient 9, Flat Chest Press Machine, every row now:");
  const rows = d.workout_assignments
    .filter((wa) => {
      const w = where(wa.id);
      return w.clientId === 9 && /flat chest press machine/i.test(w.exercise);
    })
    .map((wa) => ({ wa, w: where(wa.id), day: dayOf.get(wa.program_day_id)! }))
    .sort((a, b) => a.day.week_number - b.day.week_number || a.day.day_of_week - b.day.day_of_week);
  for (const { wa, w } of rows) {
    const b = snap.get(wa.id)!;
    console.log(`  week ${w.week} ${w.session} | ${w.reps} | ${b.kg ?? "blank"} → ${wa.target_weight_kg ?? "blank"}${wa.coach_kg !== undefined ? ` (coach_kg ${wa.coach_kg})` : ""}`);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
