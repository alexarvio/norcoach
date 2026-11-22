"use client";

import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import Link from "next/link";
import { dayMonth } from "../../lib/dayMonth";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import RailTour from "./RailTour";
import { AccountIcon, BusinessIcon, CalendarIcon, FeedIcon, GearIcon, PhasesIcon, PlusIcon, SearchIcon } from "../../components/icons";
import { TRAINING_ICON } from "../../lib/eventTypes";
import { logoutAction } from "../../lib/auth-actions";
import NewClientDialog from "../NewClientDialog";
import type { RailClient, RailData } from "./loaders";
import { Sep } from "./Sep";
import NativeCoachRedirect from "../../coach/NativeCoachRedirect";
import RefreshOnReturn from "./RefreshOnReturn";
import { pic } from "../../lib/pic";
import { BrandLogo } from "../../components/BrandLogo";

// The left rail, in the redesign's sheet: the brand, the coach's cross-client
// views as icon rows, every client in one scrolling list, and the coach at
// the foot. A click on the coach opens Settings: it grows up from the foot
// and the client list folds away; a click on Clients (or the coach again)
// brings the list back. Only the client list scrolls.

const VIEWS = [
  // Two groups, parted by space (22 Nov, Alex: "feed, phases, calendar, library, business settings"): every day first,
  // the two counts side by side; then what is opened now and then, Coaches (the owner's) and Settings last.
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
const REDRAWN: Partial<Record<string, string>> = { feed: "/admin/redesign/feed", calendar: "/admin/redesign/calendar", phases: "/admin/redesign/phases", business: "/admin/redesign/business", library: "/admin/redesign/library" };
const COACHES = "/admin/redesign/coaches";
const SETTINGS_HREF = "/admin/redesign/settings";

// Where the client list was left, kept from page to page (4 Nov, Alex: "whenever I switch a page, it kind of like pulls
// the page up. So I have to scroll back down"). Every coach page draws its own rail, so each switch drew a new one at
// the list's top with All picked: the list's scroll and its All | Needs you come back as they were, before the first
// paint. Kept in the tab's memory alone: a reload starts at the top, as the server draws it.
let keptListTop = 0;
let keptFilter: "all" | "needs" = "all";


export default function RedesignRail({ rail, clientId, settings = false }: { rail: RailData; clientId: number; /** On the Settings page: the rail opens on Settings and marks the section open. */ settings?: boolean }) {
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
  // Settings is a view of its own now, a row under the views (22 Nov, Alex): nothing folds in the rail.
  const settingsOpen = false;
  const onSettings = settings || !!path?.startsWith(SETTINGS_HREF);
  // "Take a tour" from the welcome steps.
  const touring = useSearchParams().get("tour") === "1";
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
  const here = `${clientId}:${path}`;
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
  // The row marked: the one clicked while it loads, else the page you are on.
  const viewOn = (href: string, isHere: boolean) => (pendingView ? pendingView === href : isHere);
  const goView = (href: string, isHere: boolean) => (e: MouseEvent) => {
    // A new tab or window goes the usual way, and the row you are on changes nothing.
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || isHere) return;
    setGoingTo({ href, from: path });
  };

  // The client list where it was left (keptListTop): set before the first paint, so a page switch never shows it at the
  // top first. The client you are on is kept in view, brought just inside the list's edge when it would be hidden (a
  // client opened from a link, the Feed, the chat); nothing moves when it shows already.
  const listRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el || el.clientHeight === 0) return; // folded under Settings: the top it is kept at waits for it to unfold
    el.scrollTop = keptListTop;
    const row = el.querySelector<HTMLElement>(".rr-row.active");
    if (!row) return;
    const box = el.getBoundingClientRect();
    const at = row.getBoundingClientRect();
    if (at.top < box.top) el.scrollTop += at.top - box.top;
    else if (at.bottom > box.bottom) el.scrollTop += at.bottom - box.bottom;
    keptListTop = el.scrollTop;
    // On mount alone: within a page the list scrolls only under the coach's hand.
  }, []);
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
        <BrandLogo className="rr-logo" banner={rail.coach.banner} bannerRatio={rail.coach.bannerRatio} name={rail.coach.business} nameInPlace={false} />
      </div>
      {/* The coach: their face, name and business; a click opens their Profile in Settings. */}
      <Link href={`${SETTINGS_HREF}#profile`} className="rr-coach" aria-label={`${rail.coach.name}, your profile`} onClick={goView(SETTINGS_HREF, onSettings)}>
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
      </Link>
      {/* What they pay Norcoach (28 Oct, Alex; lib/billing.ts): a payment that failed, then read-only, as a fact and its
          way to the fix (Settings, Billing). Nothing while it is paid. */}
      {(rail.billing.state === "grace" || rail.billing.state === "readonly") && (
        <Link href="/admin/redesign/settings#billing" className="rr-billing">
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
            <Link key={key} href={href} className={`rr-navrow${key === "library" ? " rr-gap" : ""}${viewOn(href, isHere) ? " active" : ""}`} aria-current={isHere ? "page" : undefined} onClick={goView(href, isHere)}>
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
            </Link>
          );
        })}
        {/* Owner only, as before; the coaches page in the redesign (22 Oct). */}
        {rail.isOwner && (
          <Link href={COACHES} className={`rr-navrow${viewOn(COACHES, !!path?.startsWith(COACHES)) ? " active" : ""}`} aria-current={path?.startsWith(COACHES) ? "page" : undefined} onClick={goView(COACHES, !!path?.startsWith(COACHES))}>
            <AccountIcon />
            <span>Coaches</span>
            {/* A coach's support line the owner hasn't read: a rust dot (the inbox is on Coaches). */}
            {rail.supportUnread > 0 && <i className="rd-due" role="img" aria-label="Unread support" title="Unread support" />}
          </Link>
        )}
        {/* Settings, the last view (22 Nov, Alex): the gear, the white pill while on it; its sections are on its page. */}
        <Link href={SETTINGS_HREF} className={`rr-navrow${viewOn(SETTINGS_HREF, onSettings) ? " active" : ""}`} aria-current={onSettings ? "page" : undefined} onClick={goView(SETTINGS_HREF, onSettings)}>
          <GearIcon />
          <span>Settings</span>
          {rail.supportUnread > 0 && !rail.isOwner && <i className="rd-due" role="img" aria-label="Unread support" title="Unread support" />}
        </Link>
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
          {shown.length === 0 ? (
            <p className="rr-empty">{rail.clients.length === 0 ? "None yet" : "No match"}</p>
          ) : (
            shown.map((c) => {
              const active = c.id === markedId;
              const open = openId === c.id && c.total > 0;
              return (
                <div key={c.id} className={`rr-item${open ? " open" : ""}`}>
                  <div className="rr-head">
                    <Link href={`/admin/redesign/home?client=${c.id}`} className={`rr-row${active ? " active" : ""}${pendingId === c.id ? " loading" : ""}`} aria-current={active ? "page" : undefined} onClick={() => setPendingId(c.id)}>
                      <span className={`rr-avatar${c.notSignedIn ? " pending" : ""}`} title={c.notSignedIn ? "Hasn't signed in to the app yet" : undefined}>
                        {c.avatarPath ? (
                          // eslint-disable-next-line @next/next/no-img-element -- client-uploaded file
                          <img src={pic(c.avatarPath, 96)} alt="" loading="lazy" decoding="async" />
                        ) : (
                          c.name.slice(0, 1).toUpperCase()
                        )}
                      </span>
                      <span className="rr-name">{c.name}</span>
                    </Link>
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

      {touring && <RailTour />}
      {adding && <NewClientDialog look="hairline" inviteReady={rail.inviteReady} clerk={rail.clerk} onClose={() => setAdding(false)} />}
    </aside>
  );
}
