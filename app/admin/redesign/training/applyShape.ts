// What Apply to the rest and a session's Apply to remaining weeks would change, in the shape the server reads it
// (applyPreviewData.ts) and the confirm shows it (ApplyChanges.tsx). Plain data and plain functions, so the page's read
// (which offers the button only while a later week would change, 23 Oct, Alex) and the pop-up count alike.

/** One figure that changes: what it is, what it was, what it becomes. A weight is kg as stored (the screen rounds it in the coach's unit). */
export type ApplyFig = { label: string; from: string | null; to: string | null; kg?: boolean; gym?: string; words?: boolean };
export type ApplyItem = { name: string; cardio?: boolean; change: "added" | "removed" | "changed"; figs: ApplyFig[] };
export type ApplySession = {
  /** Its name once applied. */
  name: string;
  /** The name it had, when the copy renames it. */
  was: string | null;
  /** A session the copy makes (the later week had fewer), with what it brings. */
  added: { exercises: number; cardio: number } | null;
  reorder: boolean;
  /** A session's copy replaces a logged session too: what of the client's goes. */
  goes: { sets: number; cardio: number } | null;
  items: ApplyItem[];
};
export type ApplyWeek = { index: number; sessions: ApplySession[] };
export type ApplyPreview = { weeks: ApplyWeek[] };

const LB = 2.20462;
const half = (x: number) => Math.round(x * 2) / 2;

/**
 * The weights in the coach's unit, as the Training tab rounds them (kgOf: the stored kg turned, then to the half), and
 * a weight that reads the same either side dropped, with a row or session it leaves with nothing to say.
 */
export function inUnit(s: ApplySession, lbs: boolean): ApplySession | null {
  const shown = (v: string | null) => (v == null ? null : String(half(lbs ? Number(v) * LB : Number(v))));
  const items = s.items
    .map((it) => (it.change !== "changed" ? it : { ...it, figs: it.figs.flatMap((f) => (!f.kg ? [f] : shown(f.from) === shown(f.to) ? [] : [{ ...f, from: shown(f.from), to: shown(f.to) }])) }))
    .filter((it) => it.change !== "changed" || it.figs.length > 0);
  return items.length || s.was || s.reorder || s.goes || s.added ? { ...s, items } : null;
}

/** The weeks (screen index) the confirm lists something under, read in the coach's unit: the weeks the apply would change. */
export const changedWeeks = (p: ApplyPreview, lbs: boolean) => p.weeks.filter((w) => w.sessions.some((s) => inUnit(s, lbs) != null)).map((w) => w.index);

/**
 * How many changes an apply would carry forward, in the coach's unit (16 Nov, Alex: "wouldn't it make more sense to have
 * that count say the number of changes that will be applied"): each once, however many weeks it reaches. A change is an
 * exercise or cardio row added, removed, or with any of its figures or its note changed; a session added or renamed; a
 * new order. Read off the confirm's own list, so what it leaves out (a weight the progression raised, a logged session
 * kept) is never counted. Only the weeks Apply can reach (`reach`, the later weeks that aren't over) count.
 */
export function changeCount(p: ApplyPreview, lbs: boolean, reach?: (index: number) => boolean): number {
  const weeks = p.weeks
    .filter((w) => !reach || reach(w.index))
    .map((w) => {
      // A session or row named twice (two Session 3s, Bench press as a top set and again as back-off sets) is each its
      // own: the nth of a name is keyed as the nth, so they never collapse into one change.
      const nth = new Map<string, number>();
      const at = (k: string) => {
        const n = nth.get(k) ?? 0;
        nth.set(k, n + 1);
        return `${k}#${n}`;
      };
      return w.sessions.flatMap((raw) => {
        const s = inUnit(raw, lbs);
        if (!s) return [];
        const key = at(`s|${s.name}`);
        return [{ s, key, rows: s.items.map((it) => at(`${key}|${it.cardio ? "cardio" : "row"}|${it.change === "removed" ? "out" : "in"}|${it.name}`)) }];
      });
    });
  // A session the apply adds is one change, rows and all, in every week: where a later week already has its slot and
  // only its rows differ, those rows are the same change, not more.
  const addedKeys = new Set(weeks.flat().filter((x) => x.s.added).map((x) => x.key));
  const seen = new Set<string>();
  for (const w of weeks)
    for (const { s, key, rows } of w) {
      if (addedKeys.has(key)) {
        seen.add(`${key}|session`);
        continue;
      }
      if (s.was) seen.add(`${key}|name`);
      if (s.reorder) seen.add(`${key}|order`);
      // A row the later weeks lack and one they hold differently are the same change of this week's row.
      for (const r of rows) seen.add(r);
    }
  return seen.size;
}
