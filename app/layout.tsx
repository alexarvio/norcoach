import type { Metadata, Viewport } from "next";
import { NATIVE_SCRIPT } from "./lib/quietLoad";
import localFont from "next/font/local";
import "./globals.css";
import { applyDueProgramDeploymentsSometimes } from "./lib/dueJobs";
import { startTiming } from "./lib/timing";
import { ClerkProvider } from "@clerk/nextjs";
import { clerkOn } from "./lib/clerk";
import SlidePills from "./components/SlidePills";
import FreshBuild from "./components/FreshBuild";
import ZoomCalm from "./components/ZoomCalm";
import NativeLinks from "./components/NativeLinks";
import NativeBack from "./components/NativeBack";
import { buildId } from "./lib/buildId";
import { getSessionUser } from "./lib/auth";
import { bannerInline, bannerPathFor, brandFor, brandMarkInline, markFor, markInline } from "./lib/brandMark";
import { brandColour, brandVars } from "./lib/brandColour";
import { headers } from "next/headers";
import { hostOf, isStaffHost } from "./lib/staffHost";

export const metadata: Metadata = {
  title: "NORCOACH", // the tab's name in capitals, as the wordmark (24 Oct, Alex)
  description: "Coach + client core loop prototype",
  // "Add to Home Screen" support: the manifest (app/manifest.ts) carries the
  // name, icons and standalone display for Android/Chrome; iOS ignores most
  // of the manifest and reads these apple-specific tags instead.
  manifest: "/manifest.webmanifest",
  // The browser tab's icon: the star alone, no square behind it (18 Nov, Alex: as the website's tab). The home-screen
  // icons keep their paper (public/icon.png, app/apple-icon.png).
  icons: { icon: [{ url: "/brand/mark.svg", type: "image/svg+xml" }], apple: [{ url: "/apple-icon.png", sizes: "180x180" }] },
  appleWebApp: {
    capable: true,
    title: "NORCOACH", // the name under the home-screen icon, in capitals (24 Oct, Alex)
    statusBarStyle: "default",
  },
};

// The client Nutrition tab's serif is Baskerville, built into iPhones. This
// self-hosted Libre Baskerville stands in wherever it is missing; the tab's
// CSS names it through this variable.
// The three Google fonts live in app/fonts (5 Oct): the build used to fetch
// them from Google, and when Railway's builder could not reach Google the
// whole build failed. Latin only, as before; Archivo and Libre Baskerville
// are variable files that hold every weight.
const libreBaskerville = localFont({
  src: [
    { path: "./fonts/LibreBaskerville-Latin.woff2", weight: "400 700", style: "normal" },
    { path: "./fonts/LibreBaskerville-Italic-Latin.woff2", weight: "400 700", style: "italic" },
  ],
  variable: "--font-libre-baskerville",
  display: "swap",
});
// Archivo: the client Nutrition tab's type. Regular text, Medium figures,
// SemiBold headings and names.
const archivo = localFont({
  src: "./fonts/Archivo-Latin.woff2",
  weight: "400 800",
  variable: "--font-archivo",
  display: "swap",
});
// Bricolage Grotesque: only the date number on Home's meeting card.
const bricolage = localFont({
  src: "./fonts/BricolageGrotesque-800-Latin.woff2",
  weight: "800",
  variable: "--font-bricolage",
  display: "swap",
});
// Kirana: the "Norcoach" wordmark at the top left of the client app.
const kirana = localFont({
  src: "./fonts/Kirana-Regular.ttf",
  variable: "--font-brand",
  display: "swap",
});

export const viewport: Viewport = {
  themeColor: "#1E3A5F",
  width: "device-width",
  initialScale: 1,
  // The client app is a phone UI with its own type sizes; pinch-zoom stays
  // enabled (maximumScale unset) for accessibility.
  viewportFit: "cover",
};

/** The faint mark behind every screen (28 Oct, Alex; lib/brandMark.ts): the signed-in coach's logo, or their coach's
 *  for a client; none (or no one signed in), the star the CSS falls back to. With it the coach's brand (19 Nov, Alex:
 *  docs/boards/coach-brand-mockup.html, option C): `--brand`, their colour on the main pills, and the
 *  faint mark in it. Each only when set, so with none every screen is as it was. The banner travels in the props
 *  (BrandLogo); it is only read into memory here, so it is never its address on a screen. */
async function bodyBrand(): Promise<React.CSSProperties | undefined> {
  try {
    // The staff admin (admin.norcoachapp.com, 26 Nov) is Norcoach's own: never a coach's colour or logo, whoever signs in.
    if (isStaffHost(hostOf(await headers()))) return undefined;
    const user = await getSessionUser();
    const style: Record<string, string> = {};
    const mark = markFor(user);
    // Inside the page, so it is there at once on every open (13 Nov, Alex); its address while that can't be made.
    if (mark) style["--bg-mark"] = `url("${(await markInline(mark)) ?? mark}")`;
    // Read into the page before it is drawn, so the banner never comes in a moment late.
    const bannerPath = bannerPathFor(user);
    if (bannerPath) await bannerInline(bannerPath);
    const brand = brandFor(user);
    // The colour and, on a bright one, its dark words (brandVars, lib/brandColour.ts).
    if (brand.color) Object.assign(style, brandVars(brand.color));
    // The faint mark in that colour (Home, the client's chat, the admin's page); with ink, the mark as it is.
    if (brand.color && brand.color !== "#141a24") {
      const tint = await brandMarkInline(mark, brandColour(brand.color)?.text ?? brand.color);
      if (tint) style["--brand-mark"] = `url("${tint}")`;
    }
    return Object.keys(style).length ? (style as React.CSSProperties) : undefined;
  } catch {
    return undefined;
  }
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // A plan the coach scheduled for e.g. Monday 6am goes live the moment anyone next loads any page after that time,
  // checked here since every route passes through this layout. Timed as "layout" (23 Oct, Alex: the admin felt slow).
  // The check-in reminders that rode here too run on a timer since 17 Nov (instrumentation.ts, mission 2).
  const timer = startTiming("layout");
  // At most once a minute (dueJobs.ts): it took ~220 ms on every page (23 Oct).
  timer.time("applyDueProgramDeployments", () => applyDueProgramDeploymentsSometimes());
  timer.end(null);

  // The palette is the design's (the tokens at the top of globals.css). A coach changes one thing in it (19 Nov, Alex):
  // their brand colour, `--brand`, which fills the main pills and nothing else, with today's ink when they have none.
  // `has-coach-logo` when the coach has a logo of their own (never `coach-mark`: that is the coach face badge's class, and on the body it drew the page as one round navy disc, 22 Nov): it is drawn whole where the star is cropped (21 Nov, Alex).
  // suppressHydrationWarning on <html>: the admin marks it data-mouse before React draws (app/admin/layout.tsx).
  const brandStyle = await bodyBrand();
  return (
    <html lang="en" suppressHydrationWarning className={`${libreBaskerville.variable} ${archivo.variable} ${kirana.variable} ${bricolage.variable}`}>
      {/* Sign-in through Clerk, when it is switched on (lib/clerk.ts). */}
      <body style={brandStyle} className={brandStyle && "--bg-mark" in brandStyle ? "has-coach-logo" : undefined}>
        {/* The phone app marks itself before anything draws (17 Nov): the server then sends a coach to /coach. */}
        <script dangerouslySetInnerHTML={{ __html: NATIVE_SCRIPT }} />
        {clerkOn() ? <ClerkProvider signInUrl="/login" signUpUrl="/signup" signInFallbackRedirectUrl="/auth/continue" signUpFallbackRedirectUrl="/auth/continue" afterSignOutUrl="/login">{children}</ClerkProvider> : children}
        {/* Every capsule's pill slides (28 Oct, Alex). */}
        <SlidePills />
        {/* A page left open across a deploy reloads onto the new build (30 Oct). */}
        <FreshBuild build={buildId()} />
        <ZoomCalm />
        {/* A tapped invite link opens in the iPhone app, on its page (13 Nov, Alex). */}
        <NativeLinks />
        {/* Android's back: the pop-up, the pushed screen, Home, then out of the app (28 Nov, Alex). */}
        <NativeBack />
      </body>
    </html>
  );
}
