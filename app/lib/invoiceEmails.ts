import "server-only";
import { getData, persist } from "./db";
import { getInvoiceView, type InvoiceView } from "./queries";
import { getInvoiceAuto } from "./invoiceAuto";
import { canPayOnline } from "./payments";
import { mailConfigured, sendInvoiceEmail, type InvoiceMail } from "./mail";
import { invoicePageUrl, invoiceViewUrl } from "./invoicePayLink";
import { sellerOf } from "./invoicePayPage";
import { countryCodeFromName, countryOf, formatMoney } from "./countries";
import { dayWords } from "./clientDates";
import { brandColour } from "./brandColour";
import { addInvoiceEvent } from "./invoiceEvents";

// Invoices by email (23 Nov, Alex: docs/boards/settings-harmony-mockup.html, Settings, Invoicing & payments): each
// invoice is emailed to the client the moment it reaches them, while the coach's switch is on (lib/invoiceAuto.ts, on
// unless switched off) and mail is set up (lib/mail.ts). From the coach's business by name, a reply going to the coach;
// the number, what for, the amount, when it is due, View invoice, the coach's bank details, and Pay when the coach's own
// Stripe takes cards (lib/invoiceCheckouts.ts).
//
// "Reaches them" is an invoice leaving Not sent: made as Sent (New invoice, Start billing, a series that sends) or set
// to Sent from its state menu. The sweep below finds every such invoice not emailed yet, a minute at a time
// (instrumentation.ts), so none is missed whichever way it went out; emailInvoice is also called straight after an
// invoice this code makes itself (billing on a plan, lib/planBillingActions.ts). Each invoice once: a row an invoice
// (`invoice_emails` in kv, as lib/healthOn.ts keeps its own), written before the email goes, so two sweeps never send
// it twice. The first time the list is read, every invoice the client already has is marked as from before, so the
// switch going live never emails a client their old invoices. One switched off when it went out is never sent later.

type EmailState = "before" | "skipped" | "sending" | "sent" | "failed";
type EmailRow = { invoice_id: number; state: EmailState; at: string; tries: number; to?: string };
type WithEmails = { invoice_emails?: EmailRow[] };

const MINUTE = 60_000;
/** Out longer than this when first seen: from before, never emailed late. */
const FRESH = 30 * MINUTE;
/** Never an invoice that reached the client more than a week ago. */
const TOO_OLD = 7 * 24 * 60 * MINUTE;
const MAX_TRIES = 3;
const RETRY_AFTER = 10 * MINUTE;

/** The server's own clock in its stored "YYYY-MM-DD HH:MM:SS" (UTC) as epoch ms. */
const storedMs = (s: string | undefined) => (s ? Date.parse(`${s.replace(" ", "T")}${/Z|[+-]\d\d:?\d\d$/.test(s) ? "" : "Z"}`) : NaN);
const reached = (inv: { status: string; from?: unknown }) => inv.status !== "unpaid" && !!inv.from;

/** On where mail is set up and on the live server: a dev or staging server with the keys would otherwise email real
 *  clients from a copy. INVOICE_EMAILS=on forces it, =off stops it. */
export function invoiceEmailsOn(): boolean {
  if (!mailConfigured()) return false;
  // Off until the server is told on (23 Nov): emails reach real clients, so the owner switches them on himself
  // (INVOICE_EMAILS=on on Railway), never by a deploy.
  return process.env.INVOICE_EMAILS === "on";
}

const rows = (): EmailRow[] => {
  const data = getData() as unknown as WithEmails;
  if (Array.isArray(data.invoice_emails)) return data.invoice_emails;
  // First read: what the clients have already is from before. One sent in the last half hour is left to go.
  const now = Date.now();
  const at = new Date().toISOString();
  data.invoice_emails = getData()
    .invoices.filter((i) => reached(i) && !(i.status === "sent" && now - storedMs(i.updated_at) < FRESH))
    .map((i) => ({ invoice_id: i.id, state: "before" as const, at, tries: 0 }));
  persist();
  return data.invoice_emails;
};

function mark(invoiceId: number, patch: Partial<EmailRow> & { state: EmailState }) {
  const list = rows();
  const was = list.find((r) => r.invoice_id === invoiceId);
  const at = new Date().toISOString();
  if (was) Object.assign(was, patch, { at });
  else list.push({ invoice_id: invoiceId, tries: 0, ...patch, at });
  persist();
}

/** The client's own sign-in email, else the one on the invoice. */
function recipient(clientId: number, v: InvoiceView): string | null {
  const login = getData().users.find((u) => u.role === "client" && u.client_id === clientId)?.email?.trim();
  const email = login || v.to.email?.trim() || "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

const spaced = (s: string) => s.replace(/\s+/g, "").replace(/(.{4})/g, "$1 ").trim();

/** The email as the invoice has it: the money and days written for the client, the bank as the sheet prints it. */
function mailOf(v: InvoiceView): InvoiceMail {
  const f = v.from;
  const country = countryOf(f.country_code || countryCodeFromName(f.country));
  const seller = sellerOf(v);
  const bank: InvoiceMail["bank"] = [];
  const holder = f.account_holder || f.legal_name || f.business_name;
  if (country.bank === "us" && f.routing_number) bank.push({ label: "Routing number", value: f.routing_number }, { label: "Account", value: f.account_number ?? "" });
  else if (country.bank === "au" && f.bsb) bank.push({ label: "BSB", value: f.bsb }, { label: "Account", value: f.account_number ?? "" });
  else if (country.bank === "uk" && f.sort_code) bank.push({ label: "Sort code", value: f.sort_code }, { label: "Account", value: f.account_number ?? "" });
  if (f.iban) bank.push({ label: "IBAN", value: spaced(f.iban) }, ...(f.bic ? [{ label: "BIC", value: f.bic }] : []));
  const bankWords = !bank.length && f.bank_details?.trim() ? f.bank_details.trim() : null;
  if (holder && (bank.length || bankWords)) bank.unshift({ label: "Account holder", value: holder });
  const coach = v.coachId != null ? getData().users.find((u) => u.id === v.coachId && u.role === "coach") : undefined;
  const b = coach?.coach_settings?.brand?.color ? brandColour(coach.coach_settings.brand.color) : null;
  const first = v.lines[0]?.description ?? "";
  return {
    seller,
    number: v.number,
    what: v.lines.length > 1 ? `${first} + ${v.lines.length - 1} more` : first,
    amount: formatMoney(v.total, v.currency, country.code),
    issued: dayWords(v.issueDate),
    due: v.dueDate ? dayWords(v.dueDate) : null,
    viewUrl: invoiceViewUrl(v.id),
    // Pay only on an invoice paid by link (26 Nov, Alex): one paid by bank transfer carries the bank details alone. It
    // opens our own invoice page (26 Nov, Alex: "every invoice email links to our own page"), whose Pay goes on to
    // Stripe, and where a series can be paid automatically from then on; the old /pay links in emails sent keep working.
    payUrl: v.pays !== "bank" && canPayOnline(v.coachId) ? invoicePageUrl(v.id) : null,
    bank: bank.filter((x) => x.value),
    bankWords,
    brand: b ? { hex: b.hex, ink: b.ink } : null,
  };
}

/** The coach's address for the client's reply: the billing email on their business, else their sign-in. */
function replyTo(v: InvoiceView): string | null {
  const coach = v.coachId != null ? getData().users.find((u) => u.id === v.coachId && u.role === "coach") : undefined;
  return v.from.billing_email?.trim() || coach?.email || null;
}

/**
 * Emails one invoice to its client if it is theirs now and not emailed yet, while the coach's switch is on. Answers
 * whether it went. Never twice: a row is written before the email goes, and a failed one is tried again (three times,
 * ten minutes apart) by the sweep.
 */
export async function emailInvoice(invoiceId: number): Promise<boolean> {
  if (!invoiceEmailsOn()) return false;
  const inv = getData().invoices.find((i) => i.id === invoiceId);
  if (!inv || !reached(inv)) return false;
  const row = rows().find((r) => r.invoice_id === invoiceId);
  const now = Date.now();
  if (row) {
    if (row.state === "before" || row.state === "skipped" || row.state === "sent") return false;
    // Another send is on it (a crash mid-send leaves it to be tried again once it is plainly stale).
    if (row.state === "sending" && now - Date.parse(row.at) < 15 * MINUTE) return false;
    if (row.tries >= MAX_TRIES) return false;
  }
  if (inv.status === "paid") return mark(invoiceId, { state: "skipped" }), false;
  if (now - storedMs(inv.updated_at) > TOO_OLD) return mark(invoiceId, { state: "skipped" }), false;
  const v = getInvoiceView(invoiceId);
  if (!v || v.coachId == null) return false;
  if (!getInvoiceAuto(v.coachId).emailInvoices) return mark(invoiceId, { state: "skipped" }), false;
  const to = recipient(inv.client_id, v);
  if (!to) return mark(invoiceId, { state: "skipped" }), false;
  const tries = (row?.tries ?? 0) + 1;
  mark(invoiceId, { state: "sending", tries, to });
  const ok = await sendInvoiceEmail({ ...mailOf(v), to, replyTo: replyTo(v) }).catch(() => false);
  mark(invoiceId, { state: ok ? "sent" : "failed", tries, to });
  // Its history (26 Nov, Alex): "Sent by email, alex@example.com".
  if (ok) addInvoiceEvent(invoiceId, { kind: "emailed", via: "email", detail: to, by: "auto" });
  return ok;
}

/** Where an email the coach asked for stands: sent; mail not on here; no address for the client; it didn't go. */
export type InvoiceMailAnswer = "sent" | "off" | "no_email" | "failed";

/** Whether the client has an address an invoice email can go to (their sign-in, else the one on the invoice). */
export function invoiceRecipientOf(invoiceId: number): string | null {
  const v = getInvoiceView(invoiceId);
  return v ? recipient(v.clientId, v) : null;
}

/**
 * The coach's Send link again and Remind (26 Nov, Alex: docs/boards/client-invoices-mockup.html, A): the invoice email
 * sent now, whatever was sent before, on a sent invoice not paid; a reminder says so in its subject ("Reminder: invoice
 * 20260004") and its head, the same design. Only where invoice emails can go at all (invoiceEmailsOn); the coach's
 * "Invoices by email" switch is for the ones that go by themselves, not for these. Its history gets "emailed" (the
 * reminder's own "reminded" is the caller's, written whether or not the email went).
 */
/** `by`: who sent it, for its history: the coach (Send link again, Remind), or "auto" for the payments code telling the
 *  client a charge needs them (26 Nov, Alex; lib/invoiceCharges.ts). */
export async function sendInvoiceMailNow(invoiceId: number, kind: "again" | "reminder", by: "coach" | "auto" = "coach"): Promise<InvoiceMailAnswer> {
  if (!invoiceEmailsOn()) return "off";
  const inv = getData().invoices.find((i) => i.id === invoiceId);
  const v = getInvoiceView(invoiceId);
  if (!inv || !v || !reached(inv) || inv.status === "paid" || inv.refunded_at) return "failed";
  const to = recipient(inv.client_id, v);
  if (!to) return "no_email";
  const ok = await sendInvoiceEmail({ ...mailOf(v), to, replyTo: replyTo(v), ...(kind === "reminder" ? { reminder: true } : {}) }).catch(() => false);
  if (!ok) return "failed";
  addInvoiceEvent(invoiceId, { kind: "emailed", via: "email", detail: to, by });
  return "sent";
}

/** In the background, after an invoice this code sent itself; nothing waits on it and nothing throws. */
export function emailInvoiceInBackground(invoiceId: number): void {
  void emailInvoice(invoiceId).catch((e) => console.error("[invoices] email failed:", e instanceof Error ? e.message : e));
}

let sweeping = false;

/** Every invoice that reached its client and has no email yet (or a failed one due again): emailed. How many went. */
export async function sweepInvoiceEmails(): Promise<number> {
  if (sweeping || !invoiceEmailsOn()) return 0;
  sweeping = true;
  try {
    const list = rows();
    const now = Date.now();
    const known = new Map(list.map((r) => [r.invoice_id, r]));
    const due = getData().invoices.filter((i) => {
      if (!reached(i)) return false;
      const r = known.get(i.id);
      if (!r) return true;
      if (r.state === "failed") return r.tries < MAX_TRIES && now - Date.parse(r.at) >= RETRY_AFTER;
      return r.state === "sending" && now - Date.parse(r.at) >= 15 * MINUTE && r.tries < MAX_TRIES;
    });
    let sent = 0;
    for (const i of due) if (await emailInvoice(i.id)) sent++;
    return sent;
  } finally {
    sweeping = false;
  }
}

/** A client erased whose invoices are kept (the law's records): the rows stay, so a kept invoice is never emailed
 *  again, but the address it went to goes. */
export function forgetInvoiceRecipients(invoiceIds: number[]): void {
  const data = getData() as unknown as WithEmails;
  const kept = new Set(invoiceIds);
  let changed = false;
  for (const r of data.invoice_emails ?? []) {
    if (!kept.has(r.invoice_id) || !r.to) continue;
    delete r.to;
    changed = true;
  }
  if (changed) persist();
}

/** Invoices erased (a client deleted with theirs): their rows go too. */
export function dropInvoiceEmails(invoiceIds: number[]): void {
  const data = getData() as unknown as WithEmails;
  const gone = new Set(invoiceIds);
  if (!data.invoice_emails?.some((r) => gone.has(r.invoice_id))) return;
  data.invoice_emails = data.invoice_emails.filter((r) => !gone.has(r.invoice_id));
  persist();
}
