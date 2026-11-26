import { staffCan, type StaffMember, type StaffPerm } from "../lib/staffTypes";

// The staff admin's views (26 Nov, Alex; docs/boards/staff-admin-mockup.html), in the rail's order, each by the address
// it has on admin.norcoachapp.com (proxy.ts rewrites it under /staff) and what it takes to see it. A view someone can't
// use isn't in their rail.

export type StaffViewKey = "coaches" | "signups" | "support" | "guides" | "staff";
export type StaffView = { key: StaffViewKey; label: string; href: string; need: StaffPerm | "owner" };

export const STAFF_VIEWS: readonly StaffView[] = [
  { key: "coaches", label: "Coaches", href: "/", need: "coaches" },
  { key: "signups", label: "Sign-ups", href: "/signups", need: "signups" },
  { key: "support", label: "Support", href: "/support", need: "support" },
  { key: "guides", label: "Guides", href: "/guides", need: "guides" },
  { key: "staff", label: "Staff", href: "/staff", need: "owner" },
];

export const canSeeView = (m: Pick<StaffMember, "role" | "perms">, v: StaffView) => (v.need === "owner" ? m.role === "owner" : staffCan(m, v.need));

/** The views this person can open. */
export const viewsFor = (m: Pick<StaffMember, "role" | "perms">) => STAFF_VIEWS.filter((v) => canSeeView(m, v));

/** The view an address is on, as the browser shows it on the staff host: `/` and `/coaches/…` are Coaches, `/staff` is
 *  the Staff screen. A rewritten path (`/staff/staff`, `/staff/signups`, `/staff/coaches/…`) reads as its visible one;
 *  `/staff` alone is always the visible Staff screen. */
export function viewOfPath(pathname: string): StaffViewKey | null {
  const raw = pathname || "/";
  const p = raw.startsWith("/staff/") ? raw.slice("/staff".length) : raw;
  if (p === "/" || p === "/coaches" || p.startsWith("/coaches/")) return "coaches";
  const hit = STAFF_VIEWS.find((v) => v.href !== "/" && (p === v.href || p.startsWith(`${v.href}/`)));
  return hit?.key ?? null;
}

/** A coach's own page: by their Norcode, else `id-<id>` (the staff spec). */
export const coachHref = (c: { norcode?: string | null; id: number }) => `/coaches/${c.norcode ? encodeURIComponent(c.norcode) : `id-${c.id}`}`;
