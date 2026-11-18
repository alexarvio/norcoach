import { callNative, nativePlatform } from "./native";

// The iPhone's own "Save password?" in the app (18 Nov, Alex: "it did not offer to save"). Inside the app's web view the
// phone fills a saved password (webcredentials, apple-app-site-association) but doesn't offer to save a new one, so the
// page asks the app to (NorcoachAuth.savePassword, mobile/ios/App/App/SceneDelegate.swift) once a password has gone
// through: a sign-in with one, a coach's new account, a reset, a password set in Settings. Then Face ID fills it after.
//
// A sign-in asks once an email on this phone, saved or Not Now alike, so a password the phone filled is never offered
// back; a password just made (sign-up, reset, Settings) is always offered, being new. Only the email is kept here, never
// the password. An app from before this has no savePassword, and Capacitor would never answer a call to it, so it is
// looked for first (the plugin's own list of methods) and nothing is asked.

const KEY = "nc.pw.offered";
const WAIT_MS = 60_000;

function offered(): string[] {
  try {
    const v = JSON.parse(window.localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Whether this build of the app has the save (an older one lists NorcoachAuth without it). */
function canSave(): boolean {
  const cap = (window as { Capacitor?: { PluginHeaders?: { name: string; methods?: { name: string }[] }[] } }).Capacitor;
  return !!cap?.PluginHeaders?.some((h) => h.name === "NorcoachAuth" && h.methods?.some((m) => m.name === "savePassword"));
}

/** Offers the phone's save for this login, and waits for the answer (a minute at most), so the page moves on after it. */
export async function offerToSavePassword(email: string, password: string, { always = false }: { always?: boolean } = {}): Promise<void> {
  if (nativePlatform() !== "ios" || !email || !password || !canSave()) return;
  const who = email.trim().toLowerCase();
  if (!always && offered().includes(who)) return;
  try {
    const answered = await Promise.race([
      callNative("NorcoachAuth", "savePassword", { email: email.trim(), password }).then(() => true),
      new Promise<false>((done) => setTimeout(() => done(false), WAIT_MS)),
    ]);
    // Marked only once the phone has answered (saved or Not Now), never on the minute running out.
    if (!answered) return;
    try {
      window.localStorage.setItem(KEY, JSON.stringify([who, ...offered().filter((x) => x !== who)].slice(0, 5)));
    } catch {}
  } catch {
    // The app can't (an older build, or the phone said no): nothing to say.
  }
}
