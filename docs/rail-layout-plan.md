# The rail stays, only the page swaps (22 Nov, Alex: "if we have to touch the rail… to make it a proper product, then yes")

Today every admin view (`app/admin/redesign/<view>/page.tsx`) draws `<div className="rd-frame">`, the rail
(`RedesignRail`, fed by `loadRail(...)` computed in that page) and its `.rd-page`. Every click therefore re-renders the
rail on the server and nothing changes on screen until the whole new page is in. Goal: the rail is drawn once by a
layout and never re-renders on navigation; a click shows the new view's outline at once (`loading.tsx`), the data fills
in after; the rail's counts stay fresh in the background.

## Pieces

1. `app/admin/redesign/layout.tsx` (server). `requireCoach()`. The onboarding gate that sits in `loadRail`
   (`users.onboarding` → `redirect("/auth/coach-setup")`) also runs here synchronously, before anything streams.
   It starts the rail's data as a promise (the coach-wide door fetches `fetchCoachChat([coach.id], "layout.rail")`,
   `fetchCoachFood`, `fetchCoachCheckIns`, `fetchCoachSets`, then `loadRail`) WITHOUT awaiting it, and renders
   `<RailFrame rail={promise}>{children}</RailFrame>`. It imports `./rail.css` (and anything the rail needs that pages
   imported for it). Keep `export const dynamic = "force-dynamic"` semantics as the pages have.
2. `app/admin/redesign/RailFrame.tsx` (client). Decides by `usePathname()` whether this path is a framed view (every
   path whose page today renders `RedesignRail`, `RedesignShell` or `NoClients`; NOT the -states boards, onboarding
   boards or redirects). Not framed: renders `children` alone. Framed:
   `<div className="rd-frame">` + the rail + `{children}` — children directly inside the div, no wrapper, so
   `.rd-frame > .rd-page`, `.rd-frame:has(> .rr.going) > .rd-page` and `.rd-frame:has(.rd-chattab) > .rd-page` keep
   matching. The rail renders under `<Suspense fallback={<rail skeleton: the dark top and paper, nothing in them>}>`
   reading the promise with `use()`.
   - Context `RailContext`: the latest `RailData` (or null while loading), and a setter for "here": the client id the
     page shows (pages that pick a default client when the address has none must report it).
   - Freshness: after each navigation (pathname or search change) and when `RefreshOnReturn` reads again, the frame
     fetches `GET /api/admin/rail` and swaps the data in (newest wins). A new promise from the layout (router.refresh,
     a server action) also replaces it. Never shows stale over fresh.
3. `app/api/admin/rail/route.ts`: GET, the signed-in coach (follow the pattern other `/api` routes use for the coach;
   memory: Clerk needs `getRequestUser` on /api), the same door fetches + `loadRail`, JSON, `Cache-Control: no-store`.
   401 when not a coach.
4. `RedesignRail`: takes its data from props as now (RailFrame passes it). Its `pending` / `.rr.going` state is cleared
   when the address changes (it used to be cleared by unmounting). `clientId` comes from RailFrame's "here", falling back
   to `?client=`. Keep ViewLink's hover prefetch and its calm refresh after landing.
5. `RedesignShell`: no longer draws `.rd-frame` or the rail. It returns `<>{chat dock / panel bits}<div className="rd-page">…</div></>`
   in the same order the frame held them. `data-chat` on the frame is set and removed by an effect on
   `document.querySelector(".rd-frame")` (it already touches `data-chat-still` that way). Replace its `rail` prop by what
   it reads: `units` (`"kg" | "lbs"`) and the client's photo; the page computes those cheaply (no `loadRail`). It reports
   its `clientId` to RailContext.
6. `NoClients`: page content only (`.rd-page`), no frame, no rail, no `rail` prop.
7. Every framed `page.tsx`: drop `loadRail`, `RedesignRail`, the `rd-frame` div; keep `ChatDock` and `.rd-page` as
   siblings in the same order (a fragment). Keep every door fetch the page's own content needs and every `t.time`.
   Pages that fetched coach-wide rows only for the rail stop fetching them, unless the page's own content uses them.
8. `loading.tsx` in every framed view's folder: the view's outline, drawn at once, static (no shimmer: "only live things
   pulse"): `<div className="rd-page">` with the view's real header (`trn-head bare`, the title in words: Feed, Phases,
   Calendar, Library, Business, Coaches, Settings) and one or two empty hairline cards (`rls-card`) of a believable
   height. Client tabs: the tab bar track (`rd-nav` grey track, no words) and an empty header. One shared component
   `PageSkeleton` (app/admin/redesign/PageSkeleton.tsx) + a few lines of CSS in rail.css.

## Must not change
- What any page looks like once loaded (DOM order and classes under `.rd-frame`).
- The door files (`app/lib/*/rows.ts`, `app/lib/sets/*`, `loaders.ts` beyond adding a tiny helper) — another session
  owns the database doors. Run `node scripts/check-chat-door.mjs`, `check-notes-door`, `check-food-door`,
  `check-checkins-door`, `check-sets-door` and the type-check (`timeout 290 npx tsc --noEmit -p .`).
- No dev server, no git commit, no branch switch.
