// A phone in two parts, the dial code and the number, stored apart and joined only to show (6 Nov, Alex: the client's
// My details and the coach's Details are one record, and one side kept the code apart while the other typed it into
// the number). No server imports here: the coach's admin and the client's app both use it.

// Dial codes in the order this business meets them, not alphabetically.
export const DIAL_CODES: [iso: string, code: string][] = [
  ["NL", "+31"],
  ["BE", "+32"],
  ["UK", "+44"],
  ["DE", "+49"],
  ["FR", "+33"],
  ["ES", "+34"],
  ["IT", "+39"],
  ["PT", "+351"],
  ["IE", "+353"],
  ["CH", "+41"],
  ["AT", "+43"],
  ["DK", "+45"],
  ["SE", "+46"],
  ["NO", "+47"],
  ["PL", "+48"],
  ["US", "+1"],
  ["AU", "+61"],
  ["NZ", "+64"],
  ["ZA", "+27"],
  ["AE", "+971"],
];
export const DEFAULT_DIAL = "+31";

/** Each business country's dial code, by its ISO code (lib/countries.ts' COUNTRIES; 23 Nov: Settings, Business details
 *  shows the country's fixed before the phone on invoices). */
const COUNTRY_DIAL: Record<string, string> = {
  AT: "+43", BE: "+32", BG: "+359", HR: "+385", CY: "+357", CZ: "+420", DK: "+45", EE: "+372", FI: "+358", FR: "+33",
  DE: "+49", GR: "+30", HU: "+36", IE: "+353", IT: "+39", LV: "+371", LT: "+370", LU: "+352", MT: "+356", NL: "+31",
  PL: "+48", PT: "+351", RO: "+40", SK: "+421", SI: "+386", ES: "+34", SE: "+46", IS: "+354", LI: "+423", NO: "+47",
  CH: "+41", GB: "+44", US: "+1", CA: "+1", AU: "+61", NZ: "+64",
};
export const dialOfCountry = (code: string | null | undefined): string | null => (code ? COUNTRY_DIAL[code.toUpperCase()] ?? null : null);

/** A dial code as it is kept: a plus and one to four digits. */
export const isDialCode = (v: string) => /^\+[0-9]{1,4}$/.test(v);

/** The phone as one line: `+31 6 12345678`; a number kept from before the split shows as it was typed. */
export function phoneLine(code: string | null | undefined, number: string | null | undefined): string {
  const n = (number ?? "").trim();
  if (!n) return "";
  return code && !n.startsWith("+") ? `${code} ${n}` : n;
}

/**
 * A number typed with its code in it (`+31 6 12345678`, `0031 6…`) split into the two: the code when it is one we
 * know, the rest as the number. Anything else is kept as typed, with no code guessed.
 */
export function splitTypedPhone(raw: string): { code: string | null; number: string } {
  const t = raw.trim();
  const plus = t.startsWith("00") ? `+${t.slice(2)}` : t;
  if (!plus.startsWith("+")) return { code: null, number: t };
  const digits = plus.replace(/[\s().-]/g, "");
  const known = DIAL_CODES.map(([, c]) => c)
    .sort((a, b) => b.length - a.length)
    .find((c) => digits.startsWith(c));
  if (!known) return { code: null, number: t };
  // Past the code's own digits, whatever separators sit between them.
  let need = known.length - 1;
  let i = 1;
  while (i < plus.length && need > 0) {
    if (/[0-9]/.test(plus[i])) need -= 1;
    i += 1;
  }
  return { code: known, number: plus.slice(i).replace(/^[\s.-]+/, "") };
}
