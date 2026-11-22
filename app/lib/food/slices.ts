// The food diary's coach-wide slices (21 Nov, docs/database-plan.md's food item: the bounded coach slices and the owner's
// aggregate). What a coach-wide read asks of a client (food/rows.ts FoodSpan) resolved into the days to take whole, the
// odd rows to take whole, and a row or two by id: the same answer from SQL (FOOD_STORE=pg, the shadow's side) and from
// rows in memory (FOOD_VIEWS=narrow, the shadow's committed side), so a view holds exactly what the store would hand it.
// Why a whole day is enough and what "odd" is: pg/feedSlices.ts.
//
//   feedFrom T   (the rail, the dots, Needs you, a client's marks): every food event of the client whose moment is at or
//                after T, and its newest event whenever it is (getClientHome's "quiet").
//   coachTop n   (the Feed's Activity: n = 200; Coaches' accounts: n = 1): the coach's newest n food events, ties and all.
//                n = 1 by each client's newest candidate (one probe a client and table); more by rounds (TOP_ROUNDS_DAYS).
//   since prev   (the Feed's Since): every row the readers may count as saved after the coach's last visit.
//   logged       (the locked app's sweep): the client's first entry and first calorie log of their own, by id.

import { sql, type SQL } from "drizzle-orm";
import type { CalorieLog, FoodEntry } from "../db";
import {
  dayBound,
  instantOf,
  isBlank,
  isDay,
  isoOf,
  nonHealth,
  oddCalorie,
  oddEntry,
  readerLatestOf,
  readerMiddayMs,
  readerStampMs,
  SQL_BLANK,
  SQL_DAY,
  SQL_NONHEALTH,
  SQL_ODD_CALORIE,
  SQL_ODD_ENTRY,
  SQL_STAMPED,
  STAMP_MARGIN_MS,
  CANDIDATE_LOOKAHEAD,
  TOP_ROUNDS_DAYS,
} from "../pg/feedSlices";

type Row = Record<string, unknown>;
type Q = (query: SQL) => Promise<Row[]>;

/** What coach-wide readers ask of one client. */
export type FoodAsk = { feed: number | null; top: { coach: number; n: number } | null; since: number | null; logged: boolean };
/** What it resolves to: days whole, the odd rows whole, rows by id. */
export type FoodResolved = { keys: Set<string>; odd: boolean; entryIds: Set<number>; calorieIds: Set<number> };

export type FoodCandidate = { tz: number | null; blank: string | null };
/** Where the rows are: SQL, or lists in memory. Each answer is for the clients asked alone. */
export type FoodSource = {
  candidates(clients: readonly number[]): Promise<Map<number, FoodCandidate>>;
  /** Days of entries and the client's own calorie logs stamped at or after `t` (an instant) or dated on or after `b`. */
  keysFrom(asks: readonly { c: number; t: number; b: string }[]): Promise<Map<number, Set<string>>>;
  oddRows(clients: readonly number[]): Promise<{ entries: FoodEntry[]; calories: CalorieLog[] }>;
  rowsOf(keys: ReadonlyMap<number, ReadonlySet<string>>): Promise<{ entries: FoodEntry[]; calories: CalorieLog[] }>;
  /** Days of entries and the client's own calorie logs stamped after `p`, or unstamped and dated on or after `from`. */
  sinceKeys(clients: readonly number[], p: number, from: string): Promise<Map<number, Set<string>>>;
  firstIds(clients: readonly number[]): Promise<Map<number, { entry: number | null; calorie: number | null }>>;
  /**
   * Each client's oldest instant and oldest day with no stamp, of entries and own calorie logs alike (a client with none
   * left out): a window from at or before both takes every day keysFrom can ever give, so the Feed's rounds stop reading.
   */
  oldest(clients: readonly number[]): Promise<Map<number, FoodOldest>>;
};
export type FoodOldest = { tz: number | null; blank: string | null };
/** Whether a window (stamped at or after t, unstamped on or after b) holds every day keysFrom gives these clients. */
const windowHoldsAll = (old: ReadonlyMap<number, FoodOldest>, clients: readonly number[], t: number, b: string) =>
  clients.every((c) => {
    const o = old.get(c);
    return !o || ((o.tz == null || o.tz >= t) && (o.blank == null || o.blank >= b));
  });

const add = (m: Map<number, Set<string>>, c: number, d: unknown) => {
  if (typeof d !== "string") return;
  let s = m.get(c);
  if (!s) m.set(c, (s = new Set()));
  s.add(d);
};
const byId = (a: { id: number }, b: { id: number }) => a.id - b.id;

/**
 * The food events of these clients at or after `t`, counted as activityFeeds builds them (a day with entries one event,
 * at the latest of its entries' and own calorie logs' stamps, else its midday; a calorie log on a day with no entries
 * one event of its own). Over whole days, so each counted moment is the one the feed gives it.
 */
export function countFoodEvents(entries: readonly FoodEntry[], calories: readonly CalorieLog[], clients: ReadonlySet<number>, t: number): number {
  const diary = new Map<string, { date: string; latest: string | null }>();
  for (const f of entries) {
    if (!clients.has(f.client_id)) continue;
    const key = `${f.client_id}:${f.date}`;
    const d = diary.get(key) ?? { date: f.date, latest: null };
    d.latest = readerLatestOf(d.latest, f.logged_at);
    diary.set(key, d);
  }
  let n = 0;
  for (const c of calories) {
    if (c.source === "health" || !clients.has(c.client_id)) continue;
    const d = diary.get(`${c.client_id}:${c.date}`);
    if (d) {
      d.latest = readerLatestOf(d.latest, c.logged_at);
      continue;
    }
    const at = c.logged_at ? readerStampMs(c.logged_at) : readerMiddayMs(c.date);
    if (Number.isFinite(at) && at >= t) n++;
  }
  for (const d of diary.values()) {
    const at = d.latest ? readerStampMs(d.latest) : readerMiddayMs(d.date);
    if (Number.isFinite(at) && at >= t) n++;
  }
  return n;
}

/** Each client's cut: no food event of theirs is newer than their newest, and that is at or after this. */
function cutOf(c: FoodCandidate | undefined): number {
  if (!c) return -Infinity;
  const parts: number[] = [];
  if (c.tz != null) parts.push(c.tz - STAMP_MARGIN_MS);
  if (c.blank != null) {
    const m = readerMiddayMs(c.blank);
    if (Number.isFinite(m)) parts.push(m);
  }
  return parts.length ? Math.max(...parts) : -Infinity;
}

/** What these asks resolve to, from this source, at `now` (the fetch's clock, the same on both sides of the shadow). */
export async function resolveFood(asks: ReadonlyMap<number, FoodAsk>, src: FoodSource, now: number): Promise<Map<number, FoodResolved>> {
  const out = new Map<number, FoodResolved>();
  const of = (c: number) => {
    let r = out.get(c);
    if (!r) out.set(c, (r = { keys: new Set(), odd: false, entryIds: new Set(), calorieIds: new Set() }));
    return r;
  };
  const merge = (m: ReadonlyMap<number, ReadonlySet<string>>) => {
    for (const [c, days] of m) for (const d of days) of(c).keys.add(d);
  };
  const clients = [...asks.keys()];
  // The odd rows whole wherever an event's moment is asked (they and their days are always in).
  const oddClients = clients.filter((c) => {
    const a = asks.get(c)!;
    return a.feed != null || a.top != null || a.since != null;
  });
  const odd = oddClients.length ? await src.oddRows(oddClients) : { entries: [], calories: [] };
  for (const c of oddClients) of(c).odd = true;
  for (const e of odd.entries) if (typeof e.date === "string") of(e.client_id).keys.add(e.date);
  for (const l of odd.calories) if (typeof l.date === "string") of(l.client_id).keys.add(l.date);

  // The cut each newest needs: per client (feedFrom), per coach (coachTop 1).
  const wantCut = clients.filter((c) => {
    const a = asks.get(c)!;
    return a.feed != null || (a.top != null && a.top.n <= 1);
  });
  const cand = wantCut.length ? await src.candidates(wantCut) : new Map<number, FoodCandidate>();
  const coachCut = new Map<number, number>();
  for (const c of clients) {
    const a = asks.get(c)!;
    if (a.top && a.top.n <= 1) coachCut.set(a.top.coach, Math.max(coachCut.get(a.top.coach) ?? -Infinity, cutOf(cand.get(c))));
  }
  // Each client's window: the lowest moment any of its asks needs whole.
  const from = new Map<number, number>();
  const low = (c: number, t: number) => from.set(c, Math.min(from.get(c) ?? Infinity, t));
  for (const c of clients) {
    const a = asks.get(c)!;
    if (a.feed != null) low(c, Math.min(a.feed, cutOf(cand.get(c))));
    if (a.top && a.top.n <= 1) low(c, coachCut.get(a.top.coach) ?? -Infinity);
  }
  // The Feed's rounds, coach by coach: the first window holding n of the coach's events (whole days), else everything.
  const tops = new Map<number, { n: number; clients: number[] }>();
  for (const c of clients) {
    const a = asks.get(c)!;
    if (a.top && a.top.n > 1) {
      const t = tops.get(a.top.coach) ?? { n: 0, clients: [] };
      t.n = Math.max(t.n, a.top.n);
      t.clients.push(c);
      tops.set(a.top.coach, t);
    }
  }
  for (const { n, clients: mine } of tops.values()) {
    const set = new Set(mine);
    const have = new Map<number, Set<string>>();
    const entries = new Map<number, FoodEntry>(odd.entries.filter((e) => set.has(e.client_id)).map((e) => [e.id, e] as const));
    const calories = new Map<number, CalorieLog>(odd.calories.filter((l) => set.has(l.client_id)).map((l) => [l.id, l] as const));
    // The odd rows' own days whole before any count (a calorie log counted with its day's entries unread would count as
    // an event of its own, and a round could stop early). A day that is no day is all odd rows, whole already.
    for (const e of entries.values()) add(have, e.client_id, e.date);
    for (const l of calories.values()) add(have, l.client_id, l.date);
    if (have.size) {
      const got = await src.rowsOf(have);
      for (const e of got.entries) entries.set(e.id, e);
      for (const l of got.calories) calories.set(l.id, l);
    }
    let t = -Infinity;
    // Once a round's window has reached every client's oldest row, the later rounds would read nothing more: they only
    // count again, each from its own moment (a coach with a short history no longer reads every round).
    const old = await src.oldest(mine);
    let holdsAll = false;
    for (const days of TOP_ROUNDS_DAYS) {
      const round = now - days * 86_400_000;
      if (!holdsAll) {
        const keys = await src.keysFrom(mine.map((c) => ({ c, t: round - STAMP_MARGIN_MS, b: dayBound(round) })));
        const fresh = new Map<number, Set<string>>();
        for (const [c, ds] of keys) for (const d of ds) {
          if (have.get(c)?.has(d)) continue;
          add(fresh, c, d);
          add(have, c, d);
        }
        if (fresh.size) {
          const got = await src.rowsOf(fresh);
          for (const e of got.entries) entries.set(e.id, e);
          for (const l of got.calories) calories.set(l.id, l);
        }
        holdsAll = windowHoldsAll(old, mine, round - STAMP_MARGIN_MS, dayBound(round));
      }
      if (countFoodEvents([...entries.values()].sort(byId), [...calories.values()].sort(byId), set, round) >= n) {
        t = round;
        break;
      }
    }
    for (const c of mine) low(c, t);
  }
  if (from.size) {
    merge(await src.keysFrom([...from].map(([c, t]) => ({ c, t: t - STAMP_MARGIN_MS, b: dayBound(t) }))));
  }
  const since = clients.filter((c) => asks.get(c)!.since != null);
  // One prev for a fetch (the coach's last visit): the lowest asked.
  if (since.length) {
    const p = Math.min(...since.map((c) => asks.get(c)!.since!));
    merge(await src.sinceKeys(since, p - STAMP_MARGIN_MS, dayBound(p)));
  }
  const logged = clients.filter((c) => asks.get(c)!.logged);
  if (logged.length) {
    for (const [c, ids] of await src.firstIds(logged)) {
      if (ids.entry != null) of(c).entryIds.add(ids.entry);
      if (ids.calorie != null) of(c).calorieIds.add(ids.calorie);
    }
  }
  return out;
}

// ---- In memory: the store's lists, or what the last save committed ------------------------------------------------------

/** The same answers over lists in id order (FOOD_VIEWS=narrow, the shadow's committed side). */
export function listFoodSource(allEntries: readonly FoodEntry[], allCalories: readonly CalorieLog[]): FoodSource {
  const ofClients = <T extends { client_id: number }>(list: readonly T[], clients: readonly number[]) => {
    const set = new Set(clients);
    return list.filter((r) => set.has(r.client_id));
  };
  return {
    async candidates(clients) {
      const entries = ofClients(allEntries, clients);
      const calories = ofClients(allCalories, clients).filter((l) => nonHealth(l as never));
      const oddDays = new Set<string>();
      const stampedDays = new Set<string>();
      for (const e of entries) {
        if (oddEntry(e as never)) oddDays.add(`${e.client_id}:${String(e.date)}`);
        if (!isBlank(e.logged_at)) stampedDays.add(`${e.client_id}:${String(e.date)}`);
      }
      for (const l of calories) {
        if (oddCalorie(l as never)) oddDays.add(`${l.client_id}:${String(l.date)}`);
        if (!isBlank(l.logged_at)) stampedDays.add(`${l.client_id}:${String(l.date)}`);
      }
      const ok = (r: FoodEntry | CalorieLog) => isDay(r.date) && !oddDays.has(`${r.client_id}:${r.date}`);
      const out = new Map<number, FoodCandidate>();
      for (const c of clients) {
        // As the SQL: the client's newest CANDIDATE_LOOKAHEAD stamped rows (by instant, then id), the first that is on a
        // day with no odd row; and of the rows with no stamp (by day, then id), the first on a day none of whose rows has one.
        const newest = (list: readonly (FoodEntry | CalorieLog)[]) =>
          list
            .filter((r) => r.client_id === c && instantOf(r.logged_at) != null)
            .map((r) => ({ r, tz: instantOf(r.logged_at)! }))
            .sort((a, b) => b.tz - a.tz || b.r.id - a.r.id)
            .slice(0, CANDIDATE_LOOKAHEAD)
            .find((x) => ok(x.r))?.tz ?? null;
        const blankest = (list: readonly (FoodEntry | CalorieLog)[]) =>
          list
            .filter((r) => r.client_id === c && isBlank(r.logged_at) && typeof r.date === "string")
            .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id))
            .slice(0, CANDIDATE_LOOKAHEAD)
            .find((r) => ok(r) && !stampedDays.has(`${r.client_id}:${r.date}`))?.date ?? null;
        const tzs = [newest(entries), newest(calories)].filter((v): v is number => v != null);
        const blanks = [blankest(entries), blankest(calories)].filter((v): v is string => v != null).sort();
        out.set(c, { tz: tzs.length ? Math.max(...tzs) : null, blank: blanks.length ? blanks[blanks.length - 1] : null });
      }
      return out;
    },
    async keysFrom(asks) {
      const byClient = new Map(asks.map((a) => [a.c, a] as const));
      const out = new Map<number, Set<string>>();
      const take = (r: FoodEntry | CalorieLog) => {
        const a = byClient.get(r.client_id);
        if (!a) return;
        const tz = instantOf(r.logged_at);
        if ((tz != null && tz >= a.t) || (isBlank(r.logged_at) && isDay(r.date) && r.date >= a.b)) add(out, r.client_id, r.date);
      };
      for (const e of allEntries) take(e);
      for (const l of allCalories) if (nonHealth(l as never)) take(l);
      return out;
    },
    async oddRows(clients) {
      return { entries: ofClients(allEntries, clients).filter((e) => oddEntry(e as never)), calories: ofClients(allCalories, clients).filter((l) => oddCalorie(l as never)) };
    },
    async rowsOf(keys) {
      const hit = (r: { client_id: number; date: string }) => keys.get(r.client_id)?.has(r.date) === true;
      return { entries: allEntries.filter(hit), calories: allCalories.filter(hit) };
    },
    async sinceKeys(clients, p, from) {
      const set = new Set(clients);
      const out = new Map<number, Set<string>>();
      const take = (r: FoodEntry | CalorieLog) => {
        if (!set.has(r.client_id)) return;
        const tz = instantOf(r.logged_at);
        if ((tz != null && tz > p) || (isBlank(r.logged_at) && isDay(r.date) && r.date >= from)) add(out, r.client_id, r.date);
      };
      for (const e of allEntries) take(e);
      for (const l of allCalories) if (nonHealth(l as never)) take(l);
      return out;
    },
    async firstIds(clients) {
      const out = new Map<number, { entry: number | null; calorie: number | null }>(clients.map((c) => [c, { entry: null, calorie: null }] as const));
      for (const e of allEntries) {
        const o = out.get(e.client_id);
        if (o && (o.entry == null || e.id < o.entry)) o.entry = e.id;
      }
      for (const l of allCalories) {
        const o = out.get(l.client_id);
        if (o && nonHealth(l as never) && (o.calorie == null || l.id < o.calorie)) o.calorie = l.id;
      }
      return out;
    },
    async oldest(clients) {
      const set = new Set(clients);
      const out = new Map<number, FoodOldest>();
      const take = (r: FoodEntry | CalorieLog) => {
        if (!set.has(r.client_id)) return;
        const o = out.get(r.client_id) ?? { tz: null, blank: null };
        const tz = instantOf(r.logged_at);
        if (tz != null && (o.tz == null || tz < o.tz)) o.tz = tz;
        if (isBlank(r.logged_at) && typeof r.date === "string" && (o.blank == null || r.date < o.blank)) o.blank = r.date;
        out.set(r.client_id, o);
      };
      for (const e of allEntries) take(e);
      for (const l of allCalories) if (nonHealth(l as never)) take(l);
      return out;
    },
  };
}

// ---- In Postgres -----------------------------------------------------------------------------------------------------

const ints = (ids: readonly number[]) => `{${ids.filter((n) => Number.isInteger(n)).join(",")}}`;
const CHUNK = 5000;
function* chunks<T>(list: readonly T[], size = CHUNK): Generator<T[]> {
  for (let i = 0; i < list.length; i += size) yield list.slice(i, i + size);
}
const raw = (s: string) => sql.raw(s);
const msOf = (v: unknown) => (v == null ? null : Number(v));

/**
 * The same answers in SQL, each on its index (migration 0024): the candidates one probe a client and table, the windows
 * a range a client, the odd rows on their partial indexes, the days whole by (client_id, date).
 */
export function sqlFoodSource(q: Q, decode: { entry: (r: Row) => FoodEntry; calorie: (r: Row) => CalorieLog }): FoodSource {
  // Every table read under its alias, so a predicate is its index's own (pg/feedSlices.ts).
  const noOdd = (a: string) =>
    raw(`NOT EXISTS (SELECT 1 FROM food_entries o WHERE o.client_id = ${a}.client_id AND o.date = ${a}.date AND ${SQL_ODD_ENTRY("o.")})
      AND NOT EXISTS (SELECT 1 FROM calorie_logs o WHERE o.client_id = ${a}.client_id AND o.date = ${a}.date AND ${SQL_ODD_CALORIE("o.")})`);
  const noStamp = (a: string) =>
    raw(`NOT EXISTS (SELECT 1 FROM food_entries s WHERE s.client_id = ${a}.client_id AND s.date = ${a}.date AND ${SQL_STAMPED("logged_at", "s.")})
      AND NOT EXISTS (SELECT 1 FROM calorie_logs s WHERE s.client_id = ${a}.client_id AND s.date = ${a}.date AND ${SQL_NONHEALTH("s.")} AND ${SQL_STAMPED("logged_at", "s.")})`);
  const day = (a: string) => raw(SQL_DAY(`${a}.date`));
  const own = (a: string) => raw(SQL_NONHEALTH(`${a}.`));
  const blank = (a: string) => raw(SQL_BLANK("logged_at", `${a}.`));
  return {
    async candidates(clients) {
      const out = new Map<number, FoodCandidate>();
      const N = CANDIDATE_LOOKAHEAD;
      for (const part of chunks(clients)) {
        // The client's newest N stamped rows (instant, then id: the index's own order), the first on a day with no odd row;
        // and of its rows with no stamp (day, then id), the first on a day none of whose rows has a stamp. None in N: none,
        // and the cut only lower (never wrong). Entries and the client's own calorie logs alike.
        const rows = await q(sql`SELECT k.c,
            (SELECT EXTRACT(EPOCH FROM x.logged_at_tz) * 1000 FROM (SELECT e.client_id, e.date, e.logged_at_tz, e.id FROM food_entries e WHERE e.client_id = k.c AND e.logged_at_tz IS NOT NULL ORDER BY e.logged_at_tz DESC, e.id DESC LIMIT ${N}) x
               WHERE ${day("x")} AND ${noOdd("x")} ORDER BY x.logged_at_tz DESC, x.id DESC LIMIT 1) AS etz,
            (SELECT EXTRACT(EPOCH FROM x.logged_at_tz) * 1000 FROM (SELECT l.client_id, l.date, l.logged_at_tz, l.id FROM calorie_logs l WHERE l.client_id = k.c AND l.logged_at_tz IS NOT NULL AND ${own("l")} ORDER BY l.logged_at_tz DESC, l.id DESC LIMIT ${N}) x
               WHERE ${day("x")} AND ${noOdd("x")} ORDER BY x.logged_at_tz DESC, x.id DESC LIMIT 1) AS ltz,
            (SELECT x.date FROM (SELECT e.client_id, e.date, e.id FROM food_entries e WHERE e.client_id = k.c AND ${blank("e")} AND e.date IS NOT NULL ORDER BY (e.date COLLATE "C") DESC, e.id DESC LIMIT ${N}) x
               WHERE ${day("x")} AND ${noOdd("x")} AND ${noStamp("x")} ORDER BY (x.date COLLATE "C") DESC, x.id DESC LIMIT 1) AS eblank,
            (SELECT x.date FROM (SELECT l.client_id, l.date, l.id FROM calorie_logs l WHERE l.client_id = k.c AND ${own("l")} AND ${blank("l")} AND l.date IS NOT NULL ORDER BY (l.date COLLATE "C") DESC, l.id DESC LIMIT ${N}) x
               WHERE ${day("x")} AND ${noOdd("x")} AND ${noStamp("x")} ORDER BY (x.date COLLATE "C") DESC, x.id DESC LIMIT 1) AS lblank
          FROM unnest(${ints(part)}::int[]) AS k(c)`);
        for (const r of rows) {
          const tzs = [msOf(r.etz), msOf(r.ltz)].filter((v): v is number => v != null && Number.isFinite(v)).map((v) => Math.round(v));
          const blanks = [r.eblank, r.lblank].filter((v): v is string => typeof v === "string").sort();
          out.set(Number(r.c), { tz: tzs.length ? Math.max(...tzs) : null, blank: blanks.length ? blanks[blanks.length - 1] : null });
        }
      }
      return out;
    },
    async keysFrom(asks) {
      const out = new Map<number, Set<string>>();
      for (const part of chunks(asks)) {
        const json = JSON.stringify(part.map((a) => ({ c: a.c, t: isoOf(a.t), b: a.b })));
        // Stamped at or after t (the instant's index), or with no stamp and dated on or after b (the unstamped rows' index).
        const rows = await q(sql`SELECT DISTINCT x.c, x.d FROM jsonb_to_recordset(${json}::jsonb) AS k(c int, t timestamptz, b text) CROSS JOIN LATERAL (
            SELECT e.client_id AS c, e.date AS d FROM food_entries e WHERE e.client_id = k.c AND e.logged_at_tz IS NOT NULL AND e.logged_at_tz >= k.t AND e.date IS NOT NULL
            UNION ALL SELECT e.client_id, e.date FROM food_entries e WHERE e.client_id = k.c AND ${blank("e")} AND (e.date COLLATE "C") >= k.b AND ${day("e")}
            UNION ALL SELECT l.client_id, l.date FROM calorie_logs l WHERE l.client_id = k.c AND l.logged_at_tz IS NOT NULL AND l.logged_at_tz >= k.t AND ${own("l")} AND l.date IS NOT NULL
            UNION ALL SELECT l.client_id, l.date FROM calorie_logs l WHERE l.client_id = k.c AND ${own("l")} AND ${blank("l")} AND (l.date COLLATE "C") >= k.b AND ${day("l")}
          ) x`);
        for (const r of rows) add(out, Number(r.c), r.d);
      }
      return out;
    },
    async oddRows(clients) {
      const entries: FoodEntry[] = [];
      const calories: CalorieLog[] = [];
      for (const part of chunks(clients)) {
        for (const r of await q(sql`SELECT * FROM food_entries WHERE client_id = ANY(${ints(part)}::int[]) AND ${raw(SQL_ODD_ENTRY())}`)) entries.push(decode.entry(r));
        for (const r of await q(sql`SELECT * FROM calorie_logs WHERE client_id = ANY(${ints(part)}::int[]) AND ${raw(SQL_ODD_CALORIE())}`)) calories.push(decode.calorie(r));
      }
      return { entries: entries.sort(byId), calories: calories.sort(byId) };
    },
    async rowsOf(keys) {
      const list = [...keys].flatMap(([c, ds]) => [...ds].map((d) => ({ c, d })));
      const entries: FoodEntry[] = [];
      const calories: CalorieLog[] = [];
      for (const part of chunks(list)) {
        const json = JSON.stringify(part);
        for (const r of await q(sql`SELECT t.* FROM jsonb_to_recordset(${json}::jsonb) AS k(c int, d text) CROSS JOIN LATERAL (SELECT t.* FROM food_entries t WHERE t.client_id = k.c AND t.date = k.d) t`)) entries.push(decode.entry(r));
        for (const r of await q(sql`SELECT t.* FROM jsonb_to_recordset(${json}::jsonb) AS k(c int, d text) CROSS JOIN LATERAL (SELECT t.* FROM calorie_logs t WHERE t.client_id = k.c AND t.date = k.d) t`)) calories.push(decode.calorie(r));
      }
      return { entries: entries.sort(byId), calories: calories.sort(byId) };
    },
    async sinceKeys(clients, p, from) {
      const out = new Map<number, Set<string>>();
      const pIso = isoOf(p);
      for (const part of chunks(clients)) {
        const rows = await q(sql`SELECT DISTINCT x.c, x.d FROM unnest(${ints(part)}::int[]) AS k(c) CROSS JOIN LATERAL (
            SELECT e.client_id AS c, e.date AS d FROM food_entries e WHERE e.client_id = k.c AND e.logged_at_tz IS NOT NULL AND e.logged_at_tz > ${pIso}::timestamptz AND e.date IS NOT NULL
            UNION ALL SELECT e.client_id, e.date FROM food_entries e WHERE e.client_id = k.c AND ${blank("e")} AND (e.date COLLATE "C") >= ${from}::text AND ${day("e")}
            UNION ALL SELECT l.client_id, l.date FROM calorie_logs l WHERE l.client_id = k.c AND l.logged_at_tz IS NOT NULL AND l.logged_at_tz > ${pIso}::timestamptz AND ${own("l")} AND l.date IS NOT NULL
            UNION ALL SELECT l.client_id, l.date FROM calorie_logs l WHERE l.client_id = k.c AND ${own("l")} AND ${blank("l")} AND (l.date COLLATE "C") >= ${from}::text AND ${day("l")}
          ) x`);
        for (const r of rows) add(out, Number(r.c), r.d);
      }
      return out;
    },
    async firstIds(clients) {
      const out = new Map<number, { entry: number | null; calorie: number | null }>();
      for (const part of chunks(clients)) {
        const rows = await q(sql`SELECT k.c,
            (SELECT min(e.id) FROM food_entries e WHERE e.client_id = k.c) AS e,
            (SELECT l.id FROM calorie_logs l WHERE l.client_id = k.c AND ${own("l")} ORDER BY l.id LIMIT 1) AS l
          FROM unnest(${ints(part)}::int[]) AS k(c)`);
        for (const r of rows) out.set(Number(r.c), { entry: r.e == null ? null : Number(r.e), calorie: r.l == null ? null : Number(r.l) });
      }
      return out;
    },
    async oldest(clients) {
      const out = new Map<number, FoodOldest>();
      for (const part of chunks(clients)) {
        // The first row of each index in its own order (instant, else day, then id): one step down each.
        const rows = await q(sql`SELECT k.c,
            EXTRACT(EPOCH FROM (SELECT e.logged_at_tz FROM food_entries e WHERE e.client_id = k.c AND e.logged_at_tz IS NOT NULL ORDER BY e.logged_at_tz, e.id LIMIT 1)) * 1000 AS etz,
            EXTRACT(EPOCH FROM (SELECT l.logged_at_tz FROM calorie_logs l WHERE l.client_id = k.c AND l.logged_at_tz IS NOT NULL AND ${own("l")} ORDER BY l.logged_at_tz, l.id LIMIT 1)) * 1000 AS ltz,
            (SELECT e.date FROM food_entries e WHERE e.client_id = k.c AND ${blank("e")} AND e.date IS NOT NULL ORDER BY (e.date COLLATE "C"), e.id LIMIT 1) AS eblank,
            (SELECT l.date FROM calorie_logs l WHERE l.client_id = k.c AND ${own("l")} AND ${blank("l")} AND l.date IS NOT NULL ORDER BY (l.date COLLATE "C"), l.id LIMIT 1) AS lblank
          FROM unnest(${ints(part)}::int[]) AS k(c)`);
        for (const r of rows) {
          // No rounding: an instant a microsecond before a window's start must read as before it.
          const tzs = [r.etz, r.ltz].filter((v) => v != null).map(Number);
          const blanks = [r.eblank, r.lblank].filter((v): v is string => typeof v === "string");
          if (!tzs.length && !blanks.length) continue;
          out.set(Number(r.c), {
            tz: tzs.length ? Math.min(...tzs) : null,
            // The lower in "C" order (byte order; for a day against a day, as JS compares).
            blank: blanks.length ? blanks.reduce((a, b) => (Buffer.compare(Buffer.from(a), Buffer.from(b)) <= 0 ? a : b)) : null,
          });
        }
      }
      return out;
    },
  };
}
