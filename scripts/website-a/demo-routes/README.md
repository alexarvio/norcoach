# Re-taking the website's pictures (25 Nov)

The laptop and phone pictures (website/img/snaps) are screenshots of today's app, taken from a demo copy with made-up
people, never real clients.

1. `../ironline-demo`: a copy of app, public, drizzle, scripts and website with the config files, node_modules a
   junction into this repo, its own `.env.local` (DATABASE_URL `pglite:./.pglite-demo`, COACH_EMAIL finlay@demo.test,
   WORKOUT_SHEET=all), `next.config.ts` with `turbopack.root` the parent folder and `devIndicators: false`.
   Its `app/lib/demoClient.ts` names Emma's phases as the site tells her story (Sleep and steps, Upper strength, a Cut at
   170 | 175 | 70) and her weigh-ins from 79.8 kg over 35 days.
2. The routes here (`.ts.txt`, so this repo never type-checks them) go in its `app/api/dev/<name>/route.ts` (seed-site, emma-login, legs-now): Finlay's profile and photo (no business name: Norcoach's own pictures never carry one coach's brand, 25 Nov, Alex), Emma and 14
   made-up clients with the site's avatars, her weight goal and To focus on; a login for Emma; her Legs half done today.
3. Start it (launch config `demo`, port 3010), sign in once as the coach, open the three routes in that order.
4. `MSYS_NO_PATHCONV=1 node shoot-demo.cjs <outDir> 1 coach-home=/clients/1/home …` for the laptop (1600×1000 at 1.25);
   `VW=390 VH=844 DPR=2 MOBILE=1` with the coach's preview (`/client?phone=1&client=1&screen=home|nutrition`) or Emma's
   own login (user 2) for the phone, adding `native-app` and `--sat: 50px` so the clock has its room;
   `node statusbar.cjs <snaps> <out> phone-home:w …` draws 9:41 and the island over it.
