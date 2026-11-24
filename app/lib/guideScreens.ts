// The help guides' topics and screens (24 Nov, Alex; lib/guides.ts). Pure, with no imports: the owner's editor on
// Coaches and the server both read it.

/** The topics offered first; any other typed is kept as typed. In the order the panel lists them, the tracks' topics in
 *  the tracks' order, Lifestyle (Check-ins), Training, Nutrition (docs/DESIGN-RULES-ADMIN.md §8). */
export const GUIDE_TOPICS = ["Getting started", "Clients", "Plan", "Check-ins", "Training", "Nutrition", "Billing", "Settings"] as const;

/** The screens a guide can belong to: the views over every client, then a client's tabs, each by its address's name
 *  (paths.ts: COACH_VIEWS, CLIENT_TAB_SLUG) and the word the coach reads. No Chat: the chat is a panel over a client's
 *  Home, not a screen, and the ? stands aside while it is open, so a guide on it would never be For this screen; a
 *  guide about the chat takes a topic instead. */
export const GUIDE_SCREENS: readonly { key: string; label: string; group: "views" | "client" }[] = [
  { key: "feed", label: "Feed", group: "views" },
  { key: "phases", label: "Phases", group: "views" },
  { key: "calendar", label: "Calendar", group: "views" },
  { key: "library", label: "Library", group: "views" },
  { key: "business", label: "Business", group: "views" },
  { key: "settings", label: "Settings", group: "views" },
  { key: "home", label: "Home", group: "client" },
  { key: "plan", label: "Plan", group: "client" },
  { key: "lifestyle", label: "Lifestyle", group: "client" },
  { key: "training", label: "Training", group: "client" },
  { key: "nutrition", label: "Nutrition", group: "client" },
  { key: "shape-update", label: "Shape update", group: "client" },
  { key: "meetings", label: "Meetings", group: "client" },
  { key: "invoices", label: "Invoices", group: "client" },
];
