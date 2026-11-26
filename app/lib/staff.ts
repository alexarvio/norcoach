import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { auth, currentUser } from "@clerk/nextjs/server";
import { getData, persist } from "./db";
import { clerkOn } from "./clerk";
import { getSessionUser, ownerEmail } from "./auth";
import { hostOf, isStaffHost } from "./staffHost";
import { STAFF_PERMS, isStaffPerm, staffCan, type StaffMember, type StaffPerm, type StaffRecord, type StaffRole, type StaffRow, type StaffSettings } from "./staffTypes";

// Norcoach's staff (26 Nov, Alex: "Build it"; docs/boards/staff-admin-mockup.html): who can get into the staff admin at
// admin.norcoachapp.com, and what each may do. Kept in `staff_members` (db.ts, in `kv` on Postgres), one row a person by
// their email; OWNER_EMAIL is always an owner, in the list or not, and can't be removed or made staff. Who is signed in is
// their email: Clerk's (any verified one, the primary first) with Clerk on, else the session's users row. Nobody needs a
// coach account to be on staff. Every staff page and action calls requireStaff (or staffForAction) itself: the proxy only
// sends the host's pages here.

export type { StaffMember, StaffPerm, StaffRole, StaffRow, StaffRecord, StaffSettings } from "./staffTypes";
export { STAFF_PERMS, STAFF_PERM_WORDS, staffCan, staffFirst } from "./staffTypes";

/** The owner from the environment (OWNER_EMAIL), lower case, or null. */
export const OWNER_EMAIL = (): string | null => ownerEmail();

const TOUCH_MS = 10 * 60 * 1000;
const clean = (email: string) => email.trim().toLowerCase();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function rows(): StaffRecord[] {
  const data = getData();
  if (!Array.isArray(data.staff_members)) data.staff_members = [];
  return data.staff_members;
}

/** The staff admin's settings (`staff_settings`): new coaches wait for a yes unless switched off. */
export function staffSettings(): Required<StaffSettings> {
  const s = getData().staff_settings ?? {};
  return { approveCoaches: s.approveCoaches !== false };
}

/** Changes the staff admin's settings. Owners only: the caller checks (setStaffSettingAction). */
export function setStaffSettings(patch: Partial<StaffSettings>): void {
  const data = getData();
  data.staff_settings = { ...(data.staff_settings ?? {}), ...patch };
  persist();
}

function memberOf(r: StaffRecord | null, email: string): StaffMember | null {
  const env = OWNER_EMAIL();
  const envOwner = !!env && email === env;
  if (!r && !envOwner) return null;
  const role: StaffRole = envOwner ? "owner" : (r?.role ?? "staff");
  return {
    email,
    name: r?.name?.trim() || null,
    role,
    perms: role === "owner" ? [...STAFF_PERMS] : (r?.perms ?? []).filter(isStaffPerm),
    envOwner,
    addedAt: envOwner && (!r || r.addedBy === "OWNER_EMAIL") ? null : (r?.addedAt ?? null),
    addedBy: r?.addedBy ?? null,
    lastInAt: r?.lastInAt ?? null,
  };
}

/** The staff row for an email, if any (not the env owner's stand-in). */
const recordFor = (email: string) => rows().find((r) => r.email === clean(email)) ?? null;

/** Clerk couldn't say who is signed in (its Backend API failed or is rate-limited): never "signed out", so never a
 *  redirect to /login (that would loop back here); a page shows the error, an action says Try again. */
export class StaffUnavailableError extends Error {
  constructor() {
    super("Clerk unavailable");
    this.name = "StaffUnavailableError";
  }
}

type Identity = { emails: string[]; name: string | null };
// Who each Clerk user is, kept a minute by their userId (auth() reads the session token locally, no API call), so a
// page of coach faces or a burst of actions makes one Clerk call, not one each. On a failure the last known entry
// stands in, however old.
const IDENTITY_MS = 60 * 1000;
const identities = new Map<string, { at: number; who: Identity }>();

async function clerkWho(userId: string): Promise<Identity> {
  const kept = identities.get(userId);
  if (kept && Date.now() - kept.at < IDENTITY_MS) return kept.who;
  let u: Awaited<ReturnType<typeof currentUser>> = null;
  try {
    u = await currentUser();
  } catch {
    u = null;
  }
  if (!u) {
    if (kept) return kept.who;
    throw new StaffUnavailableError();
  }
  const primary = u.primaryEmailAddress?.emailAddress ? clean(u.primaryEmailAddress.emailAddress) : null;
  const verified = u.emailAddresses.filter((e) => e.verification?.status === "verified").map((e) => clean(e.emailAddress));
  const emails = [...new Set([...(primary && verified.includes(primary) ? [primary] : []), ...verified])];
  const name = [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || null;
  // Signed in with no verified email: still signed in (so /not-staff, never a loop back to /login), on staff as nobody.
  const who = { emails, name };
  if (identities.size > 500) identities.clear();
  identities.set(userId, { at: Date.now(), who });
  return who;
}

/** Who is signed in, by email (every verified email, the primary first) and name, or null when nobody is. Throws
 *  StaffUnavailableError when someone is signed in but Clerk can't say who. */
export const staffIdentity = cache(async (): Promise<Identity | null> => {
  if (clerkOn()) {
    let userId: string | null;
    try {
      userId = (await auth()).userId;
    } catch {
      throw new StaffUnavailableError();
    }
    if (!userId) return null;
    return clerkWho(userId);
  }
  const user = await getSessionUser();
  return user ? { emails: [clean(user.email)], name: null } : null;
});

/** The signed-in person on staff, or null (signed out, not on staff, or Clerk unreachable: a route or the frame then
 *  shows nothing secret; requireStaff and staffForAction tell the failure apart). Notes when they were last in, and
 *  their name, at most once every 10 minutes. Cached for the request. */
export const getStaff = cache(async (): Promise<StaffMember | null> => {
  let who: Identity | null;
  try {
    who = await staffIdentity();
  } catch (e) {
    if (e instanceof StaffUnavailableError) return null;
    throw e;
  }
  if (!who) return null;
  const env = OWNER_EMAIL();
  const email = who.emails.find((e) => recordFor(e) || e === env);
  if (!email) return null;
  let r = recordFor(email);
  const now = new Date();
  // The env owner gets a row the first time they come, so their Last in and name are kept like anyone's.
  if (!r && email === env) {
    r = { email, role: "owner", perms: [], addedAt: now.toISOString(), addedBy: "OWNER_EMAIL" };
    rows().push(r);
  }
  if (!r) return null;
  const stale = !r.lastInAt || now.getTime() - Date.parse(r.lastInAt) > TOUCH_MS;
  const renamed = !!who.name && who.name !== r.name;
  if (stale || renamed) {
    r.lastInAt = now.toISOString();
    if (who.name) r.name = who.name;
    persist();
  }
  return memberOf(r, email);
});

/** The email a signed-in person who isn't on staff is signed in with (for /not-staff), or null. */
export async function signedInEmail(): Promise<string | null> {
  return (await staffIdentity())?.emails[0] ?? null;
}

/**
 * Staff only, for a page: signed out → /login; signed in but not on staff → /not-staff, which shows nothing; on staff
 * without this permission → 404. Returns who they are.
 */
export async function requireStaff(perm?: StaffPerm): Promise<StaffMember> {
  const who = await staffIdentity();
  if (!who) redirect("/login");
  const m = await getStaff();
  if (!m) redirect("/not-staff");
  if (perm && !staffCan(m, perm)) notFound();
  return m;
}

/** Owners only, for a page (the Staff screen): anyone else on staff gets a 404. */
export async function requireStaffOwner(): Promise<StaffMember> {
  const m = await requireStaff();
  if (m.role !== "owner") notFound();
  return m;
}

/** For a server action: who they are when on staff with this permission (an owner with `perm: "owner"`), else
 *  `{ error }` to show, never a throw. */
export async function staffForAction(perm?: StaffPerm | "owner"): Promise<{ staff: StaffMember; error?: undefined } | { staff?: undefined; error: string }> {
  try {
    await staffIdentity();
  } catch (e) {
    if (e instanceof StaffUnavailableError) return { error: "Not reached. Try again" };
    throw e;
  }
  const m = await getStaff();
  if (!m) return { error: "Not on Norcoach staff" };
  if (perm === "owner" ? m.role !== "owner" : perm && !staffCan(m, perm)) return { error: "Not allowed" };
  return { staff: m };
}

/** Whether this request came in on the staff admin's host. */
export async function onStaffHost(): Promise<boolean> {
  return isStaffHost(hostOf(await headers()));
}

/** Whether an email is on staff (the env owner too). For a route that already knows who is asking. */
export function isStaffEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const e = clean(email);
  return e === OWNER_EMAIL() || !!recordFor(e);
}

/** The staff member behind an email, for a route that knows who is asking (the uploads route): never writes. */
export function staffByEmail(email: string | null | undefined): StaffMember | null {
  if (!email) return null;
  const e = clean(email);
  return memberOf(recordFor(e), e);
}

// ---- The Staff screen ----------------------------------------------------------------------------------------------

/** Everyone on staff, the owners first, then by when they were added. The env owner is always there. */
export function listStaff(viewer: StaffMember): StaffRow[] {
  const env = OWNER_EMAIL();
  const list = rows().map((r) => memberOf(r, r.email)).filter((m): m is StaffMember => !!m);
  if (env && !list.some((m) => m.email === env)) list.push(memberOf(null, env)!);
  return list
    .sort((a, b) => (a.role === b.role ? 0 : a.role === "owner" ? -1 : 1) || Number(b.envOwner) - Number(a.envOwner) || (a.addedAt ?? "").localeCompare(b.addedAt ?? ""))
    .map((m) => ({ ...m, you: m.email === viewer.email }));
}

type Result = { error?: string };
const ownersLeft = (but: string) => rows().filter((r) => r.role === "owner" && r.email !== but).length + (OWNER_EMAIL() && OWNER_EMAIL() !== but ? 1 : 0);

/** Adds someone (owners only). Staff start with no permissions but See coaches; an owner has them all. */
export function addStaffMember(by: StaffMember, input: { email: string; role: StaffRole }): Result {
  if (by.role !== "owner") return { error: "Not allowed" };
  const email = clean(input.email);
  if (!EMAIL_RE.test(email) || email.length > 200) return { error: "Not an email" };
  if (input.role !== "owner" && input.role !== "staff") return { error: "Not allowed" };
  if (recordFor(email) || email === OWNER_EMAIL()) return { error: "On staff already" };
  rows().push({ email, role: input.role, perms: input.role === "owner" ? [] : ["coaches"], addedAt: new Date().toISOString(), addedBy: by.email });
  persist();
  return {};
}

/** Takes someone off staff (owners only): never the env owner, never yourself, never the last owner. */
export function removeStaffMember(by: StaffMember, email: string): Result {
  if (by.role !== "owner") return { error: "Not allowed" };
  const e = clean(email);
  if (e === OWNER_EMAIL()) return { error: "The owner stays" };
  if (e === by.email) return { error: "Not yourself" };
  const r = recordFor(e);
  if (!r) return { error: "Not on staff" };
  if (r.role === "owner" && ownersLeft(e) === 0) return { error: "The last owner stays" };
  getData().staff_members = rows().filter((x) => x.email !== e);
  persist();
  return {};
}

/** Makes someone an owner or staff (owners only): never the env owner, never yourself, never the last owner made staff. */
export function setStaffRole(by: StaffMember, email: string, role: StaffRole): Result {
  if (by.role !== "owner") return { error: "Not allowed" };
  if (role !== "owner" && role !== "staff") return { error: "Not allowed" };
  const e = clean(email);
  if (e === OWNER_EMAIL()) return { error: "The owner stays" };
  if (e === by.email) return { error: "Not yourself" };
  const r = recordFor(e);
  if (!r) return { error: "Not on staff" };
  if (r.role === role) return {};
  if (role === "staff" && ownersLeft(e) === 0) return { error: "The last owner stays" };
  r.role = role;
  // Made staff, they keep what they had switched on before (an owner's row holds none: See coaches to start).
  if (role === "staff" && r.perms.length === 0) r.perms = ["coaches"];
  persist();
  return {};
}

/** Switches one thing on or off for someone on staff (owners only). An owner's row has no switches. */
export function setStaffPerm(by: StaffMember, email: string, perm: StaffPerm, on: boolean): Result {
  if (by.role !== "owner") return { error: "Not allowed" };
  if (!isStaffPerm(perm)) return { error: "Not allowed" };
  const r = recordFor(email);
  if (!r || clean(email) === OWNER_EMAIL()) return { error: "Not on staff" };
  if (r.role === "owner") return { error: "Owners can do everything" };
  const has = r.perms.includes(perm);
  if (has === on) return {};
  r.perms = on ? STAFF_PERMS.filter((p) => p === perm || r.perms.includes(p)) : r.perms.filter((p) => p !== perm);
  persist();
  return {};
}
