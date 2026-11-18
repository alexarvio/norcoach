// The invite link opens the iPhone app (13 Nov, Alex: "make the invite link open the app"). Apple reads this file
// from the site the link points at to learn which app may open which paths: the Norcoach app opens /invite, every
// other address stays in the browser. The app carries the matching Associated Domains entitlement
// (mobile/ios/App/App/App.entitlements) and NativeLinks takes the tapped link to its page inside the app.
// Passwords too (18 Nov, Alex: signing in with a password in the app, "it didn't offer to save"): webcredentials names
// the app as this site's, so the iPhone offers to save the password in its Passwords and fills it with Face ID after,
// as Safari does; the app carries webcredentials:app.norcoachapp.com beside applinks.
// The team id is the APNs one (or APPLE_TEAM_ID); without it there is nothing to claim, and Apple sees no apps.

const BUNDLE = process.env.APNS_BUNDLE_ID?.trim() || "com.arvio.norcoach";

export function GET() {
  const team = (process.env.APNS_TEAM_ID || process.env.APPLE_TEAM_ID)?.trim();
  const app = team ? `${team}.${BUNDLE}` : null;
  const body = {
    applinks: {
      details: app ? [{ appIDs: [app], components: [{ "/": "/invite", comment: "A coach's invite" }, { "/": "/invite/*" }] }] : [],
    },
    webcredentials: { apps: app ? [app] : [] },
  };
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" },
  });
}
