// The real readers on narrow slices against wide ones, on a copy of real data (Step 5's cut-over, 19 Nov review): the
// read week's shadow proves the SQL against pick.ts and Needs you and the chat list against their readers; this proves
// every other coach-wide reader (the rail, Home's events, loadHome's Activity, the Feed's Activity and Since, the dots,
// Coaches' accounts, dismissHome's Home) gives the same output from the bounded slices as from every row.
//
// Only ever on a COPY (it boots the store, and the boot may write: migrations, counters, tidies): a pglite folder copied
// from a restored backup, or a staging database restored from production's backup (scripts/restore-pg-backup.mjs).
// Run it once per mode on the same copy, the clock frozen the same, then compare:
//   STORE=postgres DATABASE_URL=pglite:<copy> TZ=Europe/Amsterdam CHAT_VIEWS=wide   OUT=wide.json   npx tsx scripts/chat-views-compare.ts
//   STORE=postgres DATABASE_URL=pglite:<copy> TZ=Europe/Amsterdam CHAT_VIEWS=narrow OUT=narrow.json npx tsx scripts/chat-views-compare.ts
//   STORE=postgres DATABASE_URL=pglite:<copy> TZ=Europe/Amsterdam CHAT_STORE=pg     OUT=pg.json     npx tsx scripts/chat-views-compare.ts
//   npx tsx scripts/chat-views-compare.ts --compare wide.json narrow.json      (then wide.json pg.json)
// A postgres:// copy needs CHAT_COMPARE_ON_COPY=1 as well. The clock is frozen at FROZEN_MS (default: the start of today
// on the machine; give every run of one comparison the same). It writes nothing of its own: no read marks, no Feed
// visit, no dismissals. Its output holds real data: keep it on the machine and delete it after.

import fs from "fs";
import Module from "module";
import os from "os";
import path from "path";

if (process.argv[2] === "--compare") {
  const a = JSON.parse(fs.readFileSync(process.argv[3], "utf8")) as Record<string, unknown>;
  const b = JSON.parse(fs.readFileSync(process.argv[4], "utf8")) as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !k.startsWith("_"));
  const where = (x: unknown, y: unknown, at = ""): string | null => {
    if (JSON.stringify(x) === JSON.stringify(y)) return null;
    if (x && y && typeof x === "object" && typeof y === "object") {
      for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
        const w = where((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k], `${at}.${k}`);
        if (w) return w;
      }
    }
    return at || "(whole)";
  };
  const diff = keys.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
  console.log(`${keys.length - diff.length} of ${keys.length} identical`);
  // Where they differ, by path alone (never a value: this is real data).
  for (const k of diff.slice(0, 50)) console.log(`  DIFF ${k} at ${where(a[k], b[k])}`);
  console.log(`errors: ${JSON.stringify(a._errors ?? []).length > 2 ? "first has errors" : "none"} | ${JSON.stringify(b._errors ?? []).length > 2 ? "second has errors" : "none"}`);
  process.exit(diff.length ? 1 : 0);
}

const url = process.env.DATABASE_URL ?? "";
if (!url.startsWith("pglite:") && process.env.CHAT_COMPARE_ON_COPY !== "1") {
  console.error("Only on a copy: DATABASE_URL=pglite:<copied folder>, or a postgres:// copy with CHAT_COMPARE_ON_COPY=1.");
  process.exit(2);
}
if (!process.env.OUT) {
  console.error("OUT=<file.json> is where the outputs go.");
  process.exit(2);
}

// "server-only" is nothing outside Next's server bundle.
const empty = path.join(os.tmpdir(), "norcoach-server-only-empty.cjs");
if (!fs.existsSync(empty)) fs.writeFileSync(empty, "");
const M = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
const resolve = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "server-only" ? empty : resolve.call(this, request, ...rest);
};

// The clock frozen, the same for every run.
const FROZEN = Number(process.env.FROZEN_MS) || new Date(new Date().toDateString()).getTime();
const RealDate = Date;
class FrozenDate extends RealDate {
  constructor(...args: ConstructorParameters<typeof Date> | []) {
    if (args.length === 0) super(FROZEN);
    else super(...(args as ConstructorParameters<typeof Date>));
  }
  static now() {
    return FROZEN;
  }
}
globalThis.Date = FrozenDate as unknown as DateConstructor;

async function main() {
  const runtime = await import("../app/lib/pg/runtime");
  await runtime.initStore();
  const db = await import("../app/lib/db");
  const q = await import("../app/lib/queries");
  const loaders = await import("../app/admin/redesign/loaders");
  const feedBoard = await import("../app/lib/feedBoardData");
  const rows = await import("../app/lib/chat/rows");
  // The food diary's views (quest 8 part 1), beside the chat's: the same paths' fetches.
  const food = await import("../app/lib/food/rows");
  // The check-in figures' views (quest 9) the same.
  const ck = await import("../app/lib/checkins/rows");
  // The logged sets' views (quest 10), fetched as each page fetches them.
  const sets = await import("../app/lib/sets/rows");
  const data = db.getData();
  const out: Record<string, unknown> = {};
  const errors: string[] = [];
  const strip = (v: unknown) => JSON.parse(JSON.stringify(v ?? null, (k, x) => (k === "eventTotal" || k === "rev" ? undefined : x)));
  const safe = async (key: string, fn: () => unknown) => {
    try {
      out[key] = strip(await fn());
    } catch (e) {
      out[key] = { error: e instanceof Error ? e.name : "error" };
      errors.push(`${key}: ${e instanceof Error ? e.name : "error"}`);
    }
  };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const coaches = (data.users as any[]).filter((u) => u.role === "coach");
  const clients = (data.clients as any[]).map((c) => ({ id: c.id as number, coach_id: (c.coach_id ?? null) as number | null }));
  await safe("listCoachAccounts", async () => q.listCoachAccounts(await rows.fetchCoachChat(coaches.map((c) => c.id), "page.coaches.accounts"), await food.fetchCoachFood(coaches.map((c) => c.id), "page.coaches.accounts"), await ck.fetchEveryCheckIn("page.coaches.accounts"), await sets.fetchEverySet("page.coaches.accounts")));
  for (const coach of coaches) {
    await safe(`rail:${coach.id}`, async () => loaders.loadRail(coach, (await rows.fetchCoachPageChat(coach.id, "page.business")).coach, await food.fetchCoachFood([coach.id], "page.business"), await ck.fetchCoachCheckIns([coach.id], "page.business"), await sets.fetchCoachSets("page.business", [coach.id])));
    await safe(`phaseNeeds:${coach.id}`, async () => loaders.loadPhaseNeeds(coach.id, (await rows.fetchCoachPageChat(coach.id, "page.phases")).coach, await food.fetchCoachFood([coach.id], "page.phases"), await ck.fetchCoachCheckIns([coach.id], "page.phases"), await sets.fetchCoachSets("page.phases", [coach.id])));
    await safe(`dock:${coach.id}`, async () => loaders.loadChatDock(coach, (await rows.fetchCoachPageChat(coach.id, "page.calendar")).dock));
    // The Feed as it stands (its Since from the visit before, as kept; no visit noted here).
    await safe(`feedBoard:${coach.id}`, async () => feedBoard.getFeedBoard(coach.id, (await rows.fetchCoachPageChat(coach.id, "page.feed")).coach, await food.fetchCoachFood([coach.id], "page.feed"), await ck.fetchCoachCheckIns([coach.id], "page.feed"), await sets.fetchCoachSets("page.feed", [coach.id])));
  }
  for (const c of clients) {
    await safe(`tabHome:${c.id}`, async () => {
      const tab = await rows.fetchClientTabChat(c.coach_id ?? 0, c.id, "page.tab.home");
      const f = await food.fetchClientTabFood(c.coach_id ?? 0, c.id, "page.tab.home");
      const k = await ck.fetchClientTabCheckIns(c.coach_id ?? 0, c.id, "page.tab.home");
      const sk = await sets.fetchClientTabSets("page.tab.home", c.coach_id ?? 0, c.id);
      return { home: q.getClientHome(c.id, tab.coach, f, k, sk), attention: q.clientAttention(c.id, tab.coach, f, k, sk), dots: loaders.loadDots(c.id, tab.coach, f, k, sk), draft: loaders.loadHome(c.id, tab, f, k, sk) };
    });
    await safe(`dismissHome:${c.id}`, async () => q.getClientHomeActions(c.id, await rows.fetchCoachChatOfClient(c.id, "action.dismissHome"), await food.fetchCoachFoodOfClient(c.id, "action.dismissHome"), await ck.fetchCoachCheckInsOfClient(c.id, "action.dismissHome"), await sets.fetchCoachSetsOfClient("action.dismissHome", c.id)));
  }
  out._errors = errors;
  fs.writeFileSync(process.env.OUT!, JSON.stringify(out));
  console.log(`[compare] ${Object.keys(out).length - 1} outputs, ${errors.length} errors, written to ${process.env.OUT}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? `${e.name}: ${e.message.split("\nparams:")[0]}` : e);
  process.exit(1);
});
