import type { InvoiceEvery } from "./db";

// How a coaching plan reads wherever it shows (28 Oct, Alex): Settings' Plans, the Details picker, the Invoices tab.
// A plain module, safe on the screen and the server.

/** A plan as the screens get it. */
export type PlanChoice = { id: string; name: string; price: number | null; every: InvoiceEvery | null };

export const PLAN_EVERY: { value: InvoiceEvery; label: string; per: string }[] = [
  { value: "week", label: "Week", per: "week" },
  { value: "2weeks", label: "2 weeks", per: "2 weeks" },
  { value: "month", label: "Month", per: "month" },
];

/** "€150", "€89.50": whole sums without their cents. */
export function planMoney(n: number, currency: string): string {
  const whole = Math.round(n * 100) % 100 === 0;
  return new Intl.NumberFormat("en-GB", { style: "currency", currency, minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 }).format(n);
}

/** Its price and rhythm as two facts ("€150", "month"), each left out when not set; parted by Sep where shown. */
export function planFacts(p: Pick<PlanChoice, "price" | "every">, currency: string): string[] {
  return [p.price != null ? planMoney(p.price, currency) : null, PLAN_EVERY.find((e) => e.value === p.every)?.per ?? null].filter((x): x is string => !!x);
}

/** "€150 a month", "€15 a week", "€90 every 2 weeks". */
export function planPerPeriod(p: Pick<PlanChoice, "price" | "every">, currency: string): string {
  if (p.price == null || !p.every) return "";
  return `${planMoney(p.price, currency)} ${p.every === "2weeks" ? "every 2 weeks" : `a ${p.every}`}`;
}

/** How many of a rhythm fit a month (26 Nov, Alex: docs/boards/plans-redesign-mockup.html, A): a week 52 ÷ 12, two
 *  weeks 26 ÷ 12, a month 1, as Business counts a series' month. */
export const PER_MONTH: Record<InvoiceEvery, number> = { week: 52 / 12, "2weeks": 26 / 12, month: 1 };

/** A price's month's worth in whole money (26 Nov, Alex: "€35 × 26 ÷ 12 = €76 a month"); none without a rhythm. */
export function monthWorth(price: number, every: InvoiceEvery | null | undefined): number {
  return every ? Math.round((Number(price) || 0) * PER_MONTH[every]) : 0;
}

/**
 * The tax in a price (26 Nov, Alex: "€89 = €73.55 + €15.45 VAT"), at `ratePct` percent. Prices with VAT in (the plans'
 * own way where the business says so): net = price ÷ (1 + rate), to the cent, and the VAT the rest. Prices without it:
 * the price is the net, the VAT on top. `total` is what the client pays.
 */
export function vatSplit(price: number, ratePct: number, pricesIncludeVat = true): { net: number; vat: number; total: number } {
  const p = Math.round((Number(price) || 0) * 100) / 100;
  const r = Math.max(0, Number(ratePct) || 0) / 100;
  if (pricesIncludeVat) {
    const net = Math.round((p / (1 + r)) * 100) / 100;
    return { net, vat: Math.round((p - net) * 100) / 100, total: p };
  }
  const vat = Math.round(p * r * 100) / 100;
  return { net: p, vat, total: Math.round((p + vat) * 100) / 100 };
}
