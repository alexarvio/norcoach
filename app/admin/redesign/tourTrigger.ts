// The tour's one way in from anywhere in the admin (25 Nov, Alex: docs/boards/coach-onboarding-mockup.html): help's Take
// the tour says it on the window, and OnboardingTour (mounted once by the admin's layout) hears it and starts. Apart from
// OnboardingTour.tsx so the help panel never imports the tour (and the rail frame) itself.

export const TOUR_EVENT = "norcoach:tour";

/** Starts the tour from its first step. */
export function startTour() {
  window.dispatchEvent(new CustomEvent(TOUR_EVENT));
}
