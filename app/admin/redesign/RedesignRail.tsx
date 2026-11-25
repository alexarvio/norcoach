"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type MouseEvent } from "react";
import Link from "next/link";
import { dayMonth } from "../../lib/dayMonth";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import "./onboarding-tour.css";
import { AccountIcon, BusinessIcon, CalendarIcon, FeedIcon, GearIcon, PhasesIcon, PlusIcon, SearchIcon } from "../../components/icons";
import { TRAINING_ICON } from "../../lib/eventTypes";
import { logoutAction } from "../../lib/auth-actions";
import NewClientDialog from "../NewClientDialog";
import type { RailClient, RailData } from "./loaders";
import { Sep } from "./Sep";
import NativeCoachRedirect from "../../coach/NativeCoachRedirect";
import RefreshOnReturn, { calm } from "./RefreshOnReturn";
import { onRefreshFree } from "./holdRefresh";
import { pic } from "../../lib/pic";
import { BrandLogo } from "../../components/BrandLogo";
import { pageKeyOf } from "./paths";

// The left rail, in the redesign's sheet: the brand, the coach's cross-client
// views as icon rows, every client in one scrolling list, and the coach at
// the foot. A click on the coach opens Settings: it grows up from the foot
// and the client list folds away; a click on Clients (or the coach again)
// brings the list back. Only the client list scrolls.

const VIEWS = [
  // Every day first, the two counts side by side, then what is opened now and then, Coaches (the owner's) and Settings
  // last, all evenly spaced (22 Nov, Alex: "feed, phases, calendar, library, business settings"; "take the space out").
  { key: "feed", label: "Feed", Icon: FeedIcon },
  { key: "phases", label: "Phases", Icon: PhasesIcon },
  { key: "calendar", label: "Calendar", Icon: CalendarIcon },
  // Exercises, their demos and default cues, and cardio movements (5 Oct).
  { key: "library", label: "Library", Icon: LibraryIcon },
  { key: "business", label: "Business", Icon: BusinessIcon },
] as const;

// The app's own dumbbell, square like its neighbours (16 Nov, Alex: the audit; the wide 24×16 one sat squashed in the
// 16px box), its stroke the rail's one weight (rail.css).
function LibraryIcon() {
  return (
    <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={TRAINING_ICON} />
    </svg>
  );
}
// Views already redrawn here open in the redesign; the rest where they always were.
const REDRAWN: Partial<Record<string, string>> = { feed: "/feed", calendar: "/calendar", phases: "/phases", business: "/business", library: "/library" };
const COACHES = "/coaches";
const SETTINGS_HREF = "/settings";

// A view as near instant as Next allows (22 Nov, Alex: "I go to feed, I go to phases, and then maybe I go to settings, it
// takes maybe 0.5 seconds… as instant as possible"). The views are dynamic pages; since 22 Nov the rail is the layout's
// (RailFrame) and each view's loading.js draws its outline at once, and Next prefetches little of such a page by default
// (node_modules/next/dist/docs/01-app/02-guides/prefetching.md). A view row the mouse rests on for a moment is
// prefetched in full (`prefetch={true}`, the docs' "Hover-triggered prefetch"), so the click shows a page already in
// the browser. Never on viewport entry: that would draw all seven heavy pages on the server for every page, again after
// every save (a revalidation re-prefetches every armed visible link), and note a Feed or Business visit the coach never
// made. The row lets go as the pointer leaves, as it is clicked, and HOLD_MS after it armed (a prefetch under way still
// lands), so a save or a refresh never re-prefetches a row the pointer merely rests on. A full prefetch is kept 5 minutes (staleTimes.static,
// 03-api-reference/05-config/01-next-config-js/staleTimes.md): a page shown from one older than FRESH_MS reads itself
// again in the background as it lands, so the coach sees it at once and the newest a moment later. Production only:
// Next never prefetches in `next dev`. A client row the same since 22 Nov ("idk still take a decent amount of time":
// about 0.22s of every click is the way to the server), after a longer rest (CLIENT_ARM_MS), so scrolling the list
// past the rows never prefetches them: the client's page writes nothing for being drawn (the visit is written once
// it is on screen, visitClient from RedesignShell), so a hover is no visit.
const ARM_MS = 70; // a pointer passing over the rail doesn't prefetch every row it crosses
const CLIENT_ARM_MS = 150; // a client row: the list scrolls under a resting pointer, and its page is the heaviest
const FRESH_MS = 15_000; // as RefreshOnReturn's gap
const KEPT_MS = 5 * 60_000; // staleTimes.static's default
const HOLD_MS = 1000; // an armed row lets go after this: its prefetch is under way by then and still lands
/** When each view or client was last prefetched by a row (keyOf; at most once in KEPT_MS, as the cache keeps it). */
const prefetchedAt = new Map<string, number>();
/** The client cache was emptied (a refresh, or a save that revalidates: RedesignShell sees its page read again): every
 *  time above speaks of a copy that is gone, so the next arm records a real fetch and a click never reads again a page
 *  it has just fetched. */
export function forgetPrefetches() {
  prefetchedAt.clear();
}
/** The view a click is going to whose prefetch may be old: it reads itself again once it lands. */
let readOnArrival: string | null = null;
/** A page as the address tells it apart: the view, and on a client's screens the client (their tabs are one page). */
const keyOf = (href: string) => pageKeyOf(href.split("#")[0].split("?")[0]);

/** A view or client row of the rail: a Link prefetched in full while the mouse (or the keyboard's focus) rests on it. */
function ViewLink({ href, onClick, onPointerDown, children, still = false, armAfter, ...rest }: Omit<ComponentProps<typeof Link>, "href" | "prefetch" | "onPointerEnter" | "onPointerLeave" | "onPointerCancel" | "onFocus" | "onBlur"> & { href: string; /** Never prefetched (Feed, Business): their page notes the coach's look as it is read, and Next's full prefetch
   *  carries nothing that tells it from a visit, so a hover would count as one (22 Nov, review). The click still shows
   *  its outline at once (RailFrame). */ still?: boolean; /** How long the pointer (or the keyboard's focus) rests before
   *  the prefetch, in ms: ARM_MS when left out, the focus at once; a client row's CLIENT_ARM_MS, its focus after it too,
   *  so tabbing down the list doesn't draw every client's page, and a finger landing on it waits too (a flick of the
   *  list starts on a row). */ armAfter?: number }) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<number | null>(null);
  const hold = useRef<number | null>(null);
  const stop = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  const stopHold = () => {
    if (hold.current !== null) window.clearTimeout(hold.current);
    hold.current = null;
  };
  useEffect(
    () => () => {
      stop();
      stopHold();
    },
    [],
  );
  const arm = () => {
    stop();
    if (still) return;
    const key = keyOf(href);
    const now = Date.now();
    const at = prefetchedAt.get(key);
    if (at === undefined || now - at > KEPT_MS) prefetchedAt.set(key, now);
    setArmed(true);
    // Armed only long enough to start the prefetch (HOLD_MS): Next fetches every armed link again after each save or
    // refresh (pingVisibleLinks), and a pointer resting on the row would draw its page each time.
    stopHold();
    hold.current = window.setTimeout(() => {
      hold.current = null;
      setArmed(false);
    }, HOLD_MS);
  };
  const letGo = () => {
    stop();
    stopHold();
    setArmed(false);
  };
  return (
    <Link
      {...rest}
      href={href}
      prefetch={armed}
      // A mouse or pen alone: a tap's own pointer events come with its click, too late to gain anything.
      onPointerEnter={(e) => {
        if (e.pointerType === "touch" || armed) return;
        stop();
        timer.current = window.setTimeout(arm, armAfter ?? ARM_MS);
      }}
      onPointerLeave={letGo}
      // A tap: the prefetch starts as the finger lands, ahead of the click (about 100ms gained). A row with armAfter (a
      // client's) waits that long with the finger down: a flick of the list starts on a row, and the browser taking the
      // gesture for a scroll cancels the pointer (onPointerCancel) before then.
      onPointerDown={(e) => {
        onPointerDown?.(e);
        if (e.pointerType !== "touch" || armed) return;
        if (armAfter === undefined) return arm();
        stop();
        timer.current = window.setTimeout(arm, armAfter);
      }}
      onPointerCancel={letGo}
      // The keyboard's focus, not the one a mouse press gives (that comes with the click).
      onFocus={(e) => {
        if (armed || !e.currentTarget.matches(":focus-visible")) return;
        if (armAfter === undefined) return arm();
        stop();
        timer.current = window.setTimeout(arm, armAfter);
      }}
      onBlur={letGo}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        // Going there: the row lets go, so it is never armed (and fetched again) as the page lands, refreshes or saves.
        letGo();
        // Next prefetches nothing in `next dev`: there is nothing old to read again there.
        if (process.env.NODE_ENV !== "production") return;
        const key = keyOf(href);
        if (keyOf(window.location.pathname + window.location.search) === key) {
          readOnArrival = null;
          return;
        }
        // A prefetch older than FRESH_MS reads itself again as it lands; set afresh on every click, so one left by a
        // click that never landed never fires later.
        const at = prefetchedAt.get(key);
        readOnArrival = at !== undefined && Date.now() - at > FRESH_MS ? key : null;
      }}
    >
      {children}
    </Link>
  );
}

// Where the client list was left, kept from page to page (4 Nov, Alex: "whenever I switch a page, it kind of like pulls
// the page up. So I have to scroll back down"). Every coach page draws its own rail, so each switch drew a new one at
// the list's top with All picked: the list's scroll and its All | Needs you come back as they were, before the first
// paint. Kept in the tab's memory alone: a reload starts at the top, as the server draws it.
let keptListTop = 0;
let keptFilter: "all" | "needs" = "all";


export default function RedesignRail({ rail, clientId, settings = false, onArrivalRead, onGoing }: { rail: RailData; clientId: number; /** On the Settings page: the rail opens on Settings and marks the section open. */ settings?: boolean; /** Told when the read on landing (below) will read the page and the layout again, so the frame leaves its own read of this move out (RailFrame). */ onArrivalRead?: () => void; /** Told of a click to another view or client (its href), so the frame can draw that page's outline while it comes; null for a click back to the page on screen (RailFrame). */ onGoing?: (href: string | null) => void }) {
  // This browser's timezone, for the server: meetings read in it (lib/viewZone.ts).
  // New or changed (a trip): the page is drawn again in it.
  const router = useRouter();
  useEffect(() => {
    try {
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (!zone) return;
      const had = document.cookie.split("; ").find((c) => c.startsWith("ironline_tz="))?.slice("ironline_tz=".length);
      if (had === encodeURIComponent(zone)) return;
      document.cookie = `ironline_tz=${encodeURIComponent(zone)}; path=/; max-age=31536000; samesite=lax`;
      router.refresh();
    } catch {}
  }, [router]);
  // The view you are on (Feed, Calendar…) is marked, as the client you are on is.
  const path = usePathname();
  const search = useSearchParams();
  // A click away: the frame shows the page's outline if it isn't in by the next moment (RailFrame).
  const going = (href: string | null) => onGoing?.(href);
  // The page on screen as keyOf names it: the view, and the client on a client's screens.
  const landedKey = keyOf(`${path}?${search.toString()}`);
  // Landed on a view shown from a prefetch older than FRESH_MS (ViewLink): read it again in the background, once nothing holds the page, and never across a deploy (a read from a newer build
  // loads the whole page again; RefreshOnReturn).
  useEffect(() => {
    const due = readOnArrival;
    readOnArrival = null;
    if (!due || landedKey !== due) return;
    // The refresh reads the layout's rail again too: the frame's own read of this move would be a second one.
    onArrivalRead?.();
    let done = false;
    let unsubscribe: (() => void) | null = null;
    const read = async () => {
      if (done) return;
      done = true;
      unsubscribe?.();
      const page = document.documentElement.dataset.build;
      try {
        const now = page ? (await (await fetch("/api/version", { cache: "no-store" })).json())?.build : null;
        if (page && typeof now === "string" && now !== "unknown" && now !== page) return;
      } catch {
        return;
      }
      router.refresh();
    };
    // The same calm as RefreshOnReturn's: no field with the keyboard, nothing open, no press held, nothing holding
    // refreshes. Not calm yet, it tries again soon after a hold lets go, a field is left or a press ends, and every 2s.
    let poll: ReturnType<typeof setInterval> | null = null;
    let soon: ReturnType<typeof setTimeout> | null = null;
    const quiet = () => {
      if (poll) clearInterval(poll);
      if (soon) clearTimeout(soon);
      poll = null;
      soon = null;
      unsubscribe?.();
      unsubscribe = null;
      document.removeEventListener("focusout", later, true);
      window.removeEventListener("pointerup", later, true);
      window.removeEventListener("pointercancel", later, true);
    };
    const attempt = () => {
      if (done) return;
      if (document.visibilityState !== "visible" || !calm()) return;
      quiet();
      void read();
    };
    function later() {
      if (soon) clearTimeout(soon);
      soon = setTimeout(attempt, 250);
    }
    if (calm()) void read();
    else {
      unsubscribe = onRefreshFree(later);
      document.addEventListener("focusout", later, true);
      window.addEventListener("pointerup", later, true);
      window.addEventListener("pointercancel", later, true);
      poll = setInterval(attempt, 2000);
    }
    return () => {
      done = true;
      quiet();
    };
    // Once a view or client lands: the rail is drawn once by the layout now (22 Nov, RailFrame) and stays, so each new
    // page (a week or tab picked inside one is no landing).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [landedKey]);
  // Settings is a view of its own now, a row under the views (22 Nov, Alex): nothing folds in the rail.
  const settingsOpen = false;
  const onSettings = settings || !!path?.startsWith(SETTINGS_HREF);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "needs">(() => keptFilter);
  useEffect(() => {
    keptFilter = filter;
  }, [filter]);
  // Needs you: something owed, or a new client still to set up (22 Oct, Alex).
  const needsMe = (c: RailClient) => c.total > 0;
  const needsYou = rail.clients.filter(needsMe).length;
  const feedOwed = rail.clients.reduce((n, c) => n + c.owed, 0) + (rail.joinRequests ?? 0);
  // What the Phases screen lists (2 Nov, Alex: "if anyone is missing a phase have the notification appear there just like in
  // feed where there is a number").
  const phasesOwed = rail.clients.reduce((n, c) => n + c.phases, 0);
  // The client whose screens are dropped open under their row: one at a time (22 Oct, Alex).
  const [openId, setOpenId] = useState<number | null>(null);
  const q = query.trim().toLowerCase();
  const shown = rail.clients.filter((c) => (filter === "all" || needsMe(c)) && (!q || c.name.toLowerCase().includes(q)));
  const [adding, setAdding] = useState(false);
  // The client just clicked is marked at once, before the page arrives (a
  // switch is a round trip to the server), then the real one takes over.
  const [pending, setPending] = useState<{ id: number; from: string } | null>(null);
  const here = `${clientId}:${pageKeyOf(path)}`;
  // Not the client already open (22 Oct, Alex: a click on them changed nothing, so their face pulsed for good).
  const pendingId = pending && pending.from === here && pending.id !== clientId ? pending.id : null;
  const markedId = pendingId ?? clientId;
  const setPendingId = (id: number) => setPending({ id, from: here });
  // A view clicked (Feed, Calendar, Phases…) answers the same way (4 Nov, Alex: "a tiny bit slow" going Phases → Calendar
  // → Feed): its row is the ink pill at once and the one you were on lets go, and the page under it dims a little, until
  // the new page arrives and the rail is drawn afresh. Let go after 8s, or on Back, so a navigation that never lands
  // never leaves the page dimmed.
  const [goingTo, setGoingTo] = useState<{ href: string; from: string } | null>(null);
  const pendingView = goingTo && goingTo.from === path ? goingTo.href : null;
  useEffect(() => {
    if (!goingTo) return;
    const stop = () => setGoingTo(null);
    const t = window.setTimeout(stop, 8000);
    window.addEventListener("popstate", stop);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("popstate", stop);
    };
  }, [goingTo]);
  // A new address lets go of both (22 Nov): the rail stays mounted from page to page now (RailFrame), so what an
  // unmount used to clear is cleared here, and coming back to the page a click left never marks that click again.
  const [seenAddress, setSeenAddress] = useState(here);
  if (seenAddress !== here) {
    setSeenAddress(here);
    setGoingTo(null);
    setPending(null);
    // The search and a client's dropped-open screens start afresh on the new page, as a new rail did; All | Needs you
    // is kept (keptFilter), as it always was.
    setQuery("");
    setOpenId(null);
  }
  // The row marked: the one clicked while it loads, else the page you are on.
  const viewOn = (href: string, isHere: boolean) => (pendingView ? pendingView === href : isHere);
  const goView = (href: string, isHere: boolean) => (e: MouseEvent) => {
    // A new tab or window goes the usual way, and the row you are on changes nothing.
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    // The view you are on: an outline still up from another click comes down (the click goes back to this page).
    if (isHere) {
      going(null);
      return;
    }
    setGoingTo({ href, from: path });
    going(href);
  };

  // The client list where it was left (keptListTop): set before the first paint, so a page switch never shows it at the
  // top first. The client you are on is kept in view, brought just inside the list's edge when it would be hidden (a
  // client opened from a link, the Feed, the chat); nothing moves when it shows already.
  const listRef = useRef<HTMLDivElement>(null);
  const placed = useRef(false);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el || el.clientHeight === 0) return; // folded under Settings: the top it is kept at waits for it to unfold
    // The kept top once, as the rail mounts; after that the list stays where it is (the rail is no longer drawn again
    // by each page, 22 Nov) and only the new client is brought into view.
    if (!placed.current) el.scrollTop = keptListTop;
    placed.current = true;
    const row = el.querySelector<HTMLElement>(".rr-row.active");
    if (!row) return;
    const box = el.getBoundingClientRect();
    const at = row.getBoundingClientRect();
    if (at.top < box.top) el.scrollTop += at.top - box.top;
    else if (at.bottom > box.bottom) el.scrollTop += at.bottom - box.bottom;
    keptListTop = el.scrollTop;
    // On mount and when the page's client changes: within a page the list scrolls only under the coach's hand.
  }, [clientId]);
  // Settings folded back to Clients: the list grows out of nothing over .32s, so its top is held to the one kept, frame
  // by frame, until it has its room (at once with reduced motion, where it doesn't ease).
  const wasSettings = useRef(settingsOpen);
  const holding = useRef(false);
  useLayoutEffect(() => {
    const was = wasSettings.current;
    wasSettings.current = settingsOpen;
    const el = listRef.current;
    if (settingsOpen || !was || !el) return;
    const until = performance.now() + 400;
    let frame = 0;
    holding.current = true;
    // The coach's own hand wins: a wheel, a touch or a press on the list lets go of it at once.
    const letGo = () => {
      cancelAnimationFrame(frame);
      holding.current = false;
    };
    const hold = () => {
      el.scrollTop = keptListTop;
      if (holding.current && performance.now() < until) frame = requestAnimationFrame(hold);
      else holding.current = false;
    };
    hold();
    el.addEventListener("wheel", letGo, { passive: true });
    el.addEventListener("touchstart", letGo, { passive: true });
    el.addEventListener("pointerdown", letGo);
    return () => {
      letGo();
      el.removeEventListener("wheel", letGo);
      el.removeEventListener("touchstart", letGo);
      el.removeEventListener("pointerdown", letGo);
    };
  }, [settingsOpen]);
  // Kept as the coach scrolls; not while a search narrows the list, nor while Settings folds or unfolds it (the browser
  // pulls a list with less room toward its top, which is no place the coach left it).
  const keepListTop = () => {
    const el = listRef.current;
    if (el && !q && !settingsOpen && !holding.current && el.clientHeight > 0) keptListTop = el.scrollTop;
  };

  return (
    <aside className={`rr${pendingView ? " going" : ""}`} aria-label="Coach rail">
      {/* In the native app a coach is sent to their phone screens (21 Oct, /coach): the rail is on every admin screen. */}
      <NativeCoachRedirect />
      {/* Back at the window, the page reads itself again (23 Oct, Alex): what the client logged meanwhile shows. */}
      <RefreshOnReturn />
      {/* The rail in B1 (22 Nov, Alex: docs/boards/admin-rail-b-coach-mockup.html): the coach's dark holds their business,
          the banner or NORCOACH, the coach under it and the views; the paper with the clients rises over its foot. */}
      <div className="rr-dark">
      <div className="rr-brand">
        {/* Their banner in its place when they uploaded one (19 Nov, Alex); without one, NORCOACH as before. */}
        {/* NORCOACH as the word alone across the row, no star (22 Nov, Alex: "take out the north star from here… expand it to occupy the whole row"). */}
        <BrandLogo className="rr-logo" banner={rail.coach.banner} bannerRatio={rail.coach.bannerRatio} name={rail.coach.business} nameInPlace={false} word />
      </div>
      {/* The coach: their face, name and business; a click opens their Profile in Settings. */}
      <ViewLink href={`${SETTINGS_HREF}#profile`} className="rr-coach" aria-label={`${rail.coach.name}, your profile`} onClick={goView(SETTINGS_HREF, onSettings)}>
        <span className="rr-coach-avatar" aria-hidden="true">
          {rail.coach.photoPath ? (
            // eslint-disable-next-line @next/next/no-img-element -- an upload served by the app's own route
            <img src={pic(rail.coach.photoPath, 96)} alt="" />
          ) : (
            rail.coach.name.charAt(0).toUpperCase()
          )}
        </span>
        <span className="rr-coach-text">
          <b>{rail.coach.name}</b>
          {/* Their business under them, or who they are when a banner already names it (22 Nov, Alex: B1). */}
          <small>
            {rail.coach.business && !rail.coach.banner ? (
              rail.coach.business
            ) : rail.isOwner ? (
              <>
                Owner<Sep />
                Coach
              </>
            ) : (
              "Coach"
            )}
          </small>
        </span>
      </ViewLink>
      {/* What they pay Norcoach (28 Oct, Alex; lib/billing.ts): a payment that failed, then read-only, as a fact and its
          way to the fix (Settings, Billing). Nothing while it is paid. */}
      {(rail.billing.state === "grace" || rail.billing.state === "readonly") && (
        <Link href="/settings#billing" className="rr-billing">
          <b>{rail.billing.state === "readonly" ? "Read-only" : "Payment failed"}</b>
          <small>{rail.billing.state === "grace" && rail.billing.until ? `Read-only from ${dayMonth(rail.billing.until)}` : "Renew in Billing"}</small>
        </Link>
      )}

      <nav className="rr-nav" aria-label="Views">
        {/* The cross-client views are not redrawn yet: they open where they always were. */}
        {VIEWS.map(({ key, label, Icon }) => {
          const href = REDRAWN[key] ?? `/admin?view=${key}`;
          const isHere = !!(REDRAWN[key] && path?.startsWith(REDRAWN[key]!));
          return (
            <ViewLink key={key} href={href} still={key === "feed" || key === "business"} className={`rr-navrow${viewOn(href, isHere) ? " active" : ""}`} aria-current={isHere ? "page" : undefined} onClick={goView(href, isHere)}>
              <Icon />
              <span>{label}</span>
              {/* The Feed's own Needs you, counted as it lists them (22 Oct: it counted clients, a new one too, and read
                  1 over a Feed that said None). */}
              {key === "phases" && phasesOwed > 0 && (
                <em className="rr-badge" title={`${phasesOwed} thing${phasesOwed === 1 ? "" : "s"} need you`}>
                  {phasesOwed}
                </em>
              )}
              {key === "feed" && feedOwed > 0 && (
                <em className="rr-badge" title={`${feedOwed} thing${feedOwed === 1 ? "" : "s"} need you`}>
                  {feedOwed}
                </em>
              )}
            </ViewLink>
          );
        })}
        {/* Owner only, as before; the coaches page in the redesign (22 Oct). */}
        {rail.isOwner && (
          <ViewLink href={COACHES} className={`rr-navrow${viewOn(COACHES, !!path?.startsWith(COACHES)) ? " active" : ""}`} aria-current={path?.startsWith(COACHES) ? "page" : undefined} onClick={goView(COACHES, !!path?.startsWith(COACHES))}>
            <AccountIcon />
            <span>Coaches</span>
            {/* A coach's support line the owner hasn't read: a rust dot (the inbox is on Coaches). */}
            {rail.supportUnread > 0 && <i className="rd-due" role="img" aria-label="Unread support" title="Unread support" />}
          </ViewLink>
        )}
        {/* Settings, the last view (22 Nov, Alex): the gear, the white pill while on it; its sections are on its page. */}
        <ViewLink href={SETTINGS_HREF} className={`rr-navrow${viewOn(SETTINGS_HREF, onSettings) ? " active" : ""}`} aria-current={onSettings ? "page" : undefined} onClick={goView(SETTINGS_HREF, onSettings)}>
          <GearIcon />
          <span>Settings</span>
          {rail.supportUnread > 0 && !rail.isOwner && <i className="rd-due" role="img" aria-label="Unread support" title="Unread support" />}
        </ViewLink>
      </nav>
      </div>

      <div className="rr-paper">
      <div className="rr-clients-head">
        <span className="rr-label">Clients</span>
        <span className="rr-count">{q || filter === "needs" ? `${shown.length} of ${rail.clients.length}` : rail.clients.length}</span>
      </div>
      <div className="rr-clients">
        <label className="rr-search">
          <SearchIcon />
          <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search clients" aria-label="Search clients" autoComplete="off" />
        </label>
        <div className="rd-btn-group rr-filter" role="group" aria-label="Which clients">
          <button type="button" className={filter === "all" ? "on" : ""} aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
            All
          </button>
          <button type="button" className={filter === "needs" ? "on" : ""} aria-pressed={filter === "needs"} onClick={() => setFilter("needs")}>
            Needs you <small>{needsYou}</small>
          </button>
        </div>
        <div className="rr-list" ref={listRef} onScroll={keepListTop}>
          {/* No clients yet: the list says it by being empty (25 Nov, Alex: "take out the none yet"). */}
          {shown.length === 0 ? (
            rail.clients.length === 0 ? null : <p className="rr-empty">No match</p>
          ) : (
            shown.map((c) => {
              const active = c.id === markedId;
              const open = openId === c.id && c.total > 0;
              return (
                <div key={c.id} className={`rr-item${open ? " open" : ""}`}>
                  <div className="rr-head">
                    {/* Prefetched in full once the pointer rests on it a little longer than on a view (22 Nov: CLIENT_ARM_MS),
                        so the click lands on a page already in; the page writes nothing for being drawn, its visit is
                        written once it is on screen (visitClient). Its outline still shows at once (RailFrame). */}
                    <ViewLink
                      href={`/clients/${c.id}/home`}
                      armAfter={CLIENT_ARM_MS}
                      className={`rr-row${active ? " active" : ""}${pendingId === c.id ? " loading" : ""}${(c as RailClient & { example?: boolean }).example ? " example" : ""}`}
                      aria-current={active ? "page" : undefined}
                      onClick={(e) => {
                        setPendingId(c.id);
                        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                        // The page you are on: no outline, and one still up from another click comes down.
                        going(c.id === clientId && pageKeyOf(path) === `/clients/${c.id}` ? null : `/clients/${c.id}/home`);
                      }}
                    >
                      <span className={`rr-avatar${c.notSignedIn ? " pending" : ""}`} title={c.notSignedIn ? "Hasn't signed in to the app yet" : undefined}>
                        {c.avatarPath ? (
                          // eslint-disable-next-line @next/next/no-img-element -- client-uploaded file
                          <img src={pic(c.avatarPath, 96)} alt="" loading="lazy" decoding="async" />
                        ) : (
                          c.name.slice(0, 1).toUpperCase()
                        )}
                      </span>
                      <span className="rr-name">{c.name}</span>
                      {/* The example client a new coach finds already there (25 Nov, Alex: docs/boards/coach-onboarding-mockup.html):
                          the grey state pill after the name, a flag on the client, never their name. */}
                      {(c as RailClient & { example?: boolean }).example && <span className="rr-example">Example</span>}
                    </ViewLink>
                    {/* How many things need you, a rust number and nothing more said (22 Oct, Alex); a click drops the
                        screens they are on open under the row. */}
                    {c.total > 0 && (
                      <button
                        type="button"
                        className="rr-need"
                        aria-expanded={open}
                        aria-controls={`rr-spots-${c.id}`}
                        aria-label={`${c.total} for ${c.name}: ${c.spots.map((s) => s.screen).join(", ")}`}
                        onClick={() => setOpenId(open ? null : c.id)}
                      >
                        {c.total}
                      </button>
                    )}
                  </div>
                  {c.total > 0 && (
                    // The screens alone, a dot (or how many) on the right; a row opens that screen at the thing.
                    <div id={`rr-spots-${c.id}`} className="rr-spots" inert={!open}>
                      <div className="rr-spots-in">
                        {c.spots.map((s) => (
                          <Link key={s.screen} href={s.href} className="rr-spot" onClick={() => setPendingId(c.id)}>
                            <span>{s.screen}</span>
                            {s.count > 1 ? <small>{s.count}</small> : <i aria-hidden="true" />}
                          </Link>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
        <button type="button" className="rr-new" onClick={() => setAdding(true)}>
          <PlusIcon /> New client
        </button>
      </div>

      </div>

      {adding && <NewClientDialog look="hairline" inviteReady={rail.inviteReady} clerk={rail.clerk} onClose={() => setAdding(false)} />}
    </aside>
  );
}
