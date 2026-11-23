import "server-only";
import { getData, persist } from "./db";
import { getCoachPayments, getInvoiceView, type InvoiceView } from "./queries";
import { canPayOnline, checkoutUsed, invoicePaidByStripe } from "./payments";
import { expireInvoiceCheckout, invoiceCheckout, minorUnits, readInvoiceCheckout, stripeConfigured } from "./stripe";
import { invoiceReturnUrl } from "./invoicePayLink";

// Paying an invoice from its email (23 Nov, Alex: "ok do the stripe also"): Stripe's hosted checkout for that invoice,
// on the coach's own connected account (lib/stripe.ts, invoiceCheckout). One checkout an invoice at a time: a second tap
// on Pay, a retry, or a mail scanner opening the link first, gets the same open checkout back, never a second one. A
// checkout is made again only once the last has expired or the amount it asks no longer matches the invoice. Stripe
// marks the invoice Paid through /api/stripe/webhook (the checkout carries metadata.invoice_id); the way back from
// Stripe (/invoice/<id>/paid) reads the checkout as well, so it is Paid even where the webhook isn't set up.
//
// Kept as a top-level value of the store (`invoice_checkouts` in kv), a row an invoice, as lib/healthOn.ts keeps its own.

type CheckoutRow = { invoice_id: number; account: string; session_id: string; url: string; amount: number; currency: string; expires_at: number | null; made: number; at: string };
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

/** The invoice as a client may pay it: sent to them (never a draft), with its coach's connected account. */
type Payable = { kind: "error"; error: string } | { kind: "paid" } | { kind: "ok"; v: InvoiceView; account: string };
function payable(invoiceId: number): Payable {
  const v = getInvoiceView(invoiceId);
  if (!v || v.status === "unpaid") return { kind: "error", error: "This invoice isn't there." };
  if (v.status === "paid") return { kind: "paid" };
  const account = v.coachId != null ? getCoachPayments(v.coachId).stripe_account_id : undefined;
  if (!stripeConfigured() || !canPayOnline(v.coachId) || !account) return { kind: "error", error: "Paying by card isn't on for this invoice. The bank details are on it." };
  return { kind: "ok", v, account };
}

/** The checkout to send the client to for this invoice: the open one, or a new one. Callers check who is asking. */
export function checkoutForInvoice(invoiceId: number): Promise<CheckoutAnswer> {
  const busy = making.get(invoiceId);
  if (busy) return busy;
  const run = makeCheckout(invoiceId).finally(() => making.delete(invoiceId));
  making.set(invoiceId, run);
  return run;
}

async function makeCheckout(invoiceId: number): Promise<CheckoutAnswer> {
  const p = payable(invoiceId);
  if (p.kind === "error") return { error: p.error };
  if (p.kind === "paid") return { paid: true };
  const { v, account } = p;
  const amount = minorUnits(v.total, v.currency);
  const currency = v.currency.toUpperCase();
  const list = rows();
  const was = list.find((r) => r.invoice_id === invoiceId);
  const now = Math.floor(Date.now() / 1000);
  // A checkout that already paid this invoice once (the coach set it back since) is spent: a new one is made.
  if (was && was.account === account && !checkoutUsed(invoiceId, was.session_id)) {
    const same = was.amount === amount && was.currency === currency;
    try {
      const s = await readInvoiceCheckout(account, was.session_id);
      if (s.status === "complete" && s.paymentStatus === "paid") {
        invoicePaidByStripe(invoiceId, s.id, account);
        return { paid: true };
      }
      // Still open, with ten minutes or more to go: the same page again.
      if (same && s.status === "open" && s.url && (s.expiresAt == null || s.expiresAt - now > 600)) return { url: s.url };
      // Open for an amount the invoice no longer asks: closed, so it can't be paid as well.
      if (!same && s.status === "open") await expireInvoiceCheckout(account, was.session_id).catch(() => {});
    } catch {
      // Stripe unreachable for the read: the one we know, if it should still be open.
      if (same && (was.expires_at == null || was.expires_at - now > 600)) return { url: was.url };
    }
  }
  const success = invoiceReturnUrl(invoiceId, true);
  const cancel = invoiceReturnUrl(invoiceId, false);
  if (!success || !cancel) return { error: "Paying by card isn't on right now. The bank details are on the invoice." };
  const made = (was?.account === account ? was.made : 0) + 1;
  try {
    const s = await invoiceCheckout(account, {
      invoiceId,
      number: v.number,
      amount: v.total,
      currency: v.currency,
      seller: v.from.business_name || v.from.legal_name || "",
      email: v.to.email,
      successUrl: success,
      cancelUrl: cancel,
      // Sent twice (a dropped answer, a restart before the row below was kept): Stripe gives back the one it made.
      idempotencyKey: `norcoach-invoice-${invoiceId}-${account}-${made}-${amount}-${currency}`,
    });
    const row: CheckoutRow = { invoice_id: invoiceId, account, session_id: s.id, url: s.url, amount, currency, expires_at: s.expiresAt, made, at: new Date().toISOString() };
    if (was) Object.assign(was, row);
    else list.push(row);
    persist();
    return { url: s.url };
  } catch (e) {
    return { error: e instanceof Error && e.message ? e.message : "Stripe didn't answer. Try again." };
  }
}

/**
 * Back from Stripe with a checkout's id: Paid, when Stripe says that checkout, on this invoice's coach's account, for
 * this invoice, is paid (invoicePaidByStripe checks the account again and does nothing twice). Answers where it stands.
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
    const s = await readInvoiceCheckout(account, sessionId);
    if (s.metadata.invoice_id !== String(invoiceId)) return "unknown";
    if (s.status === "complete" && s.paymentStatus === "paid") {
      invoicePaidByStripe(invoiceId, s.id, account);
      return getInvoiceView(invoiceId)?.status === "paid" ? "paid" : "pending";
    }
    // A bank debit is paid later: the webhook marks it (async_payment_succeeded).
    return s.status === "complete" ? "pending" : "unknown";
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
