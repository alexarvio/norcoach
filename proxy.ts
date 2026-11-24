import { NextResponse } from "next/server";
import type { NextFetchEvent, NextRequest } from "next/server";
import { clerkMiddleware } from "@clerk/nextjs/server";
import { oldAdminAddress } from "./app/admin/redesign/paths";

// Next 16 renamed `middleware.ts` to `proxy.ts` — same mechanism, new name.
//
// This is an OPTIMISTIC check only: it looks for the presence of a session
// cookie and nothing more. It does not verify the signature and it does not
// know the user's role, because proxy runs on every request (including
// prefetches) and must not touch the data layer.
//
// Real enforcement lives in requireCoach() / requireClient() in lib/auth.ts,
// called by every protected page and every server action. If this file were
// deleted the app would still be secure — it would just show a flash of a
// protected route before redirecting. Never move an authorization decision
// up here.

// The privacy policy and support page are public: the App Store links to them.
// /signup, /invite, /sso-callback and /auth/* are Clerk's way in (26 Sep).
// /api/dev: local-only tools that refuse to run on a server (and are never deployed).
// /api/apply: the website's Apply form, posted by visitors with no account (28 Oct).
// /api/version: the build the server runs, so a page left open across a deploy reloads (FreshBuild, 30 Oct).
// /uploads authorizes every file itself (canAccessClient); it passes through
// here so Clerk's middleware has run and auth() works in it (30 Sep: photos
// and videos failed to load for a Clerk sign-in while it was left out).
// /invoice/<id>/pay and /paid (23 Nov): an invoice email's Pay and Stripe's return, for a client who may not be signed
// in; each route checks the email's signed link for that one invoice, or the signed-in client, itself.
const PUBLIC_PATHS = ["/login", "/privacy", "/support", "/signup", "/join", "/invite", "/sso-callback", "/auth", "/api/dev", "/api/apply", "/api/version", "/uploads", "/invoice"];

// With sign-in through Clerk (lib/clerk.ts: AUTH_PROVIDER=clerk), Clerk's
// middleware runs instead: it reads the session so auth() works on the
// server, and sends a signed-out visitor to /login. Our guards still decide
// everything else, as before.
const clerkOn = process.env.AUTH_PROVIDER === "clerk" && !!process.env.CLERK_SECRET_KEY && !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
const isPublic = (pathname: string) => PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
// Built only when on, so the live app without Clerk keys never loads it.
// Our own sign-in and sign-up pages, never Clerk's hosted ones.
const withClerk = !clerkOn ? null : clerkMiddleware(async (auth, request) => {
  if (isPublic(request.nextUrl.pathname)) return;
  const { userId } = await auth();
  if (userId) return;
  const url = request.nextUrl.clone();
  // Where they were going rides along (26 Oct, Alex: the coach phone app signed in to the admin), and sign-in takes
  // them back there (/auth/continue checks it fits the account).
  const { pathname, search } = request.nextUrl;
  url.pathname = "/login";
  url.search = pathname !== "/" && !pathname.startsWith("/api/") ? `?next=${encodeURIComponent(pathname + search)}` : "";
  return NextResponse.redirect(url);
}, { signInUrl: "/login", signUpUrl: "/signup" });

// The app's own address (26 Oct: norcoachapp.com). With CANONICAL_HOST set, a page asked for at the old Railway
// address or at www goes to it, path and query kept: the live sign-in only works on the own domain. /api is left
// alone, so a webhook or the phone app's calls never meet a redirect.
const CANONICAL = process.env.CANONICAL_HOST?.trim().toLowerCase() || null;
function toCanonical(request: NextRequest): NextResponse | null {
  if (!CANONICAL) return null;
  const host = (request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "").split(":")[0].toLowerCase();
  if (!host || host === CANONICAL || request.nextUrl.pathname.startsWith("/api/")) return null;
  // On a subdomain (app.norcoachapp.com), the bare domain and its www go to it too, until the website takes them.
  const parent = CANONICAL.split(".").length > 2 ? CANONICAL.slice(CANONICAL.indexOf(".") + 1) : null;
  const ours = host === `www.${CANONICAL}` || (parent != null && (host === parent || host === `www.${parent}`));
  if (!host.endsWith(".up.railway.app") && !ours) return null;
  return NextResponse.redirect(`https://${CANONICAL}${request.nextUrl.pathname}${request.nextUrl.search}`, 308);
}

// The website on the bare domain (18 Nov, Alex: "connect it to the url already, just we set a username and password"):
// once SITE_USER and SITE_PASSWORD are set on the server, norcoachapp.com (and www) shows website/ through
// app/site/[[...path]]/route.ts, which asks for them; /api stays the app's. Until then the bare domain goes to the app.
const SITE_ON = !!process.env.SITE_USER?.trim() && !!process.env.SITE_PASSWORD?.trim();
// The privacy policy and support page live on the website's address (20 Nov, Alex: "should be norcoachapp.com"): there
// they are the app's own pages, open to everyone, never behind the website's password; asked for at the app's
// address (an old link, the App Store, a link inside the app), they go there.
const LEGAL_PAGES = ["/privacy", "/support"];
const siteParent = () => (CANONICAL && CANONICAL.split(".").length > 2 ? CANONICAL.slice(CANONICAL.indexOf(".") + 1) : null);
function legalToSite(request: NextRequest): NextResponse | null {
  const parent = siteParent();
  if (!SITE_ON || !parent || !LEGAL_PAGES.includes(request.nextUrl.pathname)) return null;
  const host = (request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "").split(":")[0].toLowerCase();
  if (host !== CANONICAL) return null;
  return NextResponse.redirect(`https://${parent}${request.nextUrl.pathname}${request.nextUrl.search}`, 308);
}
function toSite(request: NextRequest, event: NextFetchEvent): NextResponse | Promise<Response | void> | null {
  if (!CANONICAL || !SITE_ON) return null;
  const parent = siteParent();
  const host = (request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "").split(":")[0].toLowerCase();
  if (!parent || (host !== parent && host !== `www.${parent}`)) return null;
  const { pathname } = request.nextUrl;
  if (pathname.startsWith("/api/")) return null;
  if (LEGAL_PAGES.includes(pathname)) return withClerk ? (withClerk(request, event) as Promise<Response | void>) : NextResponse.next();
  const url = request.nextUrl.clone();
  url.pathname = `/site${pathname === "/" ? "" : pathname}`;
  return NextResponse.rewrite(url);
}

export function proxy(request: NextRequest, event: NextFetchEvent) {
  const site = toSite(request, event);
  if (site) return site;
  const legal = legalToSite(request);
  if (legal) return legal;
  const moved = toCanonical(request);
  if (moved) return moved;
  // An old admin address (/admin/redesign/home?client=1, in a notification, a push, an email or a bookmark) goes to its
  // new one (/clients/1/home), its other query kept and its # kept by the browser (24 Nov, Alex: the addresses).
  const admin = oldAdminAddress(request.nextUrl.pathname, request.nextUrl.search);
  if (admin) {
    const url = request.nextUrl.clone();
    const [path, query = ""] = admin.split("#")[0].split("?");
    url.pathname = path;
    url.search = query ? `?${query}` : "";
    url.hash = admin.includes("#") ? admin.slice(admin.indexOf("#")) : "";
    return NextResponse.redirect(url, 308);
  }
  if (withClerk) return withClerk(request, event);
  const { pathname } = request.nextUrl;

  if (isPublic(pathname)) return NextResponse.next();

  const hasSession = request.cookies.has("ironline_session");
  if (hasSession) return NextResponse.next();

  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except Next's own assets, Stripe's webhook
  // (signed, no cookie) and the uploads (the coach's
  // video-reply and chat review, and every other big file through api/upload;
  // they do their own per-request authorization, and the proxy would also
  // buffer and cut off a big upload body), and common static files. The app icons
  // (app/icon.png, app/apple-icon.png) and the logo under public/brand must
  // stay public too: the phone fetches them from the manifest with no cookie
  // when the client adds the app to their home screen, and the login page
  // shows the logo before anyone has a session. sw.js too: the browser
  // re-checks the service worker on its own, cookie or not, and a redirect
  // to /login there would break push notifications once a session expired.
  // coach.webmanifest is the coach phone's (21 Oct, /coach), fetched with no cookie the same way.
  // .well-known (13 Nov): Apple reads apple-app-site-association there with no cookie, and it must never redirect.
  // api/upload (4 Nov, Alex: memory): every big file's way in, checked by its own route, so its body is never copied
  // into memory here.
  matcher: ["/((?!.well-known|_next/static|_next/image|api/video-reply|api/chat-review|api/upload|api/stripe/webhook|favicon.ico|manifest.webmanifest|coach.webmanifest|icon.png|apple-icon.png|sw.js|icons/|brand/).*)"],
};
