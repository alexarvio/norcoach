import "server-only";
import { allocId, getData, persist } from "./db";
import { ownerEmail } from "./auth";
import { isReviewEmail } from "./reviewAccount";
import { countryOf } from "./countries";
import { getCoachProfile } from "./queries";
import type { Application } from "./mail";

// The staff admin's Sign-ups (26 Nov, Alex; the staff spec, screen 5): coach accounts waiting for a yes (`pending` on
// their users row, lib/coachSignUp.ts), and what the website's Apply form sent (app/api/apply/route.ts), kept in kv
// `coach_applications`. Nothing here about a coach's clients.

/** One application from the website's Apply form (app/api/apply/route.ts), kept in kv `coach_applications`. */
export type CoachApplication = Application & { id: number; receivedAt: string };

/** A coach account waiting for a yes, as Sign-ups lists it. */
export type WaitingCoach = {
  id: number;
  name: string;
  email: string;
  business: string | null;
  /** The country's name, when they gave one. */
  country: string | null;
  /** Their profile picture ("/uploads/coaches/<id>/…"), when they added one. */
  photo: string | null;
  /** When they signed up (the pending mark's day, else the account's). */
  signedUpAt: string;
};

const waitingRows = () => {
  const owner = ownerEmail();
  return getData().users.filter((u) => u.role === "coach" && !!u.pending && u.email !== owner && !isReviewEmail(u.email));
};

/** Coach accounts that signed up and wait for a yes (`pending` on their users row): never the owner or the App Store
 *  review account. The rail's Sign-ups count. */
export function pendingCoachSignupsCount(): number {
  return waitingRows().length;
}

/** The coaches waiting for a yes, the newest first. */
export function listWaitingCoaches(): WaitingCoach[] {
  return waitingRows()
    .map((u) => {
      const profile = getCoachProfile(u.id);
      const biz = u.coach_settings?.business;
      const code = biz?.country_code ?? null;
      return {
        id: u.id,
        name: profile?.display_name?.trim() || u.pending?.name?.trim() || u.email,
        email: u.email,
        business: biz?.business_name?.trim() || u.pending?.business?.trim() || null,
        country: code ? countryOf(code).name : null,
        photo: profile?.avatar_path ?? null,
        signedUpAt: u.pending?.at ?? u.created_at ?? new Date().toISOString(),
      };
    })
    .sort((a, b) => b.signedUpAt.localeCompare(a.signedUpAt));
}

const MAX_APPLICATIONS = 2000;

/** Keeps one application from the website (before it is emailed, so none is lost when mail isn't set up). */
export function addCoachApplication(a: Application): CoachApplication {
  const data = getData();
  if (!Array.isArray(data.coach_applications)) data.coach_applications = [];
  const row: CoachApplication = { ...a, id: allocId("coach_applications"), receivedAt: new Date().toISOString() };
  data.coach_applications.push(row);
  // The oldest go past a ceiling, so a flood never grows the store without end.
  if (data.coach_applications.length > MAX_APPLICATIONS) data.coach_applications.splice(0, data.coach_applications.length - MAX_APPLICATIONS);
  persist();
  return row;
}

/** Every application kept, the newest first. */
export function listCoachApplications(): CoachApplication[] {
  const list = getData().coach_applications;
  return Array.isArray(list) ? [...list].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt) || b.id - a.id) : [];
}
