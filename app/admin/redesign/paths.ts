// The admin's addresses (24 Nov, Alex: "we have to work also on the urls"; B of docs/boards/admin-urls-mockup.html). A
// client's tab is /clients/<id>/<tab>, its tab named as the coach reads it (lifestyle, shape-update, chat); a view over
// every client is /<view> (/feed, /settings#branding). The pages themselves stay where they are under app/admin/redesign:
// next.config.ts rewrites the new addresses onto them, and proxy.ts sends every old /admin/redesign address (a
// notification, a push, an email, a bookmark) to its new one, its query and # kept (oldAdminAddress below). Every link
// the admin builds goes through clientTab() or adminView(), so a new screen has one place to say where it lives.
// Pure, with no imports: proxy.ts, the server and the browser all read it.

/** A client's tabs, by the key the code keeps (RedesignShell, tabs.ts), as each reads in the address. */
export const CLIENT_TAB_SLUG = {
  home: "home",
  plan: "plan",
  measurements: "lifestyle",
  training: "training",
  nutrition: "nutrition",
  pictures: "shape-update",
  meetings: "meetings",
  invoices: "invoices",
  messages: "chat",
} as const;
export type ClientTabKey = keyof typeof CLIENT_TAB_SLUG;
const SLUG_TO_TAB: Record<string, ClientTabKey> = Object.fromEntries(Object.entries(CLIENT_TAB_SLUG).map(([k, s]) => [s, k as ClientTabKey]));

/** The views over every client, each its own address at the top. */
export const COACH_VIEWS = ["feed", "phases", "calendar", "library", "business", "coaches", "settings"] as const;
export type CoachView = (typeof COACH_VIEWS)[number];
/** The boards and old redirects that live under the admin too (no rail): each keeps its name at the top. */
const OTHER_VIEWS = ["onboarding", "whiteboard", "events-states", "home-states", "notifications-states", "profile"] as const;

/** The tab key an address names: a key ("measurements") or its slug ("lifestyle"); null for neither. */
export function tabOfSlug(name: string | null | undefined): ClientTabKey | null {
  if (!name) return null;
  if (name in CLIENT_TAB_SLUG) return name as ClientTabKey;
  return SLUG_TO_TAB[name] ?? null;
}

/** "&a=1#x", "?a=1", "#x" or "": what follows a client tab's address, as the old `?client=N${rest}` builders wrote it. */
function tail(rest: string) {
  if (!rest) return "";
  if (rest.startsWith("&")) return `?${rest.slice(1)}`;
  return rest;
}

/** A client's tab: /clients/1/lifestyle. `tab` the key or the slug; `rest` its query and # ("&week=2#session-9"). */
export function clientTab(tab: string, clientId: number | string, rest = ""): string {
  const key = tabOfSlug(tab) ?? "home";
  return `/clients/${clientId}/${CLIENT_TAB_SLUG[key]}${tail(rest)}`;
}

/** A view over every client: /feed, /settings. */
export const adminView = (view: CoachView | (typeof OTHER_VIEWS)[number], rest = "") => `/${view}${rest}`;

/** Where the admin starts (after signing in, the welcome steps, a coach going back to it): the client they last had,
 *  else their first (the page picks, and moves the address onto them), else New client. */
export const ADMIN_HOME = "/clients";

/** A client's screen in an address: the client (null for /clients alone) and the tab (home for /clients/1). */
export function clientScreenOf(pathname: string | null | undefined): { clientId: number | null; tab: ClientTabKey } | null {
  if (!pathname) return null;
  const m = /^\/clients(?:\/(\d+)(?:\/([a-z-]+))?)?\/?$/.exec(pathname);
  if (!m) return null;
  const tab = m[2] ? tabOfSlug(m[2]) : "home";
  if (!tab) return null;
  return { clientId: m[1] ? Number(m[1]) : null, tab };
}

/** The rail's view a path is ("feed", or "home" and the other tab keys on a client's screens), else null. */
export function viewOfPath(pathname: string | null | undefined): string | null {
  const screen = clientScreenOf(pathname);
  if (screen) return screen.tab;
  const first = /^\/([a-z-]+)\/?$/.exec(pathname ?? "")?.[1];
  return first && (COACH_VIEWS as readonly string[]).includes(first) ? first : null;
}

/** A page as the rail tells pages apart: a client's screens are one page a client (its tabs are that page's), any
 *  other its path. */
export function pageKeyOf(pathname: string | null | undefined): string {
  const screen = clientScreenOf(pathname);
  if (screen) return screen.clientId != null ? `/clients/${screen.clientId}` : "/clients";
  return pathname ?? "";
}

/** True on any of the admin's addresses, new or old (FreshBuild, /auth/continue). */
export function isAdminPath(pathname: string): boolean {
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return true;
  if (clientScreenOf(pathname)) return true;
  if (/^\/invoices\/\d+\/?$/.test(pathname)) return true;
  const first = /^\/([a-z-]+)/.exec(pathname)?.[1];
  return !!first && ((COACH_VIEWS as readonly string[]).includes(first) || (OTHER_VIEWS as readonly string[]).includes(first));
}

/** An old address (/admin/redesign/...) as its new one, its other query and its # kept; null when it isn't one.
 *  `search` with or without its "?". The # never reaches the server: the browser keeps it across the redirect. */
export function oldAdminAddress(pathname: string, search: string): string | null {
  const m = /^\/admin\/redesign(?:\/(.*?))?\/?$/.exec(pathname);
  if (!m) return null;
  const rest = m[1] ?? "";
  const q = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const withQuery = (path: string) => {
    const s = q.toString();
    return `${path}${s ? `?${s}` : ""}`;
  };
  const [first, ...more] = rest.split("/");
  // The index and a client's tabs: the client and the tab move into the path.
  if (!first || (tabOfSlug(first) && !(first === "invoices" && more.length))) {
    const client = q.get("client");
    const tab = tabOfSlug(q.get("tab")) ?? tabOfSlug(first) ?? "home";
    q.delete("client");
    q.delete("tab");
    const id = client && /^\d+$/.test(client) ? client : null;
    if (id) return withQuery(clientTab(tab, id));
    // No client named: /clients picks one (their last, else their first) and keeps the tab asked for.
    if (tab !== "home") q.set("tab", CLIENT_TAB_SLUG[tab]);
    return withQuery(ADMIN_HOME);
  }
  // The invoice as it prints.
  if (first === "invoices") return withQuery(`/invoices/${more.join("/")}`);
  // Your profile is Settings' first section.
  if (first === "profile") return `${withQuery("/settings")}#profile`;
  return withQuery(`/${rest}`);
}
