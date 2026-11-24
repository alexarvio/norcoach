import { AccountIcon, BookmarkIcon, BuildingIcon, ChatIcon, GearIcon, LockIcon, PaletteIcon, ReceiptIcon, ShieldIcon } from "../../components/icons";

// Settings is one page, its sections listed on the left and the one picked on the right (27 Oct, Alex: mockup B); these
// are its sections in the page's order, each section's key its id and the address's #key. A plain module, so the page
// (a server component) and the rail (a client one) read the same list. The old URLs (/settings/<key>,
// /admin/redesign/profile) redirect to the section on the page.
// Nine sections since 23 Nov (Alex: docs/boards/settings-harmony-mockup.html, "9 sections, not 12"): Billing went into
// Account, Notifications into Preferences, Your data and Privacy & legal into one, Data & privacy. Their old keys
// still land (SETTINGS_ALIASES): #billing opens Account at its Norcoach part, #notifications Preferences at its
// notifications, #data Data & privacy at its export.
export const SETTINGS_PATH = "/settings";
export const SETTINGS = [
  { key: "profile", label: "Profile", href: `${SETTINGS_PATH}#profile`, Icon: AccountIcon },
  // Account & security and what the coach pays Norcoach (lib/billing.ts), one section (23 Nov, Alex).
  { key: "account", label: "Account", href: `${SETTINGS_PATH}#account`, Icon: LockIcon },
  { key: "business", label: "Business details", href: `${SETTINGS_PATH}#business`, Icon: BuildingIcon },
  // The logo, banner, brand colour and card pictures, a section of their own (22 Nov, Alex).
  { key: "branding", label: "Branding", href: `${SETTINGS_PATH}#branding`, Icon: PaletteIcon },
  // The coaching plans the coach offers (28 Oct, Alex; PlansSettings.tsx).
  { key: "plans", label: "Plans", href: `${SETTINGS_PATH}#plans`, Icon: BookmarkIcon },
  { key: "invoicing", label: "Invoicing & payments", href: `${SETTINGS_PATH}#invoicing`, Icon: ReceiptIcon },
  // Units and the time zone, then what reaches the coach's phone and quiet hours (23 Nov, Alex).
  { key: "preferences", label: "Preferences", href: `${SETTINGS_PATH}#preferences`, Icon: GearIcon },
  // The export, then the privacy policy and what happens to the clients' data (23 Nov, Alex).
  { key: "privacy", label: "Data & privacy", href: `${SETTINGS_PATH}#privacy`, Icon: ShieldIcon },
  // A coach's line to the company (lib/support.ts): coaches only.
  { key: "support", label: "Support", href: `${SETTINGS_PATH}#support`, Icon: ChatIcon },
] as const;
export type SettingsKey = (typeof SETTINGS)[number]["key"];

/** The keys of the sections merged on 23 Nov: the section each now lives in, and the part of it to land on (its
 *  element `rst-part-<part>`, Rows.tsx's `Part id`). */
export const SETTINGS_ALIASES = {
  billing: { key: "account", part: "billing" },
  notifications: { key: "preferences", part: "notifications" },
  data: { key: "privacy", part: "data" },
} as const satisfies Record<string, { key: SettingsKey; part: string }>;
export type SettingsAlias = keyof typeof SETTINGS_ALIASES;
/** Anything the address may say after its #: a section's key, or one of the old ones that lands inside a section. */
export type SettingsAddress = SettingsKey | SettingsAlias;

/** The rows an account sees: the owner answers Support from Coaches, so has no Support row (nor section). */
export const settingsFor = (owner: boolean) => SETTINGS.filter((s) => !(owner && s.key === "support"));

export const isSettingsKey = (k: string): k is SettingsKey => SETTINGS.some((s) => s.key === k);
export const isSettingsAddress = (k: string): k is SettingsAddress => isSettingsKey(k) || Object.prototype.hasOwnProperty.call(SETTINGS_ALIASES, k);

/** Where an address lands: its section, and for an old key the part inside it. Null for anything else. */
export function resolveSetting(k: string): { key: SettingsKey; part?: string } | null {
  if (isSettingsKey(k)) return { key: k };
  if (Object.prototype.hasOwnProperty.call(SETTINGS_ALIASES, k)) {
    const a = SETTINGS_ALIASES[k as SettingsAlias];
    return { key: a.key, part: a.part };
  }
  return null;
}

/** The section a save slot's key belongs to ("notifications" → "preferences", "profile:details" → "profile"). */
export const sectionOf = (slotKey: string): string => {
  const head = slotKey.split(":")[0];
  return resolveSetting(head)?.key ?? head;
};

/** The page at one section, with its query (?coachId, ?stripe) kept: `/settings?stripe=back#invoicing`. */
export function settingsHref(key: SettingsAddress, query: Record<string, string | undefined> = {}): string {
  const q = new URLSearchParams(Object.entries(query).filter((e): e is [string, string] => !!e[1])).toString();
  return `${SETTINGS_PATH}${q ? `?${q}` : ""}#${key}`;
}
