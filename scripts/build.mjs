// The production build without the running app's memory cap (4 Nov, Alex): Railway hands its variables to the build as
// well, and NODE_OPTIONS=--max-old-space-size=768 (meant to keep the running server small) made `next build`'s type
// check run out of memory. The cap belongs to the running app alone (package.json "start"); the build gets room.
import { spawnSync } from "child_process";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
// The chat's one door first (18 Nov, Step 5 of docs/database-plan.md): next build no longer lints (Next 16), so this
// check runs here, and a build with chat rows reached around app/lib/chat/rows.ts fails before it starts.
const door = spawnSync(process.execPath, [fileURLToPath(new URL("./check-chat-door.mjs", import.meta.url))], { stdio: "inherit" });
if (door.status !== 0) process.exit(door.status ?? 1);
const nextBin = require.resolve("next/dist/bin/next");
const env = { ...process.env, NODE_OPTIONS: "--max-old-space-size=4096" };
const result = spawnSync(process.execPath, [nextBin, "build"], { stdio: "inherit", env });
process.exit(result.status ?? 1);
