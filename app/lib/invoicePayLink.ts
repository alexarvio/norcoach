import crypto from "crypto";
import { appUrl } from "./passwordReset";

// The links an invoice email carries (23 Nov, Alex: Settings, Invoicing & payments, "Invoices by email"): View invoice
// (the client's own invoice page, behind their sign-in) and Pay, which opens Stripe's checkout for that invoice on the
// coach's own account (/invoice/<id>/pay). Pay carries the invoice's id signed, as an invite link does
// (lib/inviteToken.ts), so the client can pay from the email without signing in first: the signature opens that one
// invoice's checkout and nothing else, and a changed number fails it. Without AUTH_SECRET there is no signature, and the
// link asks for the client's own sign-in instead.

const secret = () => process.env.AUTH_SECRET?.trim() || "";
const sign = (payload: string) => crypto.createHmac("sha256", `${secret()}:invoice-pay`).update(payload).digest("hex").slice(0, 32);

/** The invoice's signed id, or null with no secret on the server. */
export function invoicePayToken(invoiceId: number): string | null {
  if (!secret() || !Number.isInteger(invoiceId)) return null;
  return `${invoiceId}.${sign(String(invoiceId))}`;
}

/** Whether the token is this invoice's own signature. */
export function invoicePayTokenOk(invoiceId: number, token: string | null | undefined): boolean {
  if (!secret() || !token) return false;
  const [id, mac] = token.split(".");
  if (id !== String(invoiceId) || !mac) return false;
  const a = Buffer.from(mac);
  const b = Buffer.from(sign(id));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const withToken = (base: string, path: string, invoiceId: number, extra: Record<string, string> = {}) => {
  const q = new URLSearchParams(extra);
  const t = invoicePayToken(invoiceId);
  if (t) q.set("t", t);
  const s = q.toString();
  return `${base}${path}${s ? `?${s}` : ""}`;
};

/** Pay: our route, which sends the client on to Stripe. Null when the app has no address of its own. */
export function invoicePayUrl(invoiceId: number): string | null {
  const base = appUrl();
  return base ? withToken(base, `/invoice/${invoiceId}/pay`, invoiceId) : null;
}

/** Where Stripe sends the client back: paid (Stripe fills in the session) or not. */
export function invoiceReturnUrl(invoiceId: number, paid: boolean): string | null {
  const base = appUrl();
  if (!base) return null;
  // Stripe swaps {CHECKOUT_SESSION_ID} for the session's id; URLSearchParams would encode its braces, so it goes last as is.
  const url = withToken(base, `/invoice/${invoiceId}/paid`, invoiceId);
  return paid ? `${url}${url.includes("?") ? "&" : "?"}session_id={CHECKOUT_SESSION_ID}` : url;
}

/** The client's own invoice page (signed in). */
export function invoiceViewUrl(invoiceId: number): string | null {
  const base = appUrl();
  return base ? `${base}/client/invoices/${invoiceId}` : null;
}
