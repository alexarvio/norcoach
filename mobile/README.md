# Norcoach mobile shell

The iPhone and Android app, built with Capacitor 8. It is a native wrapper that
loads the live site (`server.url` in `capacitor.config.json`), so every push to
Railway shows up in the app. Only native changes (new plugins, permissions,
icon, the site address) need a new store build.

- App id: `com.arvio.norcoach` on iPhone (11 Nov, Alex), permanent from its first
  TestFlight upload, and on Android too (`applicationId`), with its own Firebase
  Android app under that package for push (below).
- iPhone builds: GitHub > Actions > iOS to TestFlight (.github/workflows/ios-testflight.yml).
- Site: the Railway address for now. Switch it to the own domain before the
  first store upload, because changing it later needs an app update.
- `www/index.html` is only the "No connection" screen.
- `server.allowNavigation` holds every address the app opens inside itself. The site's own
  host must be in it: Capacitor counts a page as the app's only when it starts with the whole
  `server.url`, `/client` included, so the redirect to `/login` went to Safari (11 Nov, builds 3
  and 4). Also
  Clerk's `clerk.norcoachapp.com`, whose session check is a page hop (11 Nov: without it the
  first launch fell to the No connection screen and the hop opened in Safari). Any other
  address opens in Safari.
- The page starts below the clock strip (`StatusBar.overlaysWebView: false`, the strip the top bar's
  `#FAFAFA`), as the home-screen web app does; the site's top bar is built for that (11 Nov).
- Icon and splash come from `assets/`. Replace `assets/icon-only.png`
  (1024×1024) and `assets/splash.png` (2732×2732) with the real logo, then run
  `npm run icons`.

## Commands (need Node 22; the Next app is fine on 20)

```
npm install
npx cap sync        # after changing the config or adding a plugin
npx cap open android
```

## Building

- **Android:** Android Studio on Windows. Open with `npx cap open android`,
  then Run on an emulator or a phone with USB debugging.
- **iOS:** needs a Mac with Xcode, or a cloud Mac build (Codemagic, or GitHub
  Actions macOS runners). Signing needs the Apple Developer account for
  Arvio Enterprises LLC.

## Push notifications

- iPhone (12 Nov): Apple's own push (APNs), no Firebase. `AppDelegate.swift` hands
  the phone's token to the push plugin, the page posts it to `/api/push` as kind
  `apns` (`app/client/NativePush.tsx`), and `app/lib/apns.ts` sends to it. Needs
  `aps-environment` in `App.entitlements` (the TestFlight workflow signs it as
  production), the Push Notifications capability on the App ID, and on Railway
  `APNS_KEY` (the .p8 text), `APNS_KEY_ID`, `APNS_TEAM_ID`. Without them the
  Settings switch says `Not available`.
- Android: Firebase (FCM). The push plugin's own service receives them; the page
  makes the `ironline` channel (`Coach updates`), asks Android 13+ for permission and
  posts the token to `/api/push` as kind `fcm` (`app/client/NativePush.tsx`), and
  `app/lib/fcm.ts` sends to it. Two keys, from one Firebase project:
  - `GOOGLE_SERVICES_JSON` (GitHub secret, the whole `google-services.json`, which
    must list a `com.arvio.norcoach` app) for the build. The Play workflow stops
    without it, or when it lists no such app: a build without Firebase crashes the
    moment the push switch is tapped ("Default FirebaseApp is not initialized").
    Locally the same file goes in `android/app/google-services.json`, which git
    ignores; the gradle plugin is applied only when it is there.
  - `FCM_SERVICE_ACCOUNT` (Railway, the service account's JSON or base64 of it)
    for sending. Set it only once a build with Firebase is the one testers have:
    until then the switch says `Not available`, and an older build without
    Firebase would crash when it is tapped. Read once per process, so Railway
    restarts the app after setting it.
  - The two from different projects fail every send with `SENDER_ID_MISMATCH`
    (`[fcm] send failed` in the logs).
- The status-bar icon is the star in white (`res/drawable/ic_stat_norcoach.xml`),
  its accent ink (`notification_accent`), set in `AndroidManifest.xml`.

## Still to do before the stores

- Apple Health and Health Connect for steps.
- Sign-in once Clerk goes live: Google blocks sign-in inside app webviews, so
  use Clerk's native flow or the system browser. Apple also requires
  Sign in with Apple when Google is offered.
