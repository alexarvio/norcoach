import { NextResponse } from "next/server";
import { readSubscription, verifyWebhook, type StripeSubscription } from "../../../lib/stripe";
import { stripeAccountUpdated } from "../../../lib/payments";
import { checkoutEvent } from "../../../lib/invoiceCheckouts";
import { chargeIntentEvent, chargeRefundedEvent } from "../../../lib/invoiceCharges";
import { applySubscription, coachForBilling, keepCustomer } from "../../../lib/billing";

// Stripe's side of payments (lib/stripe.ts). Two endpoints can point here, each with its own signing secret:
//   the coaches' accounts (Connect, STRIPE_WEBHOOK_SECRET), events with `account` set:
//     checkout.session.completed / .async_payment_succeeded  an invoice was paid (a bank debit: on its way, then paid)
//     checkout.session.async_payment_failed                  a checkout's bank debit didn't go (26 Nov)
//     payment_intent.succeeded / .payment_failed / .processing  an automatic charge's answer (26 Nov, lib/invoiceCharges.ts;
//                                                            only ours, metadata kind auto_charge)
//     charge.refunded                                        a payment refunded, whole or part (26 Nov)
//     account.updated                                        a coach's account can (or no longer can) take payments
//   the platform's own (STRIPE_BILLING_WEBHOOK_SECRET, 28 Oct), what coaches pay Norcoach (lib/billing.ts):
//     checkout.session.completed (mode subscription)          a coach subscribed
//     customer.subscription.created / .updated / .deleted     its state: trial, paid, failed, cancelled
// Only a signed body is read; no session (the proxy lets this path through). Every invoice event is read again from
// Stripe on the event's own account and applied only to an invoice of that account's coach (26 Nov), and each is safe to
// run twice (Stripe sends again until it hears 200). A read that fails answers 500, so Stripe sends it again later.
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await request.text();
  const event = verifyWebhook(body, request.headers.get("stripe-signature"));
  if (!event) return NextResponse.json({ error: "Bad signature" }, { status: 400 });
  const o = event.data.object;
  const meta = (o.metadata as Record<string, string> | undefined) ?? {};

  try {
    if (!event.account && event.type === "checkout.session.completed" && o.mode === "subscription") {
      const coachId = coachForBilling(o.metadata as Record<string, string> | undefined, o.customer as string | null);
      if (coachId != null) keepCustomer(coachId, (o.customer as string | null) ?? null);
    } else if (!event.account && event.type.startsWith("customer.subscription.")) {
      // Stripe's state now, not the event's copy: events come out of order and retried for days (28 Oct, review).
      const sent = o as unknown as StripeSubscription;
      const coachId = coachForBilling(sent.metadata, sent.customer);
      if (coachId != null) applySubscription(coachId, await readSubscription(sent.id).catch(() => sent));
    } else if (event.account && (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded" || event.type === "checkout.session.async_payment_failed")) {
      // iDEAL and cards are paid at once; bank debits arrive later, as async_payment_succeeded (or _failed).
      const invoiceId = Number(meta.invoice_id);
      if (o.mode === "payment" && Number.isInteger(invoiceId) && typeof o.id === "string") await checkoutEvent(invoiceId, o.id, event.account, event.type === "checkout.session.async_payment_failed");
    } else if (event.account && (event.type === "payment_intent.succeeded" || event.type === "payment_intent.payment_failed" || event.type === "payment_intent.processing")) {
      if (meta.kind === "auto_charge" && typeof o.id === "string") await chargeIntentEvent(event.account, o.id);
    } else if (event.account && event.type === "charge.refunded") {
      if (typeof o.id === "string") await chargeRefundedEvent(event.account, o.id);
    } else if (event.type === "account.updated" && event.account) {
      stripeAccountUpdated(event.account, !!o.charges_enabled);
    }
  } catch (e) {
    console.error(`[stripe] ${event.type} not applied:`, e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Not applied" }, { status: 500 });
  }
  return NextResponse.json({ received: true });
}
