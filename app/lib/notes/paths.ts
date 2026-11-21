// Every way into the notifications (quest 7): each call site that fetches them has its own read path, and every write
// is counted by what it did. The shadow (shadow.ts) counts each one, so its week can say every path was seen and matched.

export const NOTE_TABS = ["home", "training", "nutrition", "measurements", "pictures", "meetings", "plan", "messages", "invoices"] as const;
export type NoteTab = (typeof NOTE_TABS)[number];

export const NOTES_READ_PATHS = [
  "page.client",
  "page.client.phone",
  ...NOTE_TABS.map((t) => `page.tab.${t}` as const),
  "action.markRead",
  "action.nutritionTargets",
  "action.chatNote.edit",
  "action.chatNote.delete",
  "action.chatNote.mealEdit",
  "action.chatNote.mealRemove",
  "job.reminders.unread",
  "job.reminders.state",
  "export",
  "backup",
  "equiv.page",
] as const;
export type NotesReadPath = (typeof NOTES_READ_PATHS)[number];

export const NOTES_WRITE_PATHS = [
  "w.insert.plain",
  "w.insert.keep",
  "w.insert.replace",
  "w.insert.merge",
  "w.insert.reminder",
  "w.drop",
  "w.read.one",
  "w.read.coachNotes",
  "w.read.all",
  "w.reminders.tickOff",
  // The nightly clean-up of old read reminders (19 Nov, notes/prune.ts).
  "w.reminders.prune",
  "w.chatNote.reword",
  "w.chatNote.delete",
  "w.client.delete",
  "w.wipe",
] as const;
export type NotesWritePath = (typeof NOTES_WRITE_PATHS)[number];
export type NotesPath = NotesReadPath | NotesWritePath;
