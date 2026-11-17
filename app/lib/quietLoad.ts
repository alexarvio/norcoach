// A load onto a new build skips the opening (16 Nov, Alex): FreshBuild sets it, app/admin/layout.tsx reads it.
export const QUIET_COOKIE = "nc_quiet";
// The opening has played in this browser session (16 Nov, Alex: "the admin reloads itself a lot"): a session cookie, so
// a reload, or the browser bringing back a tab it put to sleep, opens quietly; a new browser session plays it again.
export const OPENED_COOKIE = "nc_opened";
// The phone app says it is the phone app (17 Nov, Alex: a coach signing in there saw the admin for a moment before the
// coach app): set before anything draws by the root layout's first script, so the server sends a coach straight to /coach.
export const NATIVE_COOKIE = "nc_native";
export const NATIVE_SCRIPT = `try{var c=window.Capacitor;if(window.self===window.top&&((c&&c.isNativePlatform&&c.isNativePlatform())||document.documentElement.classList.contains("native-app")))document.cookie="${"nc_native"}=1; path=/; max-age=31536000; samesite=lax"}catch(e){}`;
