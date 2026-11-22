"use client";

import { createContext, Suspense, use, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import RedesignRail from "./RedesignRail";
import type { RailData, StampedRail } from "./loaders";

// The rail stays, only the page swaps (22 Nov, Alex: "if we have to touch the rail… to make it a proper product, then
// yes"; docs/rail-layout-plan.md). The layout (layout.tsx) hands its read of the rail over as a promise and this frame
// draws it once: `.rd-frame`, the rail, then the page as the frame's own children, exactly as every page drew them,
// so `.rd-frame > .rd-page` and the rail's `:has(> .rr.going)` keep matching. A move to another view swaps the page
// alone (its loading.tsx drawn at once); the rail stays mounted and reads itself again in the background
// (/api/admin/rail), the newest read winning. A path that isn't one of the framed views (the boards, a printed
// invoice, the redirects) is its page alone, no frame.

const BASE = "/admin/redesign/";
/** A client's screens: the shell (RedesignShell) or NoClients on each. */
const CLIENT_VIEWS = ["home", "plan", "measurements", "training", "nutrition", "pictures", "meetings", "invoices", "messages"] as const;
/** The coach-wide views, each drawing the rail and the chat dock. */
const COACH_VIEWS = ["feed", "phases", "calendar", "library", "business", "coaches", "settings"] as const;
const FRAMED = new Set<string>([...CLIENT_VIEWS, ...COACH_VIEWS]);
const CLIENT = new Set<string>(CLIENT_VIEWS);

/** The view a path is ("feed", "home"…), or null when it isn't a framed one. */
function viewOf(path: string | null): string | null {
  if (!path?.startsWith(BASE)) return null;
  const rest = path.slice(BASE.length).replace(/\/$/, "");
  return FRAMED.has(rest) ? rest : null;
}
export const isFramedPath = (path: string | null) => viewOf(path) != null;

/** A move, for the rail's read: another view, or another client on a client's screens. Nothing else in the address
 *  counts (the shell's ?tab= rewrite that drops ?program= or adds ?client=, the Calendar's ?month= and ?day=, the
 *  Library's ?edit=, a week or a phase picked): the rail's counts are the coach's, never the view's. */
const READ_GAP_MS = 200;

type RailContextValue = {
  /** The newest rail read (null while the first is on its way). */
  rail: RailData | null;
  /** The client the page shows, reported by the page (RedesignShell) so a client picked by default is marked in the
   *  rail; it answers a function that takes the report back (call it on unmount). */
  reportHere: (clientId: number) => () => void;
};
const RailContext = createContext<RailContextValue>({ rail: null, reportHere: () => () => {} });

/** The newest rail read and the page's way to say which client it shows. */
export const useRail = () => useContext(RailContext);

/** The page's client, said to the rail for as long as the page shows them (RedesignShell). */
export function useReportHere(clientId: number) {
  const { reportHere } = useRail();
  useEffect(() => reportHere(clientId), [reportHere, clientId]);
}

const newest = (a: StampedRail | null, b: StampedRail | null) => (!a ? b : !b ? a : b.at > a.at ? b : a);

/** The rail drawn from the newest read so far: the layout's latest promise, every good layout read kept before it
 *  (`kept`), and our own. A layout read that fails (a router.refresh whose read threw) never takes back the rail a good
 *  read drew, so the rail stays mounted with its search, filter and scroll. The client marked: the one the page reported
 *  (`here`), else the address's (`asked`; 0 on a coach-wide view), else on a client's screen with no ?client= the one
 *  the page picks by default, as the read says it, so it is marked from the first paint. */
function RailFromLayout({ promise, kept, fetched, here, asked, onLayout, onMissing, onArrivalRead }: { promise: Promise<StampedRail | null>; kept: StampedRail | null; fetched: StampedRail | null; here: number | null; asked: number | null; onLayout: (r: StampedRail) => void; onMissing: () => void; onArrivalRead: () => void }) {
  const fromLayout = use(promise);
  useEffect(() => {
    if (fromLayout) onLayout(fromLayout);
    // The layout's read failed: one of our own in its place, for each failed read (a new promise each time).
    else onMissing();
  }, [promise, fromLayout, onLayout, onMissing]);
  const shown = newest(newest(kept, fromLayout), fetched);
  const clientId = here ?? asked ?? shown?.defaultClient ?? 0;
  return shown ? <RedesignRail rail={shown.rail} clientId={clientId} onArrivalRead={onArrivalRead} /> : <RailSkeleton />;
}

/** The rail before its data is in: the dark top and the paper, nothing in them (rail.css, `.rr-skel`). */
function RailSkeleton() {
  return (
    <aside className="rr rr-skel" aria-label="Coach rail" aria-busy="true">
      <div className="rr-dark" />
      <div className="rr-paper" />
    </aside>
  );
}

export default function RailFrame({ rail: promise, children }: { rail: Promise<StampedRail | null>; children: ReactNode }) {
  const path = usePathname();
  const params = useSearchParams();
  const view = viewOf(path);
  const framed = view != null;

  // The newest of the layout's read and ours (newest() by when each read began, on the server's clock).
  const [fromLayout, setFromLayout] = useState<StampedRail | null>(null);
  const [fetched, setFetched] = useState<StampedRail | null>(null);
  const onLayout = useCallback((r: StampedRail) => setFromLayout((had) => newest(had, r)), []);
  const read = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/rail", { cache: "no-store" });
      if (!res.ok) return;
      const got = (await res.json()) as StampedRail;
      if (got?.rail && typeof got.at === "number") setFetched((had) => newest(had, { ...got, defaultClient: typeof got.defaultClient === "number" ? got.defaultClient : 0 }));
    } catch {}
  }, []);
  const onMissing = useCallback(() => void read(), [read]);

  // The page's client (RedesignShell reports it); each report taken back only by its own page, so a page leaving after
  // the next one arrived never clears the next one's.
  const [here, setHere] = useState<{ id: number } | null>(null);
  const reportHere = useCallback((clientId: number) => {
    const mine = { id: clientId };
    setHere(mine);
    return () => setHere((h) => (h === mine ? null : h));
  }, []);
  // Else, on a client's screen, the client the address names (a page still loading), or null when it names none (the
  // page's default, from the read); on a coach-wide view, none (0).
  const named = Number(params.get("client"));
  const onClient = !!view && CLIENT.has(view);
  const asked = !onClient ? 0 : Number.isInteger(named) && named > 0 ? named : null;
  const hereId = here?.id ?? null;

  // Fresh after each move (another view, another client), read a moment after it settles, never on the first draw (the
  // layout has just read it), never off the frame. A client's screen with no ?client= is its default client's (the
  // page's report, else the read's pick), so the shell's ?client=&tab= rewrite of that address is no move.
  const latest = newest(fromLayout, fetched);
  const keyClient = !onClient ? 0 : (asked ?? hereId ?? latest?.defaultClient ?? null);
  const moveKey = !framed || keyClient == null ? null : `${path}|${keyClient}`;
  const lastMove = useRef<string | null>(null);
  // The rail's own read on landing (RedesignRail's router.refresh after a stale prefetch) reads the layout again, so
  // this move's own read is left out: one read a click.
  const arrivalRead = useRef(false);
  const onArrivalRead = useCallback(() => {
    arrivalRead.current = true;
  }, []);
  useEffect(() => {
    if (moveKey == null) return;
    const was = lastMove.current;
    lastMove.current = moveKey;
    if (was == null || was === moveKey) return;
    if (arrivalRead.current) {
      arrivalRead.current = false;
      return;
    }
    const t = window.setTimeout(() => void read(), READ_GAP_MS);
    return () => window.clearTimeout(t);
  }, [moveKey, read]);

  const value = useMemo<RailContextValue>(() => ({ rail: latest?.rail ?? null, reportHere }), [latest, reportHere]);

  return (
    <RailContext.Provider value={value}>
      {framed ? (
        <div className="rd-frame">
          <Suspense fallback={<RailSkeleton />}>
            <RailFromLayout promise={promise} kept={fromLayout} fetched={fetched} here={hereId} asked={asked} onLayout={onLayout} onMissing={onMissing} onArrivalRead={onArrivalRead} />
          </Suspense>
          {children}
        </div>
      ) : (
        children
      )}
    </RailContext.Provider>
  );
}
