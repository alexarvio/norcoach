import "server-only";
import { getData, persist } from "./db";
import { getCoachPayments, getInvoiceView, type InvoiceView } from "./queries";
import { canPayOnline, checkoutUsed, invoicePaidByStripe } from "./payments";
import { expireInvoiceCheckout, invoiceCheckout, minorUnits, readInvoiceCheckout, stripeConfigured, type InvoiceCheckoutState } from "./stripe";
import { invoiceReturnUrl } from "./invoicePayLink";
import { autopayOfferFor, ensureCustomer, keepAutopay, noteCheckoutDebitFailed, noteInvoicePending } from "./invoiceCharges";
import { paidWords } from "./payWords";
import { invoiceStateOf } from "./invoiceEvents";

// Paying an invoice from its email (23 Nov, Alex: "ok do the stripe also"): Stripe's hosted checkout for that invoice,
// on the coach's own connected account (lib/stripe.ts, invoiceCheckout). One checkout an invoice at a time: a second tap
// on Pay, a retry, or a mail scanner opening the link first, gets the same open checkout back, never a second one. A
// checkout is made again only once the last has expired or the amount it asks no longer matches the invoice. Stripe
// marks the invoice Paid through /api/stripe/webhook (the checkout carries metadata.invoice_id); the way back from
// Stripe (/invoice/<id>/paid) reads the checkout as well, so it is Paid even where the webhook isn't set up. Since 26 Nov
// the client app's Pay goes through here too (it made a fresh checkout every tap and never confirmed on return), and a
// checkout can keep the payment for later, "Pay automatically from now on" (lib/invoiceCharges.ts).
//
// Kept as a top-level value of the store (`invoice_checkouts` in kv), a row an invoice, as lib/healthOn.ts keeps its own.

/** `save` (26 Nov, Alex): the checkout keeps the payment for later. A checkout open for the other choice (or another
 *  amount) is closed before a new one is made, so an invoice never has two open to pay. */
type CheckoutRow = { invoice_id: number; account: string; session_id: string; url: string; amount: number; currency: string; expires_at: number | null; made: number; at: string; save?: boolean };
type WithCheckouts = { invoice_checkouts?: CheckoutRow[] };

const rows = (): CheckoutRow[] => {
  const data = getData() as unknown as WithCheckouts;
  if (!Array.isArray(data.invoice_checkouts)) data.invoice_checkouts = [];
  return data.invoice_checkouts;
};

const g = globalThis as unknown as { __norcoachInvoiceCheckouts?: Map<number, Promise<CheckoutAnswer>> };
/** Checkouts being made, by invoice: a second ask meanwhile waits for the first and gets its answer. */
const making = (g.__norcoachInvoiceCheckouts ??= new Map());

export type CheckoutAnswer = { url: string } | { paid: true } | { error: string };

/** The invoice as a client may pay it: sent to them (never a draft), paid by link (never one paid by bank transfer,
 *  26 Nov), with its coach's connected account. */
type Payable = { kind: "error"; error: string } | { kind: "paid" } | { kind: "ok"; v: InvoiceView; account: string };
function payable(invoiceId: number): Payable {
  const v = getInvoiceView(invoiceId);
  if (!v || v.status === "unpaid") return { kind: "error", error: "This invoice isn't there." };
  if (v.status === "paid" || v.refundedAt) return { kind: "paid" };
  if (v.pays === "bank") return { kind: "error", error: "This invoice is paid by bank transfer. The bank details are on it." };
  // A payment already on its way (26 Nov, review): a SEPA debit processing, or an automatic charge sent in the last day
  // and not answered yet. A checkout beside it could take the money twice.
  const inv = getData().invoices.find((i) => i.id === invoiceId);
  const tryOpen = !!inv?.charge_try && !inv.charge_try.done && Date.now() - (Date.parse(inv.charge_try.at) || 0) < 24 * 60 * 60 * 1000;
  if (inv && (tryOpen || invoiceStateOf(inv) === "pending")) return { kind: "error", error: "A payment for this invoice is on its way." };
  const account = v.coachId != null ? getCoachPayments(v.coachId).stripe_account_id : undefined;
  if (!stripeConfigured() || !canPayOnline(v.coachId) || !account) return { kind: "error", error: "Paying by card isn't on for this invoice. The bank details are on it." };
  return { kind: "ok", v, account };
}

/** The checkout to send the client to for this invoice: the open one, or a new one. Callers check who is asking.
 *  `save`: "Pay automatically from now on" ticked, kept for later only where it is offered (autopayOfferFor). */
export function checkoutForInvoice(invoiceId: number, opts: { save?: boolean } = {}): Promise<CheckoutAnswer> {
  const busy = making.get(invoiceId);
  if (busy) return busy;
  const run = makeCheckout(invoiceId, !!opts.save).finally(() => making.delete(invoiceId));
  making.set(invoiceId, run);
  return run;
}

async function makeCheckout(invoiceId: number, wantSave: boolean): Promise<CheckoutAnswer> {
  const p = payable(invoiceId);
  if (p.kind === "error") return { error: p.error };
  if (p.kind === "paid") return { paid: true };
  const { v, account } = p;
  const save = wantSave && !!autopayOfferFor(invoiceId);
  const amount = minorUnits(v.total, v.currency);
  const currency = v.currency.toUpperCase();
  const list = rows();
  const was = list.find((r) => r.invoice_id === invoiceId);
  const now = Math.floor(Date.now() / 1000);
  // A checkout that already paid this invoice once (the coach set it back since) is spent: a new one is made.
  if (was && was.account === account && !checkoutUsed(invoiceId, was.session_id)) {
    const same = was.amount === amount && was.currency === currency && !!was.save === save;
    try {
      const s = await readInvoiceCheckout(account, was.session_id);
      if (s.status === "complete") {
        // Paid, or a bank debit on its way: never a second checkout beside it.
        const state = settleCheckout(invoiceId, s, account);
        if (state === "paid") return { paid: true };
        if (state === "pending") return { error: "A payment for this invoice is on its way." };
      }
      // Still open, with ten minutes or more to go: the same page again.
      if (same && s.status === "open" && s.url && (s.expiresAt == null || s.expiresAt - now > 600)) return { url: s.url };
      // Open for an amount or a choice the invoice no longer asks: closed first, so it can't be paid as well (26 Nov: a
      // close that fails stops here, never a second open checkout beside it).
      if (s.status === "open") await expireInvoiceCheckout(account, was.session_id);
    } catch {
      // Stripe unreachable: the one we know, if it should still be open; never another one while that may be open.
      if (same && (was.expires_at == null || was.expires_at - now > 600)) return { url: was.url };
      if (was.expires_at == null || was.expires_at > now) return { error: "Stripe didn't answer. Try again." };
    }
  }
  const success = invoiceReturnUrl(invoiceId, true);
  const cancel = invoiceReturnUrl(invoiceId, false);
  if (!success || !cancel) return { error: "Paying by card isn't on right now. The bank details are on the invoice." };
  const made = (was?.account === account ? was.made : 0) + 1;
  try {
    // The client as a customer on the coach's account, for a payment kept for later (made once, kept on the client).
    const customer = save ? await ensureCustomer(v.clientId, account) : undefined;
    const s = await invoiceCheckout(account, {
      invoiceId,
      number: v.number,
      amount: v.total,
      currency: v.currency,
      seller: v.from.business_name || v.from.legal_name || "",
      email: v.to.email,
      successUrl: success,
      cancelUrl: cancel,
      customer,
      save,
      metadata: { client_id: String(v.clientId), ...(v.coachId != null ? { coach_id: String(v.coachId) } : {}), ...(v.repeatId ? { repeat_id: v.repeatId } : {}) },
      // Sent twice (a dropped answer, a restart before the row below was kept): Stripe gives back the one it made.
      idempotencyKey: `norcoach-invoice-${invoiceId}-${account}-${made}-${amount}-${currency}${save ? "-auto" : ""}`,
    });
    const row: CheckoutRow = { invoice_id: invoiceId, account, session_id: s.id, url: s.url, amount, currency, expires_at: s.expiresAt, made, at: new Date().toISOString(), ...(save ? { save: true } : {}) };
    if (was) {
      Object.assign(was, row);
      if (!save) delete was.save;
    } else list.push(row);
    persist();
    return { url: s.url };
  } catch (e) {
    return { error: e instanceof Error && e.message ? e.message : "Stripe didn't answer. Try again." };
  }
}

/**
 * A finished checkout as Stripe has it (the way back, the webhook, a second Pay): Paid on Stripe's word for exactly its
 * amount (invoicePaidByStripe), with how it was paid ("Visa •••• 4242"), and the way kept for later when it was asked
 * for (keepAutopay, "Automatic payment on"); finished and not paid yet, a bank debit on its way. Only for this invoice's
 * own checkout (its metadata). Safe to run twice.
 */
export function settleCheckout(invoiceId: number, s: InvoiceCheckoutState, account: string): "paid" | "pending" | "unknown" {
  if (s.metadata.invoice_id !== String(invoiceId) || s.status !== "complete") return "unknown";
  const w = paidWords(s.intent?.facts);
  if (s.paymentStatus === "paid") {
    invoicePaidByStripe(invoiceId, s.id, account, { amount: s.amountTotal, currency: s.currency, method: w.method, detail: w.detail, intent: s.intent?.id, by: "client" });
    const paid = getInvoiceView(invoiceId)?.status === "paid";
    // Kept for later only once paid by this very checkout's money (the right amount, on the coach's account).
    if (paid && s.metadata.autopay === "1" && s.intent && checkoutUsed(invoiceId, s.id)) keepAutopay(invoiceId, account, s.intent);
    // Not Paid by it (another amount, another account): nothing to say it is on its way.
    return paid ? "paid" : "unknown";
  }
  // A debit that failed leaves the checkout complete and unpaid (26 Nov, review): not on its way, so the client can pay
  // again (a new checkout), never "pending" written once more over the failure.
  if (s.intent && s.intent.status !== "processing") return "unknown";
  noteInvoicePending(invoiceId, w, "client");
  return "pending";
}

/** checkout.session.completed / .async_payment_succeeded / .async_payment_failed: the checkout read again from Stripe
 *  on the coach's account (never the event's copy), then settled; a debit that failed is said once. */
export async function checkoutEvent(invoiceId: number, sessionId: string, account: string, failed = false): Promise<void> {
  const v = getInvoiceView(invoiceId);
  if (!v || v.coachId == null || getCoachPayments(v.coachId).stripe_account_id !== account) return;
  const s = await readInvoiceCheckout(account, sessionId);
  if (s.metadata.invoice_id !== String(invoiceId)) return;
  if (failed) {
    if (s.paymentStatus !== "paid") noteCheckoutDebitFailed(invoiceId, paidWords(s.intent?.facts));
    return;
  }
  settleCheckout(invoiceId, s, account);
}

/**
 * Back from Stripe with a checkout's id: Paid, when Stripe says that checkout, on this invoice's coach's account, for
 * this invoice, is paid (invoicePaidByStripe checks the account and the amount again and does nothing twice). Answers
 * where it stands.
 */
export async function confirmInvoiceCheckout(invoiceId: number, sessionId: string): Promise<"paid" | "pending" | "unknown"> {
  const v = getInvoiceView(invoiceId);
  if (!v) return "unknown";
  if (v.status === "paid") return "paid";
  const account = v.coachId != null ? getCoachPayments(v.coachId).stripe_account_id : undefined;
  if (!account || !stripeConfigured() || !/^cs_[A-Za-z0-9_]{8,200}$/.test(sessionId)) return "unknown";
  // Spent on this invoice before it was set back: says nothing about a payment now.
  if (checkoutUsed(invoiceId, sessionId)) return "unknown";
  try {
    // A bank debit is paid later: the webhook marks it (async_payment_succeeded).
    return settleCheckout(invoiceId, await readInvoiceCheckout(account, sessionId), account);
  } catch {
    return "unknown";
  }
}

/** An invoice erased: its checkout row goes too. */
export function dropInvoiceCheckout(invoiceId: number): void {
  const data = getData() as unknown as WithCheckouts;
  if (!data.invoice_checkouts?.some((r) => r.invoice_id === invoiceId)) return;
  data.invoice_checkouts = data.invoice_checkouts.filter((r) => r.invoice_id !== invoiceId);
  persist();
}

/**
 * An invoice marked paid by hand (26 Nov, Alex: bank transfer, cash): its checkout still open is closed on Stripe, so
 * the client can't pay it a second time from an email's old Pay. Nothing waits on it and nothing throws: Stripe
 * unreachable, the checkout stays and expires on its own (24 h); money that still arrives is kept in the invoice's
 * history as paid twice and the coach is pushed (invoicePaidByStripe), never silent. Called by markInvoicePaidAction
 * and setInvoiceStatusByIdAction (lib/actions.ts).
 */
export async function expireOpenCheckouts(invoiceId: number): Promise<void> {
  const row = rows().find((r) => r.invoice_id === invoiceId);
  if (!row || !stripeConfigured() || checkoutUsed(invoiceId, row.session_id)) return;
  try {
    const s = await readInvoiceCheckout(row.account, row.session_id);
    if (s.status === "open") await expireInvoiceCheckout(row.account, row.session_id);
  } catch (e) {
    console.error("[invoices] closing a checkout failed:", e instanceof Error ? e.message : e);
  }
}
