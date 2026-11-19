// The client's notification groups (19 Nov, Alex: docs/boards/notification-map.html, its Proposal, and the Settings ·
// Notifications phone of docs/boards/notification-popup-mockup.html): one switch a group in Settings, in this order.
// A switch turns off the push alone; the bell keeps every notification. What the map lists under "Not toggled, by
// choice" (sign-in codes and account mail, Your app is ready, a workout left running) has no group: always on.
// Client-safe: no server imports.

import { categorize } from "./notificationTypes";

export type NotifGroup = "messages" | "training" | "nutrition" | "checkins" | "shape" | "calls" | "plan" | "invoices";

export type NotifGroupInfo = {
  id: NotifGroup;
  /** The switch's name: the coach by first name on Messages, `Coach` with none. */
  label: (coachFirst: string) => string;
  /** The short grey fact under it, from the mockup; none where it showed none. */
  fact: string | null;
};

export const NOTIF_GROUPS: readonly NotifGroupInfo[] = [
  { id: "messages", label: (coach) => `Messages from ${coach.trim() || "Coach"}`, fact: "Messages and photos" },
  { id: "training", label: () => "Training", fact: "Programmes and video replies" },
  { id: "nutrition", label: () => "Nutrition", fact: "Targets and comments" },
  { id: "checkins", label: () => "Check-ins", fact: "Reminders and comments" },
  { id: "shape", label: () => "Shape updates", fact: null },
  { id: "calls", label: () => "Calls", fact: "Booked, moved, reminders" },
  { id: "plan", label: () => "Plan and events", fact: null },
  { id: "invoices", label: () => "Invoices", fact: null },
];

export const NOTIF_GROUP_IDS: readonly NotifGroup[] = NOTIF_GROUPS.map((g) => g.id);

export function isNotifGroup(x: unknown): x is NotifGroup {
  return typeof x === "string" && (NOTIF_GROUP_IDS as readonly string[]).includes(x);
}

const has = (m: string, re: RegExp) => re.test(m.trim());

/**
 * The group a notification's push belongs to, or null for one that is always on. Read from its kind, where it points
 * and, when given, its words (checked against every trigger on the map board, 19 Nov): the words say what a "home"
 * note is about (a call, an event, a shape update, a check-in), which its tab alone can't.
 */
export function groupOfNotification(n: { kind: string; action_tab: string | null; message?: string | null; dedupe_key?: string | null }): NotifGroup | null {
  if (n.kind === "coach_note") return "messages";
  // Progress reports are gone (18 Nov, Alex): nothing writes one, so nothing to switch.
  if (n.kind === "report") return null;
  const m = n.message ?? "";
  const key = n.dedupe_key ?? "";
  // A due reminder (stored, never pushed): the shape update's by its key, the rest a check-in's.
  if (n.kind === "reminder") return /photo/i.test(key) ? "shape" : "checkins";
  if (m) {
    // Words the bell's categories don't name (they fall to "system" there).
    if (has(m, /^time for your shape update/i)) return "shape";
    if (has(m, /^your coach set a new lifestyle phase/i)) return "checkins";
    if (has(m, /^cancelled \d+ calls/i) || has(m, /^your calls moved/i)) return "calls";
    if (has(m, /^(set your main goal|cleared your main goal|set a new goal|updated one of your goals)/i)) return "plan";
    if (has(m, /^received your payment/i)) return "invoices";
    if (has(m, /^updated your nutrition plan/i)) return "nutrition";
    switch (categorize({ kind: n.kind, message: m, action_tab: n.action_tab })) {
      case "message":
        return "messages";
      case "report":
        return null;
      case "video_reply":
      case "video_request":
      case "training_block":
      case "training_changed":
        return "training";
      case "nutrition_phase":
      case "nutrition_changed":
        return "nutrition";
      case "checkin_comment":
        return "checkins";
      case "pics_reviewed":
        return "shape";
      case "meeting_booked":
      case "meeting_changed":
      case "meeting_notes":
      case "focus":
        return "calls";
      case "event_added":
      case "event_changed":
      case "weight_goal":
        return "plan";
      case "invoice":
        return "invoices";
      case "system":
        break;
    }
  }
  // By where it points alone.
  switch (n.action_tab) {
    case "chat":
      return "messages";
    case "training":
    case "video":
      return "training";
    case "nutrition":
      return "nutrition";
    case "checkin":
      return "checkins";
    case "invoices":
      return "invoices";
    default:
      // A phase going live on Home is the lifestyle one (queries.ts schedulePhase's `where`).
      if (n.kind === "programme") return "checkins";
      if (/^photos/.test(key)) return "shape";
      if (/^checkin/.test(key)) return "checkins";
      if (/^meeting/.test(key)) return "calls";
      return "plan";
  }
}
