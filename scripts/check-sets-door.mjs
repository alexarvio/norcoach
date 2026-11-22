// The logged sets' one door, checked (22 Nov, Step 6 quest 10 of docs/database-plan.md): nothing in app/ reaches the
// store's sets list (set_logs), nor its cardio ticks (cardio_logs, through the same door since 22 Nov), but app/lib/sets/. A sibling of check-checkins-door.mjs (and the chat, notes and food
// guards, all left as they are): tsc already refuses `data.set_logs` (a sealed type in db.ts, and every reader takes a
// SetRows); this catches what a type can't:
//   (a) the name set_logs (and set_twins, sets_removing, sets_gym_pins) in code anywhere but app/lib/sets, app/lib/pg and
//       db.ts (comments are not code), unless marked;
//   (b) a loop over every collection of the store (Object.entries/keys/values of getData(), of a `Data`, or of what is
//       cast from either) without a `// sets-door:` note saying how the sets are handled;
//   (c) a fetch or a write of the door, or a function round it answering a promise since this step (logSet,
//       discardSession…), called without await, return, void, or a held promise awaited later;
//   (d) a "use client" file importing app/lib/sets for more than types;
//   (e) SETS_STORE read anywhere but app/lib/sets/mode.ts;
//   (f) the kv mark `sets_pg` in code outside app/lib/sets and app/lib/pg;
//   (g) storeSetBox or storeSetRows (memory mode's whole store, for scripts) imported in app/ outside the door.
//   node scripts/check-sets-door.mjs     (npm run check:sets; scripts/build.mjs runs it before next build)
// A line that must name them or walk the store says why with `// sets-door:` on it or up to three lines either side. A
// cast of the store read by one key's name that another door's guard already had marked is no walk for this one either;
// and the other doors' own whole-store copies (app/lib/chat, notes, food, checkins) copy every key as handed in.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP = path.join(ROOT, "app");
const extraFiles = [path.join(ROOT, "instrumentation.ts")].filter((f) => fs.existsSync(f));
const rel = (f) => path.relative(ROOT, f).split(path.sep).join("/");
const INSIDE = (r) => r.startsWith("app/lib/sets/") || r.startsWith("app/lib/pg/") || r === "app/lib/db.ts";
const MARK = "sets-door:";
// set_twins (the rows a pg boot kept aside), sets_removing (a removal's tombstones) and sets_gym_pins (home-gym pins) too;
// and since 22 Nov the cardio ticks (cardio_logs), which moved with the sets.
const NAMES = /\b(set_logs|cardio_logs|set_twins|sets_removing|sets_gym_pins)\b/;
/** What answers a promise and must be awaited (or handed on). */
const ASYNC = new Set([
  "fetchClientSets",
  "fetchClientPageSets",
  "fetchClientTabSets",
  "fetchCoachSets",
  "fetchCoachSetsOfClient",
  "fetchEverySet",
  "fetchDaySets",
  "fetchLiveSessionSets",
  "fetchSetsLogged",
  "fetchSetsForClients",
  "fetchAllSets",
  "fetchTicksOfClients",
  "fetchSetOwner",
  "fetchAppLockSets",
  "withClientSetsLocked",
  "writeSets",
  "deleteClientSets",
  "sweepClientSets",
  "wipeAllSets",
  // Round the door, a promise since this step.
  "logSet",
  "updateSetLog",
  "setAssignmentUnit",
  "setExerciseRows",
  "pickGymForDay",
  "discardSession",
  "removeFreeSession",
  "endStaleSessions",
  "getClientIdForSetLog",
  "setPhaseOpenEnded",
  "applyDueProgramDeployments",
  "removeClient",
  // The cardio ticks through the door (22 Nov).
  "setCardioDone",
  "setCardioSwap",
]);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts|js|jsx|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

const problems = [];
const say = (file, line, why) => problems.push(`${rel(file)}:${line}: ${why}`);
function resolved(file, spec) {
  if (spec.startsWith("@/")) return rel(path.join(ROOT, spec.slice(2)));
  if (spec.startsWith(".")) return rel(path.resolve(path.dirname(file), spec));
  return null;
}
function importsOf(file, src) {
  const out = [];
  for (const m of src.matchAll(/\bimport\s+(type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/g)) {
    const names = m[2].trim();
    const typeOnly = !!m[1] || /^\{\s*(?:type\s+\w+(?:\s+as\s+\w+)?\s*,?\s*)+\}$/.test(names);
    out.push({ what: names, from: resolved(file, m[3]), typeOnly });
  }
  for (const m of src.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) out.push({ what: "", from: resolved(file, m[1]), typeOnly: false });
  return out;
}
const isDoor = (from) => from != null && (from === "app/lib/sets" || from.startsWith("app/lib/sets/"));
function openAfter(text, start) {
  let at = -1;
  for (const m of text.matchAll(start)) at = m.index + m[0].length;
  if (at < 0) return false;
  let depth = 1;
  for (const ch of text.slice(at)) {
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return false;
  }
  return depth > 0;
}
const marked = (lines, i) => lines.slice(Math.max(0, i - 3), i + 4).some((l) => l.includes(MARK));
const ANY_MARK = /\b(chat|notes|food|checkins|sets)-door:/;
const markedByAny = (lines, i) => lines.slice(Math.max(0, i - 3), i + 4).some((l) => ANY_MARK.test(l));
const OTHER_DOOR = (r) => r.startsWith("app/lib/chat/") || r.startsWith("app/lib/notes/") || r.startsWith("app/lib/food/") || r.startsWith("app/lib/checkins/");
/** The line without its comment: a whole-line comment is nothing; a ` // …` after code is cut (a URL's // has no space). */
const codeOf = (raw) => {
  const t = raw.trim();
  if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return "";
  return raw.replace(/\s\/\/\s.*$/, "");
};

for (const file of [...walk(APP), ...extraFiles]) {
  const r = rel(file);
  const src = fs.readFileSync(file, "utf8");
  const lines = src.split(/\r?\n/);
  const inside = INSIDE(r);
  const storeNames = new Set();
  for (const m of src.matchAll(/\b(?:const|let|var)\s+(\w+)\s*(?::\s*Data\b[^=]*)?=\s*getData\(\)/g)) storeNames.add(m[1]);
  for (const m of src.matchAll(/\b(\w+)\s*\??:\s*Data\b(?!\w)/g)) storeNames.add(m[1]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const m of src.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*(\w+)\s+as\s+unknown\b/g)) {
      if (storeNames.has(m[2]) && !storeNames.has(m[1])) {
        storeNames.add(m[1]);
        grew = true;
      }
    }
  }
  const held = ["getData\\(\\)", ...[...storeNames].map((n) => `\\b${n}`)].join("|");
  const walks = new RegExp(`Object\\.(entries|keys|values)\\(\\s*(${held})\\s*[),]`);
  const casts = new RegExp(`(${held})\\s+as\\s+unknown\\s+as\\s+Record<`);
  const imports = importsOf(file, src);
  if (/^\s*["']use client["']/m.test(lines.slice(0, 5).join("\n")) && imports.some((im) => isDoor(im.from) && !im.typeOnly)) say(file, 1, `a "use client" file imports app/lib/sets`);
  // (g) The whole store's lists (memory mode, for scripts) never imported in app/ outside the door.
  if (!r.startsWith("app/lib/sets/")) {
    for (const im of imports) if (isDoor(im.from) && /\bstoreSet(Box|Rows)\b/.test(im.what)) say(file, 1, "imports storeSetBox or storeSetRows (memory mode's whole store, for scripts): fetch or write through the door");
  }

  lines.forEach((raw, i) => {
    const n = i + 1;
    const line = codeOf(raw);
    if (!line) return;
    if (!inside && NAMES.test(line) && !marked(lines, i)) say(file, n, `names ${NAMES.exec(line)[1]} outside app/lib/sets (go through the door)`);
    if (!inside && !marked(lines, i)) {
      if (walks.test(line) && !OTHER_DOOR(r)) say(file, n, "walks the store's collections (the sets leave them with SETS_STORE=pg): mark it `// sets-door:` with how they are handled");
      if (casts.test(line) && !markedByAny(lines, i)) say(file, n, "casts the store to walk it: mark it `// sets-door:` with how the sets are handled");
    }
    if (r !== "app/lib/sets/mode.ts" && /process\.env\.SETS_STORE\b|process\.env\[\s*["']SETS_STORE["']\s*\]/.test(line)) say(file, n, "reads SETS_STORE outside app/lib/sets/mode.ts (import SETS_PG from there)");
    if (!r.startsWith("app/lib/sets/") && !r.startsWith("app/lib/pg/") && /\bsets_pg\b/.test(line) && !marked(lines, i)) say(file, n, "touches the kv mark sets_pg outside app/lib/sets and app/lib/pg");
  });

  // (c) Every promise of the door awaited, returned, voided, or held and awaited later.
  const checked = new Map();
  for (const name of ASYNC) if (src.includes(`${name}(`)) checked.set(name, "answers a promise (a sets fetch or write)");
  for (const im of imports) {
    if (im.typeOnly) continue;
    const ns = /^\*\s+as\s+(\w+)$/.exec(im.what);
    if (ns) for (const name of ASYNC) if (src.includes(`${ns[1]}.${name}(`)) checked.set(`${ns[1]}.${name}`, "answers a promise (a sets fetch or write)");
    if (!im.what.startsWith("{")) continue;
    for (const part of im.what.replace(/^\{|\}$/g, "").split(",")) {
      const [name, alias] = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/);
      if (name && alias && ASYNC.has(name.trim())) checked.set(alias.trim(), "answers a promise (a sets fetch or write)");
    }
  }
  lines.forEach((raw, i) => {
    const line = codeOf(raw);
    if (!line) return;
    for (const [name, what] of checked) {
      const call = new RegExp(`(^|[^\\w.])${name.replace(".", "\\.")}\\(`, "g");
      for (const m of line.matchAll(call)) {
        const before = line.slice(0, m.index + m[1].length);
        if (/\bfunction\s*$/.test(before)) continue;
        if (/\b(await|return|void)\s*\(?\s*$/.test(before)) continue;
        if (openAfter(before, /\b(await|return|void)\s*\(/g)) continue;
        // An arrow handing the promise on (`() => fetchX(…)`, its body on the next line too): its caller is checked.
        if (/=>\s*\(?\s*$/.test(before)) continue;
        if (!before.trim() && /=>\s*$/.test(codeOf(lines.slice(0, i).reverse().find((l) => codeOf(l).trim()) ?? ""))) continue;
        // A ternary arm of an awaited or held expression (`x ? await fetchX(…) : …`, `a ? fetchX(…) : b` under an await).
        if (/\?\s*$/.test(before) && /\bawait\b/.test(before)) continue;
        const heldAs = /\bconst\s+(\w+)\s*=\s*$/.exec(before);
        // Held and awaited later, or handed back to the caller (`return held`: its caller is checked).
        if (heldAs && new RegExp(`\\b(await|return)\\s+${heldAs[1]}\\b`).test([line.slice(m.index), ...lines.slice(i + 1)].join("\n"))) continue;
        say(file, i + 1, `${name}(…) ${what}: await it (or return, void, or hold it and await it later)`);
      }
    }
  });
}

if (problems.length) {
  console.error(`[check-sets-door] ${problems.length} problem${problems.length === 1 ? "" : "s"}:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log("[check-sets-door] ok: the logged sets go through app/lib/sets alone");
