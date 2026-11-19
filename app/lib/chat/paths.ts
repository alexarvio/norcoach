// Every code path that reads or writes chat rows through the door (app/lib/chat/rows.ts), by name (18 Nov, Step 5 of
// docs/database-plan.md). Each call site names its own path, never one shared with another site, so a path seen proves
// that site ran; /api/timing counts them under `chat` (a fetch that runs two queries, a client's tab's coach view and
// thread, is counted per query: `page.tab.home:coach`, `page.tab.home:thread`), and the shadow week's exit needs every
// one seen and matched at least once (the list in docs/database-plan.md, Step 5).

import { FEED_KIND_ROWS, HOME_EVENTS, HOME_KIND_ROWS } from "./pick";

/** The admin's client tabs (a page each under app/admin/redesign), with a client and with none (the NoClients branch). */
const TABS = ["home", "training", "nutrition", "measurements", "pictures", "meetings", "plan", "messages", "invoices"] as const;

export const CHAT_READ_PATHS = [
  ...TABS.map((t) => `page.tab.${t}` as const),
  ...TABS.map((t) => `page.noClients.${t}` as const),
  "page.business",
  "page.calendar",
  "page.library",
  "page.settings",
  "page.phases",
  "page.feed",
  "page.coaches",
  "page.coaches.accounts",
  "page.onboarding",
  "page.onboarding.screen",
  "page.onboarding.screen.accounts",
  "page.client",
  "page.coachPhone",
  "page.oldAdmin",
  "page.oldAdmin.thread",
  "page.oldAdmin.profile",
  "api.thread.coach",
  "api.thread.app",
  "api.seen",
  "action.chatThread",
  "action.coachThread",
  "action.chatDraftThread",
  "action.chatList",
  "action.coachInbox",
  "action.markVideoDone",
  "action.coachReview",
  "action.food.add",
  "action.food.update",
  "action.food.remove",
  "action.food.diary",
  "action.markSeen",
  "action.markProgramNote",
  "action.dismissHome",
  "send.mealGuard",
  "export",
  "media.deleteCheck",
  "media.usesFile",
  "media.fileShown",
  "media.lacksLook",
  "media.toPrepare",
] as const;

/** Read paths that run only with CHAT_STORE=pg, so never part of the shadow week's exit: the nightly JSON backup (lib/backup.ts). */
export const CHAT_PG_READ_PATHS = ["backup"] as const;

/** The pure checks that the narrowed slices give their readers the same answers as the whole rows (shadow.ts). */
export const CHAT_EQUIV_PATHS = ["equiv.home", "equiv.dock", "equiv.top"] as const;

export const CHAT_WRITE_PATHS = [
  "w.insert.send",
  "w.insert.review",
  "w.insert.replyMedia",
  "w.insert.formReview",
  "w.insert.sessionNote",
  "w.insert.demo",
  "w.insert.mealComment",
  "w.react",
  "w.edit.coach",
  "w.edit.client",
  "w.mealComment.edit",
  "w.delete.coach",
  "w.delete.client",
  "w.mealComment.remove",
  "w.link",
  "w.pin",
  "w.look",
  "w.swap",
  "w.client.delete",
  "w.wipe",
] as const;

export const CHAT_PATHS = [...CHAT_READ_PATHS, ...CHAT_PG_READ_PATHS, ...CHAT_EQUIV_PATHS, ...CHAT_WRITE_PATHS] as const;
export type ChatReadPath = (typeof CHAT_READ_PATHS)[number] | (typeof CHAT_PG_READ_PATHS)[number];
export type ChatWritePath = (typeof CHAT_WRITE_PATHS)[number];
export type ChatPath = (typeof CHAT_PATHS)[number];

// ---- What a coach view holds, by path (Step 5's cut-over) -----------------------------------------------------------
//
// A coach view (rows.ts fetchCoachChat) no longer reads everything the coach's clients ever sent: each path fetches
// the slices its readers cut from (pick.ts, statements.ts), and a reader asks the view for its slice (`need`), so a
// path given too little throws a ChatViewMiss in narrow views, in tests and with CHAT_STORE=pg instead of drawing
// less. Every path that reaches fetchCoachChat has a shape here (the type makes it so).

/** One slice. `who`: every client of the view, or the one client the call is about (a client's tab, an action on one). */
export type CoachSlice =
  | { kind: "clientTop"; who: "all" | "focus"; n: number }
  | { kind: "coachTop"; n: number }
  | { kind: "needs"; who: "all" | "focus" }
  | { kind: "coachLast"; who: "all" | "focus" }
  | { kind: "recent"; who: "focus" }
  | { kind: "since" }
  | { kind: "full" };

/** The rail (coachNeeds: every client's Home, the feed's needs rows, the dots): each client's newest 60, Needs you, the coach's last word. */
const RAIL: CoachSlice[] = [
  { kind: "clientTop", who: "all", n: HOME_EVENTS },
  { kind: "needs", who: "all" },
  { kind: "coachLast", who: "all" },
];
/** A client's tab: the rail, and that client's Home Activity (loadHome, on every tab: each kind's newest 200). */
const TAB: CoachSlice[] = [...RAIL, { kind: "clientTop", who: "focus", n: HOME_KIND_ROWS }];

export const COACH_VIEW_PATHS = [
  ...TABS.map((t) => `page.tab.${t}` as const),
  ...TABS.map((t) => `page.noClients.${t}` as const),
  "page.business",
  "page.calendar",
  "page.library",
  "page.settings",
  "page.phases",
  "page.feed",
  "page.coaches",
  "page.coaches.accounts",
  "page.onboarding",
  "page.onboarding.screen",
  "page.onboarding.screen.accounts",
  "page.oldAdmin",
  "page.oldAdmin.profile",
  "api.seen",
  "action.markSeen",
  "action.markProgramNote",
  "action.dismissHome",
] as const satisfies readonly ChatReadPath[];
export type CoachViewPath = (typeof COACH_VIEW_PATHS)[number];

/** markClientEventsSeen: the client's last 14 days, whole (it keeps the coach's read marks to them). */
const SEEN: CoachSlice[] = [{ kind: "recent", who: "focus" }];
/** The Coaches page's accounts: each coach's newest event, so each client's newest message. */
const ACCOUNTS: CoachSlice[] = [{ kind: "clientTop", who: "all", n: 1 }];
/** The old admin (/admin): everything, as before, until it is retired (Alex). Needs you's slice too: "full" fetches every
 *  row the clients sent but only the coach's last word, and a client with an unreadable stamp needs all their rows with
 *  words for Needs you to answer as from the whole thread (pick.ts pickNeeds; 19 Nov verification). */
const FULL: CoachSlice[] = [{ kind: "full" }, { kind: "needs", who: "all" }];

export const COACH_SHAPE: Record<CoachViewPath, readonly CoachSlice[]> = {
  ...(Object.fromEntries(TABS.map((t) => [`page.tab.${t}`, TAB])) as Record<`page.tab.${(typeof TABS)[number]}`, CoachSlice[]>),
  ...(Object.fromEntries(TABS.map((t) => [`page.noClients.${t}`, RAIL])) as Record<`page.noClients.${(typeof TABS)[number]}`, CoachSlice[]>),
  "page.business": RAIL,
  "page.calendar": RAIL,
  "page.library": RAIL,
  "page.settings": RAIL,
  "page.phases": RAIL,
  // The Feed: the rail, its Activity (the coach's newest 200 of the kind), its Since (after the coach's last visit).
  "page.feed": [...RAIL, { kind: "coachTop", n: FEED_KIND_ROWS }, { kind: "since" }],
  "page.coaches": RAIL,
  "page.coaches.accounts": ACCOUNTS,
  "page.onboarding": RAIL,
  "page.onboarding.screen": RAIL,
  "page.onboarding.screen.accounts": ACCOUNTS,
  "page.oldAdmin": FULL,
  "page.oldAdmin.profile": FULL,
  "api.seen": SEEN,
  "action.markSeen": SEEN,
  "action.markProgramNote": SEEN,
  // getClientHome of that client alone (its standing items).
  "action.dismissHome": [
    { kind: "clientTop", who: "focus", n: HOME_EVENTS },
    { kind: "needs", who: "focus" },
    { kind: "coachLast", who: "focus" },
  ],
};
