// A coach's Norcode (18 Nov, Alex: "let's have an actual proper code… NC, the minus sign, and then the code… an 8-digit
// that can be numbers and letters, like capital letters. We generate one for each coach, always"): `NC-` and eight
// characters, made for every coach and never typed by them. Clients type it when they sign up to ask to join that coach
// (lib/joinRequests.ts). The letters and digits leave out the ones read as one another (0 and O, 1, I and L), so a code
// read off a screen or said on a call is typed right the first time. Client-safe: no server imports.
export const NORCODE_LENGTH = 8;
export const NORCODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** The eight characters of a made code (what is kept), and nothing else. */
export function isNorcode(code: string): boolean {
  return code.length === NORCODE_LENGTH && [...code].every((c) => NORCODE_ALPHABET.includes(c));
}

/** The code as people read it: NC-AB12CD34. */
export function norcode(code: string): string {
  return `NC-${code}`;
}

/** What was typed or pasted, as its eight characters: upper case, letters and digits only, the NC in front left out
 *  ("nc-ab12 cd34", "NC AB12CD34" and "ab12cd34" are all AB12CD34). No code starts with NC (lib/joinRequests.ts makes
 *  them so), so an NC typed by hand is always the prefix, with or without its minus sign. */
export function typedNorcode(raw: string): string {
  let s = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  while (s.startsWith("NC")) s = s.slice(2);
  return s.slice(0, NORCODE_LENGTH);
}
