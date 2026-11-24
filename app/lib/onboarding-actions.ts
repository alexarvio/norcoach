"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { createPasswordlessUser, findUserByEmail, getSessionUser, isOwner, requireCoach, requireCoachAccount } from "./auth";
import { clerkIdentity, clerkOn } from "./clerk";
import { letCoachIn } from "./coachSignUp";
import { withNames } from "./coachNames";
import { getData, persist, persistNow } from "./db";
import { billingAccess } from "./billing";
import { latestRequestFor, withdrawJoinRequest } from "./joinRequests";
import { deleteUpload, fitPhoto, keyOf, putUpload } from "./storage";
import { saveCoachPhoto } from "./queries";
import { countryOf } from "./countries";
import { COACH_PROFILE_LIMITS as LIMIT } from "./coachProfileView";
import { getCoachProfile, saveCoachProfile } from "./queries";

// The welcome steps a new coach goes through once the owner lets them in
// (/welcome): who they are, their business, then off to add a client. Each
// step saves as it goes, so leaving halfway keeps what was filled in; the
// last one clears the mark that sends them here (users.onboarding).

const clip = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);

/** Step 1: name (required), what they coach, specialties. The photo saves on its own (uploadCoachPhotoAction). */
export async function saveWelcomeAboutAction(input: { name: string; title: string; specialties: string[] }): Promise<{ ok: boolean; error?: string }> {
  const coach = await requireCoach();
  const name = clip(input.name, LIMIT.displayName);
  if (!name) return { ok: false, error: "Add your name to carry on." };
  const specialties = [...new Set((input.specialties ?? []).map((s) => clip(s, 40)).filter(Boolean))].slice(0, LIMIT.specialties);
  const p = getCoachProfile(coach.id);
  // Everything else on the profile stays as it is.
  saveCoachProfile(coach.id, {
    displayName: name,
    title: clip(input.title, LIMIT.title),
    headline: p?.headline ?? "",
    location: p?.location ?? "",
    languages: p?.languages ?? "",
    yearsCoaching: p?.years_coaching ?? null,
    intro: p?.intro ?? "",
    bio: p?.bio ?? "",
    quote: p?.quote ?? "",
    specialties,
    studies: p?.studies ?? [],
    experience: p?.experience ?? [],
    outside: p?.outside ?? "",
    replyNote: p?.reply_note ?? "",
  });
  revalidatePath("/auth/coach-setup");
  return { ok: true };
}

/** A real day, as YYYY-MM-DD, someone of working age could have been born on. */
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

/**
 * About you, the coach sign-up's first step after the email (18 Nov, Alex: docs/boards/coach-flow-mockup.html): first and
 * last name, date of birth, what they coach. Makes the account for someone signed in to Clerk with no account here (in
 * at once, no approval: letCoachIn), or updates the one they made while setup is still under way (Back). The photo
 * comes in the same form and is saved with it, shrunk. While coaches pay, `next` is the subscribe screen, before the rest.
 */
export async function saveCoachAboutAction(form: FormData): Promise<{ ok: boolean; error?: string; next?: string; photo?: "saved" | "failed" }> {
  const first = clip(form.get("first"), 40);
  const last = clip(form.get("last"), 40);
  if (!first || !last) return { ok: false, error: "Add your first and last name." };
  const birthdate = birthdateOf(form.get("birthdate"));
  if (!birthdate) return { ok: false, error: "Check your date of birth." };
  const name = `${first} ${last}`.slice(0, LIMIT.displayName);
  const title = clip(form.get("title"), LIMIT.title);

  let coachId: number;
  const me = await getSessionUser();
  if (me) {
    // A coach still setting up (Back to About you); after that their profile is edited in Settings.
    const coach = await requireCoachAccount();
    if (!getData().users.find((u) => u.id === coach.id)?.onboarding) return { ok: false, error: "Change this in Settings, Profile." };
    coachId = coach.id;
  } else {
    if (!clerkOn()) return { ok: false, error: "Sign in again to carry on." };
    const who = await clerkIdentity();
    const email = who?.emails[0];
    if (!who || !email) return { ok: false, error: "Sign in again to carry on." };
    if (findUserByEmail(email)) return { ok: false, error: "This email has an account already. Sign in with it instead." };
    // Asking a coach to join them before: that request goes, as they are a coach themselves now.
    if (latestRequestFor(who.userId)?.status === "open") withdrawJoinRequest(who.userId);
    coachId = createPasswordlessUser(email, "coach", null, { name, business: null }).id;
    letCoachIn(coachId);
    (await cookies()).delete("ironline_intent");
  }
  const p = getCoachProfile(coachId);
  saveCoachProfile(coachId, {
    displayName: name,
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
  const user = getData().users.find((u) => u.id === coachId && u.role === "coach");
  if (user) {
    // The two names as typed, so Settings, Profile reads a first name of two words back whole (coachNames.ts).
    user.coach_settings = { ...withNames(user.coach_settings, first, last), birthdate };
    persist();
  }
  // The photo clients see (shrunk in the browser already; fitted again here, as every coach picture is).
  let photo: "saved" | "failed" | undefined;
  const file = form.get("photo");
  if (file instanceof File && file.size > 0) {
    try {
      if (file.size > 6 * 1024 * 1024 || !file.type.startsWith("image/")) throw new Error("not a photo");
      const original = Buffer.from(await file.arrayBuffer());
      const fitted = await fitPhoto(original);
      const body = fitted?.bytes ?? original;
      const type = fitted?.type ?? file.type;
      const previous = getCoachProfile(coachId)?.avatar_path ?? null;
      const saved = saveCoachPhoto(coachId, "avatar", body, type);
      if (previous && keyOf(previous) !== keyOf(saved)) await deleteUpload(previous);
      await putUpload(saved, body, type);
      photo = "saved";
    } catch (error) {
      console.error("[coach setup] photo not saved:", error instanceof Error ? error.message : error);
      photo = "failed";
    }
  }
  await persistNow().catch(() => {});
  // While coaches pay: the subscribe screen before Your business (the rest of setup waits on it, /auth/coach-setup).
  const owner = isOwner({ role: "coach", email: user?.email ?? "" });
  const next = billingAccess(coachId, owner).state === "subscribe" ? "/auth/subscribe" : undefined;
  return { ok: true, next, photo };
}

/** Step 2: business name, country (sets currency and tax on invoices), time zone (new meetings start in it). */
export async function saveWelcomeBusinessAction(input: { business: string; countryCode: string; timezone: string }): Promise<{ ok: boolean }> {
  const coach = await requireCoach();
  const user = getData().users.find((u) => u.id === coach.id && u.role === "coach");
  if (!user) return { ok: false };
  const code = countryOf(input.countryCode).code;
  const business = { ...(user.coach_settings?.business ?? {}) };
  const name = clip(input.business, 120);
  if (name) business.business_name = name;
  if (code) business.country_code = code;
  let timezone = clip(input.timezone, 64);
  try {
    if (timezone) new Intl.DateTimeFormat("en-GB", { timeZone: timezone });
  } catch {
    timezone = "";
  }
  user.coach_settings = { ...(user.coach_settings ?? {}), business, ...(timezone ? { timezone } : {}) };
  persist();
  return { ok: true };
}

/** Done: off to add the first client, a short tour of the coach side, or just to look around. */
export async function finishWelcomeAction(next: "client" | "tour" | "look") {
  const coach = await requireCoach();
  const user = getData().users.find((u) => u.id === coach.id);
  if (user?.onboarding) {
    delete user.onboarding;
    persist();
  }
  redirect(next === "client" ? "/clients?add=1" : next === "tour" ? "/clients?tour=1" : "/clients");
}
