import "server-only";
import { clerkClient } from "@clerk/nextjs/server";
import { getData } from "./db";
import { clerkOn } from "./clerk";
import { isOwner } from "./auth";
import { billingOn, billingView, getBilling, priceFor, TRIAL_DAYS, type BillingInterval } from "./billing";
import { readPrice, stripeTestMode } from "./stripe";
import { getCoachProfile } from "./queries";
import { countryOf } from "./countries";
import { isNorcode, norcode, typedNorcode } from "./norcode";
import { staffCan, type StaffMember } from "./staffTypes";
import { dayMonth } from "./dayMonth";

// The staff admin's coaches (26 Nov, Alex; the staff spec, "Data helpers"; docs/boards/staff-admin-mockup.html): every
// coach account as Norcoach's customer. Reads only: the account, its plan, what it pays, its clients as counts and where
// it last signed in from. Never a client's name, chat, media or anything they logged. What a coach pays (Pays, A month,
// Paying, Stripe) is only put in what goes out for someone with See what coaches pay: a viewer without it gets none of
// it, not even in the props the browser receives.

type CoachUser = ReturnType<typeof getData>["users"][number];
const coachUsers = (): CoachUser[] => getData().users.filter((u) => u.role === "coach");

/** A coach's Norcode as people read it (`NC-K7M2XQ9T`), only one made for them; never makes one (a read never writes). */
export function readNorcode(u: CoachUser): string | null {
  const code = u.coach_settings?.join_code;
  return code && u.coach_settings?.join_code_made && isNorcode(code) ? norcode(code) : null;
}

/** The coach a `/coaches/<key>` address names: `NC-…` (or the bare eight), else `id-<id>`. */
export function coachByKey(key: string): CoachUser | null {
  const k = decodeURIComponent(key).trim();
  const id = /^id-(\d+)$/i.exec(k);
  if (id) return coachUsers().find((u) => u.id === Number(id[1])) ?? null;
  const code = typedNorcode(k);
  if (!isNorcode(code)) return null;
  return coachUsers().find((u) => u.coach_settings?.join_code === code && u.coach_settings?.join_code_made) ?? null;
}

// ---- Clients, as counts ----------------------------------------------------------------------------------------

/** A coach's clients now (their example client is none), and how many of them are in the app: a login that has been
 *  used (a Clerk account, or a password once the temporary one handed out was changed) or a visit to the app on record. */
function clientCounts(): Map<number, { now: number; inApp: number }> {
  const data = getData();
  const used = new Set<number>();
  for (const u of data.users) if (u.role === "client" && u.client_id != null && (u.clerk_user_id || (u.password_hash && !u.must_change_password))) used.add(u.client_id);
  const out = new Map<number, { now: number; inApp: number }>();
  for (const c of data.clients) {
    if (c.example || c.coach_id == null) continue;
    const n = out.get(c.coach_id) ?? { now: 0, inApp: 0 };
    n.now += 1;
    if (used.has(c.id) || c.last_active_at) n.inApp += 1;
    out.set(c.coach_id, n);
  }
  return out;
}

// ---- What a plan costs ----------------------------------------------------------------------------------------

type Price = { amount: number; currency: string };
const PRICE_TTL = 60 * 60 * 1000;
const g = globalThis as unknown as { __staffPrices?: { at: number; v: Record<BillingInterval, Price | null> }; __staffClerk?: Map<string, { at: number; v: ClerkFacts }> };

/** The list price of each interval, from Stripe (kept an hour); none while billing is off. */
async function listPrices(): Promise<Record<BillingInterval, Price | null>> {
  if (!billingOn()) return { month: null, year: null };
  const hit = g.__staffPrices;
  if (hit && Date.now() - hit.at < PRICE_TTL) return hit.v;
  const [m, y] = await Promise.all([readPrice(priceFor("month") ?? ""), readPrice(priceFor("year") ?? "")]);
  const v = { month: m ? { amount: m.amount, currency: m.currency } : null, year: y ? { amount: y.amount, currency: y.currency } : null };
  if (m && y) g.__staffPrices = { at: Date.now(), v };
  return v;
}

/** A sum of money as it reads: `€59`, `€49.17`. */
export function money(amount: number, currency: string): string {
  const whole = Math.abs(amount - Math.round(amount)) < 0.005;
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency, minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 }).format(amount);
  } catch {
    return `${whole ? Math.round(amount) : amount.toFixed(2)} ${currency}`;
  }
}

// ---- What Clerk knows ------------------------------------------------------------------------------------------

/** When the coach was last in, where from, and how they sign in, as Clerk records them. */
type ClerkFacts = { lastInAt: string | null; city: string | null; country: string | null; signIn: string[] };
const CLERK_TTL = 10 * 60 * 1000;
const clerkCache = (g.__staffClerk ??= new Map());

const PROVIDERS: Record<string, string> = { google: "Google", apple: "Apple" };

/** Clerk's facts on these accounts: the users in one call, each one's latest session for the place (kept ten minutes).
 *  Empty while Clerk is off or not reachable. */
async function clerkFacts(ids: string[]): Promise<Map<string, ClerkFacts>> {
  const out = new Map<string, ClerkFacts>();
  if (!clerkOn() || ids.length === 0) return out;
  const now = Date.now();
  const want = ids.filter((id) => {
    const hit = clerkCache.get(id);
    if (hit && now - hit.at < CLERK_TTL) {
      out.set(id, hit.v);
      return false;
    }
    return true;
  });
  if (want.length === 0) return out;
  try {
    const clerk = await clerkClient();
    const users: Awaited<ReturnType<typeof clerk.users.getUserList>>["data"] = [];
    for (let i = 0; i < want.length; i += 100) {
      const page = await clerk.users.getUserList({ userId: want.slice(i, i + 100), limit: 100 });
      users.push(...page.data);
    }
    const places = await Promise.all(
      users.map(async (u) => {
        try {
          const list = await clerk.sessions.getSessionList({ userId: u.id, limit: 10 });
          const latest = [...list.data].filter((s) => s.latestActivity?.city || s.latestActivity?.country).sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
          return { city: latest?.latestActivity?.city ?? null, country: latest?.latestActivity?.country ?? null };
        } catch {
          return { city: null, country: null };
        }
      }),
    );
    users.forEach((u, i) => {
      const via = [...new Set(u.externalAccounts.map((a) => PROVIDERS[a.provider.replace(/^oauth_/, "")] ?? null).filter((p): p is string => !!p))];
      if (u.passwordEnabled || via.length === 0) via.push("Email");
      const v: ClerkFacts = { lastInAt: u.lastActiveAt ? new Date(u.lastActiveAt).toISOString() : u.lastSignInAt ? new Date(u.lastSignInAt).toISOString() : null, ...places[i], signIn: via };
      clerkCache.set(u.id, { at: now, v });
      out.set(u.id, v);
    });
  } catch (error) {
    console.error("[staff] could not read coaches from Clerk:", error instanceof Error ? error.message : error);
  }
  return out;
}

/** A country as Clerk gives it (`NL`), as a code or a name. */
function countryWords(c: string | null, long: boolean): string | null {
  if (!c) return null;
  if (!/^[A-Za-z]{2}$/.test(c)) return c;
  const code = c.toUpperCase();
  if (!long) return code;
  try {
    return new Intl.DisplayNames(["en-GB"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}
const place = (f: ClerkFacts | undefined, long: boolean) => {
  const p = [f?.city || null, countryWords(f?.country ?? null, long)].filter(Boolean).join(", ");
  return p || null;
};

// ---- The plan as a pill --------------------------------------------------------------------------------------

export type PlanTone = "" | "ink" | "grey" | "rust" | "red";
export type PlanPill = { word: string; tone: PlanTone };

type CoachMoney = { status: string; interval: BillingInterval | null; monthly: number | null; currency: string | null };

/** The plan's pill: Monthly or Yearly green, Trial ink, Free and Not started grey, Payment failed rust, Read-only red. */
function planOf(u: CoachUser): { pill: PlanPill; money: Omit<CoachMoney, "monthly" | "currency">; view: ReturnType<typeof billingView> } {
  const owner = isOwner(u);
  const view = billingView(u.id, owner);
  const interval = view.interval;
  if (!view.on) return { pill: view.status === "free" ? { word: "Free", tone: "grey" } : { word: "Not started", tone: "grey" }, money: { status: view.status === "free" ? "free" : "needed", interval: null }, view };
  let pill: PlanPill;
  if (view.access.state === "readonly") pill = { word: "Read-only", tone: "red" };
  else if (view.status === "active") pill = { word: interval === "year" ? "Yearly" : "Monthly", tone: "" };
  else if (view.status === "trialing") pill = { word: "Trial", tone: "ink" };
  else if (view.status === "past_due" || view.status === "unpaid") pill = { word: "Payment failed", tone: "rust" };
  else if (view.status === "free") pill = { word: "Free", tone: "grey" };
  else if (view.status === "canceled") pill = { word: "Cancelled", tone: "grey" };
  else if (view.status === "paused") pill = { word: "Paused", tone: "grey" };
  else pill = { word: "Not started", tone: "grey" };
  return { pill, money: { status: view.status ?? "needed", interval }, view };
}

/** What a plan is billed a month, list price (a yearly one over twelve), while it is billed: active, or a payment that
 *  failed and still runs. None for a trial, free, cancelled or not started. */
function monthlyOf(status: string, interval: BillingInterval | null, prices: Record<BillingInterval, Price | null>): Price | null {
  if (status !== "active" && status !== "past_due" && status !== "unpaid") return null;
  const p = prices[interval ?? "month"];
  if (!p) return null;
  return { amount: interval === "year" ? p.amount / 12 : p.amount, currency: p.currency };
}

// ---- The list -------------------------------------------------------------------------------------------------

const businessOf = (u: CoachUser) => u.coach_settings?.business?.business_name?.trim() || null;
const nameOf = (u: CoachUser) => {
  const p = getCoachProfile(u.id);
  const typed = p?.display_name?.trim();
  if (typed) return typed;
  const pending = u.pending?.name?.trim();
  if (pending) return pending;
  const words = (u.email.split("@")[0] ?? "").split(/[._-]+/).filter(Boolean);
  return words.length ? words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ") : "Coach";
};

export type StaffCoachRow = {
  id: number;
  /** The coach's own page, as the browser shows it on the staff host. */
  href: string;
  name: string;
  business: string | null;
  norcode: string | null;
  email: string;
  photo: string | null;
  plan: PlanPill;
  /** See what coaches pay only: `€59 a month`, or `Ends 2/12` on a trial; null for none (drawn as —). Absent without it. */
  pays?: { words: string; trial: boolean } | null;
  joinedAt: string;
  clients: number;
  lastInAt: string | null;
  region: string | null;
};

export type StaffCoachFigures = {
  coaches: number;
  /** Coaches who joined this calendar month. */
  newThisMonth: number;
  /** The month's name, `November`. */
  month: string;
  clients: number;
  /** See what coaches pay only. */
  paying?: { count: number; trial: number; free: number };
  aMonth?: { total: string; each: string | null };
};

export type StaffCoachesBoard = { figures: StaffCoachFigures; rows: StaffCoachRow[] };

/** The Coaches screen: the figures across Norcoach and a row a coach, the newest joined first. */
export async function loadStaffCoaches(viewer: StaffMember): Promise<StaffCoachesBoard> {
  const seesMoney = staffCan(viewer, "billing_view");
  const users = coachUsers();
  const counts = clientCounts();
  const [prices, facts] = await Promise.all([seesMoney ? listPrices() : Promise.resolve({ month: null, year: null }), clerkFacts(users.map((u) => u.clerk_user_id).filter((x): x is string => !!x))]);
  const now = new Date();
  let total = 0;
  let currency: string | null = null;
  let payingCount = 0;
  let trial = 0;
  let free = 0;
  const rows: StaffCoachRow[] = users.map((u) => {
    const { pill, money: m, view } = planOf(u);
    const f = u.clerk_user_id ? facts.get(u.clerk_user_id) : undefined;
    const row: StaffCoachRow = {
      id: u.id,
      href: `/coaches/${readNorcode(u) ? encodeURIComponent(readNorcode(u)!) : `id-${u.id}`}`,
      name: nameOf(u),
      business: businessOf(u),
      norcode: readNorcode(u),
      email: u.email,
      photo: getCoachProfile(u.id)?.avatar_path ?? null,
      plan: pill,
      joinedAt: u.created_at,
      clients: counts.get(u.id)?.now ?? 0,
      lastInAt: f?.lastInAt ?? null,
      region: place(f, false),
    };
    if (seesMoney) {
      if (m.status === "active") payingCount += 1;
      else if (m.status === "trialing") trial += 1;
      else if (m.status === "free") free += 1;
      const monthly = monthlyOf(m.status, m.interval, prices);
      if (monthly && m.status === "active") {
        total += monthly.amount;
        currency ??= monthly.currency;
      }
      row.pays =
        m.status === "trialing" && view.trialEnd
          ? { words: `Ends ${dayMonth(view.trialEnd)}`, trial: true }
          : monthly
            ? { words: `${money(Math.round(monthly.amount), monthly.currency)} a month`, trial: false }
            : null;
    }
    return row;
  });
  rows.sort((a, b) => b.joinedAt.localeCompare(a.joinedAt) || b.id - a.id);
  const clients = rows.reduce((s, r) => s + r.clients, 0);
  const figures: StaffCoachFigures = {
    coaches: rows.length,
    newThisMonth: rows.filter((r) => {
      const d = new Date(r.joinedAt);
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    }).length,
    month: now.toLocaleDateString("en-GB", { month: "long" }),
    clients,
  };
  if (seesMoney) {
    const cur = currency ?? prices.month?.currency ?? "EUR";
    figures.paying = { count: payingCount, trial, free };
    figures.aMonth = { total: money(Math.round(total), cur), each: payingCount ? money(Math.round(total / payingCount), cur) : null };
  }
  return { figures, rows };
}

// ---- A coach ----------------------------------------------------------------------------------------------------

export type StaffCoachPage = {
  id: number;
  name: string;
  first: string;
  business: string | null;
  country: string | null;
  norcode: string | null;
  photo: string | null;
  plan: PlanPill;
  /** Under the plan's figure: `Renews 12/12`, `Trial ends 26/10`, `Ends 12/12`. */
  planWhen: string | null;
  joinedAt: string;
  clients: number;
  inApp: number;
  /** The owner's own coach account: always free, never removed here. */
  ownerAccount: boolean;
  account: { email: string; signIn: string[]; lastInAt: string | null; region: string | null };
  /** Remove a coach only: no client of their own. */
  removable: boolean;
  /** See what coaches pay only; absent without it. */
  billing?: {
    pays: { amount: string; trialEnds: string | null } | null;
    planLine: string;
    /** Whether they pay Norcoach now (Make it free), else free (Make them pay). */
    required: boolean;
    trial: { used: boolean; from: string | null; to: string | null };
    stripe: { status: string | null; link: string | null };
  };
};

const STRIPE_WORDS: Record<string, string> = {
  needed: "Not started",
  trialing: "Trialing",
  active: "Active",
  past_due: "Past due",
  unpaid: "Unpaid",
  canceled: "Cancelled",
  incomplete: "Incomplete",
  incomplete_expired: "Expired",
  paused: "Paused",
};

/** One coach's page, by its address key; null when there is no such coach. */
export async function loadStaffCoach(viewer: StaffMember, key: string): Promise<StaffCoachPage | null> {
  const u = coachByKey(key);
  if (!u) return null;
  const seesMoney = staffCan(viewer, "billing_view");
  const { pill, money: m, view } = planOf(u);
  const [prices, facts] = await Promise.all([seesMoney ? listPrices() : Promise.resolve({ month: null, year: null }), clerkFacts(u.clerk_user_id ? [u.clerk_user_id] : [])]);
  const f = u.clerk_user_id ? facts.get(u.clerk_user_id) : undefined;
  const counts = clientCounts().get(u.id) ?? { now: 0, inApp: 0 };
  const name = nameOf(u);
  const code = u.coach_settings?.business?.country_code || u.coach_settings?.contact?.country_code || null;
  const country = code ? countryOf(code).name : u.coach_settings?.business?.country?.trim() || null;
  const owner = isOwner(u);
  const planWhen = !view.on
    ? null
    : m.status === "trialing" && view.trialEnd
      ? `Trial ends ${dayMonth(view.trialEnd)}`
      : view.cancelAtPeriodEnd && view.periodEnd
        ? `Ends ${dayMonth(view.periodEnd)}`
        : m.status === "active" && view.periodEnd
          ? `Renews ${dayMonth(view.periodEnd)}`
          : null;
  const page: StaffCoachPage = {
    id: u.id,
    name,
    first: name.split(/\s+/)[0] || name,
    business: businessOf(u),
    country: country && country !== "Other" ? country : null,
    norcode: readNorcode(u),
    photo: getCoachProfile(u.id)?.avatar_path ?? null,
    plan: pill,
    planWhen,
    joinedAt: u.created_at,
    clients: counts.now,
    inApp: counts.inApp,
    ownerAccount: owner,
    account: { email: u.email, signIn: f?.signIn ?? [], lastInAt: f?.lastInAt ?? null, region: place(f, true) },
    removable: !owner && counts.now === 0,
  };
  if (seesMoney) {
    const b = getBilling(u.id);
    const monthly = monthlyOf(m.status, m.interval, prices);
    const trialTo = b.trial_end ?? null;
    const trialFrom = trialTo ? new Date(Date.parse(trialTo) - TRIAL_DAYS * 86_400_000).toISOString() : null;
    page.billing = {
      pays: monthly ? { amount: money(Math.round(monthly.amount), monthly.currency), trialEnds: null } : m.status === "trialing" && view.trialEnd ? { amount: "", trialEnds: dayMonth(view.trialEnd) } : null,
      planLine: monthly ? `${pill.word}, ${money(Math.round(monthly.amount), monthly.currency)}` : pill.word,
      required: !owner && !!b.required,
      trial: { used: !!b.trial_used || !!trialTo, from: trialFrom ? dayMonth(trialFrom) : null, to: trialTo ? dayMonth(trialTo) : null },
      stripe: {
        status: b.status ? (STRIPE_WORDS[b.status] ?? b.status) : null,
        link: b.customer ? `https://dashboard.stripe.com/${stripeTestMode() ? "test/" : ""}customers/${encodeURIComponent(b.customer)}` : null,
      },
    };
  }
  return page;
}
