import "server-only";
import { getData, type InvoiceEvent, type InvoiceEvery, type InvoiceLine, type InvoicePayMethod, type InvoicePays } from "./db";
import { getCoachFirstName, getCoachSettings, getInvoiceView, invoiceRepeatViews, listInvoices, localDateStr, nextInvoiceDate, type InvoiceView } from "./queries";
import { clientPlanBilling, clientPlanId, listCoachPlans } from "./coachPlans";
import { invoiceChargeOf, invoiceEventsOf, invoiceLateDays, invoiceStateOf, OWED_STATES, remindedToday, type InvoiceCharge, type InvoiceState } from "./invoiceEvents";
import { canPayOnline } from "./payments";
import { hasBankDetails, invoicingFor } from "./countries";
import { brandColour } from "./brandColour";
import { coachMark } from "./brandMark";
import { firstNameOf } from "./coachProfileView";

// What the coach's Invoices tab, its pop-ups and Settings › Plans read (26 Nov, Alex: docs/boards/client-invoices-
// mockup.html A, invoice-new-mockup.html B, plans-redesign-mockup.html A). One read a screen, built from the store:
// each invoice as it prints with what happened to it and the one state it is in (lib/invoiceEvents.ts); the client's
// Billing card (their plan, their own price, the series billing them, how they pay, the figures); and what the New
// invoice pop-up and its preview of what the client gets need. Plain data, safe to hand to the screen.

/** An invoice on the Invoices tab: as it prints, with its history and the state it is in. `via`: how it was paid.
 *  `charge`: a failed automatic charge and its retries, else null. `canRemind`: sent, not paid, not reminded today,
 *  and the client has an address. `payable`: paid by our page's link and the coach takes cards. `lateDays`: past due. */
export type InvoiceRow = InvoiceView & {
  events: InvoiceEvent[];
  state: InvoiceState;
  via: InvoicePayMethod | "stripe" | null;
  charge: InvoiceCharge | null;
  canRemind: boolean;
  remindedToday: boolean;
  payable: boolean;
  lateDays: number;
};

/** The client's address an invoice email goes to: their sign-in, else the one on their card. */
export function clientBillingEmail(clientId: number): string | null {
  const data = getData();
  const login = data.users.find((u) => u.role === "client" && u.client_id === clientId)?.email?.trim();
  const card = data.client_profiles.find((p) => p.client_id === clientId)?.email?.trim();
  const email = login || card || "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

/** One invoice with what happened to it (null when there is none). */
export function invoiceRowOf(invoiceId: number, today: string = localDateStr()): InvoiceRow | null {
  const inv = getData().invoices.find((i) => i.id === invoiceId);
  const v = getInvoiceView(invoiceId);
  if (!inv || !v) return null;
  const events = invoiceEventsOf(inv);
  const state = invoiceStateOf(inv, today, events);
  const owed = OWED_STATES.includes(state);
  const reminded = remindedToday(inv, today);
  return {
    ...v,
    events,
    state,
    via: state === "paid" || state === "refunded" ? (inv.paid_method ?? (inv.paid_via === "stripe" ? "stripe" : inv.paid_via === "manual" ? "bank" : null)) : null,
    charge: invoiceChargeOf(inv, events),
    canRemind: owed && !reminded && !!clientBillingEmail(inv.client_id),
    remindedToday: reminded,
    payable: owed && v.pays !== "bank" && canPayOnline(v.coachId),
    lateDays: invoiceLateDays(inv, today),
  };
}

/** The client's invoices, newest first, each with what happened to it. */
export function invoiceRowsFor(clientId: number, today: string = localDateStr()): InvoiceRow[] {
  return listInvoices(clientId)
    .map((i) => invoiceRowOf(i.id, today))
    .filter((r): r is InvoiceRow => !!r)
    .sort((a, b) => (a.issueDate === b.issueDate ? b.id - a.id : a.issueDate < b.issueDate ? 1 : -1));
}

/** The series on the Billing card. `next`: the day its next invoice comes (a paused one's next day still to come once
 *  resumed). `total`: what each one comes to. `started`: the day its first was issued. */
export type BillingSeries = { id: string; every: InvoiceEvery; next: string; anchorDay: number; lines: InvoiceLine[]; note: string; pays: InvoicePays; auto: boolean; paused: boolean; planId: string | null; total: number; started: string; send: boolean };

/**
 * The client's Billing card (26 Nov, Alex: docs/boards/client-invoices-mockup.html, A): their plan and its price, their
 * own price and since when, the series billing them (their plan's, else another one of theirs; a running one before a
 * paused one), its state, how they pay automatically, and the figures (Outstanding, Paid, Last paid). `plan.lines` and
 * `canStart` are the Start billing fill the screen read before (clientPlanBilling), kept.
 */
export type BillingCard = {
  plan: { id: string; name: string; price: number | null; every: InvoiceEvery | null; archived: boolean; lines: InvoiceLine[] } | null;
  canStart: boolean;
  ownPrice: number | null;
  ownSince: string | null;
  /** What they pay a period on the plan: their own price, else the plan's. */
  price: number | null;
  series: BillingSeries | null;
  state: "not_billed" | "active" | "paused";
  autopay: { kind: "card" | "sepa_debit"; brand?: string; last4?: string; since: string } | null;
  figures: {
    outstanding: number;
    outstandingCount: number;
    overdueCount: number;
    paid: number;
    paidCount: number;
    /** The issue day of the first invoice paid ("3 invoices since 26/9"). */
    paidSince: string | null;
    lastPaid: { date: string; amount: number; via: InvoicePayMethod | "stripe" | null } | null;
  };
  firstName: string;
  email: string | null;
  currency: string;
};

const r2 = (n: number) => Math.round(n * 100) / 100;
const stampDay = (s: string | null | undefined) => {
  if (!s) return null;
  const t = Date.parse(/T/.test(s) ? s : `${s.replace(" ", "T")}Z`);
  return Number.isFinite(t) ? localDateStr(new Date(t)) : s.slice(0, 10);
};

export function billingCardFor(coachId: number, clientId: number, rows: InvoiceRow[] = invoiceRowsFor(clientId)): BillingCard {
  const data = getData();
  const client = data.clients.find((c) => c.id === clientId);
  const profile = data.client_profiles.find((p) => p.client_id === clientId);
  const s = getCoachSettings(coachId);
  const eff = invoicingFor(s.business ?? {}, s.invoicing ?? {});
  const old = clientPlanBilling(coachId, clientId);
  const planId = clientPlanId(clientId);
  const plan = planId ? listCoachPlans(coachId, true).find((p) => p.id === planId) ?? null : null;
  const ownPrice = plan && profile?.coaching_plan_price != null ? profile.coaching_plan_price : null;

  const today = localDateStr();
  const views = invoiceRepeatViews(clientId);
  const pick = views.find((v) => plan && v.planId === plan.id) ?? views.find((v) => !v.paused) ?? views[0] ?? null;
  let series: BillingSeries | null = null;
  if (pick) {
    let next = pick.next;
    if (pick.paused) for (let guard = 0; next < today && guard < 400; guard++) next = nextInvoiceDate(next, pick.every, pick.anchorDay);
    series = { id: pick.id, every: pick.every, next, anchorDay: pick.anchorDay, lines: pick.lines, note: pick.note, pays: pick.pays, auto: pick.auto, paused: pick.paused, planId: pick.planId, total: pick.total, started: pick.started, send: pick.send };
  }

  const owed = rows.filter((r) => OWED_STATES.includes(r.state));
  const paid = rows.filter((r) => r.state === "paid");
  const paidDay = (r: InvoiceRow) => stampDay(r.paidAt) ?? r.issueDate;
  const last = [...paid].sort((a, b) => (paidDay(b) < paidDay(a) ? -1 : paidDay(b) > paidDay(a) ? 1 : b.id - a.id))[0];
  const firstPaid = paid.reduce<string | null>((m, r) => (m == null || r.issueDate < m ? r.issueDate : m), null);

  const ap = client?.autopay;
  return {
    plan: plan ? { id: plan.id, name: plan.name, price: plan.price ?? null, every: plan.every ?? null, archived: !!plan.archived, lines: old.plan?.lines ?? [] } : null,
    canStart: old.canStart,
    ownPrice,
    ownSince: ownPrice != null ? (profile?.coaching_plan_price_since ?? null) : null,
    price: ownPrice ?? plan?.price ?? null,
    series,
    state: !series ? "not_billed" : series.paused ? "paused" : "active",
    autopay: ap ? { kind: ap.kind, ...(ap.brand ? { brand: ap.brand } : {}), ...(ap.last4 ? { last4: ap.last4 } : {}), since: ap.since } : null,
    figures: {
      outstanding: r2(owed.reduce((t, r) => t + r.total, 0)),
      outstandingCount: owed.length,
      overdueCount: owed.filter((r) => r.lateDays > 0).length,
      paid: r2(paid.reduce((t, r) => t + r.total, 0)),
      paidCount: paid.length,
      paidSince: firstPaid,
      lastPaid: last ? { date: paidDay(last), amount: last.total, via: last.via } : null,
    },
    firstName: firstNameOf(client?.name ?? "Client"),
    email: clientBillingEmail(clientId),
    currency: eff.currency,
  };
}

/**
 * What the New invoice pop-up and its preview of what the client gets need (26 Nov, Alex: docs/boards/invoice-new-
 * mockup.html, B): the coach's plans (archived ones marked, for a client still on one), the client's plan and own
 * price, the coach's business name, first name, brand colour (and the words on it) and faint mark (the same file as
 * the page's own `--bg-mark`), how invoices are priced and numbered, whether there are bank details to print, whether
 * the coach takes cards, and where the email goes.
 */
export type InvoiceCompose = {
  plans: { id: string; name: string; price: number | null; every: InvoiceEvery | null; archived: boolean }[];
  clientPlanId: string | null;
  ownPrice: number | null;
  coach: { business: string; first: string; brand: { hex: string; ink: string } | null; mark: string | null };
  invoicing: { currency: string; vatRate: number; taxLabel: string; pricesIncludeVat: boolean; termsDays: number; prefix: string; nextNumber: string; bank: { iban: string | null; holder: string | null; words: string | null } | null };
  canPayByLink: boolean;
  email: string | null;
};

export function invoiceComposeFor(coachId: number, clientId: number): InvoiceCompose {
  const s = getCoachSettings(coachId);
  const b = s.business ?? {};
  const i = s.invoicing ?? {};
  const eff = invoicingFor(b, i);
  const today = localDateStr();
  const next = Math.max(1, Math.round(i.next_number ?? 1));
  const profile = getData().client_profiles.find((p) => p.client_id === clientId);
  const brand = s.brand?.color ? brandColour(s.brand.color) : null;
  const holder = i.account_holder || b.legal_name || b.business_name || null;
  return {
    plans: listCoachPlans(coachId, true).map((p) => ({ id: p.id, name: p.name, price: p.price ?? null, every: p.every ?? null, archived: !!p.archived })),
    clientPlanId: profile?.coaching_plan_id ?? null,
    ownPrice: profile?.coaching_plan_id && profile.coaching_plan_price != null ? profile.coaching_plan_price : null,
    coach: { business: b.business_name?.trim() || b.legal_name?.trim() || "", first: getCoachFirstName(clientId), brand: brand ? { hex: brand.hex, ink: brand.ink } : null, mark: coachMark(coachId) },
    invoicing: {
      currency: eff.currency,
      vatRate: eff.rate,
      taxLabel: eff.taxLabel,
      pricesIncludeVat: eff.pricesIncludeVat,
      termsDays: eff.termsDays,
      prefix: i.number_prefix ?? "",
      nextNumber: `${(i.number_prefix ?? "").replaceAll("{year}", today.slice(0, 4))}${String(next).padStart(4, "0")}`,
      bank: hasBankDetails(i, eff.country) ? { iban: i.iban || null, holder, words: i.bank_details?.trim() || null } : null,
    },
    canPayByLink: canPayOnline(coachId),
    email: clientBillingEmail(clientId),
  };
}
