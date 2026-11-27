// The pure parts of paying (26 Nov, Alex; app/lib/payWords.ts, app/lib/stripe.ts minorUnits), checked without Stripe or
// the store: amounts to Stripe's minor units, how a payment is said, why a charge didn't go.
//   npx tsx scripts/test-pay-words.ts
import assert from "node:assert/strict";
import { minorUnits } from "../app/lib/stripe";
import { autopayWords, declineWords, ordinal, paidWords, wholeMoney } from "../app/lib/payWords";

// Minor units: cents, rounded (a float sum like 0.1 + 0.2 never lands a cent off), none for zero-decimal currencies.
assert.equal(minorUnits(89, "EUR"), 8900);
assert.equal(minorUnits(89.99, "eur"), 8999);
assert.equal(minorUnits(0.1 + 0.2, "EUR"), 30);
assert.equal(minorUnits(1.005 * 100, "EUR"), 10050);
assert.equal(minorUnits(5000, "JPY"), 5000);

assert.deepEqual(paidWords({ type: "card", brand: "visa", last4: "4242" }), { method: "card", detail: "Visa •••• 4242" });
assert.deepEqual(paidWords({ type: "card", brand: "mastercard", last4: "4444", wallet: "apple_pay" }), { method: "apple_pay", detail: "Mastercard •••• 4444" });
assert.deepEqual(paidWords({ type: "ideal", bank: "ing" }), { method: "ideal", detail: "ING" });
assert.deepEqual(paidWords({ type: "sepa_debit", last4: "3000" }), { method: "sepa_debit", detail: "SEPA •••• 3000" });
assert.deepEqual(paidWords(null), {});

assert.equal(autopayWords({ kind: "card", brand: "Visa", last4: "4242", since: "" }), "Visa •••• 4242");
assert.equal(autopayWords({ kind: "sepa_debit", brand: "ING", last4: "3000", since: "" }), "ING •••• 3000");
assert.equal(autopayWords({ kind: "sepa_debit", since: "" }), "SEPA");

assert.equal(declineWords("card_declined", "insufficient_funds"), "insufficient funds");
assert.equal(declineWords("expired_card"), "card expired");
assert.equal(declineWords("authentication_required"), "needs confirming");
assert.equal(declineWords("card_declined", "do_not_honor"), "declined");

assert.equal(ordinal(1), "1st");
assert.equal(ordinal(2), "2nd");
assert.equal(ordinal(3), "3rd");
assert.equal(ordinal(11), "11th");
assert.equal(ordinal(22), "22nd");
assert.equal(ordinal(26), "26th");
assert.equal(wholeMoney("€89.00"), "€89");
assert.equal(wholeMoney("€89.50"), "€89.50");
assert.equal(wholeMoney("€ 1.250,00"), "€ 1.250");

console.log("pay words: all good");
