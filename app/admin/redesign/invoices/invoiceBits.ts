import type { InvoiceEvery, InvoiceLine } from "../../../lib/db";

// The small sums and dates the Invoices tab and its pop-ups share (26 Nov, Alex: docs/boards/client-invoices-mockup.html,
// A): money as it prints, a typed amount either way of writing it, an invoice's sums, a series' next day. Plain, so the
// tab, Start billing, Edit lines and New invoice all read them from one place.

export const money = (n: number, currency: string) => new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(n || 0);
/** Money as a fact, whole when it is: "€89", "€89.50". */
export const wholeMoney = (n: number, currency: string) => money(n, currency).replace(/([.,])00(?!\d)/, "");
export const iso = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
export const addDays = (d: string, n: number) => {
  const x = new Date(`${d}T12:00:00`);
  x.setDate(x.getDate() + n);
  return iso(x);
};
/** Whole days from `a` to `b` (yyyy-mm-dd). */
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00`) - Date.parse(`${a}T12:00:00`)) / 86_400_000);
/** When a series comes back after `d` (as the server's nextInvoiceDate): a week or two on, or the anchor day next month. */
export const nextOf = (d: string, every: InvoiceEvery, anchor = Number(d.slice(8, 10))) => {
  if (every === "week") return addDays(d, 7);
  if (every === "2weeks") return addDays(d, 14);
  const x = new Date(`${d}T12:00:00`);
  const y = x.getMonth() === 11 ? x.getFullYear() + 1 : x.getFullYear();
  const m = (x.getMonth() + 1) % 12;
  return iso(new Date(y, m, Math.min(anchor, new Date(y, m + 1, 0).getDate()), 12));
};
/** A new series' first day to come after `today` (a first invoice in the past never back-fills; as addInvoiceRepeat). */
export const firstNext = (issue: string, every: InvoiceEvery, today: string) => {
  const anchor = Number(issue.slice(8, 10));
  let n = nextOf(issue, every, anchor);
  while (n <= today) n = nextOf(n, every, anchor);
  return n;
};
export const EVERY: { value: InvoiceEvery | null; label: string; long: string }[] = [
  { value: null, label: "Once", long: "" },
  { value: "week", label: "Week", long: "Weekly" },
  { value: "2weeks", label: "2 weeks", long: "Every 2 weeks" },
  { value: "month", label: "Month", long: "Monthly" },
];
export const everyLong = (e: InvoiceEvery | null | undefined) => EVERY.find((x) => x.value === e)?.long ?? "";
export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** "{month}" and "{year}" as of a day, as the server fills them when it makes the invoice. */
export const fill = (text: string, day: string) => {
  const x = new Date(`${day}T12:00:00`);
  return text.replace(/\{month\}/gi, MONTHS[x.getMonth()]).replace(/\{year\}/gi, String(x.getFullYear()));
};
export const cents = (n: number) => Math.round(n * 100) / 100;
/**
 * A typed amount, either way of writing it: the last comma or point is the decimals and any other a thousands mark
 * ("1.250,00", "1,250.00"), except one kind of mark with exactly three digits after each, which is thousands
 * ("1,250", "1.250", "1.250.000"; prices never have three decimals). "0,250" stays 0.25. Unreadable: NaN.
 */
export const num = (s: string) => {
  const t = s.trim();
  if (!t) return 0;
  const i = Math.max(t.lastIndexOf(","), t.lastIndexOf("."));
  if (i < 0) return Number(t);
  const mark = t[i];
  const head = t.slice(0, i);
  const tail = t.slice(i + 1);
  if (tail.length === 3 && new RegExp(`^[1-9]\\d{0,2}(\\${mark}\\d{3})*$`).test(head)) return Number(head.split(mark).join("") + tail);
  return Number(`${head.replace(/[.,]/g, "")}.${tail}`);
};
/** Figures only, as typed: digits, commas and points. */
export const figure = (v: string) => v.replace(/[^\d.,]/g, "");
export function totals(lines: InvoiceLine[], rate: number, incl: boolean) {
  const sum = cents(lines.reduce((s, l) => s + (Number(l.quantity) || 0) * (Number(l.unit_price) || 0), 0));
  const r = rate / 100;
  if (incl) {
    const subtotal = cents(sum / (1 + r));
    return { subtotal, vat: cents(sum - subtotal), total: sum };
  }
  const vat = cents(sum * r);
  return { subtotal: sum, vat, total: cents(sum + vat) };
}
/** The plan's own line on a series or a plan fill: the one named after it, else the first (as the server's planLineIndexOf). */
export const planLineIndex = (lines: InvoiceLine[], planName: string | null | undefined) => {
  const name = (planName ?? "").trim().toLowerCase();
  const i = name
    ? lines.findIndex((l) => {
        const d = l.description.trim().toLowerCase();
        return d === name || d.startsWith(`${name},`);
      })
    : -1;
  return i >= 0 ? i : 0;
};
/** "today", "tomorrow", "in 30 days". */
export const inDays = (n: number) => (n <= 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`);
export const sheetHref = (id: number) => `/invoices/${id}`;
/** The currency's sign alone, as it prints before a price: "€", "£", "CHF". */
export const currencySign = (currency: string) => money(0, currency).replace(/[\d.,\s ]/g, "") || currency;
/** A stored stamp ("2026-11-26 09:01:00", UTC, or ISO) as a Date; null when it won't read. */
export const stampDate = (s: string | null | undefined) => {
  if (!s) return null;
  const t = Date.parse(/T/.test(s) ? s : `${s.replace(" ", "T")}${/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? "" : "Z"}`);
  return Number.isFinite(t) ? new Date(t) : null;
};
