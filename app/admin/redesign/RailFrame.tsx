"use client";

import { createContext, Suspense, use, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import RedesignRail from "./RedesignRail";
import PageSkeleton, { VIEW_SKELETON } from "./PageSkeleton";
import HelpButton from "./help/HelpButton";
import type { RailData, StampedRail } from "./loaders";
import { clientScreenOf, pageKeyOf, viewOfPath } from "./paths";
import { isVisitView, visitView } from "./visit";

// The rail stays, only the page swaps (22 Nov, Alex: "if we have to touch the rail… to make it a proper product, then
// yes"; docs/rail-layout-plan.md). The layout (layout.tsx) hands its read of the rail over as a promise and this frame
// draws it once: `.rd-frame`, the rail, then the page as the frame's own children, exactly as every page drew them,
// so `.rd-frame > .rd-page` and the rail's `:has(> .rr.going)` keep matching. A move to another view swaps the page
// alone (its loading.tsx drawn at once); the rail stays mounted and reads itself again in the background
// (/api/admin/rail), the newest read winning. A path that isn't one of the framed views (the boards, a printed
// invoice, the redirects) is its page alone, no frame.

/** The view a path is ("feed", or a client's tab key, "home"…), or null when it isn't a framed one (paths.ts: a client's
 *  screens are /clients/<id>/<tab>, the coach-wide views /<view>). */
const viewOf = (path: string | null): string | null => viewOfPath(path);
export const isFramedPath = (path: string | null) => viewOf(path) != null;

/** A move, for the rail's read: another view, or another client on a client's screens. Nothing else in the address
 *  counts (the shell's ?tab= rewrite that drops ?program= or adds ?client=, the Calendar's ?month= and ?day=, the
 *  Library's ?edit=, a week or a phase picked): the rail's counts are the coach's, never the view's. */
// Read once the coach has stopped moving, and at most every READ_EVERY_MS (24 Nov, Alex: "still quite laggy changing
// from page to page"): the read costs the server most of a second (the Needs you of every client), and on its one
// thread it held up the next page clicked. A save or a refresh reads the rail with the page anyway; this only catches
// what changed meanwhile (a message come in), so it can wait.
const READ_GAP_MS = 2500;
const READ_EVERY_MS = 30_000;
/** How long a rail click waits for its page before the outline takes the page's place: a page the browser has lands
 *  well inside it, so it never flashes. */
const OUTLINE_MS = 90;
/** A click that never lands lets go of the outline after this, the page it left shown again. */
const GIVE_UP_MS = 4000;

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
function RailFromLayout({ promise, kept, fetched, here, asked, onLayout, onMissing, onArrivalRead, onGoing }: { promise: Promise<StampedRail | null>; kept: StampedRail | null; fetched: StampedRail | null; here: number | null; asked: number | null; onLayout: (r: StampedRail) => void; onMissing: () => void; onArrivalRead: () => void; onGoing: (href: string | null) => void }) {
  const fromLayout = use(promise);
  useEffect(() => {
    if (fromLayout) onLayout(fromLayout);
    // The layout's read failed: one of our own in its place, for each failed read (a new promise each time).
    else onMissing();
  }, [promise, fromLayout, onLayout, onMissing]);
  const shown = newest(newest(kept, fromLayout), fetched);
  const clientId = here ?? asked ?? shown?.defaultClient ?? 0;
  return shown ? <RedesignRail rail={shown.rail} clientId={clientId} onArrivalRead={onArrivalRead} onGoing={onGoing} /> : <RailSkeleton />;
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
  const view = viewOf(path);
  const framed = view != null;

  // The newest of the layout's read and ours (newest() by when each read began, on the server's clock).
  const [fromLayout, setFromLayout] = useState<StampedRail | null>(null);
  const [fetched, setFetched] = useState<StampedRail | null>(null);
  const onLayout = useCallback((r: StampedRail) => setFromLayout((had) => newest(had, r)), []);
  const lastRead = useRef(0);
  const read = useCallback(async () => {
    lastRead.current = Date.now();
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
  const screen = clientScreenOf(path);
  const named = screen?.clientId ?? 0;
  const onClient = screen != null;
  const asked = !onClient ? 0 : Number.isInteger(named) && named > 0 ? named : null;
  const hereId = here?.id ?? null;

  // Fresh after each move (another view, another client), read a moment after it settles, never on the first draw (the
  // layout has just read it), never off the frame. A client's screen with no ?client= is its default client's (the
  // page's report, else the read's pick), so the shell's ?client=&tab= rewrite of that address is no move.
  const latest = newest(fromLayout, fetched);
  const keyClient = !onClient ? 0 : (asked ?? hereId ?? latest?.defaultClient ?? null);
  // A client's tabs are one page (a tab switched is no move), keyed by the client alone.
  const moveKey = !framed || keyClient == null ? null : onClient ? `/clients|${keyClient}` : `${path}|0`;
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
    const t = window.setTimeout(() => void read(), Math.max(READ_GAP_MS, lastRead.current + READ_EVERY_MS - Date.now()));
    return () => window.clearTimeout(t);
  }, [moveKey, read]);

  const value = useMemo<RailContextValue>(() => ({ rail: latest?.rail ?? null, reportHere }), [latest, reportHere]);
  // The help panel reads the rail again once the team's lines are read, so the rail's Support dot goes with its own.
  const reread = useCallback(() => void read(), [read]);

  // A rail click whose page isn't in by OUTLINE_MS (22 Nov, Alex: "a bit faster yeah but not completely smooth"; a click
  // on a client Next hasn't kept showed nothing for half a second, then swapped): the page you were on gives way to the
  // outline of the one coming, as its loading.tsx draws it, until the new address lands. A page already in the browser
  // (a view prefetched on hover) lands before that and never shows it. Let go after GIVE_UP_MS or on Back, so a click
  // that never lands never leaves the outline up.
  // The outline is drawn (hidden) the moment of the click, an urgent render before Next's own transition starts; showing
  // it later is a plain attribute on the frame (`data-going`), never a React render, so it can't cut into the new page's
  // render under way (22 Nov, review: a state update there threw the transition's work away and flashed the outline over
  // a page about to land). React never renders the attribute, so nothing it draws takes it off by mistake.
  const frameRef = useRef<HTMLDivElement>(null);
  const [goingTo, setGoingTo] = useState<string | null>(null);
  const hide = useCallback(() => frameRef.current?.removeAttribute("data-going"), []);
  const onGoing = useCallback(
    (href: string | null) => {
      hide();
      const v = href ? viewOf(href.split(/[?#]/)[0]) : null;
      setGoingTo(v);
    },
    [hide]
  );
  // A new click restarts the wait (a click on the same view as the last one too: the effect keys on the click itself).
  const [clicks, setClicks] = useState(0);
  const onGoingCounted = useCallback(
    (href: string | null) => {
      onGoing(href);
      setClicks((n) => n + 1);
    },
    [onGoing]
  );
  useEffect(() => {
    if (!goingTo) return;
    const show = window.setTimeout(() => frameRef.current?.setAttribute("data-going", ""), OUTLINE_MS);
    const stop = () => {
      hide();
      setGoingTo(null);
    };
    // A click that never lands (abandoned, or sent back to this very page by the server) lets go after GIVE_UP_MS.
    const giveUp = window.setTimeout(stop, GIVE_UP_MS);
    window.addEventListener("popstate", stop);
    return () => {
      window.clearTimeout(show);
      window.clearTimeout(giveUp);
      window.removeEventListener("popstate", stop);
    };
  }, [goingTo, clicks, hide]);
  // Landed: another view, or another client (a tab or a week picked inside a page is no landing). The attribute comes off
  // before the paint that shows the new page.
  const address = pageKeyOf(path);
  const [seenAddress, setSeenAddress] = useState(address);
  if (seenAddress !== address) {
    setSeenAddress(address);
    setGoingTo(null);
  }
  useLayoutEffect(() => {
    if (goingTo == null) hide();
  }, [goingTo, hide]);
  // The Feed or Business on screen: its look is noted now (26 Nov), not by its render, which the rail draws ahead.
  useEffect(() => {
    if (isVisitView(view)) visitView(view);
  }, [address, view]);

  return (
    <RailContext.Provider value={value}>
      {framed ? (
        <div className="rd-frame" ref={frameRef}>
          <Suspense fallback={<RailSkeleton />}>
            <RailFromLayout promise={promise} kept={fromLayout} fetched={fetched} here={hereId} asked={asked} onLayout={onLayout} onMissing={onMissing} onArrivalRead={onArrivalRead} onGoing={onGoingCounted} />
          </Suspense>
          {children}
          {goingTo != null && <PageSkeleton {...VIEW_SKELETON[goingTo]} chat={false} />}
          {/* Help on every screen (24 Nov, Alex: B of docs/boards/coach-help-mockup.html): fixed, so it takes no cell. */}
          <HelpButton view={view} rail={latest?.rail ?? null} reread={reread} />
        </div>
      ) : (
        children
      )}
    </RailContext.Provider>
  );
}
