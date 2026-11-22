"use client";

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { notificationTypeOf, type NotificationCategory } from "../lib/notificationTypes";
import type { EventTypeId } from "../lib/eventTypes";
import type { LinkView } from "../lib/messageLinks";
import { pic } from "../lib/pic";
import { TypeIcon } from "./events/AddEventSheet";
import { Bars } from "./Bars";
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
};

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
  const system = n.category === "system";
  // No time on it (22 Nov, Alex: "take out the time"): the push just came. The coach's own words grey under the title;
  // facts (more than one, " · " apart as written) on the drawn bar.
  const parts = n.body ? n.body.split(" · ").map((p) => p.trim()).filter(Boolean) : [];
  const words = parts.length === 1 ? parts[0] : null;
  const facts = parts.length > 1 ? parts : [];
  const edges = Math.min(list.length - 1, 2);

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
          style={{ "--c": t.color, "--rgb": t.rgb, ...(drag ? { transform: `translateX(${drag}px)` } : {}) } as CSSProperties}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
        >
          <div className="nfp-top">
            <span className="nfp-kind">{t.label}</span>
            {several && <span className="nfp-when">{`${index + 1} of ${list.length}`}</span>}
          </div>
          <div className="nfp-who">
            <span className="ntf-avatar nfp-face" aria-hidden="true">
              {system ? (
                <span className="ntf-avatar-sys">
                  <TypeIcon path={t.icon} size={20} stroke={1.6} />
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
              <h2 id="nfp-title" className="nfp-title">
                {n.title}
              </h2>
              {words && <p className="nfp-words">{words}</p>}
              {facts.length > 0 && (
                <div className="nfp-facts">
                  <Bars parts={facts} />
                </div>
              )}
            </div>
          </div>
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
                View
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
