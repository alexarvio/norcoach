// Every code path that reads or writes chat rows through the door (app/lib/chat/rows.ts), by name (18 Nov, Step 5 of
// docs/database-plan.md). Each call site names its own path, never one shared with another site, so a path seen proves
// that site ran; /api/timing counts them under `chat` (a fetch that runs two queries, a client's tab's coach view and
// thread, is counted per query: `page.tab.home:coach`, `page.tab.home:thread`), and the shadow week's exit needs every
// one seen and matched at least once (the list in docs/database-plan.md, Step 5).

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

/** The pure checks that the narrowed slices give their readers the same answers as the whole rows (shadow.ts). */
export const CHAT_EQUIV_PATHS = ["equiv.home", "equiv.dock"] as const;

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

export const CHAT_PATHS = [...CHAT_READ_PATHS, ...CHAT_EQUIV_PATHS, ...CHAT_WRITE_PATHS] as const;
export type ChatReadPath = (typeof CHAT_READ_PATHS)[number];
export type ChatWritePath = (typeof CHAT_WRITE_PATHS)[number];
export type ChatPath = (typeof CHAT_PATHS)[number];
