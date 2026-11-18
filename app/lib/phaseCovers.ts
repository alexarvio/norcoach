import type { PhaseTrack } from "./db";

// The stock pictures for a phase card, per track: what the coach picks from
// in the phase dialog, and the default for a phase without a cover (always
// the first, 13 Nov). Files live in public/; add one here, with its source, and it is offered.
// A track with none shows its deep colour. While the client has no pictures of their own and the coach chose none, a
// track's stock pictures take turns on its Home card and behind its banner (18 Nov, Alex; PictureCycle).
export const PHASE_COVERS: Record<PhaseTrack, string[]> = {
  // Five, taking turns (18 Nov, Alex: "these 5 are going to be in rotation"; Unsplash, free to use):
  // unsplash.com/photos/variety-of-cooked-foods-NOAzwcMzZJA, /vegetable-dish-in-white-ceramic-bowl-Ww8eQWjMJWk,
  // /four-clear-plastic-bowls-with-vegetables-CJdZ800-Fbs, /meal-prep-containers-with-healthy-food-lMcRyBx4G50,
  // /cooked-food-on-tray-sosOqjx31Go.
  nutrition: ["/img/nutrition-spread.jpg", "/img/nutrition-bowl.jpg", "/img/nutrition-bowls.jpg", "/img/nutrition-prep.jpg", "/img/nutrition-tray.jpg"],
  // The gym (13 Nov, Alex: the photo on docs/boards/reopen-session-mockup.html; Unsplash, free to use).
  training: ["/img/training-gym.jpg"],
  // Walking on the shore (14 Nov, Alex: number 7 of docs/boards/lifestyle-picture-mockup.html; Unsplash, free to use).
  lifestyle: ["/img/lifestyle-shore.jpg"],
};

// Stock pictures taken out (18 Nov, Alex: only pictures known to be free to use; the kettlebell, the water bottle and
// the food photo had no source on record). A phase that still names one shows its track's default.
const RETIRED_COVERS = ["/img/session-head.jpg", "/img/lifestyle-bottle.jpg", "/img/lifestyle-head.jpg", "/img/nutrition-head.jpg"];

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
