import "server-only";
import { getData, persist, type ClientAutopay, type InvoicePayMethod } from "./db";
import { autopayWords, bankWord, brandWord, declineWords, ordinal, paidWords, wholeMoney } from "./payWords";
import { getCoachPayments, getInvoiceView, invoiceRepeatViews, localDateStr, logCoachActivity } from "./queries";
import { canPayOnline, invoicePaidByStripe } from "./payments";
import {
  StripeError,
  cancelPaymentIntent,
  chargeOffSession,
  createCustomer,
  customerIntents,
  detachPaymentMethod,
  minorUnits,
  readCharge,
  readInvoiceCheckout,
  readPaymentIntent,
  refundPaymentIntent,
  stripeConfigured,
  type StripeIntent,
} from "./stripe";
import { CHARGE_RETRIES, addInvoiceEvent, invoiceChargeOf, invoiceEventsOf, invoiceStateOf, stampIso } from "./invoiceEvents";
import { sendInvoiceMailNow } from "./invoiceEmails";
import { sendPushInBackground } from "./push";
import { countryCodeFromName, formatMoney } from "./countries";
import { dayWords } from "./clientDates";

// Paying automatically (26 Nov, Alex: docs/boards/client-invoices-mockup.html A and invoice-new-mockup.html B; "on a
// repeating plan Alex can choose there to pay automatically from then on; later invoices are charged by themselves").
//
// The client ticks "Pay automatically from now on" on an invoice of a series with Charge automatically on, and pays it
// through Stripe's checkout on the coach's own account as a customer there (ensureCustomer), the payment kept for later
// (lib/stripe.ts invoiceCheckout, `save`). Paid, the card or the SEPA mandate an iDEAL payment leaves is kept on the
// client (Client.autopay, keepAutopay) and the invoice's history says "Automatic payment on". From then each invoice the
// series makes itself is charged off session (chargeInvoice), from the ten-minute job beside the recurring invoices
// (runInvoiceCharges, instrumentation.ts). Norcoach takes no cut: no application fee anywhere.
//
// A charge declined is retried a day later, three times (26 Nov, Alex): the first try, then retry 1, 2 and 3 a day
// apart; after the third the coach is told (a push, and a row of the client's To do under Invoices) and the client gets
// the invoice's link by email. A charge the bank wants the client to confirm (3D Secure) emails them the link at once,
// and is still counted. The client's app is never locked for it. Paid by link or marked paid by hand, no try is made
// again (each try reads the invoice first).
//
// Money safety: every create carries an idempotency key (one a customer, one a try, one a refund); a try is written down
// before it goes, so a restart mid-call sends the same try again with the same key and gets back the same charge; before
// any try, the customer's charges on Stripe are read, and one already made for the invoice that went through, or is on
// its way, is applied instead of charging again. Paid only on Stripe's word for exactly the invoice's amount on the
// coach's own account (lib/payments.ts invoicePaidByStripe). Every handler is safe to run twice: each failed try and each
// refund is written once.
//
// Off unless STRIPE_SECRET_KEY is set; the charges themselves only where INVOICE_CHARGES=on (as INVOICE_EMAILS: a copy
// of the live data on a dev or staging server must never charge real clients), and never with RECURRING_INVOICES=off.

const DAY_MS = 24 * 60 * 60 * 1000;
/** A try sent with no answer back after this long is sent again (the same key: the same charge). */
const STALE_MS = 15 * 60 * 1000;
/** No first charge on an invoice issued longer ago than this (a server off for weeks never charges old months). */
const FIRST_WITHIN_DAYS = 30;

type InvoiceRow = ReturnType<typeof getData>["invoices"][number];
type ClientRow = ReturnType<typeof getData>["clients"][number];

/** Automatic charges are sent from this server (INVOICE_CHARGES=on, with Stripe's keys). */
export function chargesOn(): boolean {
  return stripeConfigured() && process.env.INVOICE_CHARGES === "on" && process.env.RECURRING_INVOICES !== "off";
}


// ---- The client and the series -----------------------------------------------------------------------------------

const clientOf = (inv: InvoiceRow): ClientRow | undefined => getData().clients.find((c) => c.id === inv.client_id);
const coachIdOf = (inv: InvoiceRow, c?: ClientRow) => inv.coach_id ?? c?.coach_id ?? null;
const seriesOf = (inv: InvoiceRow, c?: ClientRow) => (inv.repeat_id ? c?.invoice_repeats?.find((r) => r.id === inv.repeat_id) : undefined);
/** The kept way to pay, if it lives on the coach's account now (a coach who connected another account starts over). */
const autopayOn = (c: ClientRow | undefined, account: string | undefined) => (c?.autopay && account && c.autopay.account === account && c.autopay.customer && c.autopay.payment_method ? c.autopay : null);

/**
 * "Pay automatically from now on" (26 Nov, Alex), for the invoice's page and the client's app: offered on an invoice
 * still to pay, of a series with Charge automatically on and paid by link, its coach taking payments, while the client
 * has no way kept on that coach's account. `fact`: what it means, "€89 on the 26th of each month from 26 Dec". Null:
 * not offered.
 */
export function autopayOfferFor(invoiceId: number): { fact: string } | null {
  const inv = getData().invoices.find((i) => i.id === invoiceId);
  if (!inv || (inv.status !== "sent" && inv.status !== "due") || inv.refunded_at || inv.pays === "bank") return null;
  const c = clientOf(inv);
  const r = seriesOf(inv, c);
  const coachId = coachIdOf(inv, c);
  if (!c || c.example || !r || !r.auto || r.pays === "bank" || r.paused || coachId == null || !canPayOnline(coachId)) return null;
  const account = getCoachPayments(coachId).stripe_account_id;
  if (!account || autopayOn(c, account)) return null;
  const view = invoiceRepeatViews(c.id).find((x) => x.id === r.id);
  if (!view) return null;
  const cc = inv.from?.country_code || countryCodeFromName(inv.from?.country);
  const amount = wholeMoney(formatMoney(view.total, view.currency, cc));
  const from = dayWords(r.next);
  if (r.every === "month") return { fact: `${amount} on the ${ordinal(r.anchor_day)} of each month from ${from}` };
  return { fact: `${amount} every ${r.every === "week" ? "week" : "2 weeks"} from ${from}` };
}

/** The client's way kept on the coach's account, in words, for the invoice's page ("Pays by Visa •••• 4242"). */
export function autopayWordsFor(invoiceId: number): string | null {
  const inv = getData().invoices.find((i) => i.id === invoiceId);
  if (!inv) return null;
  const c = clientOf(inv);
  const coachId = coachIdOf(inv, c);
  const a = coachId != null ? autopayOn(c, getCoachPayments(coachId).stripe_account_id) : null;
  return a ? autopayWords(a) : null;
}

const customersMaking = new Map<string, Promise<string>>();

/** The client as a customer on the coach's account, made once and kept (Client.stripe_customers): what a checkout kept
 *  for later and every automatic charge go on. Throws when Stripe doesn't answer. */
export function ensureCustomer(clientId: number, account: string): Promise<string> {
  const c = getData().clients.find((x) => x.id === clientId);
  if (!c) return Promise.reject(new Error("No such client."));
  const kept = c.stripe_customers?.[account] ?? (c.autopay?.account === account ? c.autopay.customer : undefined);
  if (kept) return Promise.resolve(kept);
  const key = `${clientId}:${account}`;
  const busy = customersMaking.get(key);
  if (busy) return busy;
  const data = getData();
  const email = data.users.find((u) => u.role === "client" && u.client_id === clientId)?.email?.trim() || data.client_profiles.find((p) => p.client_id === clientId)?.email?.trim() || undefined;
  const run = createCustomer(account, { email, name: c.name, metadata: { norcoach_client_id: String(clientId) }, idempotencyKey: `norcoach-customer-${clientId}-${account}` })
    .then((id) => {
      const now = getData().clients.find((x) => x.id === clientId);
      if (now) {
        now.stripe_customers = { ...(now.stripe_customers ?? {}), [account]: id };
        persist();
      }
      return id;
    })
    .finally(() => customersMaking.delete(key));
  customersMaking.set(key, run);
  return run;
}

/**
 * A checkout kept for later went through (the way back from Stripe or the webhook): the card, or the SEPA mandate an
 * iDEAL payment left, kept on the client as their way to pay automatically, and "Automatic payment on" in the
 * invoice's history, once. Only for the client's own customer on the coach's own account.
 */
export function keepAutopay(invoiceId: number, account: string, p: StripeIntent): boolean {
  const inv = getData().invoices.find((i) => i.id === invoiceId);
  const c = inv ? clientOf(inv) : undefined;
  if (!inv || !c || !p.customer) return false;
  const coachId = coachIdOf(inv, c);
  if (coachId == null || getCoachPayments(coachId).stripe_account_id !== account) return false;
  const ours = c.stripe_customers?.[account];
  if (ours && ours !== p.customer) {
    console.error(`[payments] a kept payment for invoice ${invoiceId} on a customer that isn't the client's: not kept`);
    return false;
  }
  const f = p.facts;
  let kind: ClientAutopay["kind"];
  let pm: string | null;
  let mandate: string | undefined;
  if (f?.type === "ideal") {
    // iDEAL kept for later leaves a SEPA Direct Debit method and its mandate (Stripe's generated_sepa_debit).
    kind = "sepa_debit";
    pm = f.generatedSepa ?? null;
    mandate = f.generatedMandate;
  } else if (f?.type === "sepa_debit") {
    kind = "sepa_debit";
    pm = p.paymentMethod;
    mandate = f.mandate;
  } else if (f?.type === "card") {
    kind = "card";
    pm = p.paymentMethod;
  } else return false;
  if (!pm) return false;
  if (c.autopay?.payment_method === pm && c.autopay.account === account) return false;
  const brand = f.type === "card" ? brandWord(f.brand) : f.type === "ideal" ? bankWord(f.bank) || undefined : undefined;
  c.autopay = { kind, ...(brand ? { brand } : {}), ...(f.last4 ? { last4: f.last4 } : {}), since: new Date().toISOString(), account, customer: p.customer, payment_method: pm, ...(mandate ? { mandate } : {}) };
  c.stripe_customers = { ...(c.stripe_customers ?? {}), [account]: p.customer };
  const via = f.type === "card" ? (f.wallet === "apple_pay" ? "apple_pay" : "card") : f.type;
  addInvoiceEvent(invoiceId, { kind: "auto_on", via, detail: autopayWords(c.autopay), by: "client" }, { persist: false });
  persist();
  return true;
}

/**
 * The coach turns automatic payment off for the client and forgets the way kept (26 Nov, Alex): it is taken off the
 * customer on Stripe too, so nothing can be charged on it again (best effort: Stripe unreachable, it is forgotten here,
 * which alone stops every charge). Charge automatically on the series stays the coach's switch (updateInvoiceRepeat).
 */
export async function forgetAutopay(clientId: number): Promise<boolean> {
  const c = getData().clients.find((x) => x.id === clientId);
  const a = c?.autopay;
  if (!c || !a) return false;
  delete c.autopay;
  persist();
  if (a.account && a.payment_method && stripeConfigured()) {
    await detachPaymentMethod(a.account, a.payment_method).catch((e) => console.error("[payments] detaching a kept way to pay failed:", e instanceof Error ? e.message : e));
  }
  return true;
}

// ---- A charge's answer -------------------------------------------------------------------------------------------

/** The run of failed tries since the invoice was last paid, set back or marked: its first (by whom) and its retries. */
function runOf(inv: InvoiceRow) {
  const events = invoiceEventsOf(inv);
  let start = 0;
  events.forEach((e, i) => {
    if (e.kind === "paid" || e.kind === "marked_paid" || e.kind === "marked_unpaid") start = i + 1;
  });
  const run = events.slice(start);
  return { events, first: run.find((e) => e.kind === "charge_failed"), retries: run.filter((e) => e.kind === "retry").length, told: run.some((e) => e.kind === "coach_told"), pending: run.filter((e) => ["pending", "charge_failed", "retry"].includes(e.kind)).pop()?.kind === "pending" };
}

/** A bank debit on its way (a SEPA charge processing, a checkout paid by debit): "pending" in its history, once. */
export function noteInvoicePending(invoiceId: number, w: { method?: InvoicePayMethod; detail?: string }, by: "client" | "auto"): void {
  const inv = getData().invoices.find((i) => i.id === invoiceId);
  if (!inv || inv.status === "paid" || inv.status === "unpaid" || runOf(inv).pending) return;
  addInvoiceEvent(invoiceId, { kind: "pending", by, ...(w.method ? { via: w.method } : {}), ...(w.detail ? { detail: w.detail } : {}) });
}

/** A checkout's bank debit that didn't go (checkout.session.async_payment_failed): the debit failed, by the client's own
 *  payment, so no automatic retries follow it (those are the series' charges alone). Once. */
export function noteCheckoutDebitFailed(invoiceId: number, w: { method?: InvoicePayMethod; detail?: string }): void {
  const inv = getData().invoices.find((i) => i.id === invoiceId);
  if (!inv || inv.status === "paid" || inv.status === "unpaid" || !runOf(inv).pending) return;
  addInvoiceEvent(invoiceId, { kind: "charge_failed", by: "client", via: w.method ?? "sepa_debit", detail: [w.detail, "debit failed"].filter(Boolean).join(" | ") });
}

const emailLink = (invoiceId: number) =>
  void sendInvoiceMailNow(invoiceId, "reminder", "auto").catch((e) => console.error("[payments] emailing the pay link failed:", e instanceof Error ? e.message : e));

/**
 * A try that didn't go (declined, or waiting on the client's 3D Secure): `n` 0 the first try, 1 to 3 the retries.
 * Written once a try, in order (a webhook after the answer, or an answer seen twice, writes nothing). The next retry a
 * day on; the third failed, the coach told (a push, the To do row) and the client emailed the link; one waiting on the
 * client's confirming emails the link at once.
 */
function chargeFailed(invoiceId: number, n: number, reason: string, auth: boolean): void {
  const inv = getData().invoices.find((i) => i.id === invoiceId);
  if (!inv || inv.status === "paid" || inv.status === "unpaid" || inv.refunded_at || !Number.isInteger(n) || n < 0 || n > CHARGE_RETRIES) return;
  const run = runOf(inv);
  if (n === 0 ? !!run.first : !run.first || run.first.by !== "auto" || run.retries !== n - 1) return;
  const c = clientOf(inv);
  const card = autopayWords(c?.autopay);
  const now = Date.now();
  addInvoiceEvent(invoiceId, { kind: n === 0 ? "charge_failed" : "retry", via: c?.autopay?.kind ?? "card", detail: [card, reason].filter(Boolean).join(" | "), by: "auto" }, { persist: false });
  if (n < CHARGE_RETRIES) inv.charge_next_at = new Date(now + DAY_MS).toISOString();
  else delete inv.charge_next_at;
  let told = false;
  if (n >= CHARGE_RETRIES && !run.told) {
    addInvoiceEvent(invoiceId, { kind: "coach_told", by: "auto" }, { persist: false });
    told = true;
  }
  persist();
  // The client can still pay it themselves: the link, at once when the bank wants them to confirm, and after the last.
  if (auth || told) emailLink(invoiceId);
  if (told) {
    const coachId = coachIdOf(inv, c);
    const first = c?.name?.split(/\s+/)[0] || "A client";
    const cc = inv.from?.country_code || countryCodeFromName(inv.from?.country);
    if (coachId != null) sendPushInBackground(coachId, { title: `${first}'s payment failed`, body: `${inv.number ?? "Invoice"} | ${formatMoney(inv.amount, inv.currency ?? "EUR", cc)}`, url: `/clients/${inv.client_id}/invoices#invoice-${invoiceId}`, tag: `invoice-charge:${invoiceId}` });
  }
}

/**
 * What a charge's PaymentIntent says, however it reached us (the answer, the webhook, a charge found on Stripe before a
 * try): through, Paid on Stripe's word for the money it received; on its way (a SEPA debit), pending; else a failed
 * try. Only for the invoice it was made for (its metadata) on the coach's own account.
 */
export function applyChargeIntent(invoiceId: number, p: StripeIntent, account: string): void {
  if (p.metadata.invoice_id !== String(invoiceId)) return;
  const inv = getData().invoices.find((i) => i.id === invoiceId);
  if (!inv) return;
  const coachId = coachIdOf(inv, clientOf(inv));
  if (coachId == null || getCoachPayments(coachId).stripe_account_id !== account) return;
  const n = Number(p.metadata.attempt);
  // Its try answered.
  if (inv.charge_try && !inv.charge_try.done && (inv.charge_try.intent === p.id || inv.charge_try.n === n)) {
    inv.charge_try = { ...inv.charge_try, done: true, intent: p.id };
    persist();
  }
  const w = paidWords(p.facts);
  if (p.status === "succeeded") {
    invoicePaidByStripe(invoiceId, p.id, account, { amount: p.amountReceived, currency: p.currency, method: w.method, detail: w.detail, intent: p.id, by: "auto" });
    return;
  }
  if (p.status === "processing") return noteInvoicePending(invoiceId, w, "auto");
  if (p.status === "requires_capture") return;
  // Waiting on the client's confirming (3D Secure): cancelled, so it can never be completed beside the link they pay.
  if (p.status === "requires_action" || p.status === "requires_confirmation") void cancelPaymentIntent(account, p.id).catch(() => {});
  const auth = p.status === "requires_action" || p.lastError?.code === "authentication_required" || p.lastError?.declineCode === "authentication_required";
  if (Number.isInteger(n)) chargeFailed(invoiceId, n, declineWords(p.lastError?.code, p.lastError?.declineCode), auth);
}

// ---- Charging ----------------------------------------------------------------------------------------------------

/** Everything a charge needs, while one may be made: an invoice sent and not paid, by link, of a series with Charge
 *  automatically on and running, its coach taking payments, the client's way kept on that coach's account. */
function chargeSetup(inv: InvoiceRow) {
  if ((inv.status !== "sent" && inv.status !== "due") || inv.refunded_at || inv.pays === "bank" || !inv.repeat_id) return null;
  const c = clientOf(inv);
  if (!c || c.example) return null;
  const r = seriesOf(inv, c);
  if (!r || !r.auto || r.pays === "bank" || r.paused) return null;
  const coachId = coachIdOf(inv, c);
  if (coachId == null || !canPayOnline(coachId)) return null;
  const account = getCoachPayments(coachId).stripe_account_id;
  const a = autopayOn(c, account);
  if (!account || !a?.customer || !a.payment_method) return null;
  return { account, customer: a.customer, paymentMethod: a.payment_method, kind: a.kind, mandate: a.mandate, since: a.since };
}

/** The try due on the invoice now, or null: the first (once, on an invoice the series made itself after the way was
 *  kept, issued in the last 30 days), the next retry once its day has come, or a try sent with no answer, again once
 *  plainly stale. Never while a debit is on its way. */
function tryDue(inv: InvoiceRow, since: string, now: number): number | null {
  const events = invoiceEventsOf(inv);
  const state = invoiceStateOf(inv, localDateStr(), events);
  if (state === "pending" || state === "paid" || state === "refunded" || state === "not_sent") return null;
  const t = inv.charge_try;
  if (t && !t.done) return now - (Date.parse(t.at) || 0) >= STALE_MS ? t.n : null;
  const charge = invoiceChargeOf(inv, events);
  if (!charge) {
    // Once: never again after a try, nor on an invoice paid, marked or set back to Not paid by the coach before.
    if (t || events.some((e) => e.kind === "paid" || e.kind === "marked_paid" || e.kind === "marked_unpaid")) return null;
    const made = events.find((e) => e.kind === "made");
    if (made?.by !== "auto") return null;
    const madeAt = Date.parse(made.at || stampIso(inv.created_at) || "");
    if (!(madeAt >= Date.parse(since))) return null;
    const issued = Date.parse(`${inv.issue_date ?? localDateStr()}T12:00:00`);
    if (!Number.isFinite(issued) || now - issued > FIRST_WITHIN_DAYS * DAY_MS || issued - now > DAY_MS) return null;
    return 0;
  }
  // Retries are the series' own: a checkout's debit that failed is the client's to pay again.
  if (runOf(inv).first?.by !== "auto" || charge.attempt >= CHARGE_RETRIES) return null;
  if (!charge.nextAt || Date.parse(charge.nextAt) > now) return null;
  const n = charge.attempt + 1;
  if (t && t.n >= n) return null;
  return n;
}

const g = globalThis as unknown as { __norcoachCharging?: Set<number>; __norcoachChargeSweep?: boolean };
const charging = (g.__norcoachCharging ??= new Set());

/** One try on one invoice, if one is due. Answers whether a charge was sent to Stripe. */
export async function chargeInvoice(invoiceId: number): Promise<boolean> {
  if (!chargesOn() || charging.has(invoiceId)) return false;
  charging.add(invoiceId);
  try {
    const inv = getData().invoices.find((i) => i.id === invoiceId);
    const s = inv ? chargeSetup(inv) : null;
    if (!inv || !s) return false;
    const n = tryDue(inv, s.since, Date.now());
    if (n == null) return false;
    // The client paying it themselves right now (a checkout of theirs still open, lib/invoiceCheckouts.ts): no charge
    // beside it; the next round, once that checkout is over, sees it paid or tries.
    // A try already sent and unanswered is always settled first (the same key), whatever else is open.
    const open = (getData() as unknown as { invoice_checkouts?: { invoice_id: number; expires_at: number | null; at: string }[] }).invoice_checkouts?.find((r) => r.invoice_id === invoiceId);
    const openUntil = open ? (open.expires_at != null ? open.expires_at * 1000 : (Date.parse(open.at) || 0) + DAY_MS) : 0;
    const unanswered = !!inv.charge_try && !inv.charge_try.done;
    if (openUntil > Date.now() && !unanswered) return false;
    const currency = (inv.currency ?? "EUR").toUpperCase();
    // The total the invoice shows and a checkout asks, so the paid check (lib/payments.ts) reads the same figure.
    const amount = minorUnits(getInvoiceView(invoiceId)?.total ?? inv.amount, currency);
    if (!(amount > 0)) return false;
    // Charged already? A try whose answer was lost, or one from longer ago than Stripe keeps a key: the customer's
    // charges for this invoice read first, and one through or on its way applied instead of charging again. Stripe
    // unreachable: nothing is sent, the next round tries.
    let mine: StripeIntent[];
    try {
      mine = (await customerIntents(s.account, s.customer)).filter((p) => p.metadata.invoice_id === String(invoiceId));
    } catch (e) {
      console.error("[payments] reading charges failed:", e instanceof Error ? e.message : e);
      return false;
    }
    const live = mine.find((p) => p.status === "succeeded" || p.status === "processing" || p.status === "requires_capture");
    const same = mine.find((p) => p.metadata.attempt === String(n));
    if (live || same) {
      applyChargeIntent(invoiceId, (live ?? same)!, s.account);
      return false;
    }
    // Read again after the wait on Stripe (26 Nov, review): paid by link, marked paid by hand, refunded, the series
    // paused or set to bank, the way forgotten, or another try made meanwhile: no charge.
    const nowInv = getData().invoices.find((i) => i.id === invoiceId);
    const nowSetup = nowInv ? chargeSetup(nowInv) : null;
    if (!nowInv || !nowSetup || nowSetup.paymentMethod !== s.paymentMethod || nowSetup.customer !== s.customer || tryDue(nowInv, nowSetup.since, Date.now()) !== n) return false;
    // An unanswered try that never reached Stripe, while the client has a checkout open: theirs goes first.
    const openNow = (getData() as unknown as { invoice_checkouts?: { invoice_id: number; expires_at: number | null; at: string }[] }).invoice_checkouts?.find((r) => r.invoice_id === invoiceId);
    if (openNow && (openNow.expires_at != null ? openNow.expires_at * 1000 : (Date.parse(openNow.at) || 0) + DAY_MS) > Date.now()) return false;
    // Written before it goes: a restart mid-call sends this same try again, with the same key.
    inv.charge_try = { n, at: new Date().toISOString(), done: false };
    persist();
    try {
      const p = await chargeOffSession(s.account, {
        amount,
        currency,
        customer: s.customer,
        paymentMethod: s.paymentMethod,
        kind: s.kind,
        mandate: s.mandate,
        description: `Invoice ${inv.number ?? invoiceId}`,
        metadata: { kind: "auto_charge", invoice_id: String(invoiceId), invoice_number: inv.number ?? "", client_id: String(inv.client_id), coach_id: String(inv.coach_id ?? ""), attempt: String(n) },
        idempotencyKey: `norcoach-charge-${invoiceId}-${s.account}-${n}-${amount}-${currency}`,
      });
      inv.charge_try = { n, at: inv.charge_try.at, done: true, intent: p.id };
      persist();
      applyChargeIntent(invoiceId, p, s.account);
    } catch (e) {
      if (e instanceof StripeError && e.intent) {
        // Declined, the intent as the bank left it.
        inv.charge_try = { n, at: inv.charge_try?.at ?? new Date().toISOString(), done: true, intent: e.intent.id };
        persist();
        applyChargeIntent(invoiceId, { ...e.intent, lastError: e.intent.lastError ?? { code: e.code, declineCode: e.declineCode, message: e.message }, metadata: { ...e.intent.metadata, invoice_id: String(invoiceId), attempt: String(n) } }, s.account);
      } else if (e instanceof StripeError && (e.type === "card_error" || (e.status >= 400 && e.status < 500 && e.status !== 409 && e.status !== 429))) {
        // Refused for good (the card or the customer gone): a failed try, so it ends with the coach told, never a loop.
        inv.charge_try = { n, at: inv.charge_try?.at ?? new Date().toISOString(), done: true };
        persist();
        chargeFailed(invoiceId, n, declineWords(e.code, e.declineCode), e.code === "authentication_required" || e.declineCode === "authentication_required");
      } else {
        // Stripe down or slow: the try stays unanswered and goes again once stale, with the same key.
        console.error("[payments] a charge didn't reach Stripe:", e instanceof Error ? e.message : e);
      }
    }
    return true;
  } finally {
    charging.delete(invoiceId);
  }
}

/** Every try due, one invoice after another (instrumentation.ts, every ten minutes beside the recurring invoices, right
 *  after a series makes its invoices). How many were sent. */
export async function runInvoiceCharges(): Promise<number> {
  if (!chargesOn() || g.__norcoachChargeSweep) return 0;
  g.__norcoachChargeSweep = true;
  try {
    const now = Date.now();
    const due = getData().invoices.filter((inv) => {
      const s = chargeSetup(inv);
      return !!s && tryDue(inv, s.since, now) != null;
    });
    let sent = 0;
    for (const inv of due) if (await chargeInvoice(inv.id)) sent++;
    return sent;
  } finally {
    g.__norcoachChargeSweep = false;
  }
}

// ---- Webhooks ----------------------------------------------------------------------------------------------------

/** payment_intent.succeeded / .payment_failed / .processing: one of our automatic charges (metadata kind auto_charge),
 *  read again from Stripe (never the event's copy), applied to its invoice. A checkout's own PaymentIntent is the
 *  checkout's events' to handle. */
export async function chargeIntentEvent(account: string, intentId: string): Promise<void> {
  const p = await readPaymentIntent(account, intentId);
  if (p.metadata.kind !== "auto_charge") return;
  const invoiceId = Number(p.metadata.invoice_id);
  if (Number.isInteger(invoiceId)) applyChargeIntent(invoiceId, p, account);
}

// ---- Refunds -----------------------------------------------------------------------------------------------------

/** How much Stripe has refunded of the payment that paid it, in minor units (cumulative): counted once. Whole, the
 *  invoice is Refunded (neither paid nor owed); part, its history says how much. */
function applyRefund(inv: InvoiceRow, refundedMinor: number, totalMinor: number, by?: "coach"): void {
  const before = inv.refunded_minor ?? 0;
  if (!(refundedMinor > before)) return;
  inv.refunded_minor = refundedMinor;
  const currency = (inv.currency ?? "EUR").toUpperCase();
  const unit = minorUnits(1, currency) || 1;
  const cc = inv.from?.country_code || countryCodeFromName(inv.from?.country);
  if (refundedMinor >= totalMinor) {
    if (!inv.refunded_at) {
      inv.refunded_at = new Date().toISOString();
      delete inv.charge_next_at;
      addInvoiceEvent(inv.id, { kind: "refunded", detail: formatMoney(totalMinor / unit, currency, cc), ...(by ? { by } : {}) }, { persist: false });
      logCoachActivity(inv.client_id, `Refunded invoice ${inv.number ?? ""}`.trim(), { kind: "general", actionTab: "invoices", actionLabel: "See your invoices", actionRef: inv.id, dedupeKey: `invoice-refunded:${inv.id}` });
    }
  } else {
    addInvoiceEvent(inv.id, { kind: "refunded", via: "part", detail: `${formatMoney((refundedMinor - before) / unit, currency, cc)} of ${formatMoney(totalMinor / unit, currency, cc)}`, ...(by ? { by } : {}) }, { persist: false });
  }
  persist();
}

/** charge.refunded: the charge read again from Stripe, its PaymentIntent's invoice (the one that paid it, or an older
 *  invoice by its metadata) on the coach's own account, the refunded amount applied once. */
export async function chargeRefundedEvent(account: string, chargeId: string): Promise<void> {
  const ch = await readCharge(account, chargeId);
  if (!ch.paymentIntent) return;
  const data = getData();
  const onAccount = (i: InvoiceRow) => {
    const coachId = coachIdOf(i, clientOf(i));
    return coachId != null && getCoachPayments(coachId).stripe_account_id === account;
  };
  let inv = data.invoices.find((i) => i.stripe_payment_intent === ch.paymentIntent || i.stripe_session_id === ch.paymentIntent);
  if (!inv) {
    const p = await readPaymentIntent(account, ch.paymentIntent);
    const id = Number(p.metadata.invoice_id);
    // An older invoice paid by checkout before the PaymentIntent was kept on it; never one paid by another payment
    // (26 Nov, review: a second payment refunded on the dashboard marked the invoice Refunded): the checkout that paid
    // it must be this PaymentIntent's. Checked on the coach's own account before anything is written, so another
    // account's charge, metadata and all, never touches it.
    const old = data.invoices.find((i) => i.id === id && i.status === "paid" && i.paid_via === "stripe" && !i.stripe_payment_intent);
    if (!old || !onAccount(old) || !old.stripe_session_id?.startsWith("cs_")) return;
    const s = await readInvoiceCheckout(account, old.stripe_session_id);
    if (s.metadata.invoice_id !== String(old.id) || s.intent?.id !== ch.paymentIntent) return;
    old.stripe_payment_intent = ch.paymentIntent;
    inv = old;
  }
  if (!onAccount(inv)) return;
  if (ch.currency && ch.currency !== (inv.currency ?? "EUR").toUpperCase()) return;
  applyRefund(inv, ch.amountRefunded, ch.amount);
}

export type RefundAnswer = { ok: true; state: "refunded" | "pending" } | { ok: false; error: "not_paid_online" | "off" | "failed" };

const refunding = new Set<number>();

/**
 * Refund (26 Nov, Alex: a word in the opened row): the whole payment back, on the coach's own account, for an invoice
 * paid through Stripe; one paid by hand isn't (Not paid instead). One refund an invoice (its idempotency key); the
 * invoice is Refunded only on Stripe's word: at once when Stripe answers succeeded, else by charge.refunded.
 */
export async function refundInvoice(invoiceId: number): Promise<RefundAnswer> {
  const inv = getData().invoices.find((i) => i.id === invoiceId);
  if (!inv || inv.status !== "paid" || inv.paid_via !== "stripe" || inv.refunded_at) return { ok: false, error: "not_paid_online" };
  const coachId = coachIdOf(inv, clientOf(inv));
  const account = coachId != null ? getCoachPayments(coachId).stripe_account_id : undefined;
  if (!stripeConfigured() || !account) return { ok: false, error: "off" };
  if (refunding.has(invoiceId)) return { ok: false, error: "failed" };
  refunding.add(invoiceId);
  try {
    let pi = inv.stripe_payment_intent ?? (inv.stripe_session_id?.startsWith("pi_") ? inv.stripe_session_id : undefined);
    if (!pi && inv.stripe_session_id?.startsWith("cs_")) {
      const s = await readInvoiceCheckout(account, inv.stripe_session_id);
      if (s.metadata.invoice_id === String(invoiceId) && s.intent) pi = s.intent.id;
    }
    if (!pi) return { ok: false, error: "not_paid_online" };
    if (!inv.stripe_payment_intent) {
      inv.stripe_payment_intent = pi;
      persist();
    }
    const r = await refundPaymentIntent(account, { paymentIntent: pi, metadata: { invoice_id: String(invoiceId) }, idempotencyKey: `norcoach-refund-${invoiceId}-${pi}` });
    if (r.status === "succeeded") {
      const now = getData().invoices.find((i) => i.id === invoiceId);
      // Never past the whole (charge.refunded may have counted it already).
      const total = now ? minorUnits(getInvoiceView(invoiceId)?.total ?? now.amount, (now.currency ?? "EUR").toUpperCase()) : 0;
      if (now) applyRefund(now, Math.min(total, (now.refunded_minor ?? 0) + r.amount), total, "coach");
      return { ok: true, state: "refunded" };
    }
    if (r.status === "failed" || r.status === "canceled") return { ok: false, error: "failed" };
    return { ok: true, state: "pending" };
  } catch (e) {
    console.error("[payments] refund failed:", e instanceof Error ? e.message : e);
    return { ok: false, error: "failed" };
  } finally {
    refunding.delete(invoiceId);
  }
}
