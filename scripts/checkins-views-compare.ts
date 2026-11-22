// The check-in figures' readers on narrow views and on Postgres against the store's own lists, on a copy of real data
// (quest 9, Step 6 of docs/database-plan.md; the views compare its Exit names): every reader the pages, the jobs and the
// actions fetch for (the check-in pop-up, Entries, Progress and Calendar, the streak, every body weight, the goals, the
// coach's Lifestyle Table and Graph, the series, Home's board and tiles, Consistency's asked days, the engagement, Home,
// the rail, the dots, the Feed, Coaches' accounts, the minute job's due items, the locked app), for every client.
//
// Only ever on a COPY (it boots the store, and the boot may write: migrations, counters, tidies; with CHECKINS_STORE=pg
// its boot moves twins and makes the unique rules). Run it once per mode on fresh copies of one folder, the clock frozen
// the same, then compare:
//   STORE=postgres DATABASE_URL=pglite:<copy1> TZ=Europe/Amsterdam                        OUT=wide.json   npx tsx scripts/checkins-views-compare.ts
//   STORE=postgres DATABASE_URL=pglite:<copy2> TZ=Europe/Amsterdam CHECKINS_VIEWS=narrow  OUT=narrow.json npx tsx scripts/checkins-views-compare.ts
//   STORE=postgres DATABASE_URL=pglite:<copy3> TZ=Europe/Amsterdam CHECKINS_STORE=pg      OUT=pg.json     npx tsx scripts/checkins-views-compare.ts
//   npx tsx scripts/checkins-views-compare.ts --compare wide.json narrow.json      (then wide.json pg.json, by value)
// A postgres:// copy needs CHECKINS_COMPARE_ON_COPY=1 as well. FROZEN_MS freezes the clock (default: the start of today).
// It writes nothing of its own but what a page render writes (the untouched auto Weight line dropped, as the pages do).
// Its output holds real data: keep it on the machine and delete it after. It prints paths, never values.

import fs from "fs";
import Module from "module";
import os from "os";
import path from "path";

/** Canonical JSON (keys sorted): pg mode's rows come back with their fields in another order, as after any reboot. */
const canon = (v: unknown): string =>
  v === undefined
    ? "null"
    : v === null || typeof v !== "object"
      ? JSON.stringify(v)
      : Array.isArray(v)
        ? `[${v.map(canon).join(",")}]`
        : `{${Object.keys(v as Record<string, unknown>)
            .sort()
            .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
            .map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`)
            .join(",")}}`;

if (process.argv[2] === "--compare") {
  const a = JSON.parse(fs.readFileSync(process.argv[3], "utf8")) as Record<string, unknown>;
  const b = JSON.parse(fs.readFileSync(process.argv[4], "utf8")) as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !k.startsWith("_"));
  const where = (x: unknown, y: unknown, at = ""): string => {
    if (x && y && typeof x === "object" && typeof y === "object") {
      for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
        const xx = (x as Record<string, unknown>)[k];
        const yy = (y as Record<string, unknown>)[k];
        if (canon(xx) !== canon(yy)) return where(xx, yy, `${at}.${k}`);
      }
    }
    return at || "(whole)";
  };
  const diff = keys.filter((k) => canon(a[k]) !== canon(b[k]));
  console.log(`${keys.length - diff.length} of ${keys.length} identical (by value)`);
  for (const k of diff.slice(0, 50)) console.log(`  DIFF ${k} at ${where(a[k], b[k])}`);
  console.log(`errors: ${JSON.stringify(a._errors ?? []).length > 2 ? "first has errors" : "none"} | ${JSON.stringify(b._errors ?? []).length > 2 ? "second has errors" : "none"}`);
  process.exit(diff.length ? 1 : 0);
}

const url = process.env.DATABASE_URL ?? "";
if (!url.startsWith("pglite:") && process.env.CHECKINS_COMPARE_ON_COPY !== "1") {
  console.error("Only on a copy: DATABASE_URL=pglite:<copied folder>, or a postgres:// copy with CHECKINS_COMPARE_ON_COPY=1.");
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
  const hb = await import("../app/lib/homeBoardData");
  const chat = await import("../app/lib/chat/rows");
  const food = await import("../app/lib/food/rows");
  const appLock = await import("../app/lib/appLock");
  const ck = await import("../app/lib/checkins/rows");
  // The logged sets' views (quest 10), fetched as each page fetches them.
  const sets = await import("../app/lib/sets/rows");
  const data = db.getData();
  const out: Record<string, unknown> = {};
  const errors: string[] = [];
  const keep = (_k: string, x: unknown) => (x instanceof Map ? [...x] : x instanceof Set ? [...x] : x);
  const safe = async (key: string, fn: () => unknown) => {
    try {
      out[key] = JSON.parse(JSON.stringify((await fn()) ?? null, keep));
    } catch (e) {
      out[key] = { error: e instanceof Error ? e.name : "error" };
      errors.push(`${key}: ${e instanceof Error ? e.name : "error"}`);
    }
  };
  const today = q.localDateStr();
  const day = (n: number) => {
    const d = new Date(`${today}T00:00:00`);
    d.setDate(d.getDate() + n);
    return q.localDateStr(d);
  };
  const coaches = data.users.filter((u) => u.role === "coach");
  const everyCoach = coaches.map((c) => c.id);
  const allChat = await chat.fetchCoachChat(everyCoach, "page.coaches.accounts");
  const allFood = await food.fetchCoachFood(everyCoach, "page.coaches.accounts");
  const every = await ck.fetchEveryCheckIn("page.coaches.accounts");
  const everySet = await sets.fetchEverySet("page.coaches.accounts");
  const due = await ck.fetchDueCheckIns(data.clients.map((c) => c.id), "job.reminders", q.dueCheckInDefIds);
  await safe("accounts", () => q.listCoachAccounts(allChat, allFood, every, everySet));
  for (const c of data.clients) await safe(`due:${c.id}`, () => q.getDueItems(due, c.id));
  for (const coach of coaches) {
    const pageChat = await chat.fetchCoachPageChat(coach.id, "page.feed");
    const coachFood = await food.fetchCoachFood([coach.id], "page.feed");
    const coachV = await ck.fetchCoachCheckIns([coach.id], "page.feed");
    const coachS = await sets.fetchCoachSets("page.feed", [coach.id]);
    await safe(`feed:${coach.id}`, () => q.getActivityFeed(coach.id, pageChat.coach, coachFood, coachV, coachS, { span: { feedFrom: Date.now() - 14 * 86400000 } }).filter((e: { at: number }) => e.at >= Date.now() - 14 * 86400000));
    await safe(`feedBoard:${coach.id}`, () => feedBoard.getFeedBoard(coach.id, pageChat.coach, coachFood, coachV, coachS));
    await safe(`rail:${coach.id}`, () => loaders.loadRail(coach, pageChat.coach, coachFood, coachV, coachS));
    await safe(`phaseNeeds:${coach.id}`, () => loaders.loadPhaseNeeds(coach.id, pageChat.coach, coachFood, coachV, coachS));
  }
  for (const c of data.clients) {
    const cid = c.id;
    const coachId = c.coach_id ?? 0;
    await q.dropUnusedAutoWeightPg(cid);
    const tabChat = await chat.fetchClientTabChat(coachId, cid, "page.tab.measurements");
    const foodPage = await food.fetchClientPageFood(cid, "page.client");
    const foodTab = await food.fetchClientTabFood(coachId, cid, "page.tab.measurements");
    const lockFood = await appLock.fetchAppLockFood([cid], "action.appLock");
    const page = await ck.fetchClientPageCheckIns(cid, "page.client");
    const tab = await ck.fetchClientTabCheckIns(coachId, cid, "page.tab.measurements");
    const lockCk = await appLock.fetchAppLockCheckIns([cid], "action.appLock");
    const pageS = await sets.fetchClientPageSets("page.client", cid);
    const tabS = await sets.fetchClientTabSets("page.tab.measurements", coachId, cid);
    const lockS = await appLock.fetchAppLockSets([cid], "action.appLock");
    const k = `c${cid}`;
    const sections = q.getCheckInSections(page, cid);
    await safe(`${k}.sections`, () => sections);
    await safe(`${k}.status`, () => q.getCheckInStatus(page, cid));
    await safe(`${k}.weeklyAsked`, () => q.weeklyCheckInAskedToday(page, cid, sections.sections));
    await safe(`${k}.monthlyAsked`, () => q.monthlyCheckInAskedToday(page, cid, sections.sections));
    await safe(`${k}.history`, () => q.getCheckInHistory(page, cid));
    await safe(`${k}.streak`, () => q.getCheckInStreak(page, cid));
    await safe(`${k}.calendar`, () => q.getActivityCalendar(foodPage, cid, page, pageS));
    await safe(`${k}.bodyWeight`, () => [q.bodyWeightReadings(page, cid), q.bodyWeightKg(page, cid), q.getLatestWeight(page, cid)]);
    await safe(`${k}.goalViews`, () => q.getWeightGoalViews(page, cid, today));
    for (const cad of ["daily", "weekly", "monthly"] as const) await safe(`${k}.logged.${cad}`, () => [q.getLoggedValues(tab, cid, cad, 8), q.getLoggedValues(tab, cid, cad, 730)]);
    await safe(`${k}.notes`, () => q.listCheckInNotes(tab, cid, 500));
    await safe(`${k}.series`, () => data.metric_definitions.filter((m) => m.client_id === cid).map((m) => q.getMetricSeries(tab, m.id)));
    await safe(`${k}.graphChoices`, () => q.listGraphChoices(tab, cid));
    await safe(`${k}.goals`, () => [q.getGoalSummaries(foodTab, cid, tab, tabS), q.getGoalEditorOptions(foodTab, cid, tab, tabS), q.getPlanData(foodTab, cid, tab, tabS)]);
    await safe(`${k}.askedOn`, () => {
      const f = q.dailyAskedOn(tab, cid);
      return Array.from({ length: 40 }, (_, i) => f(day(-i)));
    });
    await safe(`${k}.engagement`, () => q.getClientEngagement(foodTab, tab, tabS, cid));
    await safe(`${k}.home`, () => [q.getClientHome(cid, tabChat.coach, foodTab, tab, tabS), q.clientAttention(cid, tabChat.coach, foodTab, tab, tabS)]);
    await safe(`${k}.loadHome`, () => loaders.loadHome(cid, tabChat, foodTab, tab, tabS));
    await safe(`${k}.loadMeasurements`, () => loaders.loadMeasurements(cid, {}, tab, tabS));
    await safe(`${k}.loadPlan`, () => [loaders.loadPlan(cid, foodTab, tab, tabS), loaders.loadMeetings(cid, foodTab, tab, tabS)]);
    await safe(`${k}.dots`, () => loaders.loadDots(cid, tabChat.coach, foodTab, tab, tabS));
    await safe(`${k}.training`, () => [hb.exerciseTrends(tab, tabS, cid), hb.personalBests(tab, tabS, cid), hb.trainingBests(page, pageS, cid).bests]);
    await safe(`${k}.appLocked`, () => appLock.appLocked(cid, lockFood, lockCk, lockS));
  }
  out._errors = errors;
  fs.writeFileSync(process.env.OUT!, JSON.stringify(out));
  console.log(`[compare] ${Object.keys(out).length - 1} outputs, ${errors.length} errors, written to ${process.env.OUT}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.name : "error");
  process.exit(1);
});
