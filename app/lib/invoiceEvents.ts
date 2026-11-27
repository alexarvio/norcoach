import { getData, persist, type Data, type InvoiceEvent, type InvoiceEventKind } from "./db";

// What happened to an invoice (26 Nov, Alex: docs/boards/client-invoices-mockup.html, A: "every invoice tells what
// happened to it: sent, opened (app or browser), reminders, paid and how, automatic payment turned on, a charge and its
// retries, marked paid by hand, refunded"). Kept on the invoice itself (Invoice.events, in the row's extra jsonb),
// written by addInvoiceEvent wherever an invoice is made, sent, emailed, opened, reminded or paid. Older invoices carry
// none: invoiceEventsOf fills in made, sent and paid from their own fields, so the history is never empty.
//
// One state an invoice is in, worked out here alone (invoiceStateOf), for the Invoices tab and its Billing card: Not
// sent, Sent, Overdue (its due day gone), Paid, Pending (a bank debit on its way), Charge failed (an automatic charge
// declined and not paid since) or Refunded. Only imports the store, so queries.ts can call it without a cycle.

type InvoiceRow = Data["invoices"][number];

/** The retries a failed automatic charge gets, a day apart, before the coach is told (26 Nov, Alex). */
export const CHARGE_RETRIES = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The server's local day, as queries.ts's localDateStr writes it (no import, so no cycle). */
const localDay = (d: Date = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
/** A stored "YYYY-MM-DD HH:MM:SS" (UTC, from toISOString) or an ISO stamp, as ISO. */
export function stampIso(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = Date.parse(/[T]/.test(s) ? s : `${s.replace(" ", "T")}${/Z|[+-]\d\d:?\d\d$/.test(s) ? "" : "Z"}`);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
const dayOfIso = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? localDay(new Date(t)) : iso.slice(0, 10);
};

/** Adds one thing that happened to an invoice, now unless `at` is given, and keeps it. False when there is no invoice. */
export function addInvoiceEvent(invoiceId: number, ev: Omit<InvoiceEvent, "at"> & { at?: string }, opts: { persist?: boolean } = {}): boolean {
  const inv = getData().invoices.find((i) => i.id === invoiceId);
  if (!inv) return false;
  const row: InvoiceEvent = { at: ev.at ?? new Date().toISOString(), kind: ev.kind };
  if (ev.via) row.via = String(ev.via).slice(0, 40);
  if (ev.detail) row.detail = String(ev.detail).slice(0, 200);
  if (ev.by) row.by = ev.by;
  // A hundred at most: a series of retries or reminders never grows a row without end; the first (made) always stays.
  const list = [...(inv.events ?? []), row];
  inv.events = list.length > 100 ? [list[0], ...list.slice(-99)] : list;
  if (opts.persist !== false) persist();
  return true;
}

/**
 * The invoice's history, oldest first: its own events, with made, sent and paid filled in from its fields where it
 * has none of them (an invoice from before 26 Nov, or one paid before paid events were written).
 */
export function invoiceEventsOf(inv: InvoiceRow): InvoiceEvent[] {
  const own = inv.events ?? [];
  const has = (...kinds: InvoiceEventKind[]) => own.some((e) => kinds.includes(e.kind));
  const out: InvoiceEvent[] = [...own];
  const made = stampIso(inv.created_at);
  if (!has("made") && made) out.push({ at: made, kind: "made", ...(inv.repeat_id ? { by: "auto" as const } : {}) });
  // Sent: it left Not sent (its parties frozen). The day is not kept on older ones: the day it was made stands in.
  if (!has("sent") && inv.status !== "unpaid" && made) out.push({ at: made, kind: "sent" });
  const paidAt = stampIso(inv.paid_at);
  if (inv.status === "paid" && !has("paid", "marked_paid") && paidAt) {
    out.push(inv.paid_via === "stripe" ? { at: paidAt, kind: "paid", ...(inv.paid_method ? { via: inv.paid_method } : {}) } : { at: paidAt, kind: "marked_paid", via: inv.paid_method ?? "bank", by: "coach" });
  }
  const refundedAt = stampIso(inv.refunded_at);
  if (refundedAt && !has("refunded")) out.push({ at: refundedAt, kind: "refunded" });
  // Stable by time; the same moment keeps the order written (made before sent).
  return out.map((e, i) => ({ e, i, t: Date.parse(e.at) || 0 })).sort((a, b) => a.t - b.t || a.i - b.i).map((x) => x.e);
}

/** Where a failed automatic charge stands: retries done (0 to 3), when the next one is due, when the first failed and
 *  when the coach was told. Null when no charge has failed since the invoice was last paid, or it is paid. */
export type InvoiceCharge = { attempt: number; of: number; nextAt?: string; failedAt?: string; toldAt?: string };
export function invoiceChargeOf(inv: InvoiceRow, events: InvoiceEvent[] = invoiceEventsOf(inv)): InvoiceCharge | null {
  if (inv.status === "paid" || inv.refunded_at) return null;
  // The run since the last time it was paid, set back or marked: a run before that is over.
  let start = 0;
  events.forEach((e, i) => {
    if (e.kind === "paid" || e.kind === "marked_paid" || e.kind === "marked_unpaid") start = i + 1;
  });
  const run = events.slice(start);
  const first = run.find((e) => e.kind === "charge_failed");
  if (!first) return null;
  const retries = run.filter((e) => e.kind === "retry");
  const attempt = Math.min(CHARGE_RETRIES, retries.length);
  const told = run.find((e) => e.kind === "coach_told");
  const last = retries[retries.length - 1] ?? first;
  let nextAt: string | undefined;
  if (attempt < CHARGE_RETRIES) {
    const stored = inv.charge_next_at && Date.parse(inv.charge_next_at) > Date.parse(last.at) ? inv.charge_next_at : null;
    nextAt = stored ?? new Date(Date.parse(last.at) + DAY_MS).toISOString();
  }
  return { attempt, of: CHARGE_RETRIES, ...(nextAt ? { nextAt } : {}), failedAt: first.at, ...(told ? { toldAt: told.at } : {}) };
}

export type InvoiceState = "not_sent" | "sent" | "overdue" | "paid" | "pending" | "charge_failed" | "refunded";

/** Days past its due day (0 when not due yet, or nothing is owed). */
export function invoiceLateDays(inv: InvoiceRow, today: string = localDay()): number {
  if (inv.status === "paid" || inv.status === "unpaid" || inv.refunded_at || !inv.due_date || !/^\d{4}-\d{2}-\d{2}$/.test(inv.due_date)) return 0;
  const days = Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${inv.due_date}T12:00:00Z`)) / DAY_MS);
  return days > 0 ? days : 0;
}

/**
 * The one state an invoice is in (26 Nov, Alex: "the status pill stops being a menu. It follows what happened"):
 * Refunded, Paid, Not sent; Pending while a bank debit is on its way; Charge failed while a failed automatic charge
 * stands; Overdue once its due day has gone (or stored as Overdue before); else Sent.
 */
export function invoiceStateOf(inv: InvoiceRow, today: string = localDay(), events: InvoiceEvent[] = invoiceEventsOf(inv)): InvoiceState {
  if (inv.refunded_at) return "refunded";
  if (inv.status === "paid") return "paid";
  if (inv.status === "unpaid") return "not_sent";
  const money = events.filter((e) => ["pending", "paid", "marked_paid", "marked_unpaid", "charge_failed", "retry"].includes(e.kind));
  if (money[money.length - 1]?.kind === "pending") return "pending";
  if (invoiceChargeOf(inv, events)) return "charge_failed";
  if (inv.status === "due" || invoiceLateDays(inv, today) > 0) return "overdue";
  return "sent";
}

/** States that are money owed: sent and not paid. */
export const OWED_STATES: readonly InvoiceState[] = ["sent", "overdue", "pending", "charge_failed"];

/** The coach reminded the client of it today (one reminder a day an invoice). */
export function remindedToday(inv: InvoiceRow, today: string = localDay()): boolean {
  return (inv.events ?? []).some((e) => e.kind === "reminded" && dayOfIso(e.at) === today);
}

/**
 * The client opened the invoice (26 Nov, Alex: "opened, in Alex's app" or "in the browser"): one opened a source a day,
 * written by the client's own invoice page (via app) and the browser invoice page (via browser), never for a coach
 * looking (callers pass only a client's own visit). Answers whether it wrote one.
 */
export function noteInvoiceOpened(invoiceId: number, via: "app" | "browser", today: string = localDay()): boolean {
  const inv = getData().invoices.find((i) => i.id === invoiceId);
  // Never a draft: Not sent isn't theirs to open.
  if (!inv || inv.status === "unpaid") return false;
  if ((inv.events ?? []).some((e) => e.kind === "opened" && e.via === via && dayOfIso(e.at) === today)) return false;
  return addInvoiceEvent(invoiceId, { kind: "opened", via, by: "client" });
}

/** A failed automatic charge the coach has been told of (26 Nov, Alex: "Finlay is told on his To do", only after the
 *  third retry): a row of the client's To do under Invoices for as long as it stands, gone once the invoice is paid,
 *  marked paid or refunded, or let go with the row's round check. Its key carries when the coach was told, so a later
 *  run that fails again comes back as a new row. `reason`: the last decline's words ("Visa •••• 4242 | insufficient
 *  funds"). */
export type ChargeTodo = { key: string; invoiceId: number; number: string; amount: number; currency: string; reason: string | null; toldAt: string };
export function chargeTodosOf(clientId: number, today: string = localDay()): ChargeTodo[] {
  const out: ChargeTodo[] = [];
  for (const inv of getData().invoices) {
    if (inv.client_id !== clientId) continue;
    const events = invoiceEventsOf(inv);
    if (invoiceStateOf(inv, today, events) !== "charge_failed") continue;
    const charge = invoiceChargeOf(inv, events);
    if (!charge?.toldAt) continue;
    const failed = [...events].reverse().find((e) => e.kind === "retry" || e.kind === "charge_failed");
    out.push({ key: `charge-${inv.id}-${Date.parse(charge.toldAt) || 0}`, invoiceId: inv.id, number: inv.number ?? `#${inv.id}`, amount: inv.amount, currency: inv.currency ?? "EUR", reason: failed?.detail ?? null, toldAt: charge.toldAt });
  }
  return out;
}
