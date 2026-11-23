import type { CoachSettings } from "./db";

// A coach's first and last name as they typed them (23 Nov: Settings, Profile, Your details; the sign-up's About you).
// The profile keeps only the display name, "first last", so a first name of two words ("Anne Marie") can't be read back
// from it. The two parts ride along on coach_settings; read back only while they still make the display name (a name
// changed elsewhere since, Public profile, is split at its first space instead).

type WithNames = CoachSettings & { first_name?: string; last_name?: string };

/** The settings with the two names kept on them. */
export function withNames(settings: CoachSettings | undefined, first: string, last: string): CoachSettings {
  return { ...(settings ?? {}), first_name: first, last_name: last } as WithNames;
}

/** First and last as typed, else the display name cut at its first space. */
export function nameParts(settings: CoachSettings | undefined, displayName: string | null | undefined): { first: string; last: string } {
  const shown = (displayName ?? "").trim();
  const s = (settings ?? {}) as WithNames;
  const first = s.first_name?.trim() ?? "";
  const last = s.last_name?.trim() ?? "";
  if (first && `${first} ${last}`.trim() === shown) return { first, last };
  const words = shown.split(/\s+/).filter(Boolean);
  return { first: words[0] ?? "", last: words.slice(1).join(" ") };
}
