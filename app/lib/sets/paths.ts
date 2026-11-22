// Every way into the logged sets (quest 10): each call site that fetches them has its own read path, and every write is
// counted by what it did. The shadow (shadow.ts) counts each one, so its week can say every path was seen and matched.

export const SET_TABS = ["home", "training", "nutrition", "measurements", "pictures", "meetings", "plan", "messages", "invoices"] as const;
export type SetTab = (typeof SET_TABS)[number];

export const SETS_READ_PATHS = [
  "page.client",
  ...SET_TABS.map((t) => `page.tab.${t}` as const),
  ...SET_TABS.map((t) => `page.noClients.${t}` as const),
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
  "api.chat.seen",
  // The actions that read sets outside a write of their own (a write reads its reach inside writeSets, counted under its
  // w.* path).
  "action.liveNow",
  "action.training",
  "action.applyPreview",
  "action.appLock",
  "action.openApp",
  "action.dismissHome",
  "action.markSeen",
  "job.due",
  "job.progress.full",
  "job.staleSessions",
  "job.workoutReminders",
  "job.appLocks",
  "export",
  "backup",
] as const;
export type SetReadPath = (typeof SETS_READ_PATHS)[number];

/** Never asked of the shadow's read week (pg mode alone reads the door there; proved on staging). The weight rule's full
 *  pass reads every set only with SETS_STORE=pg (memory mode's minute job reads the store, sampled as `job.due` when it
 *  names clients), its statements the backup's (`loadPaged`). */
export const SETS_PATHS_OUTSIDE_WEEK: readonly SetReadPath[] = ["backup", "export", "job.progress.full"];
/** Rare: driven by hand on staging during the read week (docs/database-plan.md, the sets item's Staging list). */
export const SETS_PATHS_BY_HAND: readonly SetReadPath[] = [
  ...SET_TABS.map((t) => `page.noClients.${t}` as const),
  "page.onboarding",
  "page.onboarding.screen",
  "page.onboarding.screen.accounts",
  "page.oldAdmin",
  "page.oldAdmin.profile",
  "page.coaches.accounts",
  "action.openApp",
];

export const SETS_WRITE_PATHS = [
  "w.set.log",
  "w.set.update",
  "w.set.unit",
  "w.set.rows",
  "w.set.gym",
  "w.set.homeGym",
  "w.set.demo",
  "w.set.seed",
  "w.set.dev",
  // The cardio ticks (with the sets since 22 Nov): a tick or an untick, and a copy over a session replacing its cardio.
  "w.cardio.tick",
  "w.remove.copyOver",
  "w.session.discard",
  "w.session.freeRemove",
  "w.session.staleDiscard",
  "w.remove.assignment",
  "w.remove.day",
  "w.remove.session",
  "w.remove.week",
  "w.remove.programWeek",
  "w.remove.applyTo",
  "w.client.delete",
  "w.wipe",
] as const;
export type SetWritePath = (typeof SETS_WRITE_PATHS)[number];
export type SetPath = SetReadPath | SetWritePath;

/**
 * What each coach-wide read path takes of the coach's clients' sets (sets/rows.ts fetchCoachSets): the rail's (each
 * client's sets on the days getClientHomeActions reads and the training feed's window), the Feed's (the rail and the
 * coach's newest training events), Coaches' (each coach's newest), or (any path not named here: the old admin, until it is
 * retired) everything.
 */
export type SetShape = "rail" | "phases" | "feed" | "accounts" | "all";
export const SETS_SHAPE: Partial<Record<SetReadPath, SetShape>> = {
  ...(Object.fromEntries(SET_TABS.map((t) => [`page.tab.${t}`, "rail"])) as Record<`page.tab.${SetTab}`, SetShape>),
  ...(Object.fromEntries(SET_TABS.map((t) => [`page.noClients.${t}`, "rail"])) as Record<`page.noClients.${SetTab}`, SetShape>),
  "page.business": "rail",
  "page.calendar": "rail",
  "page.library": "rail",
  "page.settings": "rail",
  // The rail, and which rows of each client hold a set (the Phases screen's programmes: programLoggedWeekIndexes).
  "page.phases": "phases",
  "page.coaches": "rail",
  "page.onboarding": "rail",
  "page.onboarding.screen": "rail",
  "page.feed": "feed",
  "page.coaches.accounts": "accounts",
  "page.onboarding.screen.accounts": "accounts",
  "api.chat.seen": "rail",
  "action.markSeen": "rail",
  "action.dismissHome": "rail",
};
