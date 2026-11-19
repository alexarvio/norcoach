// Every way into the food diary (quest 8 part 1): each call site that fetches it has its own read path, and every write
// is counted by what it did. The shadow (shadow.ts) counts each one, so its week can say every path was seen and matched.

export const FOOD_TABS = ["home", "training", "nutrition", "measurements", "pictures", "meetings", "plan", "messages", "invoices"] as const;
export type FoodTab = (typeof FOOD_TABS)[number];

export const FOOD_READ_PATHS = [
  "page.client",
  "page.client.phone",
  ...FOOD_TABS.map((t) => `page.tab.${t}` as const),
  ...FOOD_TABS.map((t) => `page.noClients.${t}` as const),
  "page.feed",
  "page.business",
  "page.calendar",
  "page.library",
  "page.settings",
  "page.phases",
  "page.coaches",
  "page.coaches.accounts",
  "page.onboarding",
  "page.onboarding.screen",
  "page.onboarding.screen.accounts",
  "page.oldAdmin",
  "page.oldAdmin.profile",
  "page.oldAdmin.nutrition",
  "api.thread.coach",
  "api.thread.app",
  "api.send.link",
  "api.seen",
  "action.food.diary",
  "action.food.add",
  "action.food.update",
  "action.food.remove",
  "action.chatThread",
  "action.coachThread",
  "action.chatDraftThread",
  "action.chatSend",
  "action.setLink",
  "action.markSeen",
  "action.markProgramNote",
  "action.dismissHome",
  "action.healthSync",
  "action.appLock",
  "job.appLocks",
  "job.media.prepare",
  "export",
  "backup",
] as const;
export type FoodReadPath = (typeof FOOD_READ_PATHS)[number];

/**
 * Never asked of the shadow's read week, so its report never waits on them: `backup` reads the door only with
 * FOOD_STORE=pg (memory mode's JSON is the store), `page.client.phone` is the coach's phone preview, not drawn since 19 Nov.
 */
export const FOOD_PATHS_OUTSIDE_WEEK: readonly FoodReadPath[] = ["backup", "page.client.phone"];
/** Rare: driven by hand on staging during the read week (docs/database-plan.md, the food item's Staging list). */
export const FOOD_PATHS_BY_HAND: readonly FoodReadPath[] = [
  ...FOOD_TABS.map((t) => `page.noClients.${t}` as const),
  "page.onboarding",
  "page.onboarding.screen",
  "page.onboarding.screen.accounts",
  "page.oldAdmin",
  "page.oldAdmin.profile",
  "page.oldAdmin.nutrition",
  "page.coaches.accounts",
  "action.markProgramNote",
  "export",
];

export const FOOD_WRITE_PATHS = [
  "w.entry.add",
  "w.entry.update",
  "w.entry.remove",
  "w.meal.add",
  "w.meal.rename",
  "w.meal.remove",
  "w.meal.copy",
  "w.meal.reorder",
  "w.day.release",
  "w.day.type",
  "w.day.push",
  "w.day.copy",
  "w.savedMeal.save",
  "w.savedMeal.create",
  "w.savedMeal.update",
  "w.savedMeal.rename",
  "w.savedMeal.food",
  "w.savedMeal.picture",
  "w.savedMeal.delete",
  "w.savedMeal.use",
  "w.savedMeal.useCard",
  "w.savedDay.save",
  "w.savedDay.create",
  "w.savedDay.rename",
  "w.savedDay.card",
  "w.savedDay.picture",
  "w.savedDay.delete",
  "w.savedDay.use",
  "w.photo.save",
  "w.photo.remove",
  "w.calories.typed",
  "w.calories.health",
  "w.calories.demo",
  "w.look",
  "w.client.delete",
  "w.wipePhotos",
] as const;
export type FoodWritePath = (typeof FOOD_WRITE_PATHS)[number];
export type FoodPath = FoodReadPath | FoodWritePath;
