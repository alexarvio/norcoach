// The notifications' one door, checked (19 Nov, Step 6 quest 7 of docs/database-plan.md): nothing in app/ reaches the
// store's coach_activity rows but app/lib/notes/rows.ts. A sibling of check-chat-door.mjs (which is left as it is):
// tsc already refuses `data.coach_activity` (a sealed type in db.ts); this catches what a type can't:
//   (a) the name `coach_activity` in code anywhere but app/lib/notes, app/lib/pg and db.ts (comments are not code);
//   (b) a loop over every collection of the store (Object.entries/keys/values of getData(), of a `Data`, or of what is
//       cast from either) without a `// notes-door:` note saying how the notifications are handled;
//   (c) a fetch of the door, or a function round it that answers a promise since quest 7, called without await,
//       return, void, or a held promise awaited later;
//   (d) a "use client" file importing app/lib/notes for more than types;
//   (f) NOTES_STORE read anywhere but app/lib/notes/mode.ts;
//   (g) the outbox's key `notes_outbox` in code outside app/lib/notes, app/lib/pg and db.ts.
//   node scripts/check-notes-door.mjs     (npm run check:notes; scripts/build.mjs runs it before next build)
// A line that must name them or walk the store says why with `// notes-door:` on it or up to three lines either side.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP = path.join(ROOT, "app");
const extraFiles = [path.join(ROOT, "instrumentation.ts")].filter((f) => fs.existsSync(f));
const rel = (f) => path.relative(ROOT, f).split(path.sep).join("/");
const INSIDE = (r) => r.startsWith("app/lib/notes/") || r.startsWith("app/lib/pg/") || r === "app/lib/db.ts";
const MARK = "notes-door:";
/** What answers a promise and must be awaited (or handed on). */
const ASYNC = new Set([
  "fetchClientNotes",
  "fetchNoteKeys",
  "fetchNoteOwner",
  "fetchChatNote",
  "fetchUnreadReminderClients",
  "fetchReminderState",
  "fetchNotesExport",
  "fetchAllNotes",
  "fetchPictureNotes",
  "notesKeyed",
  "deleteClientNotes",
  "wipeAllNotes",
  "runClientReminders",
  "drainOutbox",
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
const isDoor = (from) => from != null && (from === "app/lib/notes" || from.startsWith("app/lib/notes/"));
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
  if (/^\s*["']use client["']/m.test(lines.slice(0, 5).join("\n")) && imports.some((im) => isDoor(im.from) && !im.typeOnly)) say(file, 1, `a "use client" file imports app/lib/notes`);

  lines.forEach((raw, i) => {
    const n = i + 1;
    const line = codeOf(raw);
    if (!line) return;
    if (!inside && /\bcoach_activity\b/.test(line) && !marked(lines, i)) say(file, n, "names coach_activity outside app/lib/notes (go through the door)");
    if (!inside && !marked(lines, i)) {
      if (walks.test(line)) say(file, n, "walks the store's collections (the notifications leave them with NOTES_STORE=pg): mark it `// notes-door:` with how they are handled");
      if (casts.test(line)) say(file, n, "casts the store to walk it: mark it `// notes-door:` with how the notifications are handled");
    }
    if (r !== "app/lib/notes/mode.ts" && /process\.env\.NOTES_STORE\b|process\.env\[\s*["']NOTES_STORE["']\s*\]/.test(line)) say(file, n, "reads NOTES_STORE outside app/lib/notes/mode.ts (import NOTES_PG from there)");
    if (!inside && /\bnotes_outbox\b/.test(line) && !marked(lines, i)) say(file, n, "touches notes_outbox outside app/lib/notes (the drainer's alone)");
  });

  // (c) Every promise of the door awaited, returned, voided, or held and awaited later.
  const checked = new Map();
  for (const name of ASYNC) if (src.includes(`${name}(`)) checked.set(name, "answers a promise (a notes fetch or write)");
  for (const im of imports) {
    if (im.typeOnly) continue;
    const ns = /^\*\s+as\s+(\w+)$/.exec(im.what);
    if (ns) for (const name of ASYNC) if (src.includes(`${ns[1]}.${name}(`)) checked.set(`${ns[1]}.${name}`, "answers a promise (a notes fetch or write)");
    if (!im.what.startsWith("{")) continue;
    for (const part of im.what.replace(/^\{|\}$/g, "").split(",")) {
      const [name, alias] = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/);
      if (name && alias && ASYNC.has(name.trim())) checked.set(alias.trim(), "answers a promise (a notes fetch or write)");
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
        // An arrow handing the promise on (`() => fetchX(…)`, `const fetchY = (…) => fetchX(…)`): its caller is checked.
        if (/=>\s*$/.test(before)) continue;
        const heldAs = /\bconst\s+(\w+)\s*=\s*$/.exec(before);
        if (heldAs && new RegExp(`\\bawait\\s+${heldAs[1]}\\b`).test([line.slice(m.index), ...lines.slice(i + 1)].join("\n"))) continue;
        say(file, i + 1, `${name}(…) ${what}: await it (or return, void, or hold it and await it later)`);
      }
    }
  });
}

if (problems.length) {
  console.error(`[check-notes-door] ${problems.length} problem${problems.length === 1 ? "" : "s"}:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log("[check-notes-door] ok: the notifications go through app/lib/notes/rows.ts alone");
