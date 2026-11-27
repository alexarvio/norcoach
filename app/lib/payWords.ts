import type { ClientAutopay, InvoicePayMethod } from "./db";
import type { PaidFacts } from "./stripe";

// The words of paying (26 Nov, Alex): how a payment was made ("Visa •••• 4242", "ING"), a kept way to pay, why a charge
// didn't go ("insufficient funds"), for the invoice's history, its page and the coach's To do. Pure, no store and no
// Stripe, so scripts/test-pay-words.ts can run it on its own.

const BRANDS: Record<string, string> = { visa: "Visa", mastercard: "Mastercard", amex: "American Express", discover: "Discover", jcb: "JCB", unionpay: "UnionPay", diners: "Diners Club", cartes_bancaires: "Cartes Bancaires", eftpos_au: "eftpos", interac: "Interac" };
const BANKS: Record<string, string> = { abn_amro: "ABN AMRO", asn_bank: "ASN Bank", bunq: "bunq", ing: "ING", knab: "Knab", rabobank: "Rabobank", regiobank: "RegioBank", revolut: "Revolut", sns_bank: "SNS", triodos_bank: "Triodos", van_lanschot: "Van Lanschot", n26: "N26", yoursafe: "Yoursafe" };
const titled = (s: string) => s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
/** A card's brand in words: "Visa", "American Express". */
export const brandWord = (b: string | undefined) => (b ? (BRANDS[b.toLowerCase()] ?? titled(b)) : "Card");
/** An iDEAL bank in words: "ING", "ABN AMRO". */
export const bankWord = (b: string | undefined) => (b ? (BANKS[b.toLowerCase()] ?? titled(b)) : "");

/** How a payment was made, as the invoice's history and the page say it: the method, and "Visa •••• 4242", "ING",
 *  "SEPA •••• 3000". */
export function paidWords(f: PaidFacts | null | undefined): { method?: InvoicePayMethod; detail?: string } {
  if (!f) return {};
  if (f.type === "card") return { method: f.wallet === "apple_pay" ? "apple_pay" : "card", detail: f.last4 ? `${brandWord(f.brand)} •••• ${f.last4}` : brandWord(f.brand) };
  if (f.type === "ideal") return { method: "ideal", ...(bankWord(f.bank) ? { detail: bankWord(f.bank) } : {}) };
  if (f.type === "sepa_debit") return { method: "sepa_debit", detail: f.last4 ? `SEPA •••• ${f.last4}` : "SEPA" };
  return { detail: titled(f.type) };
}

/** A kept way to pay in words: "Visa •••• 4242", "ING •••• 3000". */
export function autopayWords(a: ClientAutopay | null | undefined): string {
  if (!a) return "";
  const head = a.kind === "card" ? brandWord(a.brand) : a.brand || "SEPA";
  return a.last4 ? `${head} •••• ${a.last4}` : head;
}

/** Why a charge didn't go, in plain words (26 Nov, Alex: "insufficient funds"), from Stripe's code and the bank's. */
export function declineWords(code?: string, decline?: string): string {
  const c = decline || code || "";
  if (c === "insufficient_funds") return "insufficient funds";
  if (c === "expired_card") return "card expired";
  if (c === "lost_card" || c === "stolen_card" || c === "pickup_card" || c === "restricted_card") return "card blocked";
  if (c === "incorrect_cvc" || c === "invalid_cvc") return "security code wrong";
  if (c === "processing_error") return "bank error";
  if (c === "authentication_required") return "needs confirming";
  if (c === "card_velocity_exceeded" || c === "withdrawal_count_limit_exceeded") return "card limit reached";
  if (c === "resource_missing" || c === "payment_method_unexpected_state") return "no longer on file";
  if (c === "debit_not_authorized" || c === "invalid_account_number") return "debit not allowed";
  if (c === "account_closed" || c === "bank_account_restricted") return "account closed";
  return "declined";
}

/** Money as a fact on the client's page, whole when it is: "€89", "€89.50". */
export const wholeMoney = (formatted: string) => formatted.replace(/([.,])00(?!\d)/, "");
/** 1st, 2nd, 3rd, 4th, 11th, 21st. */
export const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th")}`;
