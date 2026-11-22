// Every way into the check-in figures (quest 9): each call site that fetches them has its own read path, and every
// write is counted by what it did. The shadow (shadow.ts) counts each one, so its week can say every path was seen and
// matched.

export const CHECKIN_TABS = ["home", "training", "nutrition", "measurements", "pictures", "meetings", "plan", "messages", "invoices"] as const;
export type CheckInTab = (typeof CHECKIN_TABS)[number];

export const CHECKINS_READ_PATHS = [
  "page.client",
  ...CHECKIN_TABS.map((t) => `page.tab.${t}` as const),
  ...CHECKIN_TABS.map((t) => `page.noClients.${t}` as const),
  "page.feed",
  "page.phases",
  "page.business",
  "page.calendar",
  "page.library",
  "page.settings",
  "page.onboarding",
  "page.onboarding.screen",
  "page.onboarding.screen.accounts",
  "page.coaches",
  "page.coaches.accounts",
  "page.oldAdmin",
  "page.oldAdmin.profile",
  "api.metricSeries",
  "api.seen",
  // Only the actions that fetch: a check-in, the Measure note, a sync, a removal, a copy and a duplicated phase read
  // their rows inside their own write (writeCheckIns, counted under its w.* path), and the old admin's Lifestyle panel
  // reads the page's page.oldAdmin view.
  "action.weightGoal",
  "action.appLock",
  "action.markSeen",
  "action.markProgramNote",
  "action.dismissHome",
  "job.reminders",
  "job.reminders.prune",
  "job.appLocks",
  "export",
  "backup",
] as const;
export type CheckInReadPath = (typeof CHECKINS_READ_PATHS)[number];

/**
 * Never asked of the shadow's read week, so its report never waits on them: `backup` and `export` read the door only in
 * pg mode (in memory mode they are the store's own lists, nothing to compare), so their paged reads are proved on
 * staging (docs/database-plan.md, the check-in item's Staging list).
 */
export const CHECKINS_PATHS_OUTSIDE_WEEK: readonly CheckInReadPath[] = ["backup", "export"];
/** Rare: driven by hand on staging during the read week (docs/database-plan.md, the check-in item's Staging list). */
export const CHECKINS_PATHS_BY_HAND: readonly CheckInReadPath[] = [
  ...CHECKIN_TABS.map((t) => `page.noClients.${t}` as const),
  "page.onboarding",
  "page.onboarding.screen",
  "page.onboarding.screen.accounts",
  "page.oldAdmin",
  "page.oldAdmin.profile",
  "page.coaches.accounts",
  "api.metricSeries",
  "action.markProgramNote",
];

export const CHECKINS_WRITE_PATHS = [
  "w.entry.typed",
  "w.entry.health",
  "w.entry.demo",
  "w.entry.seed",
  "w.entry.dev",
  "w.note.measure",
  "w.def.remove",
  "w.def.merge",
  "w.def.dropUnused",
  "w.client.delete",
  "w.wipe",
] as const;
export type CheckInWritePath = (typeof CHECKINS_WRITE_PATHS)[number];
export type CheckInPath = CheckInReadPath | CheckInWritePath;

/**
 * What each coach-wide read path takes of the coach's clients' check-ins (21 Nov, the bounded slices; checkins/rows.ts
 * fetchCoachCheckIns, fetchClientTabCheckIns, fetchEveryCheckIn): the rail's window (each client's check-ins of the last
 * HOME_NEW_DAYS and their newest, and every metric's newest period), the Feed's too with the coach's newest
 * FEED_KIND_ROWS of each kind and its Since, Coaches' newest per coach, the window of the one client an action is about,
 * or (any path not named here: the old admin, until it is retired) everything.
 */
export type CheckInShape = "rail" | "feed" | "accounts" | "focus" | "all";
export const CHECKINS_SHAPE: Partial<Record<CheckInReadPath, CheckInShape>> = {
  ...(Object.fromEntries(CHECKIN_TABS.map((t) => [`page.tab.${t}`, "rail"])) as Record<`page.tab.${CheckInTab}`, CheckInShape>),
  ...(Object.fromEntries(CHECKIN_TABS.map((t) => [`page.noClients.${t}`, "rail"])) as Record<`page.noClients.${CheckInTab}`, CheckInShape>),
  "page.business": "rail",
  "page.calendar": "rail",
  "page.library": "rail",
  "page.settings": "rail",
  "page.phases": "rail",
  "page.coaches": "rail",
  "page.onboarding": "rail",
  "page.onboarding.screen": "rail",
  "page.feed": "feed",
  "page.coaches.accounts": "accounts",
  "page.onboarding.screen.accounts": "accounts",
  "api.seen": "focus",
  "action.markSeen": "focus",
  "action.markProgramNote": "focus",
  "action.dismissHome": "focus",
};
