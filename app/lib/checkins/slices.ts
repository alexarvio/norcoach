// The check-in figures' coach-wide slices (21 Nov, docs/database-plan.md's check-in item: the bounded coach slices and
// the owner's aggregate). What a coach-wide read asks of a client (checkins/rows.ts CheckInSpan) resolved into the
// periods to take whole (every figure of the client's metrics in the period, and every note of the client's in it) and
// the odd rows to take whole: the same answer from SQL (CHECKINS_STORE=pg, the shadow's side) and from rows in memory
// (CHECKINS_VIEWS=narrow, the shadow's committed side). A check-in event is a client's typed figures of one frequency in
// a period with its note (activityFeeds, queries.ts); why a whole period is enough and what "odd" is: pg/feedSlices.ts.
// The measurements' values stay in memory (question 3 of the item): their dates are periods too, so a measurement's note
// is taken with them.
//
//   feedFrom T          every check-in of the client whose moment is at or after T, and their newest.
//   coachTop n figures  the coach's newest n check-ins with a figure in (the Feed's Lifestyle), by rounds.
//   coachTop n notes    the coach's newest n notes with no figure (the Feed's Messages), by rounds on the notes alone.
//   coachTop 1 all      the coach's newest check-in of any kind (Coaches' accounts), by each client's candidates.
//   since prev          every figure the Feed's Since may count as sent after the coach's last visit.

import { sql, type SQL } from "drizzle-orm";
import type { CheckInEntry, CheckInNote } from "../db";
import {
  dayBound,
  instantOf,
  isBlank,
  isDay,
  isoOf,
  oddFigure,
  oddNote,
  readerLatestOf,
  readerMiddayMs,
  readerStampMs,
  SQL_BLANK,
  SQL_DAY,
  SQL_ODD_FIGURE,
  SQL_ODD_NOTE,
  SQL_STAMPED,
  SQL_TYPED,
  STAMP_MARGIN_MS,
  CANDIDATE_LOOKAHEAD,
  TOP_ROUNDS_DAYS,
  typedFigure,
} from "../pg/feedSlices";

type Row = Record<string, unknown>;
type Q = (query: SQL) => Promise<Row[]>;

export type CheckInTop = { coach: number; figures: number; notes: number; any: number };
/** What coach-wide readers ask of one client. */
export type CheckInAsk = { feed: number | null; top: CheckInTop | null; since: number | null };
/** What it resolves to: periods whole, the odd rows whole. */
export type CheckInResolved = { keys: Set<string>; odd: boolean };
/** The metrics as memory held them at the fetch: each client's ids, each id's client and frequency. */
export type DefsAtFetch = { ofClient: ReadonlyMap<number, readonly number[]>; info: ReadonlyMap<number, { client: number; frequency: string }> };
/** The measurements' values (memory) of the scope's clients at the fetch: each value's date and stamp, by client. */
export type MeasuresAtFetch = ReadonlyMap<number, readonly { date: unknown; logged_at: unknown }[]>;

export type CheckInCandidate = { figure: number | null; note: { tz: number; period: string } | null; blank: string | null };
export type CheckInSource = {
  candidates(clients: readonly number[], defs: DefsAtFetch): Promise<Map<number, CheckInCandidate>>;
  /** Periods of the client's typed figures and notes stamped at or after `t` or in a period on or after `b`. */
  keysFrom(asks: readonly { c: number; t: number; b: string }[], defs: DefsAtFetch, notesOnly: boolean): Promise<Map<number, Set<string>>>;
  oddRows(clients: readonly number[], defs: DefsAtFetch): Promise<{ entries: CheckInEntry[]; notes: CheckInNote[] }>;
  rowsOf(keys: ReadonlyMap<number, ReadonlySet<string>>, defs: DefsAtFetch): Promise<{ entries: CheckInEntry[]; notes: CheckInNote[] }>;
  /** Periods of the client's typed figures stamped after `p`, or unstamped in a period on or after `from`. */
  sinceKeys(clients: readonly number[], defs: DefsAtFetch, p: number, from: string): Promise<Map<number, Set<string>>>;
  /**
   * Each client's oldest instant and oldest period with no stamp, of its typed figures and of its notes (a client with
   * neither left out): a window from at or before them takes every period keysFrom can ever give, so the rounds stop.
   */
  oldest(clients: readonly number[], defs: DefsAtFetch): Promise<Map<number, CheckInOldest>>;
};
type Oldest = { tz: number | null; blank: string | null };
export type CheckInOldest = { figures: Oldest; notes: Oldest };
const noOldest = (): CheckInOldest => ({ figures: { tz: null, blank: null }, notes: { tz: null, blank: null } });
/** Whether a window (stamped at or after t, unstamped on or after b) holds every period of this kind keysFrom gives. */
const windowHoldsAll = (old: ReadonlyMap<number, CheckInOldest>, clients: readonly number[], kind: "figures" | "notes", t: number, b: string) =>
  clients.every((c) => {
    const o = old.get(c)?.[kind];
    return !o || ((o.tz == null || o.tz >= t) && (o.blank == null || o.blank >= b));
  });

const add = (m: Map<number, Set<string>>, c: number, p: unknown) => {
  if (typeof p !== "string") return;
  let s = m.get(c);
  if (!s) m.set(c, (s = new Set()));
  s.add(p);
};
const byId = (a: { id: number }, b: { id: number }) => a.id - b.id;
const KINDS = new Set(["daily", "weekly", "monthly"]);

/**
 * These clients' daily, weekly and monthly check-ins at or after `t`, as activityFeeds builds them (the typed figures of
 * a frequency in a period, at the latest of their stamps and the note's, else its midday): those with a figure in, and
 * those that are a note alone. The measurements' check-ins are left out (a count of fewer is never wrong for a round).
 */
export function countCheckInEvents(entries: readonly CheckInEntry[], notes: readonly CheckInNote[], defs: DefsAtFetch, clients: ReadonlySet<number>, t: number): { figures: number; notes: number } {
  const groups = new Map<string, { period: string; kind: string; count: number; latest: string | null }>();
  const group = (c: number, kind: string, period: string) => {
    const key = `${c}:${kind}:${period}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { period, kind, count: 0, latest: null }));
    return g;
  };
  for (const e of entries) {
    const def = defs.info.get(e.metric_definition_id);
    if (!def || e.value == null || e.source === "health" || !clients.has(def.client)) continue;
    const g = group(def.client, def.frequency, e.period);
    g.count++;
    g.latest = readerLatestOf(g.latest, e.logged_at);
  }
  for (const n of notes) {
    if (!clients.has(n.client_id)) continue;
    const g = group(n.client_id, n.kind, n.period);
    g.latest = readerLatestOf(g.latest, n.created_at);
  }
  let figures = 0;
  let alone = 0;
  for (const g of groups.values()) {
    if (!KINDS.has(g.kind)) continue;
    const at = g.latest ? readerStampMs(g.latest) : readerMiddayMs(g.period);
    if (!Number.isFinite(at) || at < t) continue;
    if (g.count > 0) figures++;
    else alone++;
  }
  return { figures, notes: alone };
}

/** Each client's cut: no check-in of theirs is newer than their newest, and that is at or after this. */
function cutOf(c: CheckInCandidate | undefined, measureOdd: ReadonlySet<string>): number {
  if (!c) return -Infinity;
  const parts: number[] = [];
  if (c.figure != null) parts.push(c.figure - STAMP_MARGIN_MS);
  // A note on a day whose measurements carry an odd stamp may be no event at all (its group's moment unreadable).
  if (c.note && !measureOdd.has(c.note.period)) parts.push(c.note.tz - STAMP_MARGIN_MS);
  if (c.blank != null) {
    const m = readerMiddayMs(c.blank);
    if (Number.isFinite(m)) parts.push(m);
  }
  return parts.length ? Math.max(...parts) : -Infinity;
}

const oddStampOf = (s: unknown) => (s != null && typeof s !== "string") || (typeof s === "string" && s !== "" && oddNote({ period: "2000-01-01", created_at: s }));

/** What these asks resolve to, from this source, at `now` (the fetch's clock, the same on both sides of the shadow). */
export async function resolveCheckIns(asks: ReadonlyMap<number, CheckInAsk>, src: CheckInSource, defs: DefsAtFetch, measures: MeasuresAtFetch, now: number): Promise<Map<number, CheckInResolved>> {
  const out = new Map<number, CheckInResolved>();
  const of = (c: number) => {
    let r = out.get(c);
    if (!r) out.set(c, (r = { keys: new Set(), odd: false }));
    return r;
  };
  const merge = (m: ReadonlyMap<number, ReadonlySet<string>>) => {
    for (const [c, ps] of m) for (const p of ps) of(c).keys.add(p);
  };
  const clients = [...asks.keys()];
  const oddMeasure = new Map<number, Set<string>>();
  for (const c of clients) for (const v of measures.get(c) ?? []) if (oddStampOf(v.logged_at) || !isDay(v.date)) add(oddMeasure, c, v.date);
  // The odd rows whole, with their periods; a measurement with an odd stamp or day has its day whole too.
  const odd = await src.oddRows(clients, defs);
  for (const c of clients) of(c).odd = true;
  for (const e of odd.entries) {
    const c = defs.info.get(e.metric_definition_id)?.client;
    if (c != null && typeof e.period === "string") of(c).keys.add(e.period);
  }
  for (const n of odd.notes) if (typeof n.period === "string") of(n.client_id).keys.add(n.period);
  for (const [c, ps] of oddMeasure) for (const p of ps) of(c).keys.add(p);
  // A measurement's day is a period when its values fall in a window (their stamps, else their day).
  const measureKeys = (c: number, t: number, b: string) => {
    for (const v of measures.get(c) ?? []) {
      const tz = instantOf(v.logged_at);
      if ((tz != null && tz >= t) || (isDay(v.date) && v.date >= b)) of(c).keys.add(v.date as string);
    }
  };

  const wantCut = clients.filter((c) => {
    const a = asks.get(c)!;
    return a.feed != null || (a.top != null && a.top.any > 0);
  });
  const cand = wantCut.length ? await src.candidates(wantCut, defs) : new Map<number, CheckInCandidate>();
  const cut = (c: number) => cutOf(cand.get(c), oddMeasure.get(c) ?? new Set());
  const coachCut = new Map<number, number>();
  for (const c of clients) {
    const a = asks.get(c)!;
    if (a.top && a.top.any > 0) coachCut.set(a.top.coach, Math.max(coachCut.get(a.top.coach) ?? -Infinity, cut(c)));
  }
  const from = new Map<number, number>();
  const low = (c: number, t: number) => from.set(c, Math.min(from.get(c) ?? Infinity, t));
  for (const c of clients) {
    const a = asks.get(c)!;
    if (a.feed != null) low(c, Math.min(a.feed, cut(c)));
    if (a.top && a.top.any > 0) low(c, coachCut.get(a.top.coach) ?? -Infinity);
  }
  // The Feed's rounds, coach by coach: the check-ins with a figure on the whole window; the notes alone on theirs.
  const tops = new Map<number, { figures: number; notes: number; clients: number[] }>();
  for (const c of clients) {
    const a = asks.get(c)!;
    if (!a.top || (a.top.figures <= 0 && a.top.notes <= 0)) continue;
    const t = tops.get(a.top.coach) ?? { figures: 0, notes: 0, clients: [] };
    t.figures = Math.max(t.figures, a.top.figures);
    t.notes = Math.max(t.notes, a.top.notes);
    t.clients.push(c);
    tops.set(a.top.coach, t);
  }
  const noteFrom = new Map<number, number>();
  for (const top of tops.values()) {
    const set = new Set(top.clients);
    let old: Map<number, CheckInOldest> | undefined;
    for (const kind of ["figures", "notes"] as const) {
      const n = top[kind];
      if (n <= 0) continue;
      const have = new Map<number, Set<string>>();
      const entries = new Map<number, CheckInEntry>();
      const notes = new Map<number, CheckInNote>();
      for (const e of odd.entries) if (set.has(defs.info.get(e.metric_definition_id)?.client ?? -1)) entries.set(e.id, e);
      for (const x of odd.notes) if (set.has(x.client_id)) notes.set(x.id, x);
      // The odd rows' own periods whole before any count (a note counted with its period's figures unread would count as
      // a note alone, and a round could stop early). A period that is no day is all odd rows, whole already.
      for (const e of entries.values()) add(have, defs.info.get(e.metric_definition_id)!.client, e.period);
      for (const x of notes.values()) add(have, x.client_id, x.period);
      if (have.size) {
        const got = await src.rowsOf(have, defs);
        for (const e of got.entries) entries.set(e.id, e);
        for (const x of got.notes) notes.set(x.id, x);
      }
      let t = -Infinity;
      // Once a round's window has reached every client's oldest row of the kind (a check-in with a figure has a typed
      // figure, a note alone a note), the later rounds would read nothing that counts: they only count again.
      old ??= await src.oldest(top.clients, defs);
      let holdsAll = false;
      for (const days of TOP_ROUNDS_DAYS) {
        const round = now - days * 86_400_000;
        if (!holdsAll) {
          const keys = await src.keysFrom(top.clients.map((c) => ({ c, t: round - STAMP_MARGIN_MS, b: dayBound(round) })), defs, kind === "notes");
          const fresh = new Map<number, Set<string>>();
          for (const [c, ps] of keys) for (const p of ps) {
            if (have.get(c)?.has(p)) continue;
            add(fresh, c, p);
            add(have, c, p);
          }
          if (fresh.size) {
            const got = await src.rowsOf(fresh, defs);
            for (const e of got.entries) entries.set(e.id, e);
            for (const x of got.notes) notes.set(x.id, x);
          }
          holdsAll = windowHoldsAll(old, top.clients, kind, round - STAMP_MARGIN_MS, dayBound(round));
        }
        if (countCheckInEvents([...entries.values()].sort(byId), [...notes.values()].sort(byId), defs, set, round)[kind] >= n) {
          t = round;
          break;
        }
      }
      for (const c of top.clients) {
        if (kind === "figures") low(c, t);
        else noteFrom.set(c, Math.min(noteFrom.get(c) ?? Infinity, t));
      }
    }
  }
  if (from.size) {
    const list = [...from].map(([c, t]) => ({ c, t: t - STAMP_MARGIN_MS, b: dayBound(t) }));
    merge(await src.keysFrom(list, defs, false));
    for (const a of list) measureKeys(a.c, a.t, a.b);
  }
  if (noteFrom.size) merge(await src.keysFrom([...noteFrom].map(([c, t]) => ({ c, t: t - STAMP_MARGIN_MS, b: dayBound(t) })), defs, true));
  const since = clients.filter((c) => asks.get(c)!.since != null);
  if (since.length) {
    const p = Math.min(...since.map((c) => asks.get(c)!.since!));
    merge(await src.sinceKeys(since, defs, p - STAMP_MARGIN_MS, dayBound(p)));
  }
  return out;
}

// ---- In memory: the store's lists, or what the last save committed ------------------------------------------------------

/** The same answers over lists in id order (CHECKINS_VIEWS=narrow, the shadow's committed side). */
export function listCheckInSource(allEntries: readonly CheckInEntry[], allNotes: readonly CheckInNote[]): CheckInSource {
  /** A client's live figures: their metrics' as memory held them at the fetch. */
  const figuresOf = (clients: readonly number[], defs: DefsAtFetch) => {
    const set = new Set(clients);
    return allEntries.filter((e) => set.has(defs.info.get(e.metric_definition_id)?.client ?? -1));
  };
  const notesOf = (clients: readonly number[]) => {
    const set = new Set(clients);
    return allNotes.filter((n) => set.has(n.client_id));
  };
  const clientOf = (e: CheckInEntry, defs: DefsAtFetch) => defs.info.get(e.metric_definition_id)!.client;
  return {
    async candidates(clients, defs) {
      const figures = figuresOf(clients, defs);
      const notes = notesOf(clients);
      const oddAt = new Set<string>();
      const stampedAt = new Set<string>();
      const noteAt = new Set<string>();
      for (const e of figures) {
        const k = `${clientOf(e, defs)}:${String(e.period)}`;
        if (oddFigure(e as never)) oddAt.add(k);
        if (typedFigure(e as never) && !isBlank(e.logged_at)) stampedAt.add(k);
      }
      for (const n of notes) {
        const k = `${n.client_id}:${String(n.period)}`;
        if (oddNote(n as never)) oddAt.add(k);
        noteAt.add(k);
      }
      const N = CANDIDATE_LOOKAHEAD;
      const out = new Map<number, CheckInCandidate>();
      for (const c of clients) {
        const ok = (p: unknown) => isDay(p) && !oddAt.has(`${c}:${p}`);
        // As the SQL: the client's newest N typed stamped figures and N stamped notes (instant, then id), the first in a
        // period with no odd row; of its typed figures with no stamp (period, then id), the first in a period with no
        // stamp and no note.
        const mine = figures.filter((e) => clientOf(e, defs) === c && typedFigure(e as never));
        const figure = mine
          .filter((e) => instantOf(e.logged_at) != null && typeof e.value === "number")
          .map((e) => ({ e, tz: instantOf(e.logged_at)! }))
          .sort((a, b) => b.tz - a.tz || b.e.id - a.e.id)
          .slice(0, N)
          .find((x) => ok(x.e.period));
        const note = notes
          .filter((n) => n.client_id === c && instantOf(n.created_at) != null)
          .map((n) => ({ n, tz: instantOf(n.created_at)! }))
          .sort((a, b) => b.tz - a.tz || b.n.id - a.n.id)
          .slice(0, N)
          .find((x) => ok(x.n.period));
        const blank = mine
          .filter((e) => isBlank(e.logged_at) && typeof e.value === "number" && typeof e.period === "string")
          .sort((a, b) => (a.period < b.period ? 1 : a.period > b.period ? -1 : b.id - a.id))
          .slice(0, N)
          .find((e) => ok(e.period) && !stampedAt.has(`${c}:${e.period}`) && !noteAt.has(`${c}:${e.period}`));
        out.set(c, { figure: figure?.tz ?? null, note: note ? { tz: note.tz, period: note.n.period } : null, blank: blank?.period ?? null });
      }
      return out;
    },
    async keysFrom(asks, defs, notesOnly) {
      const byClient = new Map(asks.map((a) => [a.c, a] as const));
      const out = new Map<number, Set<string>>();
      const hit = (c: number, stamp: unknown, period: unknown) => {
        const a = byClient.get(c);
        if (!a) return;
        const tz = instantOf(stamp);
        if ((tz != null && tz >= a.t) || (isBlank(stamp) && isDay(period) && period >= a.b)) add(out, c, period);
      };
      if (!notesOnly) for (const e of figuresOf([...byClient.keys()], defs)) if (typedFigure(e as never)) hit(clientOf(e, defs), e.logged_at, e.period);
      for (const n of notesOf([...byClient.keys()])) hit(n.client_id, n.created_at, n.period);
      return out;
    },
    async oddRows(clients, defs) {
      return { entries: figuresOf(clients, defs).filter((e) => oddFigure(e as never)), notes: notesOf(clients).filter((n) => oddNote(n as never)) };
    },
    async rowsOf(keys, defs) {
      return {
        entries: allEntries.filter((e) => {
          const c = defs.info.get(e.metric_definition_id)?.client;
          return c != null && keys.get(c)?.has(e.period) === true;
        }),
        notes: allNotes.filter((n) => keys.get(n.client_id)?.has(n.period) === true),
      };
    },
    async sinceKeys(clients, defs, p, from) {
      const out = new Map<number, Set<string>>();
      for (const e of figuresOf(clients, defs)) {
        if (!typedFigure(e as never)) continue;
        const tz = instantOf(e.logged_at);
        if ((tz != null && tz > p) || (isBlank(e.logged_at) && isDay(e.period) && e.period >= from)) add(out, clientOf(e, defs), e.period);
      }
      return out;
    },
    async oldest(clients, defs) {
      const out = new Map<number, CheckInOldest>();
      const take = (o: Oldest, stamp: unknown, period: unknown) => {
        const tz = instantOf(stamp);
        if (tz != null && (o.tz == null || tz < o.tz)) o.tz = tz;
        if (isBlank(stamp) && typeof period === "string" && (o.blank == null || period < o.blank)) o.blank = period;
      };
      const of = (c: number) => {
        let o = out.get(c);
        if (!o) out.set(c, (o = noOldest()));
        return o;
      };
      for (const e of figuresOf(clients, defs)) if (typedFigure(e as never)) take(of(clientOf(e, defs)).figures, e.logged_at, e.period);
      for (const n of notesOf(clients)) take(of(n.client_id).notes, n.created_at, n.period);
      return out;
    },
  };
}

// ---- In Postgres -----------------------------------------------------------------------------------------------------

const ints = (ids: Iterable<number>) => `{${[...ids].filter((n) => Number.isInteger(n)).join(",")}}`;
const CHUNK = 2000;
function* chunks<T>(list: readonly T[], size = CHUNK): Generator<T[]> {
  for (let i = 0; i < list.length; i += size) yield list.slice(i, i + size);
}
const raw = (s: string) => sql.raw(s);
const msOf = (v: unknown) => (v == null ? null : Math.round(Number(v)));

/**
 * The same answers in SQL, each on its index (migration 0024): a client's figures by def_client_id (its metrics as memory
 * holds them, never a join to them), its notes by client_id; the candidates one probe a client and table.
 */
export function sqlCheckInSource(q: Q, decode: { entry: (r: Row) => CheckInEntry; note: (r: Row) => CheckInNote }): CheckInSource {
  const day = (a: string) => raw(SQL_DAY(`${a}.period`));
  const typed = (a: string) => raw(SQL_TYPED(`${a}.`));
  // No odd figure or note of the client in the period (the group's moment could read otherwise).
  const noOdd = (c: string, p: string) =>
    raw(`NOT EXISTS (SELECT 1 FROM metric_entries o WHERE o.def_client_id = ${c} AND (o.period COLLATE "C") = ${p} AND ${SQL_ODD_FIGURE("o.")})
      AND NOT EXISTS (SELECT 1 FROM check_in_notes o WHERE o.client_id = ${c} AND (o.period COLLATE "C") = ${p} AND ${SQL_ODD_NOTE("o.")})`);
  // One of the client's metrics at the fetch (k.d, their ids as a JSON list): a filter, never an index of its own.
  const mine = (a: string) => raw(`(k.d @> to_jsonb(${a}.metric_definition_id))`);
  const clientDefs = (part: readonly number[], defs: DefsAtFetch) => JSON.stringify(part.map((c) => ({ c, d: defs.ofClient.get(c) ?? [] })));
  return {
    async candidates(clients, defs) {
      const out = new Map<number, CheckInCandidate>();
      const N = CANDIDATE_LOOKAHEAD;
      for (const part of chunks(clients)) {
        // The client's newest N typed stamped figures of its metrics (instant, then id: the index's own order; a metric a
        // filter, so the walk stays on the index) and newest N stamped notes, the first in a period with no odd row; of its
        // typed figures with no stamp (period, then id), the first in a period with no stamp and no note. None in N: none,
        // and the cut only lower (never wrong).
        const rows = await q(sql`SELECT k.c,
            (SELECT EXTRACT(EPOCH FROM x.logged_at_tz) * 1000 FROM (SELECT e.period, e.logged_at_tz, e.id FROM metric_entries e WHERE e.def_client_id = k.c AND e.logged_at_tz IS NOT NULL AND ${typed("e")} AND ${mine("e")}
                 ORDER BY e.logged_at_tz DESC, e.id DESC LIMIT ${N}) x
               WHERE ${day("x")} AND ${noOdd("k.c", '(x.period COLLATE "C")')} ORDER BY x.logged_at_tz DESC, x.id DESC LIMIT 1) AS ftz,
            (SELECT EXTRACT(EPOCH FROM x.created_at_tz) * 1000 FROM (SELECT n.period, n.created_at_tz, n.id FROM check_in_notes n WHERE n.client_id = k.c AND n.created_at_tz IS NOT NULL ORDER BY n.created_at_tz DESC, n.id DESC LIMIT ${N}) x
               WHERE ${day("x")} AND ${noOdd("k.c", '(x.period COLLATE "C")')} ORDER BY x.created_at_tz DESC, x.id DESC LIMIT 1) AS ntz,
            (SELECT x.period FROM (SELECT n.period, n.created_at_tz, n.id FROM check_in_notes n WHERE n.client_id = k.c AND n.created_at_tz IS NOT NULL ORDER BY n.created_at_tz DESC, n.id DESC LIMIT ${N}) x
               WHERE ${day("x")} AND ${noOdd("k.c", '(x.period COLLATE "C")')} ORDER BY x.created_at_tz DESC, x.id DESC LIMIT 1) AS nperiod,
            (SELECT x.period FROM (SELECT e.period, e.id FROM metric_entries e WHERE e.def_client_id = k.c AND ${typed("e")} AND ${raw(SQL_BLANK("logged_at", "e."))} AND e.period IS NOT NULL AND ${mine("e")}
                 ORDER BY (e.period COLLATE "C") DESC, e.id DESC LIMIT ${N}) x
               WHERE ${day("x")} AND ${noOdd("k.c", '(x.period COLLATE "C")')}
                 AND NOT EXISTS (SELECT 1 FROM metric_entries s WHERE s.def_client_id = k.c AND (s.period COLLATE "C") = (x.period COLLATE "C") AND ${raw(SQL_TYPED("s."))} AND ${raw(SQL_STAMPED("logged_at", "s."))} AND ${mine("s")})
                 AND NOT EXISTS (SELECT 1 FROM check_in_notes s WHERE s.client_id = k.c AND (s.period COLLATE "C") = (x.period COLLATE "C"))
               ORDER BY (x.period COLLATE "C") DESC, x.id DESC LIMIT 1) AS blank
          FROM jsonb_to_recordset(${clientDefs(part, defs)}::jsonb) AS k(c int, d jsonb)`);
        for (const r of rows) {
          const ntz = msOf(r.ntz);
          out.set(Number(r.c), { figure: msOf(r.ftz), note: ntz != null && typeof r.nperiod === "string" ? { tz: ntz, period: r.nperiod } : null, blank: typeof r.blank === "string" ? r.blank : null });
        }
      }
      return out;
    },
    async keysFrom(asks, defs, notesOnly) {
      const out = new Map<number, Set<string>>();
      for (const part of chunks(asks)) {
        const json = JSON.stringify(part.map((a) => ({ c: a.c, t: isoOf(a.t), b: a.b, d: defs.ofClient.get(a.c) ?? [] })));
        // Stamped at or after t (the instants' indexes), or with no stamp in a period on or after b.
        const figures = notesOnly
          ? sql``
          : sql`SELECT e.period AS p FROM metric_entries e WHERE e.def_client_id = k.c AND e.logged_at_tz IS NOT NULL AND e.logged_at_tz >= k.t AND ${typed("e")} AND ${mine("e")} AND e.period IS NOT NULL
              UNION ALL SELECT e.period FROM metric_entries e WHERE e.def_client_id = k.c AND ${typed("e")} AND ${raw(SQL_BLANK("logged_at", "e."))} AND (e.period COLLATE "C") >= k.b AND ${day("e")} AND ${mine("e")}
              UNION ALL `;
        const rows = await q(sql`SELECT DISTINCT k.c, x.p FROM jsonb_to_recordset(${json}::jsonb) AS k(c int, t timestamptz, b text, d jsonb) CROSS JOIN LATERAL (
            ${figures}SELECT n.period AS p FROM check_in_notes n WHERE n.client_id = k.c AND n.created_at_tz IS NOT NULL AND n.created_at_tz >= k.t AND n.period IS NOT NULL
            UNION ALL SELECT n.period FROM check_in_notes n WHERE n.client_id = k.c AND ${raw(SQL_BLANK("created_at", "n."))} AND (n.period COLLATE "C") >= k.b AND ${day("n")}
          ) x`);
        for (const r of rows) add(out, Number(r.c), r.p);
      }
      return out;
    },
    async oddRows(clients, defs) {
      const entries: CheckInEntry[] = [];
      const notes: CheckInNote[] = [];
      for (const part of chunks(clients)) {
        const ids = part.flatMap((c) => defs.ofClient.get(c) ?? []);
        if (ids.length)
          for (const r of await q(sql`SELECT * FROM metric_entries WHERE def_client_id = ANY(${ints(part)}::int[]) AND metric_definition_id = ANY(${ints(ids)}::int[]) AND ${raw(SQL_ODD_FIGURE())}`)) entries.push(decode.entry(r));
        for (const r of await q(sql`SELECT * FROM check_in_notes WHERE client_id = ANY(${ints(part)}::int[]) AND ${raw(SQL_ODD_NOTE())}`)) notes.push(decode.note(r));
      }
      return { entries: entries.sort(byId), notes: notes.sort(byId) };
    },
    async rowsOf(keys, defs) {
      const list = [...keys].flatMap(([c, ps]) => [...ps].map((p) => ({ c, p, d: defs.ofClient.get(c) ?? [] })));
      const entries: CheckInEntry[] = [];
      const notes: CheckInNote[] = [];
      for (const part of chunks(list)) {
        const json = JSON.stringify(part);
        for (const r of await q(sql`SELECT e.* FROM jsonb_to_recordset(${json}::jsonb) AS k(c int, p text, d jsonb) CROSS JOIN LATERAL (SELECT e.* FROM metric_entries e WHERE e.def_client_id = k.c AND (e.period COLLATE "C") = k.p AND (k.d @> to_jsonb(e.metric_definition_id))) e`)) entries.push(decode.entry(r));
        for (const r of await q(sql`SELECT n.* FROM jsonb_to_recordset(${json}::jsonb) AS k(c int, p text, d jsonb) CROSS JOIN LATERAL (SELECT n.* FROM check_in_notes n WHERE n.client_id = k.c AND (n.period COLLATE "C") = k.p) n`)) notes.push(decode.note(r));
      }
      return { entries: entries.sort(byId), notes: notes.sort(byId) };
    },
    async sinceKeys(clients, defs, p, from) {
      const out = new Map<number, Set<string>>();
      const pIso = isoOf(p);
      for (const part of chunks(clients)) {
        const rows = await q(sql`SELECT DISTINCT k.c, x.p FROM jsonb_to_recordset(${clientDefs(part, defs)}::jsonb) AS k(c int, d jsonb) CROSS JOIN LATERAL (
            SELECT e.period AS p FROM metric_entries e WHERE e.def_client_id = k.c AND e.logged_at_tz IS NOT NULL AND e.logged_at_tz > ${pIso}::timestamptz AND ${typed("e")} AND (k.d @> to_jsonb(e.metric_definition_id)) AND e.period IS NOT NULL
            UNION ALL SELECT e.period FROM metric_entries e WHERE e.def_client_id = k.c AND ${raw(SQL_BLANK("logged_at", "e."))} AND (e.period COLLATE "C") >= ${from}::text AND ${day("e")} AND ${typed("e")} AND (k.d @> to_jsonb(e.metric_definition_id))
          ) x`);
        for (const r of rows) add(out, Number(r.c), r.p);
      }
      return out;
    },
    async oldest(clients, defs) {
      const out = new Map<number, CheckInOldest>();
      for (const part of chunks(clients)) {
        // The first row of each index in its own order (instant, else period, then id), a metric a filter as above. The
        // notes with no stamp have no index of their own: the period index, its client's notes alone.
        const rows = await q(sql`SELECT k.c,
            EXTRACT(EPOCH FROM (SELECT e.logged_at_tz FROM metric_entries e WHERE e.def_client_id = k.c AND e.logged_at_tz IS NOT NULL AND ${typed("e")} AND ${mine("e")} ORDER BY e.logged_at_tz, e.id LIMIT 1)) * 1000 AS ftz,
            (SELECT e.period FROM metric_entries e WHERE e.def_client_id = k.c AND ${typed("e")} AND ${raw(SQL_BLANK("logged_at", "e."))} AND e.period IS NOT NULL AND ${mine("e")} ORDER BY (e.period COLLATE "C"), e.id LIMIT 1) AS fblank,
            EXTRACT(EPOCH FROM (SELECT n.created_at_tz FROM check_in_notes n WHERE n.client_id = k.c AND n.created_at_tz IS NOT NULL ORDER BY n.created_at_tz, n.id LIMIT 1)) * 1000 AS ntz,
            (SELECT n.period FROM check_in_notes n WHERE n.client_id = k.c AND ${raw(SQL_BLANK("created_at", "n."))} AND n.period IS NOT NULL ORDER BY (n.period COLLATE "C"), n.id LIMIT 1) AS nblank
          FROM jsonb_to_recordset(${clientDefs(part, defs)}::jsonb) AS k(c int, d jsonb)`);
        for (const r of rows) {
          // No rounding: an instant a microsecond before a window's start must read as before it.
          const o: CheckInOldest = {
            figures: { tz: r.ftz == null ? null : Number(r.ftz), blank: typeof r.fblank === "string" ? r.fblank : null },
            notes: { tz: r.ntz == null ? null : Number(r.ntz), blank: typeof r.nblank === "string" ? r.nblank : null },
          };
          if (o.figures.tz != null || o.figures.blank != null || o.notes.tz != null || o.notes.blank != null) out.set(Number(r.c), o);
        }
      }
      return out;
    },
  };
}
