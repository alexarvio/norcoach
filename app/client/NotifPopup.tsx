"use client";

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { notificationTypeOf, type NotificationCategory } from "../lib/notificationTypes";
import type { EventTypeId } from "../lib/eventTypes";
import type { LinkView } from "../lib/messageLinks";
import { pic } from "../lib/pic";
import { TypeIcon } from "./events/AddEventSheet";
import { Bars } from "./Bars";
import { clockRange, dayWords, monthWords, weekdayWords } from "../lib/clientDates";
import { meetingTypeOf } from "../lib/meetingTypes";
import type { VideoReplyView } from "./VideoReplySheet";
import "./notif-popup.css";

// The notification pop-up (19 Nov, Alex: A of docs/boards/notification-popup-mockup.html): a push tapped opens the app on
// that notification in a card over the dimmed app, then the other unread ones that buzzed since the app was last open,
// newest after it, five at most, as a stack. Swiped sideways either way, or ‹ ›, until one is viewed (Alex: "if I go to
// the third one… I go back to the first one"). View lands on it as a tap in the bell list does and reads only it; the
// rest go and stay unread in the bell (Alex: "whenever I view one… they all disappear"). Close: all go, none read.

/** One notification as the pop-up draws it (app/lib/notifPopup.ts popupNotesFor), the first the one tapped. */
export type PopupNote = {
  id: number;
  category: NotificationCategory;
  eventType: EventTypeId | null;
  title: string;
  body: string | null;
  createdAt: string;
  actionTab: string | null;
  actionRef: number | null;
  videoReply: VideoReplyView | null;
  link: LinkView | null;
  /** What it is about, drawn on the paper (22 Nov, Alex: C of docs/boards/notification-popup-kinds-mockup.html); null:
   *  the coach's words as before. */
  thing: PopupThing | null;
};

/** The thing a notification is about, as the pop-up's paper draws it (app/lib/notifPopup.ts thingOf). Days are
 *  YYYY-MM-DD and times HH:MM, already in the phone's zone. */
export type PopupThing =
  | { kind: "programme"; name: string; weeks: number; perWeek: number; from: string | null }
  | { kind: "targets"; name: string; kcal: number; protein: number | null; carbs: number | null; fat: number | null }
  | { kind: "phase"; track: "training" | "nutrition" | "lifestyle"; name: string; from: string; to: string | null; weeks: number | null }
  | { kind: "video"; frame: string | null; words: string | null; exercise: string; sentOn: string | null }
  | { kind: "call"; state: "booked" | "moved" | "cancelled"; date: string; time: string; minutes: number; topic: string; type: "checkin" | "review" | "other"; every: string | null; count: number | null; last: string | null }
  | { kind: "focus"; goals: string[] }
  | { kind: "goal"; target: number; unit: "kg" | "lbs"; byDate: string; now: number | null; toGo: number | null }
  | { kind: "invoice"; number: string; what: string; total: number; currency: string; due: string | null }
  | { kind: "shape"; angles: { label: string; photo: string | null }[] };

const MAX = 5;

// When the app last went to the back (19 Nov): "since the client was last in the app" is read from it. A push tapped
// from a closed app opens /client and then hops to /client?n=, so the hop's own hide (seconds ago) is passed over.
const LAST_IN_KEY = "norcoach-last-in";
const HOP_MS = 20_000;
function readHides(): number[] {
  try {
    const v = JSON.parse(window.localStorage.getItem(LAST_IN_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : [];
  } catch {
    return [];
  }
}
function lastIn(now = Date.now()): number | null {
  return readHides().filter((t) => now - t > HOP_MS).sort((a, b) => b - a)[0] ?? null;
}

/** Keeps the app's last times to the back on the phone (mounted once in the client's own app). */
export function useLastInStamp(on: boolean) {
  useEffect(() => {
    if (!on) return;
    const hide = () => {
      if (document.visibilityState !== "hidden") return;
      try {
        window.localStorage.setItem(LAST_IN_KEY, JSON.stringify([Date.now(), ...readHides()].slice(0, 3)));
      } catch {
        /* blocked storage: the pop-up shows the one tapped alone */
      }
    };
    document.addEventListener("visibilitychange", hide);
    return () => document.removeEventListener("visibilitychange", hide);
  }, [on]);
}

export default function NotifPopup({ notes, coachName, coachPhoto, onView, onClose }: { notes: PopupNote[]; coachName: string; coachPhoto: string | null; onView: (n: PopupNote) => void; onClose: () => void }) {
  const coachFirst = coachName.trim().split(/\s+/)[0] || "Coach";
  // The others since the app was last open, read on the phone after the first frame (the page can't know it).
  const [list, setList] = useState<PopupNote[] | null>(null);
  useEffect(() => {
    const t = setTimeout(() => {
      const since = lastIn();
      const [tapped, ...rest] = notes;
      const others = since == null ? [] : rest.filter((n) => Date.parse(n.createdAt) > since);
      setList(tapped ? [tapped, ...others].slice(0, MAX) : []);
    }, 0);
    return () => clearTimeout(t);
  }, [notes]);
  const [index, setIndex] = useState(0);
  const [from, setFrom] = useState<"left" | "right" | null>(null);
  const [drag, setDrag] = useState(0);
  const start = useRef<{ x: number; y: number; id: number; sideways: boolean | null } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") go(1);
      if (e.key === "ArrowLeft") go(-1);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  if (!list || !list.length) return null;
  const n = list[Math.min(index, list.length - 1)];
  const several = list.length > 1;
  function go(by: 1 | -1) {
    if (!list) return;
    const next = index + by;
    if (next < 0 || next >= list.length) return;
    setFrom(by > 0 ? "right" : "left");
    setIndex(next);
  }

  // A sideways swipe either way (an up-and-down one is left alone); a short one springs back.
  const down = (e: ReactPointerEvent) => {
    if (!several || (e.target as HTMLElement).closest("button")) return;
    start.current = { x: e.clientX, y: e.clientY, id: e.pointerId, sideways: null };
  };
  const move = (e: ReactPointerEvent) => {
    const s = start.current;
    if (!s || s.id !== e.pointerId) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (s.sideways == null && Math.hypot(dx, dy) > 8) {
      s.sideways = Math.abs(dx) > Math.abs(dy);
      if (s.sideways) (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
    if (!s.sideways) return;
    // Past either end it gives a little, as a list's edge does.
    const edge = (dx > 0 && index === 0) || (dx < 0 && index === list.length - 1);
    setDrag(edge ? dx / 4 : dx);
  };
  const up = (e: ReactPointerEvent) => {
    const s = start.current;
    start.current = null;
    if (!s || s.id !== e.pointerId) return;
    const dx = e.clientX - s.x;
    setDrag(0);
    if (!s.sideways || Math.abs(dx) < 48) return;
    go(dx < 0 ? 1 : -1);
  };

  const t = notificationTypeOf(n.category, n.eventType);
  const system = n.category === "system" || n.thing?.kind === "shape";
  // No time on it (22 Nov, Alex: "take out the time"): the push just came. With no thing to show, the coach's own words
  // grey on the paper; facts (more than one, " · " apart as written) on the drawn bar.
  const parts = n.body ? n.body.split(" · ").map((p) => p.trim()).filter(Boolean) : [];
  const words = parts.length === 1 ? parts[0] : null;
  const facts = parts.length > 1 ? parts : [];
  const edges = Math.min(list.length - 1, 2);
  // The kind's colour, lighter on the dark so it reads there (its own on the paper).
  const light = lighter(t.rgb);

  return createPortal(
    <div className="nfp" onClick={onClose}>
      <div className={`nfp-stack edges-${edges}`} onClick={(e) => e.stopPropagation()}>
        {edges > 1 && <span className="nfp-edge e2" aria-hidden="true" />}
        {edges > 0 && <span className="nfp-edge e1" aria-hidden="true" />}
        <div
          key={n.id}
          className={`nfp-card${from ? ` from-${from}` : ""}${drag ? " dragging" : ""}`}
          role="dialog"
          aria-modal="true"
          aria-labelledby="nfp-title"
          style={{ "--c": t.color, "--rgb": t.rgb, "--c-light": light, ...(drag ? { transform: `translateX(${drag}px)` } : {}) } as CSSProperties}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
        >
          {/* The coach's dark (22 Nov, Alex: C of docs/boards/notification-popup-kinds-mockup.html): Home's head in small,
              their brand colour and their logo faint in it, their face with the kind's badge and what they did. */}
          <div className="nfp-dark">
            {several && <span className="nfp-count">{`${index + 1} of ${list.length}`}</span>}
            <div className="nfp-who">
              <span className="ntf-avatar nfp-face" aria-hidden="true">
                {system ? (
                  <span className="ntf-avatar-sys">
                    <TypeIcon path={t.icon} size={18} stroke={1.6} />
                  </span>
                ) : coachPhoto ? (
                  <img src={pic(coachPhoto, 96)} alt="" decoding="async" />
                ) : (
                  <span className="ntf-avatar-initial">{coachFirst.charAt(0).toUpperCase()}</span>
                )}
                {!system && (
                  <span className="ntf-badge">
                    <TypeIcon path={t.icon} size={10} stroke={2.6} />
                  </span>
                )}
              </span>
              <div className="nfp-text">
                <span className="nfp-kind">{t.label}</span>
                <h2 id="nfp-title" className="nfp-title">
                  {n.title}
                </h2>
              </div>
            </div>
          </div>
          <div className="nfp-paper">
            {n.thing ? (
              <Thing thing={n.thing} />
            ) : (
              <div className="nfp-plain">
                {words && <p className="nfp-words">{words}</p>}
                {facts.length > 0 && (
                  <div className="nfp-facts">
                    <Bars parts={facts} />
                  </div>
                )}
              </div>
            )}
            <div className="nfp-foot">
              <button type="button" className="nfp-close" onClick={onClose}>
                Close
              </button>
              <div className="nfp-acts">
                {several && (
                  <>
                    <button type="button" className="nfp-arrow" onClick={() => go(-1)} disabled={index === 0} aria-label="Previous">
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="m14.5 6-6 6 6 6" />
                      </svg>
                    </button>
                    <button type="button" className="nfp-arrow" onClick={() => go(1)} disabled={index === list.length - 1} aria-label="Next">
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="m9.5 6 6 6-6 6" />
                      </svg>
                    </button>
                  </>
                )}
                <button type="button" className="nfp-view" onClick={() => onView(n)}>
                  {viewWord(n.thing)}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

/** The kind's colour mixed halfway to white: its words on the dark. */
function lighter(rgb: string): string {
  const [r, g, b] = rgb.split(",").map((x) => Number(x.trim()));
  const mix = (v: number) => Math.round(v + (255 - v) * 0.5);
  return Number.isFinite(r) ? `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})` : "#fff";
}

/** View's word, as the thing is (the board's: View call, Watch, Take them). */
function viewWord(thing: PopupThing | null): string {
  if (!thing) return "View";
  switch (thing.kind) {
    case "programme":
      return "View programme";
    case "targets":
      return "View targets";
    case "phase":
      return "View phase";
    case "video":
      return "Watch";
    case "call":
      return thing.state === "cancelled" ? "View meetings" : thing.count ? "View calls" : "View call";
    case "goal":
      return "View goal";
    case "invoice":
      return "View invoice";
    case "shape":
      return "Take them";
    default:
      return "View";
  }
}

const TRACK_LABEL = { training: "Training", nutrition: "Nutrition", lifestyle: "Lifestyle" } as const;
const KG_TO_LBS = 2.20462;
const oneDp = (v: number) => (Math.round(v * 10) / 10).toLocaleString("en-GB", { maximumFractionDigits: 1 });

/** A call's day as the Meetings tile draws it: the weekday small over the day's numeral, the month under it. */
function DayTile({ date, struck = false }: { date: string; struck?: boolean }) {
  return (
    <span className={`nfp-tile${struck ? " struck" : ""}`} aria-hidden="true">
      <small>{weekdayWords(date, { short: true })}</small>
      <b>{Number(date.slice(8, 10))}</b>
      <i>{monthWords(date, { short: true, year: false })}</i>
    </span>
  );
}

/** The paper: what the notification is about, one drawing per kind. */
function Thing({ thing }: { thing: PopupThing }) {
  switch (thing.kind) {
    case "programme":
      return (
        <div className="nfp-thing">
          <b className="nfp-big">{thing.name}</b>
          <div className="nfp-fact">
            <Bars parts={[`${thing.weeks} ${thing.weeks === 1 ? "week" : "weeks"}`, thing.perWeek ? `${thing.perWeek} ${thing.perWeek === 1 ? "session" : "sessions"} a week` : null, thing.from ? `from ${dayWords(thing.from)}` : null].filter((x): x is string => !!x)} />
          </div>
        </div>
      );
    case "targets":
      return (
        <div className="nfp-thing">
          <div className="nfp-kcal">
            <b>{thing.kcal.toLocaleString("en-GB")}</b>
            <span>KCAL</span>
          </div>
          <div className="nfp-macros">
            {([["Protein", thing.protein, "#334eac"], ["Carbs", thing.carbs, "#d99a2b"], ["Fat", thing.fat, "#2e8b79"]] as const).map(([label, g, c]) => (
              <span key={label} style={{ borderLeftColor: c }}>
                <b>{g != null ? `${Math.round(g)} g` : "—"}</b>
                <small>{label}</small>
              </span>
            ))}
          </div>
          {thing.name && <div className="nfp-fact">{thing.name}</div>}
        </div>
      );
    case "phase":
      return (
        <div className="nfp-thing">
          <b className="nfp-big">{thing.name}</b>
          <div className="nfp-fact">
            <Bars parts={[TRACK_LABEL[thing.track], thing.to ? `${dayWords(thing.from)} → ${dayWords(thing.to)}` : `From ${dayWords(thing.from)}`, thing.weeks ? `${thing.weeks} ${thing.weeks === 1 ? "week" : "weeks"}` : null].filter((x): x is string => !!x)} />
          </div>
        </div>
      );
    case "video":
      return (
        <div className="nfp-thing nfp-video">
          <span className="nfp-frame" aria-hidden="true">
            {thing.frame && <img src={thing.frame} alt="" decoding="async" />}
            <span className="nfp-play">
              <svg viewBox="0 0 24 24">
                <path d="M8 5.5v13l10.5-6.5z" />
              </svg>
            </span>
          </span>
          <div>
            {thing.words && <p className="nfp-say">{thing.words}</p>}
            <div className="nfp-fact">
              <Bars parts={[thing.exercise, thing.sentOn ? dayWords(thing.sentOn, { weekday: "short" }) : null].filter((x): x is string => !!x)} />
            </div>
          </div>
        </div>
      );
    case "call": {
      const type = meetingTypeOf(thing.type);
      const cancelled = thing.state === "cancelled";
      const when = thing.time ? clockRange(`${thing.date}T${thing.time}`, addMinutes(thing.date, thing.time, thing.minutes)) : "All day";
      return (
        <div className={`nfp-thing nfp-call${cancelled ? " cancelled" : ""}`}>
          <DayTile date={thing.date} struck={cancelled} />
          <div className="nfp-what">
            <b>{thing.every ?? (thing.topic || `${type.label} call`)}</b>
            <span className="nfp-fact">
              <Bars
                parts={[
                  when,
                  cancelled ? (thing.count ? `${thing.count} calls cancelled` : "Cancelled") : thing.count && thing.last ? `${thing.count} calls to ${dayWords(thing.last)}` : thing.state === "moved" ? "New time" : thing.time ? `${thing.minutes} min` : null,
                ].filter((x): x is string => !!x)}
              />
            </span>
            {!cancelled && (
              <span className="nfp-tag" style={{ color: type.color, background: `rgba(${type.rgb}, 0.1)` }}>
                <TypeIcon path={type.icon} size={11} stroke={2} />
                {type.label}
              </span>
            )}
          </div>
        </div>
      );
    }
    case "focus":
      return (
        <ol className="nfp-thing nfp-goals">
          {thing.goals.map((g, i) => (
            <li key={i}>
              <i>{i + 1}</i>
              <span>{g}</span>
            </li>
          ))}
        </ol>
      );
    case "goal": {
      const lbs = thing.unit === "lbs";
      const w = (kg: number) => `${oneDp(lbs ? kg * KG_TO_LBS : kg)} ${lbs ? "lbs" : "kg"}`;
      return (
        <div className="nfp-thing nfp-goal">
          <span className="nfp-target" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="8.5" />
              <circle cx="12" cy="12" r="4.5" />
              <circle cx="12" cy="12" r="0.8" />
            </svg>
          </span>
          <div>
            <b className="nfp-big">{`${w(thing.target)} by ${dayWords(thing.byDate)}`}</b>
            {(thing.now != null || thing.toGo != null) && (
              <div className="nfp-fact">
                <Bars parts={[thing.now != null ? `Now ${w(thing.now)}` : null, thing.toGo != null && thing.toGo > 0 ? `${w(thing.toGo)} to go` : null].filter((x): x is string => !!x)} />
              </div>
            )}
          </div>
        </div>
      );
    }
    case "invoice":
      return (
        <div className="nfp-thing nfp-invoice">
          <div>
            <div className="nfp-fact first">{thing.number}</div>
            {thing.what && <b className="nfp-inv-what">{thing.what}</b>}
            {thing.due && <div className="nfp-fact">{`Due ${dayWords(thing.due)}`}</div>}
          </div>
          <b className="nfp-sum">{money(thing.total, thing.currency)}</b>
        </div>
      );
    case "shape": {
      const done = thing.angles.filter((a) => a.photo).length;
      return (
        <div className="nfp-thing">
          <div className="nfp-angles" style={{ gridTemplateColumns: `repeat(${Math.max(thing.angles.length, 3)}, minmax(0, 1fr))` }}>
            {thing.angles.map((a, i) => (
              <span key={i}>
                <span className={`nfp-angle${a.photo ? "" : " empty"}`}>
                  {a.photo ? (
                    <img src={pic(a.photo, 480)} alt="" decoding="async" />
                  ) : (
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M4 8h3l2-2.5h6L17 8h3v11H4z" />
                      <circle cx="12" cy="13" r="3.3" />
                    </svg>
                  )}
                </span>
                <em>{a.label}</em>
              </span>
            ))}
          </div>
          <div className="nfp-fact">{`${done} of ${thing.angles.length} in`}</div>
        </div>
      );
    }
  }
}

/** A day and a time, a number of minutes later, as the "YYYY-MM-DDTHH:MM" clockRange reads. */
function addMinutes(date: string, time: string, minutes: number): string {
  const [h, m] = time.split(":").map(Number);
  const total = h * 60 + m + (minutes || 0);
  const hh = Math.floor((total % 1440) / 60);
  const mm = total % 60;
  return `${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/** An amount in its currency, as the invoice prints it (whole when it is whole). */
function money(total: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency, minimumFractionDigits: Number.isInteger(total) ? 0 : 2 }).format(total);
  } catch {
    return `${total} ${currency}`;
  }
}
