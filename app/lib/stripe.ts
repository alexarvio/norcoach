import crypto from "crypto";

// Online payments through Stripe Connect. Each coach connects their own
// Stripe account (a Standard account: theirs, with their own dashboard,
// fees and payouts; Stripe checks who they are, not us). An invoice the
// coach has sent gets a Pay button for the client, which opens Stripe's
// checkout on the coach's account with whatever payment methods the coach
// has on there (iDEAL, cards, Bancontact, PayPal, Apple Pay…). Stripe then
// tells /api/stripe/webhook, and the invoice marks itself paid.
//
// Off until the platform's keys are set on the server:
//   STRIPE_SECRET_KEY      the platform account's secret key (sk_test_… to try it)
//   STRIPE_WEBHOOK_SECRET  the signing secret of a Connect webhook endpoint at
//                          /api/stripe/webhook, listening for checkout.session.completed,
//                          checkout.session.async_payment_succeeded, checkout.session.async_payment_failed,
//                          payment_intent.succeeded, payment_intent.payment_failed, charge.refunded and
//                          account.updated (26 Nov: automatic charges and refunds, lib/invoiceCharges.ts)
// No SDK: the handful of calls below go straight to the REST API (no stripe package is installed; the shapes below are
// Stripe's REST objects as documented, the fields read kept to the few that are used).

const API = "https://api.stripe.com/v1";

export function stripeConfigured(): boolean {
  return !!process.env.STRIPE_SECRET_KEY?.trim();
}

/** Test keys: say so wherever money would move. */
export function stripeTestMode(): boolean {
  return (process.env.STRIPE_SECRET_KEY ?? "").trim().startsWith("sk_test_");
}

type Params = Record<string, unknown>;

// Stripe takes form encoding with nested keys: metadata[invoice_id]=12, line_items[0][quantity]=1.
function encode(params: Params, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => (typeof item === "object" && item ? out.push(...encode(item as Params, `${key}[${i}]`)) : out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(item))}`)));
    else if (typeof v === "object") out.push(...encode(v as Params, key));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out;
}

async function call<T>(method: "GET" | "POST" | "DELETE", path: string, params: Params = {}, account?: string, idempotencyKey?: string): Promise<T> {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) throw new Error("Stripe isn't set up on this server.");
  const body = encode(params).join("&");
  const res = await fetch(`${API}${path}${method === "GET" && body ? `?${body}` : ""}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
      ...(account ? { "Stripe-Account": account } : {}),
      // A create sent twice with one key (a retry, a double tap) gives back the first one made, never a second.
      ...(idempotencyKey && method === "POST" ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: method === "GET" ? undefined : body,
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: StripeErrorBody };
  if (!res.ok) throw new StripeError(res.status, json.error);
  return json;
}

type StripeErrorBody = { message?: string; type?: string; code?: string; decline_code?: string; payment_intent?: RawIntent };

/** What Stripe refused, with its reasons (26 Nov): a card declined answers 402 with its code, the bank's decline code
 *  and the PaymentIntent as it was left; a bad request or Stripe down has no intent. A plain Error to every older
 *  caller, which reads only its message. */
export class StripeError extends Error {
  status: number;
  type?: string;
  code?: string;
  declineCode?: string;
  intent?: StripeIntent;
  constructor(status: number, e?: StripeErrorBody) {
    super(e?.message || `Stripe answered ${status}`);
    this.status = status;
    this.type = e?.type;
    this.code = e?.code;
    this.declineCode = e?.decline_code;
    if (e?.payment_intent && typeof e.payment_intent === "object") this.intent = intentOf(e.payment_intent);
  }
}

// ---- PaymentIntents (26 Nov, Alex: automatic payment; lib/invoiceCharges.ts) --------------------------------------

/** How a charge was paid, from its payment_method_details: a card (Apple Pay when its wallet says so), iDEAL (with the
 *  SEPA method and mandate it left when kept for later), or a SEPA debit. */
export type PaidFacts = { type: string; wallet?: string; brand?: string; last4?: string; bank?: string; generatedSepa?: string; generatedMandate?: string; mandate?: string };
/** A PaymentIntent as the app reads it. Amounts in the currency's minor units. */
export type StripeIntent = {
  id: string;
  status: string;
  amount: number;
  amountReceived: number;
  currency: string;
  customer: string | null;
  paymentMethod: string | null;
  metadata: Record<string, string>;
  lastError: { code?: string; declineCode?: string; message?: string } | null;
  facts: PaidFacts | null;
};
type RawCharge = { id: string; payment_method_details?: { type?: string; card?: { brand?: string; last4?: string; wallet?: { type?: string } | null }; ideal?: { bank?: string | null; iban_last4?: string | null; generated_sepa_debit?: string | { id: string } | null; generated_sepa_debit_mandate?: string | { id: string } | null }; sepa_debit?: { last4?: string | null; mandate?: string | null } } };
type RawIntent = {
  id: string;
  status?: string;
  amount?: number;
  amount_received?: number;
  currency?: string;
  customer?: string | { id: string } | null;
  payment_method?: string | { id: string } | null;
  metadata?: Record<string, string>;
  last_payment_error?: { code?: string; decline_code?: string; message?: string } | null;
  latest_charge?: string | RawCharge | null;
};
const idOf = (x: string | { id: string } | null | undefined) => (typeof x === "string" ? x : (x?.id ?? null));

function factsOf(c: RawCharge | null): PaidFacts | null {
  const d = c?.payment_method_details;
  if (!d?.type) return null;
  if (d.type === "card") return { type: "card", ...(d.card?.wallet?.type ? { wallet: d.card.wallet.type } : {}), ...(d.card?.brand ? { brand: d.card.brand } : {}), ...(d.card?.last4 ? { last4: d.card.last4 } : {}) };
  if (d.type === "ideal") {
    const sepa = idOf(d.ideal?.generated_sepa_debit);
    const mandate = idOf(d.ideal?.generated_sepa_debit_mandate);
    return { type: "ideal", ...(d.ideal?.bank ? { bank: d.ideal.bank } : {}), ...(d.ideal?.iban_last4 ? { last4: d.ideal.iban_last4 } : {}), ...(sepa ? { generatedSepa: sepa } : {}), ...(mandate ? { generatedMandate: mandate } : {}) };
  }
  if (d.type === "sepa_debit") return { type: "sepa_debit", ...(d.sepa_debit?.last4 ? { last4: d.sepa_debit.last4 } : {}), ...(d.sepa_debit?.mandate ? { mandate: d.sepa_debit.mandate } : {}) };
  return { type: d.type };
}

function intentOf(p: RawIntent): StripeIntent {
  const charge = p.latest_charge && typeof p.latest_charge === "object" ? p.latest_charge : null;
  return {
    id: p.id,
    status: p.status ?? "",
    amount: p.amount ?? 0,
    amountReceived: p.amount_received ?? 0,
    currency: (p.currency ?? "").toUpperCase(),
    customer: idOf(p.customer),
    paymentMethod: idOf(p.payment_method),
    metadata: p.metadata ?? {},
    lastError: p.last_payment_error ? { code: p.last_payment_error.code, declineCode: p.last_payment_error.decline_code, message: p.last_payment_error.message } : null,
    facts: factsOf(charge),
  };
}

/** The client as a customer on the coach's account, made once (the key makes a retry give back the same one). */
export async function createCustomer(account: string, v: { email?: string; name?: string; metadata: Record<string, string>; idempotencyKey: string }): Promise<string> {
  const c = await call<{ id: string }>("POST", "/customers", { ...(v.email ? { email: v.email } : {}), ...(v.name ? { name: v.name } : {}), metadata: v.metadata }, account, v.idempotencyKey);
  return c.id;
}

/**
 * An automatic charge on the coach's account (26 Nov, Alex): the kept card or SEPA mandate, off session (the client
 * isn't there), confirmed at once. Answers the PaymentIntent: succeeded (a card), processing (a SEPA debit, paid days
 * later by payment_intent.succeeded), or it throws a StripeError carrying the intent when the bank declines. Always sent
 * with an idempotency key, one a try, so a retry of the call is the same charge, never a second.
 */
export async function chargeOffSession(account: string, v: { amount: number; currency: string; customer: string; paymentMethod: string; kind: "card" | "sepa_debit"; mandate?: string; description: string; metadata: Record<string, string>; idempotencyKey: string }): Promise<StripeIntent> {
  const p = await call<RawIntent>(
    "POST",
    "/payment_intents",
    {
      amount: v.amount,
      currency: v.currency.toLowerCase(),
      customer: v.customer,
      payment_method: v.paymentMethod,
      payment_method_types: [v.kind],
      ...(v.kind === "sepa_debit" && v.mandate ? { mandate: v.mandate } : {}),
      off_session: true,
      confirm: true,
      description: v.description,
      metadata: v.metadata,
      expand: ["latest_charge"],
    },
    account,
    v.idempotencyKey,
  );
  return intentOf(p);
}

export async function readPaymentIntent(account: string, id: string): Promise<StripeIntent> {
  return intentOf(await call<RawIntent>("GET", `/payment_intents/${encodeURIComponent(id)}`, { expand: ["latest_charge"] }, account));
}

/** The customer's latest PaymentIntents (twenty): before a charge is sent, one already made for the invoice is found. */
export async function customerIntents(account: string, customer: string): Promise<StripeIntent[]> {
  const r = await call<{ data?: RawIntent[] }>("GET", "/payment_intents", { customer, limit: 20 }, account);
  return (r.data ?? []).map(intentOf);
}

/** A charge left waiting on the client (3D Secure): cancelled, so it can never be completed as well as a later one. */
export async function cancelPaymentIntent(account: string, id: string): Promise<void> {
  await call("POST", `/payment_intents/${encodeURIComponent(id)}/cancel`, {}, account);
}

/** A kept card or mandate taken off the customer, so nothing can be charged on it again. */
export async function detachPaymentMethod(account: string, id: string): Promise<void> {
  await call("POST", `/payment_methods/${encodeURIComponent(id)}/detach`, {}, account);
}

/** A refund of the whole PaymentIntent, on the coach's account. Answers its status: succeeded, or pending (a SEPA
 *  debit's, confirmed later by charge.refunded). */
export async function refundPaymentIntent(account: string, v: { paymentIntent: string; metadata: Record<string, string>; idempotencyKey: string }): Promise<{ id: string; status: string; amount: number; currency: string }> {
  const r = await call<{ id: string; status?: string; amount?: number; currency?: string }>("POST", "/refunds", { payment_intent: v.paymentIntent, reason: "requested_by_customer", metadata: v.metadata }, account, v.idempotencyKey);
  return { id: r.id, status: r.status ?? "", amount: r.amount ?? 0, currency: (r.currency ?? "").toUpperCase() };
}

/** A charge as Stripe has it now: what it was for and how much of it is refunded (charge.refunded reads this, never the
 *  event's copy). */
export async function readCharge(account: string, id: string): Promise<{ id: string; paymentIntent: string | null; amount: number; amountRefunded: number; currency: string; refunded: boolean }> {
  const c = await call<{ id: string; payment_intent?: string | { id: string } | null; amount?: number; amount_refunded?: number; currency?: string; refunded?: boolean }>("GET", `/charges/${encodeURIComponent(id)}`, {}, account);
  return { id: c.id, paymentIntent: idOf(c.payment_intent), amount: c.amount ?? 0, amountRefunded: c.amount_refunded ?? 0, currency: (c.currency ?? "").toUpperCase(), refunded: !!c.refunded };
}

export type StripeAccountState = { id: string; chargesEnabled: boolean; detailsSubmitted: boolean };

/** A new Standard account for a coach, in their country when we know it. */
export async function createCoachAccount(email: string, country: string | null): Promise<string> {
  const acct = await call<{ id: string }>("POST", "/accounts", { type: "standard", email, ...(country ? { country } : {}) });
  return acct.id;
}

/** Stripe's own onboarding for that account: where the coach goes to finish setting it up. */
export async function onboardingLink(account: string, returnUrl: string, refreshUrl: string): Promise<string> {
  const link = await call<{ url: string }>("POST", "/account_links", { account, return_url: returnUrl, refresh_url: refreshUrl, type: "account_onboarding" });
  return link.url;
}

export async function accountState(account: string): Promise<StripeAccountState> {
  const a = await call<{ id: string; charges_enabled?: boolean; details_submitted?: boolean }>("GET", `/accounts/${encodeURIComponent(account)}`);
  return { id: a.id, chargesEnabled: !!a.charges_enabled, detailsSubmitted: !!a.details_submitted };
}

// Amounts go to Stripe in the currency's smallest unit; a few currencies have none.
const ZERO_DECIMAL = new Set(["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);
export function minorUnits(amount: number, currency: string): number {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? Math.round(amount) : Math.round(amount * 100);
}

/** A checkout for one invoice, on the coach's account; answers with the page to send the client to. */
/** `save` (26 Nov, Alex: "Pay automatically from now on"): the payment is kept for later on `customer`, the client on
 *  the coach's account, so the series' next invoices are charged by themselves (lib/invoiceCharges.ts). The methods are
 *  then card (Apple Pay rides on it) and, in euros, iDEAL: an iDEAL payment with setup_future_usage leaves a SEPA Direct
 *  Debit method and its mandate on the customer (charge.payment_method_details.ideal.generated_sepa_debit and
 *  generated_sepa_debit_mandate), which later charges are made on. Checkout itself shows the client the consent to being
 *  charged later. Without it, whatever methods the coach has on their account, as before. */
export async function invoiceCheckout(account: string, v: { invoiceId: number; number: string; amount: number; currency: string; seller: string; email?: string; successUrl: string; cancelUrl: string; idempotencyKey?: string; customer?: string; save?: boolean; metadata?: Record<string, string> }): Promise<{ id: string; url: string; expiresAt: number | null }> {
  const meta = { ...(v.metadata ?? {}), invoice_id: String(v.invoiceId), invoice_number: v.number };
  const save = !!v.save && !!v.customer;
  const s = await call<{ id: string; url: string; expires_at?: number }>(
    "POST",
    "/checkout/sessions",
    {
      mode: "payment",
      line_items: [{ quantity: 1, price_data: { currency: v.currency.toLowerCase(), unit_amount: minorUnits(v.amount, v.currency), product_data: { name: `Invoice ${v.number}`, description: v.seller } } }],
      ...(v.customer ? { customer: v.customer } : { customer_email: v.email }),
      ...(save ? { payment_method_types: v.currency.toUpperCase() === "EUR" ? ["card", "ideal"] : ["card"] } : {}),
      client_reference_id: String(v.invoiceId),
      metadata: { ...meta, ...(save ? { autopay: "1" } : {}) },
      payment_intent_data: { metadata: meta, description: `Invoice ${v.number}`, ...(save ? { setup_future_usage: "off_session" } : {}) },
      success_url: v.successUrl,
      cancel_url: v.cancelUrl,
    },
    account,
    v.idempotencyKey,
  );
  return { id: s.id, url: s.url, expiresAt: typeof s.expires_at === "number" ? s.expires_at : null };
}

/** An invoice's checkout as Stripe has it now, on the coach's account: still open, paid, or expired. */
/** With what it took (26 Nov): the amount and currency (amount_total, minor units), the customer, and its PaymentIntent
 *  with its charge and how it was paid, so it is marked Paid only for the right money and a way kept is known. */
export type InvoiceCheckoutState = { id: string; url: string | null; status: "open" | "complete" | "expired" | string; paymentStatus: string; metadata: Record<string, string>; expiresAt: number | null; amountTotal: number | null; currency: string | null; customer: string | null; intent: StripeIntent | null };
export async function readInvoiceCheckout(account: string, id: string): Promise<InvoiceCheckoutState> {
  const s = await call<{ id: string; url?: string | null; status?: string; payment_status?: string; metadata?: Record<string, string>; expires_at?: number; amount_total?: number | null; currency?: string | null; customer?: string | { id: string } | null; payment_intent?: RawIntent | string | null }>(
    "GET",
    `/checkout/sessions/${encodeURIComponent(id)}`,
    { expand: ["payment_intent", "payment_intent.latest_charge"] },
    account,
  );
  return {
    id: s.id,
    url: s.url ?? null,
    status: s.status ?? "",
    paymentStatus: s.payment_status ?? "",
    metadata: s.metadata ?? {},
    expiresAt: typeof s.expires_at === "number" ? s.expires_at : null,
    amountTotal: typeof s.amount_total === "number" ? s.amount_total : null,
    currency: s.currency ? s.currency.toUpperCase() : null,
    customer: idOf(s.customer),
    intent: s.payment_intent && typeof s.payment_intent === "object" ? intentOf(s.payment_intent) : null,
  };
}

/** Closes an invoice's checkout left open (its amount changed), so the old page can't be paid as well. */
export async function expireInvoiceCheckout(account: string, id: string): Promise<void> {
  await call("POST", `/checkout/sessions/${encodeURIComponent(id)}/expire`, {}, account);
}

// ---- What coaches pay Norcoach (28 Oct, Alex; lib/billing.ts): a subscription on the platform's own account, so
// these calls carry no Stripe-Account. The prices live in Stripe (STRIPE_PRICE_MONTHLY, STRIPE_PRICE_YEARLY), so a new
// price needs no deploy.

/** A Stripe subscription as the app reads it; current_period_end moved onto its items in newer API versions. */
export type StripeSubscription = {
  id: string;
  customer: string;
  status: string;
  trial_end?: number | null;
  current_period_end?: number;
  cancel_at_period_end?: boolean;
  metadata?: Record<string, string>;
  items?: { data?: { current_period_end?: number; price?: { recurring?: { interval?: string } } }[] };
};

/** A coach's checkout for Norcoach: the price, a trial when they have not had one, the card asked for upfront. */
export async function subscriptionCheckout(v: { price: string; coachId: number; email: string; customer?: string; trialDays: number; successUrl: string; cancelUrl: string }): Promise<{ id: string; url: string }> {
  const meta = { coach_id: String(v.coachId) };
  const s = await call<{ id: string; url: string }>("POST", "/checkout/sessions", {
    mode: "subscription",
    line_items: [{ price: v.price, quantity: 1 }],
    ...(v.customer ? { customer: v.customer } : { customer_email: v.email }),
    client_reference_id: String(v.coachId),
    metadata: meta,
    subscription_data: { metadata: meta, ...(v.trialDays > 0 ? { trial_period_days: v.trialDays } : {}) },
    payment_method_collection: "always",
    allow_promotion_codes: true,
    success_url: v.successUrl,
    cancel_url: v.cancelUrl,
  });
  return { id: s.id, url: s.url };
}

/** A finished checkout, with its subscription: read on the way back, so the coach is in before the webhook lands. */
export async function readCheckout(id: string): Promise<{ customer: string | null; metadata?: Record<string, string>; subscription: StripeSubscription | null }> {
  const s = await call<{ customer?: string | null; metadata?: Record<string, string>; subscription?: StripeSubscription | string | null }>("GET", `/checkout/sessions/${encodeURIComponent(id)}`, { expand: ["subscription"] });
  return { customer: s.customer ?? null, metadata: s.metadata, subscription: s.subscription && typeof s.subscription === "object" ? s.subscription : null };
}

/** A subscription as Stripe has it now: the webhook applies this, never the event's copy, which can arrive late. */
export async function readSubscription(id: string): Promise<StripeSubscription> {
  return call<StripeSubscription>("GET", `/subscriptions/${encodeURIComponent(id)}`);
}

/** The customer's subscriptions, any state: one already live is never doubled, and one trial a customer. */
export async function customerSubscriptions(customer: string): Promise<StripeSubscription[]> {
  const r = await call<{ data: StripeSubscription[] }>("GET", "/subscriptions", { customer, status: "all", limit: 20 });
  return r.data ?? [];
}

/** Ends a subscription now (the owner made the coach free). */
export async function cancelSubscription(id: string): Promise<void> {
  await call("DELETE", `/subscriptions/${encodeURIComponent(id)}`);
}

/** Closes a checkout left open, so an earlier tab can't start a second subscription. */
export async function expireCheckout(id: string): Promise<void> {
  await call("POST", `/checkout/sessions/${encodeURIComponent(id)}/expire`);
}

/** Stripe's own billing page for the coach: card, plan, receipts, cancel. */
export async function billingPortal(customer: string, returnUrl: string): Promise<string> {
  const p = await call<{ url: string }>("POST", "/billing_portal/sessions", { customer, return_url: returnUrl });
  return p.url;
}

/** A price as the subscribe screen shows it; kept ten minutes. */
const priceCache = new Map<string, { at: number; v: { amount: number; currency: string; interval: string } }>();
export async function readPrice(id: string): Promise<{ amount: number; currency: string; interval: string } | null> {
  const hit = priceCache.get(id);
  if (hit && Date.now() - hit.at < 600_000) return hit.v;
  try {
    const p = await call<{ unit_amount?: number | null; currency: string; recurring?: { interval?: string } | null }>("GET", `/prices/${encodeURIComponent(id)}`);
    const v = { amount: ZERO_DECIMAL.has(p.currency.toUpperCase()) ? (p.unit_amount ?? 0) : (p.unit_amount ?? 0) / 100, currency: p.currency.toUpperCase(), interval: p.recurring?.interval ?? "month" };
    priceCache.set(id, { at: Date.now(), v });
    return v;
  } catch {
    return null;
  }
}

export type StripeEvent = { id: string; type: string; account?: string; data: { object: Record<string, unknown> } };

/** The event, if the Stripe-Signature header proves Stripe sent this body in the last five minutes; else null. Two
 *  endpoints can point here, each with its own secret (28 Oct): the coaches' accounts (STRIPE_WEBHOOK_SECRET) and the
 *  platform's own, for subscriptions (STRIPE_BILLING_WEBHOOK_SECRET). */
export function verifyWebhook(body: string, header: string | null): StripeEvent | null {
  const secrets = [process.env.STRIPE_WEBHOOK_SECRET, process.env.STRIPE_BILLING_WEBHOOK_SECRET].map((s) => s?.trim()).filter((s): s is string => !!s);
  if (!secrets.length || !header) return null;
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=", 2) as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > 300) return null;
  const given = header
    .split(",")
    .filter((p) => p.startsWith("v1="))
    .map((p) => p.slice(3));
  const ok = secrets.some((secret) => {
    const expected = crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
    return given.some((g) => g.length === expected.length && crypto.timingSafeEqual(Buffer.from(g), Buffer.from(expected)));
  });
  if (!ok) return null;
  try {
    return JSON.parse(body) as StripeEvent;
  } catch {
    return null;
  }
}
