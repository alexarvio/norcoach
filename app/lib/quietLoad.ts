// A load onto a new build skips the opening (16 Nov, Alex): FreshBuild sets it, app/admin/layout.tsx reads it.
export const QUIET_COOKIE = "nc_quiet";
// The opening has played in this browser session (16 Nov, Alex: "the admin reloads itself a lot"): a session cookie, so
// a reload, or the browser bringing back a tab it put to sleep, opens quietly; a new browser session plays it again.
export const OPENED_COOKIE = "nc_opened";
