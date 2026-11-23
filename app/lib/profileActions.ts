"use server";

import { revalidatePath } from "next/cache";
import { isOwner, requireCoach } from "./auth";
import { getData, persist } from "./db";
import { COACH_PROFILE_LIMITS as LIMIT } from "./coachProfileView";
import { withNames } from "./coachNames";
import { getCoachProfile, getCoachProfileView, saveCoachProfile } from "./queries";

// Settings, Profile, Your details (23 Nov, Alex: A of docs/boards/settings-profile-mockup.html): About you, the first and
// last name, the date of birth and what they coach, as the sign-up's About you asks them (saveCoachAboutAction). The
// phone and the address stay saveCoachContactAction's. On Settings' one bar.

const clip = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);

/** Whose details: the coach's own, or for the owner any coach's (as saveCoachContactAction reads it). */
async function profileCoachId(form: FormData): Promise<number> {
  const coach = await requireCoach();
  const asked = Number(form.get("coachId"));
  if (isOwner(coach) && Number.isInteger(asked) && asked > 0 && asked !== coach.id && getCoachProfileView(asked)) return asked;
  return coach.id;
}

/** A real day, as YYYY-MM-DD, someone of working age could have been born on (onboarding-actions.ts's birthdateOf). */
function birthdateOf(raw: unknown): string | null {
  const v = String(raw ?? "").trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  const now = new Date();
  const youngest = new Date(Date.UTC(now.getFullYear() - 14, now.getMonth(), now.getDate()));
  return y >= now.getFullYear() - 100 && date.getTime() <= youngest.getTime() ? v : null;
}

/** The date of birth (a real one, or none given) and what they coach; the first and last name (both needed) only when
 *  the form carries them, which it does once either was changed, so a name kept from before (one word, from Public
 *  profile) never blocks the rest. The display name is the two names, never cut short: a name over its limit is refused.
 *  Everything else on the profile stays as it was. */
export async function saveCoachAboutDetailsAction(form: FormData): Promise<{ ok: boolean; error?: string }> {
  const coachId = await profileCoachId(form);
  const user = getData().users.find((u) => u.id === coachId && u.role === "coach");
  if (!user) return { ok: false, error: "Not saved. Try again." };
  const p = getCoachProfile(coachId);
  const naming = form.has("first") || form.has("last");
  const first = String(form.get("first") ?? "").trim().replace(/\s+/g, " ");
  const last = String(form.get("last") ?? "").trim().replace(/\s+/g, " ");
  if (naming && (!first || !last)) return { ok: false, error: "Add your first and last name." };
  const displayName = naming ? `${first} ${last}` : (p?.display_name ?? "");
  if (displayName.length > LIMIT.displayName) return { ok: false, error: `Your name is over ${LIMIT.displayName} characters.` };
  const rawBirth = clip(form.get("birthdate"), 10);
  const birthdate = rawBirth ? birthdateOf(rawBirth) : null;
  if (rawBirth && !birthdate) return { ok: false, error: "Check your date of birth." };
  const title = clip(form.get("title"), LIMIT.title);

  saveCoachProfile(coachId, {
    displayName,
    title,
    headline: p?.headline ?? "",
    location: p?.location ?? "",
    languages: p?.languages ?? "",
    yearsCoaching: p?.years_coaching ?? null,
    intro: p?.intro ?? "",
    bio: p?.bio ?? "",
    quote: p?.quote ?? "",
    specialties: p?.specialties ?? [],
    studies: p?.studies ?? [],
    experience: p?.experience ?? [],
    outside: p?.outside ?? "",
    replyNote: p?.reply_note ?? "",
  });
  // The two names as typed, so a first name of two words comes back as one (coachNames.ts).
  const settings = naming ? withNames(user.coach_settings, first, last) : { ...(user.coach_settings ?? {}) };
  if (birthdate) settings.birthdate = birthdate;
  else delete settings.birthdate;
  user.coach_settings = settings;
  persist();
  // The settings page, and the rail and chats that show the name.
  revalidatePath("/admin/redesign", "layout");
  revalidatePath("/client");
  return { ok: true };
}
