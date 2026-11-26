// The staff admin's address (26 Nov, Alex: "Build it"; the staff spec): admin.norcoachapp.com live, admin.localhost:3000
// on a laptop, or what STAFF_HOST names (a comma-separated list). Pure, no Next imports, so proxy.ts and the server pages
// read it alike.

const DEFAULT_STAFF_HOSTS = ["admin.norcoachapp.com", "admin.localhost"];

const bare = (raw: string) => raw.trim().split(":")[0].toLowerCase();

/**
 * The host a request came in on, as the edge saw it: the `Host` header first (Railway's edge routes on it and passes it
 * on, and a visitor can't change it without landing on another host), else the last `x-forwarded-host` value (the one
 * the nearest proxy appended, never one the visitor sent first). Its port taken off, lower case.
 */
export function hostOf(headers: { get(name: string): string | null }): string {
  const host = headers.get("host");
  if (host && host.trim()) return bare(host);
  const fwd = (headers.get("x-forwarded-host") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return fwd.length ? bare(fwd[fwd.length - 1]) : "";
}

function staffHosts(): string[] {
  const env = typeof process !== "undefined" ? process.env.STAFF_HOST : undefined;
  const list = (env ?? "").split(",").map(bare).filter(Boolean);
  return list.length ? list : DEFAULT_STAFF_HOSTS;
}

/** The staff admin's host: exactly one of the staff hosts (admin.norcoachapp.com, admin.localhost, or STAFF_HOST's). */
export function isStaffHost(host: string | null | undefined): boolean {
  if (!host) return false;
  return staffHosts().includes(bare(host.split(",")[0]));
}

/** A request's headers on the staff host. */
export const onStaffHostHeaders = (headers: { get(name: string): string | null }) => isStaffHost(hostOf(headers));

/**
 * A `?next=` that is a plain path on this site, as `path?search#hash`, else null: printable ASCII only (a tab or a
 * newline after the slash would let a browser read `/\t/evil.com` as `//evil.com`), no backslash, and resolving to this
 * origin. Never the sign-in, Clerk's way in or the API.
 */
export function safeStaffNext(next: string | null | undefined): string | null {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return null;
  if (/[^\x21-\x7e]/.test(next) || next.includes("\\")) return null;
  let u: URL;
  try {
    u = new URL(next, "https://x.invalid");
  } catch {
    return null;
  }
  if (u.origin !== "https://x.invalid") return null;
  if (/^\/(login|auth|api|sso-callback)(\/|$)/.test(u.pathname)) return null;
  return u.pathname + u.search + u.hash;
}
