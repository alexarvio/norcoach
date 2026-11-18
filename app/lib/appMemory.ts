// What the client app keeps on the phone of where it was (AppShell): the bottom tab ("{client}:{tab}", in
// sessionStorage and a cookie the server reads, lib/tabMemory.ts) and the screen on top with when the app left it
// (17 Nov, opened on again within ten minutes). Small on purpose, so the sign-in page can clear it without loading the app.
export const RESUME_KEY = "ironline.client.resume";
export const TAB_KEY = "ironline.client.tab";
export const TAB_COOKIE = "ironline_tab";

/** Signing in always lands on Home (18 Nov, Alex: signed out from Settings, in again with a password, "it jumped straight
 *  into settings… The app should always land on home when logging in"): every way out ends on the sign-in page, which
 *  forgets where the app was. Coming back to the app without signing out still opens where it was. */
export function forgetWhereTheAppWas() {
  try {
    window.localStorage.removeItem(RESUME_KEY);
  } catch {}
  try {
    window.sessionStorage.removeItem(TAB_KEY);
  } catch {}
  document.cookie = `${TAB_COOKIE}=; path=/; max-age=0; samesite=lax`;
}
