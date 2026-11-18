import type { PhaseTrack } from "./db";

// The stock pictures for a phase card, per track: what the coach picks from
// in the phase dialog, and the default for a phase without a cover (always
// the first, 13 Nov). Files live in public/; add one here and it is offered.
// A track with none shows its deep colour.
export const PHASE_COVERS: Record<PhaseTrack, string[]> = {
  nutrition: ["/img/nutrition-head.jpg"],
  // The gym (13 Nov, Alex: the photo on docs/boards/reopen-session-mockup.html; Unsplash, free to use).
  training: ["/img/training-gym.jpg"],
  // Walking on the shore (14 Nov, Alex: number 7 of docs/boards/lifestyle-picture-mockup.html; Unsplash, free to use).
  lifestyle: ["/img/lifestyle-shore.jpg"],
};

// Stock pictures taken out (18 Nov, Alex: only pictures known to be free to use; the kettlebell and the water bottle
// had no source on record). A phase that still names one shows its track's default.
const RETIRED_COVERS = ["/img/session-head.jpg", "/img/lifestyle-bottle.jpg", "/img/lifestyle-head.jpg"];

/** A phase's own cover, or null when it has none or names a picture that was taken out. */
export function liveCover(p: string | null | undefined): string | null {
  return p && !RETIRED_COVERS.includes(p) ? p : null;
}

export const PHASE_OBJECTIVES_MAX = 3;
export const PHASE_OBJECTIVE_CHARS = 80;

export function defaultPhaseCover(track: PhaseTrack, phaseId: number): string | null {
  const list = PHASE_COVERS[track];
  void phaseId;
  return list[0] ?? null;
}

export function isStockCover(p: string): boolean {
  return Object.values(PHASE_COVERS).some((list) => list.includes(p));
}
