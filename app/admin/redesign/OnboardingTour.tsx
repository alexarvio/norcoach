"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter } from "next/navigation";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "../../components/ui/dialog";
import { markTourSeenAction } from "../../lib/tourActions";
import type { RailClient } from "./loaders";
import { useRail } from "./RailFrame";
import { clientScreenOf, clientTab, viewOfPath, type ClientTabKey } from "./paths";
import { Sep } from "./Sep";
import { TOUR_EVENT } from "./tourTrigger";
import "./training/trn.css";
import "./onboarding-tour.css";

// The coach's onboarding (25 Nov, Alex: docs/boards/coach-onboarding-mockup.html). Mounted once by the admin's layout,
// beside the rail, so it stays from page to page.
//
// The welcome: the first time a coach with an example client opens a framed admin screen and has never seen it, a pop-up
// in the pop-ups' C, `Welcome, {First}`, what the example client is and how to delete him, Not now in words and Start
// tour the brand pill. Either way (✕ and Esc too) it is seen, once (coach_settings.tour_seen_at), and help's Take the
// tour is the way back to it.
//
// The tour: thirteen steps, the rail, then into the example client's tabs (the tour opens the tab it talks about), then
// Settings, the chat and help. The page dims; the part the step is on stays lit, ringed in white (a box-shadow cut-out);
// its card beside it, never past the window's edge, in Norcoach's C: the dark head with the faint star (the coach's own
// logo when set), where it is and how far along in small caps, the title white; the paper rising over its foot with the
// words, Skip and Back in words, Next the brand pill (Done on the last). Esc or Skip ends it; Enter or → next, ← back.
// With no example client (deleted, or a coach from before) the client steps are left out. Prefix ntour- (ntw- the
// welcome), onboarding-tour.css.

type Side = "right" | "below" | "left";
type Step = { where: "rail" | "client" | "edge"; what: string; title: string; text: string; find: string; side: Side; tab?: ClientTabKey };

const tabButton = (label: string) => `.rd-nav:not(.rd-skel-nav) button[data-label="${label}"]`;

// The board's words, exactly (25 Nov, Alex: "way better worded, which is nicer to read").
const STEPS: Step[] = [
  { where: "rail", what: "Feed", title: "Feed", find: '.rr-nav a[href="/feed"]', side: "right", text: "Your notification centre. Here you see what your clients are doing, and everything that needs your attention, such as messages to answer and videos to review." },
  { where: "rail", what: "Phases", title: "Phases", find: '.rr-nav a[href="/phases"]', side: "right", text: "Every client's plan on one timeline. Here you see at a glance whose phase is ending and who needs a new one." },
  { where: "rail", what: "Calendar", title: "Calendar", find: '.rr-nav a[href="/calendar"]', side: "right", text: "Here you plan your week: calls with clients, one-to-one training sessions, and anything else of your own." },
  { where: "rail", what: "Library", title: "Library", find: '.rr-nav a[href="/library"]', side: "right", text: "Your exercises and their demo videos. You decide, client by client, whether they can watch a demo in their workout." },
  { where: "rail", what: "New client", title: "Add a client", find: ".rr-new", side: "right", text: "Here is where you add your clients." },
  { where: "client", what: "Home", title: "Overview", find: tabButton("Home"), side: "below", tab: "home", text: "An overview of each client on one screen: their phases, strength, weight and consistency, together with their meetings and invoices." },
  { where: "client", what: "Plan", title: "Plan", find: tabButton("Plan"), side: "below", tab: "plan", text: "Their training, nutrition and lifestyle phases on one timeline, together with their events, such as trips and holidays." },
  { where: "client", what: "Lifestyle", title: "Lifestyle", find: tabButton("Lifestyle"), side: "below", tab: "measurements", text: "Deploy personalised metrics for your client to fill in each day, week or month, such as weight, sleep or steps, and collect their answers as they come in." },
  { where: "client", what: "Training", title: "Training", find: tabButton("Training"), side: "below", tab: "training", text: "Here is where you create and deploy personalised programmes for every client's needs, week by week. Choose the columns you work with, and follow every set they log." },
  { where: "client", what: "Nutrition", title: "Nutrition", find: tabButton("Nutrition"), side: "below", tab: "nutrition", text: "Here is where you set your client's nutritional targets, and which supplements they take, how much and when. You also see every meal they log in the app." },
  { where: "rail", what: "Settings", title: "Settings", find: '.rr-nav a[href="/settings"]', side: "right", text: "Here is where you set up your profile and your business: your logo and brand colour, the Norcode your clients join you with, and your invoice details." },
  { where: "edge", what: "Chat", title: "Chat", find: "button.rd-chattab", side: "left", text: "Here is where you chat with each of your clients." },
  { where: "edge", what: "?", title: "Help", find: ".hlp-tab", side: "left", text: "Here you find guides and tutorials for Norcoach, and you can contact our team whenever you have a question." },
];

/** How long a step looks for its part (a tab still loading) before its card shows alone in the middle. */
const GIVE_UP_MS = 8000;
const LOOK_EVERY_MS = 120;
/** A tab clicked is given this long to come forward before it is clicked again. */
const CLICK_GAP_MS = 700;
const CARD_W = 320;
const EDGE = 16;
const GAP = 12;
/** The point never nearer a corner than this (the card's 20px radius). */
const NUB_IN = 22;
/** The point: a 14px square turned, half of it showing past the card's edge. */
const NUB = 14;
/** The white ring's room round the part (4px of the part's own cut-out, then the 4px ring). */
const PAD = 4;

type Box = { top: number; left: number; width: number; height: number; radius: number };
const sameBox = (a: Box | null, b: Box) => !!a && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height && a.radius === b.radius;

/** Where the card goes: on its step's side of the part when it fits, else the next side that does, kept inside the window.
 *  Lined up on the part's edge as the To do's pop-over is on its pill (25 Nov, Alex: "align these pop-ups just the same
 *  way you did with the to-do pop-up"): beside a rail row or an edge tab its top level with the ring's top, under a tab
 *  its left edge on the ring's left; its point (`nub`, px along that edge) on the part's middle. */
type Placed = { top: number; left: number; on: Side | "above"; nub: number };
function cardAt(box: Box | null, side: Side, w: number, h: number): Placed | null {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const clampX = (x: number) => Math.min(Math.max(EDGE, x), Math.max(EDGE, vw - w - EDGE));
  const clampY = (y: number) => Math.min(Math.max(EDGE, y), Math.max(EDGE, vh - h - EDGE));
  if (!box) return { top: clampY((vh - h) / 2), left: clampX((vw - w) / 2), on: "below", nub: -1 };
  const ring = PAD + 4;
  const out = ring + GAP;
  const fits: Record<Side, boolean> = {
    right: box.left + box.width + out + w <= vw - EDGE,
    below: box.top + box.height + out + h <= vh - EDGE,
    left: box.left - out - w >= EDGE,
  };
  const order: Side[] = [side, ...(["right", "below", "left"] as Side[]).filter((s) => s !== side)];
  const pick = order.find((s) => fits[s]);
  const midY = box.top + box.height / 2;
  const midX = box.left + box.width / 2;
  const along = (mid: number, from: number, len: number) => Math.min(len - NUB_IN, Math.max(NUB_IN, mid - from));
  if (pick === "right" || pick === "left") {
    // A part low on the window (New client at the rail's foot): the card may come 8px from the window's foot, so its
    // point still reaches the part's middle.
    const top = Math.max(EDGE, Math.min(box.top - ring, vh - h - 8));
    return { top, left: pick === "right" ? box.left + box.width + out : box.left - out - w, on: pick, nub: along(midY, top, h) };
  }
  const left = clampX(box.left - ring);
  const top = pick === "below" ? box.top + box.height + out : clampY(box.top - out - h);
  return { top, left, on: pick ?? "above", nub: along(midX, left, w) };
}

const firstOf = (name: string | null | undefined) => (name ?? "").trim().split(/\s+/)[0] ?? "";

export default function OnboardingTour({ seen, example: given }: { /** coach_settings.tour_seen_at is set. */ seen: boolean; /** The coach's example client, as the layout read it. */ example: { id: number; name: string } | null }) {
  const path = usePathname();
  const router = useRouter();
  const { rail } = useRail();
  const framed = viewOfPath(path) != null;

  // The example client: the rail's own flagged row (read afresh on every move), else the layout's while the rail lists it.
  const flagged = rail?.clients.find((c) => (c as RailClient & { example?: boolean }).example);
  const example = flagged ? { id: flagged.id, name: flagged.name } : given && (!rail || rail.clients.some((c) => c.id === given.id)) ? given : null;
  const exampleId = example?.id ?? null;
  const exampleName = example?.name ?? "";
  const coachFirst = firstOf(rail?.coach.name);
  const hasRail = rail != null;

  const [seenNow, setSeenHere] = useState(seen);
  // Seen in another tab, read again with the layout: seen here too.
  const seenHere = seen || seenNow;
  const [welcome, setWelcome] = useState(false);
  const [running, setRunning] = useState(false);
  const [at, setAt] = useState(0);
  /** Each start of the tour, so a part measured on an earlier run is never taken for this one's. */
  const [run, setRun] = useState(0);

  const markSeen = useCallback(() => {
    setSeenHere(true);
    setWelcome(false);
    markTourSeenAction().catch(() => {});
  }, []);
  const seenRef = useRef(seenHere);
  useEffect(() => {
    seenRef.current = seenHere;
  }, [seenHere]);
  // The steps of this run, fixed as it starts: Sam arriving or going meanwhile never shifts the steps under the count.
  const [steps, setSteps] = useState<Step[]>(STEPS);
  const exampleRef = useRef(exampleId);
  useEffect(() => {
    exampleRef.current = exampleId;
  }, [exampleId]);
  const start = useCallback(() => {
    if (!seenRef.current) markSeen();
    setWelcome(false);
    // One panel on the right at a time (help/sidePanels.ts): the chat, help and the To do all shut for the tour.
    window.dispatchEvent(new CustomEvent("norcoach:side-panel", { detail: "tour" }));
    setSteps(exampleRef.current == null ? STEPS.filter((s) => s.where !== "client") : STEPS);
    setAt(0);
    setRun((n) => n + 1);
    setRunning(true);
  }, [markSeen]);
  const end = useCallback(() => setRunning(false), []);

  // Take the tour (help), and the old welcome steps' ?tour=1, which leaves the address as it starts.
  useEffect(() => {
    const go = () => start();
    window.addEventListener(TOUR_EVENT, go);
    return () => window.removeEventListener(TOUR_EVENT, go);
  }, [start]);
  useEffect(() => {
    if (!framed) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("tour") !== "1") return;
    url.searchParams.delete("tour");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    const t = window.setTimeout(start, 0);
    return () => window.clearTimeout(t);
  }, [framed, path, start]);

  // The welcome, once: after the admin's opening has gone (AdminOpening's `.nc-boot`), never over the tour.
  useEffect(() => {
    if (seenHere || exampleId == null || !hasRail || !framed || running || welcome) return;
    let t = 0;
    const wait = () => {
      t = document.querySelector(".nc-boot") ? window.setTimeout(wait, 300) : window.setTimeout(() => setWelcome(true), 500);
    };
    wait();
    return () => window.clearTimeout(t);
  }, [seenHere, exampleId, hasRail, framed, running, welcome]);

  const step = running ? steps[Math.min(at, steps.length - 1)] : null;
  const last = at >= steps.length - 1;
  const next = useCallback(() => (last ? end() : setAt((n) => n + 1)), [last, end]);
  const back = useCallback(() => setAt((n) => Math.max(0, n - 1)), []);

  // The part the step is on, looked for until it is there (a tab of the example client opened first) and kept measured
  // while the step shows, so the ring follows the window and the edge tabs as they slide. Null while looking; "none"
  // when it never came: the card then shows alone in the middle.
  // Kept with the step it was measured for (`run:at`), so a new step reads as looking until its own part is found.
  const [found, setFound] = useState<{ key: string; box: Box | "none" } | null>(null);
  const stepKey = `${run}:${at}`;
  const box = running && found?.key === stepKey ? found.box : null;
  const stepFind = step?.find ?? null;
  const stepTab = step?.tab ?? null;
  useEffect(() => {
    if (!running || !stepFind) return;
    const setBox = (b: Box | "none") => setFound((had) => (had?.key === stepKey && (had.box === b || (had.box !== "none" && b !== "none" && sameBox(had.box, b))) ? had : { key: stepKey, box: b }));
    // Counted in looks, not read off the clock.
    let looks = 0;
    let pushed = false;
    let clickedAt = -Infinity;
    const look = (): boolean => {
      looks++;
      const el = document.querySelector<HTMLElement>(stepFind);
      if (stepTab && exampleId != null) {
        const here = clientScreenOf(window.location.pathname);
        if (here?.clientId !== exampleId) {
          if (!pushed) {
            pushed = true;
            router.push(clientTab(stepTab, exampleId));
          }
          return false;
        }
        if (!el) return false;
        if (!el.classList.contains("on")) {
          if ((looks - clickedAt) * LOOK_EVERY_MS > CLICK_GAP_MS) {
            clickedAt = looks;
            el.click();
          }
          return false;
        }
      }
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return false;
      if (r.bottom < 0 || r.top > window.innerHeight) el.scrollIntoView({ block: "nearest" });
      const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
      const b: Box = { top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height), radius: Math.min(999, Math.round(radius)) };
      setBox(b);
      return true;
    };
    // A part found once and gone a moment (a tab drawn again) keeps its last place; one never found gives up.
    let ever = false;
    const tick = () => {
      if (look()) ever = true;
      // A tab of Sam's is given time to load; a part of the rail or the edge is there at once or not at all (no chat tab
      // on a screen without one), so its card shows in the middle without the page sitting dimmed.
      else if (!ever && looks * LOOK_EVERY_MS > (stepTab ? GIVE_UP_MS : 600)) setBox("none");
    };
    tick();
    const every = window.setInterval(tick, LOOK_EVERY_MS);
    window.addEventListener("resize", tick);
    return () => {
      window.clearInterval(every);
      window.removeEventListener("resize", tick);
    };
  }, [running, stepKey, stepFind, stepTab, exampleId, router]);

  // The card's own height, for where it goes.
  const card = useRef<HTMLDivElement>(null);
  const [cardH, setCardH] = useState(220);
  useLayoutEffect(() => {
    const h = card.current?.offsetHeight;
    if (h && h !== cardH) setCardH(h);
  }, [stepKey, box, cardH]);

  // Next takes the keyboard on each step; Esc ends, Enter or → next, ← back.
  const nextBtn = useRef<HTMLButtonElement>(null);
  const shown = running && box !== null;
  useEffect(() => {
    if (shown) nextBtn.current?.focus({ preventScroll: true });
  }, [shown, at]);
  useEffect(() => {
    if (!running) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        end();
      } else if (e.key === "ArrowRight" || (e.key === "Enter" && !(e.target as HTMLElement | null)?.closest?.("button"))) {
        e.preventDefault();
        next();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        back();
      }
    };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, [running, next, back, end]);

  const welcomeStart = useRef<HTMLButtonElement>(null);
  const exampleFirst = firstOf(exampleName);

  if (!framed) return null;
  const lit = box && box !== "none" ? box : null;
  const w = typeof window === "undefined" ? CARD_W : Math.min(CARD_W, window.innerWidth - EDGE * 2);
  const place = shown && step ? cardAt(lit, step.side, w, cardH) : null;

  return (
    <>
      {welcome && example && (
        <Dialog open onOpenChange={(o) => !o && markSeen()}>
          <DialogContent
            className="dlh ntw"
            onOpenAutoFocus={(e) => {
              e.preventDefault();
              welcomeStart.current?.focus({ preventScroll: true });
            }}
          >
            <div className="dlh-head">
              <DialogTitle className="dlh-title">{coachFirst ? `Welcome, ${coachFirst}` : "Welcome"}</DialogTitle>
              <DialogClose className="dlh-x" aria-label="Close">
                ✕
              </DialogClose>
            </div>
            <DialogDescription className="dlh-text">
              {exampleName} is an example client, with eight weeks of training, check-ins and meals already logged, so every screen has something to show.
            </DialogDescription>
            <p className="dlh-text">When you no longer need him, open his Home and choose Delete {exampleFirst} in the ⋯ menu.</p>
            <p className="dlh-text">The tour takes you through each screen in thirteen short steps.</p>
            <div className="dlh-foot">
              <DialogClose className="dlh-cancel">Not now</DialogClose>
              <button ref={welcomeStart} type="button" className="dlh-go" onClick={start}>
                Start tour
              </button>
            </div>
          </DialogContent>
        </Dialog>
      )}
      {running &&
        step &&
        createPortal(
          <div className={`ntour${lit ? "" : " plain"}`} role="dialog" aria-modal="true" aria-labelledby="ntour-title">
            {lit && <div className="ntour-lit" style={{ top: lit.top - PAD, left: lit.left - PAD, width: lit.width + PAD * 2, height: lit.height + PAD * 2, borderRadius: lit.radius >= 999 ? 999 : lit.radius + PAD }} />}
            {/* The card's point on its part, as the To do's nub on its pill: a turned square in the head's colour (white
                when it falls past the head, the card above its part), half under the card's edge. */}
            {place && place.nub >= 0 && (
              <span
                className={`ntour-nub${place.on === "above" ? " paper" : ""}`}
                aria-hidden="true"
                style={
                  place.on === "right"
                    ? { top: place.top + place.nub - NUB / 2, left: place.left - NUB / 2 }
                    : place.on === "left"
                      ? { top: place.top + place.nub - NUB / 2, left: place.left + w - NUB / 2 }
                      : place.on === "below"
                        ? { top: place.top - NUB / 2, left: place.left + place.nub - NUB / 2 }
                        : { top: place.top + cardH - NUB / 2, left: place.left + place.nub - NUB / 2 }
                }
              />
            )}
            {place && (
              <div ref={card} className="ntour-card" style={{ top: place.top, left: place.left, width: w } as CSSProperties}>
                <div className="ntour-head">
                  <div className="ntour-top">
                    <span>
                      {step.where === "client" ? exampleFirst : step.where === "rail" ? "Rail" : "Edge"}
                      <Sep />
                      {step.what}
                    </span>
                    <em>
                      {at + 1} of {steps.length}
                    </em>
                  </div>
                  <h2 id="ntour-title" className="ntour-title">
                    {step.title}
                  </h2>
                </div>
                <div className="ntour-body">
                  <p className="ntour-text">{step.text}</p>
                  <div className="ntour-foot">
                    <button type="button" className="ntour-word" onClick={end}>
                      Skip
                    </button>
                    <span className="ntour-go">
                      {at > 0 && (
                        <button type="button" className="ntour-word ink" onClick={back}>
                          Back
                        </button>
                      )}
                      <button ref={nextBtn} type="button" className="ntour-next" onClick={next}>
                        {last ? "Done" : "Next"}
                      </button>
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>,
          document.body
        )}
    </>
  );
}
