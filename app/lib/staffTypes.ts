// The staff admin's people and what each may do (26 Nov, Alex: docs/boards/staff-admin-mockup.html, "3 · Staff"). Pure
// types and words, so the store (app/lib/staff.ts), the server actions and the Staff screen in the browser share them.

/** One thing someone on staff may do. Owners have every one, and manage staff besides. */
export type StaffPerm = "coaches" | "billing_view" | "support" | "guides" | "signups" | "billing_change" | "remove_coach";
export type StaffRole = "owner" | "staff";

/** Every permission, in the order the Staff screen lists them. */
export const STAFF_PERMS: readonly StaffPerm[] = ["coaches", "billing_view", "support", "guides", "signups", "billing_change", "remove_coach"];

export const isStaffPerm = (v: unknown): v is StaffPerm => typeof v === "string" && (STAFF_PERMS as readonly string[]).includes(v);

/** Each permission's switch on the Staff screen: its name and one grey fact (the mockup's words). */
export const STAFF_PERM_WORDS: Record<StaffPerm, { name: string; fact: string }> = {
  coaches: { name: "See coaches", fact: "The list, a coach’s plan, clients and region" },
  billing_view: { name: "See what coaches pay", fact: "Pays, A month and Stripe" },
  support: { name: "Answer support", fact: "Reply, message coaches and mark a problem done" },
  guides: { name: "Make and edit guides", fact: "The help videos coaches watch" },
  signups: { name: "Let new coaches in", fact: "Sign-ups waiting and the website’s applications" },
  billing_change: { name: "Change a coach’s billing", fact: "Make them pay or make it free" },
  remove_coach: { name: "Remove a coach", fact: "Only a coach with no clients" },
};

/** One person on staff, as kept in `staff_members` (kv). The email is lower case and is who they are. */
export type StaffRecord = {
  email: string;
  role: StaffRole;
  perms: StaffPerm[];
  /** From their sign-in (Clerk's first and last name), written at most once every 10 minutes. */
  name?: string;
  addedAt: string;
  /** Who added them, by email; "OWNER_EMAIL" for the owner's own row, made the first time they come. */
  addedBy: string;
  lastInAt?: string;
};

/** The staff admin's own settings (kv `staff_settings`). */
export type StaffSettings = {
  /** New coaches wait for a yes on Sign-ups (default on). */
  approveCoaches?: boolean;
};

/** Someone signed in on staff, as every staff page and action sees them. `perms` is what they may do: every one for an
 *  owner. `envOwner`: the OWNER_EMAIL owner, who can't be removed or made staff. */
export type StaffMember = {
  email: string;
  name: string | null;
  role: StaffRole;
  perms: StaffPerm[];
  envOwner: boolean;
  addedAt: string | null;
  addedBy: string | null;
  lastInAt: string | null;
};

/** A row of the Staff screen (owners only): a StaffMember with what the screen needs. */
export type StaffRow = StaffMember & { you: boolean };

/** Whether this person may do this. Owners may do everything. */
export function staffCan(m: Pick<StaffMember, "role" | "perms"> | null | undefined, perm: StaffPerm): boolean {
  if (!m) return false;
  return m.role === "owner" || m.perms.includes(perm);
}

/** The person's first name, for `Remove Emma`: the first word of their name, else their email before the @. */
export function staffFirst(m: Pick<StaffMember, "name" | "email">): string {
  return (m.name?.trim().split(/\s+/)[0] || m.email.split("@")[0]).trim();
}
