"use client";

import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";
import { ChatIcon, LockIcon, PhaseFlagIcon } from "../../components/icons";
import { meetingTypeOf } from "../../lib/meetingTypes";
import { NEED_CATS, type NeedCat } from "../../lib/needCats";
import { pic } from "../../lib/pic";
import { TRACK_ACCENT } from "../phaseChrome";
import { TrackIcon } from "./plan/PlanDraft";

// Every needs-you list is one anatomy (3 Nov, Alex: option C of docs/boards/needs-rows-mockup.html): the Feed's and the
// Phases screen's Needs you, and Ending soon. The list split by category, each group under a small-caps head with the
// category's icon in its colour, its name and its count, over its own hairline card; a row the date, the face and name,
// the thing and their words, then (as the row has them) a bar, the wait, the action as its icon alone (3 Nov, Alex: "the
// icons should be self explanatory"; its word the tooltip), and the round check on hover. Styles: .nd- in feed/feed.css.
// The client's To do panel (TodoStrip.tsx; 24 Nov, Alex: "Build B", the rust strip on each tab before) borrows the
// groups' heads and draws its rows its own way, the action in words.

const CALL = meetingTypeOf("checkin");

export const NEED_LOOK: Record<NeedCat, { label: string; color: string; icon: ReactNode }> = {
  // Someone asking to join with the coach's code (18 Nov, Alex): a person with a plus, in ink.
  join: {
    label: "Join requests",
    color: "#141a24",
    icon: (
      <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="9.5" cy="8" r="3.5" />
        <path d="M3 19.5c.7-3.4 3.3-5.4 6.5-5.4s5.8 2 6.5 5.4" />
        <path d="M18.5 8.5v5M16 11h5" />
      </svg>
    ),
  },
  messages: { label: "Messages", color: "#5b6474", icon: <ChatIcon /> },
  lifestyle: { label: "Lifestyle", color: TRACK_ACCENT.lifestyle, icon: <TrackIcon track="lifestyle" size={14} /> },
  training: { label: "Training", color: TRACK_ACCENT.training, icon: <TrackIcon track="training" size={14} /> },
  nutrition: { label: "Nutrition", color: TRACK_ACCENT.nutrition, icon: <TrackIcon track="nutrition" size={14} /> },
  meetings: {
    label: "Meetings",
    color: CALL.color,
    icon: (
      <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={CALL.icon} />
      </svg>
    ),
  },
  account: { label: "Sign-in", color: "#8b93a1", icon: <LockIcon /> },
  plan: { label: "Plan", color: "#141a24", icon: <PhaseFlagIcon /> },
};

/** The rows by group, in the groups' order (NEED_CATS), each keeping the list's own order inside it. */
export function byNeedCat<T>(rows: T[], catOf: (r: T) => NeedCat): [NeedCat, T[]][] {
  return NEED_CATS.map((c) => [c, rows.filter((r) => catOf(r) === c)] as [NeedCat, T[]]).filter(([, rs]) => rs.length > 0);
}

/** A group: its head (the icon in its colour, the name, the count) over its card. */
export function NeedGroup({ cat, count, children }: { cat: NeedCat; count: number; children: ReactNode }) {
  const look = NEED_LOOK[cat];
  return (
    <div className="nd-group">
      <div className="nd-head" style={{ "--c": look.color } as CSSProperties}>
        {look.icon}
        {look.label}
        <small>{count}</small>
      </div>
      <div className="rls-card ndg-card">{children}</div>
    </div>
  );
}

/** The client's face, 24px: their photo, else their initial on a hairline ring. */
export function NeedFace({ name, src }: { name: string; src: string | null }) {
  return (
    <span className="nd-face" aria-hidden="true">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- the client's own upload, served by the app
        <img src={pic(src, 96)} alt="" loading="lazy" decoding="async" />
      ) : (
        name.trim().charAt(0).toUpperCase()
      )}
    </span>
  );
}

/** A row's action as its icon alone, round, its word the tooltip and the label: a link, or a button. */
export function NeedAction({ label, icon, href, onClick }: { label: string; icon: ReactNode; href?: string; onClick?: () => void }) {
  if (href)
    return (
      <Link href={href} prefetch={false} className="nd-act" title={label} aria-label={label}>
        {icon}
      </Link>
    );
  return (
    <button type="button" className="nd-act" title={label} aria-label={label} onClick={onClick}>
      {icon}
    </button>
  );
}
