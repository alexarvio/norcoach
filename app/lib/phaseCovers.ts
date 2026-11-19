import type { PhaseTrack } from "./db";

// The stock pictures for a phase card, per track: what the coach picks from
// in the phase dialog, and the default for a phase without a cover (always
// the first, 13 Nov). Files live in public/; add one here, with its source, and it is offered.
// A track with none shows its deep colour. While the client has no pictures of their own and the coach chose none, a
// track's stock pictures take turns on its Home card and behind its banner (18 Nov, Alex; PictureCycle). A coach's own
// card pictures take their place for that coach's clients (19 Nov, Alex; trackPictures, lib/coachCards.ts).
export const PHASE_COVERS: Record<PhaseTrack, string[]> = {
  // Five, taking turns (18 Nov, Alex: "these 5 are going to be in rotation"; Unsplash, free to use):
  // unsplash.com/photos/variety-of-cooked-foods-NOAzwcMzZJA, /vegetable-dish-in-white-ceramic-bowl-Ww8eQWjMJWk,
  // /four-clear-plastic-bowls-with-vegetables-CJdZ800-Fbs, /meal-prep-containers-with-healthy-food-lMcRyBx4G50,
  // /cooked-food-on-tray-sosOqjx31Go.
  nutrition: ["/img/nutrition-spread.jpg", "/img/nutrition-bowl.jpg", "/img/nutrition-bowls.jpg", "/img/nutrition-prep.jpg", "/img/nutrition-tray.jpg"],
  // Five, taking turns (18 Nov, Alex: 1, 2, 3, 8 and 7 of docs/boards/track-pictures-mockup.html; Unsplash, free to
  // use). The gym first (13 Nov, the photo on docs/boards/reopen-session-mockup.html), then images.unsplash.com/
  // photo-1689877020200-403d8542d95d, photo-1757924284732-4189190321cf, photo-1593079831268-3381b0db4a77 and
  // photo-1761971976282-b2bb051a5474.
  training: ["/img/training-gym.jpg", "/img/training-machines.jpg", "/img/training-windows.jpg", "/img/training-floor.jpg", "/img/training-bikes.jpg"],
  // Walking on the shore (14 Nov, Alex: number 7 of docs/boards/lifestyle-picture-mockup.html; Unsplash, free to use).
  // With four more since 18 Nov (Alex: 1, 4, 5, 11 and 13 of the same board; Unsplash, free to use):
  // images.unsplash.com/photo-1699890968439-a5141afaeb29, photo-1604502130010-22a9eb4c77a8,
  // photo-1552650272-b8a34e21bc4b and photo-1493224533326-630c89563300.
  lifestyle: ["/img/lifestyle-shore.jpg", "/img/lifestyle-path.jpg", "/img/lifestyle-field.jpg", "/img/lifestyle-stretch.jpg", "/img/lifestyle-morning.jpg"],
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

/** Pictures by track: a coach's own card pictures (lib/coachCards.ts), a client's. */
export type TrackPictures = Partial<Record<PhaseTrack, string[]>>;

/** What a track shows where no one chose a picture (19 Nov, Alex: "do up to 5 per track"): the coach's own card
 *  pictures, taking turns; only with none set for that track, Norcoach's stock ones. */
export function trackPictures(track: PhaseTrack, coachCards?: TrackPictures | null): string[] {
  const theirs = coachCards?.[track];
  return theirs?.length ? theirs : PHASE_COVERS[track];
}

export function isStockCover(p: string): boolean {
  return Object.values(PHASE_COVERS).some((list) => list.includes(p));
}
