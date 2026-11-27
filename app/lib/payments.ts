import { accountState, minorUnits, stripeConfigured, stripeTestMode } from "./stripe";
import { getCoachPayments, getInvoiceView, logCoachActivity, markInvoicePaidOnline, setCoachPayments } from "./queries";
import { sendPushInBackground } from "./push";
import { getData, type InvoicePayMethod } from "./db";
import { addInvoiceEvent } from "./invoiceEvents";

// Online payments as the app sees them: whether they are on at all (the
// platform's keys), where a coach's Stripe account stands, and what happens
// when Stripe says an invoice was paid. The Stripe calls themselves are in
// lib/stripe.ts; this is the part that knows about coaches and invoices.

/** "off": no keys on the server. "none": the coach hasn't started. "pending": started, Stripe still needs things. "active": clients can pay. */
export type PaymentsState = { status: "off" | "none" | "pending" | "active"; testMode: boolean };

export function paymentsState(coachId: number): PaymentsState {
  if (!stripeConfigured()) return { status: "off", testMode: false };
  const p = getCoachPayments(coachId);
  return { status: !p.stripe_account_id ? "none" : p.stripe_status === "active" ? "active" : "pending", testMode: stripeTestMode() };
}

/** Asks Stripe where the coach's account stands (after onboarding, or while it is pending). */
export async function refreshCoachStripe(coachId: number): Promise<PaymentsState> {
  const p = getCoachPayments(coachId);
  if (stripeConfigured() && p.stripe_account_id) {
    try {
      const a = await accountState(p.stripe_account_id);
      const status = a.chargesEnabled ? "active" : "pending";
      if (status !== p.stripe_status) setCoachPayments(coachId, { stripe_status: status });
    } catch {
      // Stripe unreachable: keep what we knew.
    }
  }
  return paymentsState(coachId);
}

export function canPayOnline(coachId: number | null): boolean {
  return coachId != null && paymentsState(coachId).status === "active";
}

/** This checkout has already marked this invoice Paid once. */
export function checkoutUsed(invoiceId: number, sessionId: string): boolean {
  return getData().invoices.find((i) => i.id === invoiceId)?.stripe_session_id === sessionId;
}

/** What Stripe says came in (26 Nov, Alex): the money (minor units) and currency, how it was paid ("Visa •••• 4242"),
 *  the PaymentIntent, and who paid: the client at a checkout, or "auto" for an automatic charge. */
export type StripeMoney = { amount: number | null; currency: string | null; method?: InvoicePayMethod; detail?: string; intent?: string; by?: "client" | "auto" };

/**
 * Stripe told us (the webhook, the way back from a checkout, an automatic charge's answer) that money came in for an
 * invoice: `ref` is the checkout (cs_…) or the PaymentIntent (pi_…) it came through. Paid only when it is the coach's
 * own account (markInvoicePaidOnline) and exactly the invoice's amount in its currency (26 Nov, Alex: never Paid without
 * Stripe confirming the right amount); any other amount is kept in its history and the coach told, never Paid. Money
 * for an invoice already paid or refunded is kept as paid twice and the coach told, once. Safe to run twice.
 */
export function invoicePaidByStripe(invoiceId: number, ref: string, account: string | undefined, money?: StripeMoney) {
  // A checkout pays an invoice once (23 Nov, review): one that already marked it Paid, the invoice since set back by
  // the coach (a refund, paid by bank after all), never marks it again, from a webhook retried, the email's old Pay
  // or the way back from Stripe opened again.
  if (checkoutUsed(invoiceId, ref)) return;
  const row = getData().invoices.find((i) => i.id === invoiceId);
  if (!row) return;
  const coachOf = row.coach_id ?? getData().clients.find((c) => c.id === row.client_id)?.coach_id ?? null;
  // Only the coach's own account speaks for their invoice (never another account's event with this id in it).
  if (coachOf == null || !account || getCoachPayments(coachOf).stripe_account_id !== account) {
    console.error(`[payments] money for invoice ${invoiceId} on an account that isn't its coach's (${account ?? "none"}): left alone`);
    return;
  }
  const client = getData().clients.find((c) => c.id === row.client_id);
  const who = client?.name?.split(/\s+/)[0] || "A client";
  const number = row.number ?? `#${invoiceId}`;
  const tell = (title: string, body: string, tag: string) => sendPushInBackground(coachOf, { title, body, url: `/clients/${row.client_id}/invoices`, tag });
  // Already paid (or refunded): paid twice, kept once a payment, and the coach told (26 Nov, Alex: never silent).
  if (row.status === "paid") {
    const before = (row.events ?? []).filter((e) => e.kind === "paid_twice").length;
    markInvoicePaidOnline(invoiceId, ref, account, money?.method, { intent: money?.intent });
    if ((getData().invoices.find((i) => i.id === invoiceId)?.events ?? []).filter((e) => e.kind === "paid_twice").length > before) tell("Paid twice", `${who} paid ${number} again`, `invoice-twice:${ref}`);
    return;
  }
  // The right money, or none of it (26 Nov): a payment for another amount or currency never marks it Paid.
  const currency = (row.currency ?? "EUR").toUpperCase();
  // The total the invoice shows and its checkout asked (getInvoiceView), the stored amount where there is none.
  const expected = minorUnits(getInvoiceView(invoiceId)?.total ?? row.amount, currency);
  if (money && (money.amount !== expected || (money.currency ?? "").toUpperCase() !== currency)) {
    if (!(row.events ?? []).some((e) => e.kind === "paid_wrong_amount" && e.detail?.endsWith(ref))) {
      const got = money.amount != null && money.currency ? `${(money.amount / (minorUnits(1, money.currency) || 1)).toFixed(2)} ${money.currency.toUpperCase()}` : "unknown amount";
      addInvoiceEvent(invoiceId, { kind: "paid_wrong_amount", detail: `${got} | ${ref}`, by: money.by ?? "client", ...(money.method ? { via: money.method } : {}) });
      tell("Payment to check", `${who} paid ${got} for ${number}`, `invoice-amount:${ref}`);
    }
    return;
  }
  const inv = markInvoicePaidOnline(invoiceId, ref, account, money?.method, { detail: money?.detail, by: money?.by, intent: money?.intent });
  if (!inv) return;
  const name = inv.number ?? "your invoice";
  logCoachActivity(inv.client_id, `Received your payment for ${name}`, { kind: "general", actionTab: "invoices", actionLabel: "See your invoices", dedupeKey: `invoice-paid-online:${invoiceId}` });
  // The coach hears on their devices, when they have notifications on.
  const coachId = inv.coach_id;
  if (coachId != null) sendPushInBackground(coachId, { title: "Invoice paid", body: `${client?.name ?? "A client"} paid ${name}`, url: `/clients/${inv.client_id}/invoices`, tag: `invoice-paid:${invoiceId}` });
}

/** Stripe told us an account changed (account.updated): keep its status current. */
export function stripeAccountUpdated(account: string, chargesEnabled: boolean) {
  const coach = getData().users.find((u) => u.role === "coach" && u.coach_settings?.payments?.stripe_account_id === account);
  if (!coach) return;
  const status = chargesEnabled ? "active" : "pending";
  if (coach.coach_settings?.payments?.stripe_status !== status) setCoachPayments(coach.id, { stripe_status: status });
}
