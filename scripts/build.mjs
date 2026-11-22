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
// The notifications' door the same (19 Nov, quest 7).
const notesDoor = spawnSync(process.execPath, [fileURLToPath(new URL("./check-notes-door.mjs", import.meta.url))], { stdio: "inherit" });
if (notesDoor.status !== 0) process.exit(notesDoor.status ?? 1);
// The food diary's door the same (19 Nov, quest 8 part 1).
const foodDoor = spawnSync(process.execPath, [fileURLToPath(new URL("./check-food-door.mjs", import.meta.url))], { stdio: "inherit" });
if (foodDoor.status !== 0) process.exit(foodDoor.status ?? 1);
// The check-in figures' door the same (20 Nov, quest 9).
const checkInsDoor = spawnSync(process.execPath, [fileURLToPath(new URL("./check-checkins-door.mjs", import.meta.url))], { stdio: "inherit" });
if (checkInsDoor.status !== 0) process.exit(checkInsDoor.status ?? 1);
// The logged sets' door the same (22 Nov, quest 10).
const setsDoor = spawnSync(process.execPath, [fileURLToPath(new URL("./check-sets-door.mjs", import.meta.url))], { stdio: "inherit" });
if (setsDoor.status !== 0) process.exit(setsDoor.status ?? 1);
const nextBin = require.resolve("next/dist/bin/next");
const env = { ...process.env, NODE_OPTIONS: "--max-old-space-size=4096" };
const result = spawnSync(process.execPath, [nextBin, "build"], { stdio: "inherit", env });
process.exit(result.status ?? 1);
