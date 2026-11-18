// The chat's one door, checked (18 Nov, Step 5 of docs/database-plan.md): nothing in app/ reaches the store's chat
// rows but app/lib/chat/rows.ts. tsc already refuses `data.chat_messages` (a sealed type in db.ts); this catches what
// a type can't: (a) the name written anywhere else; (b) a loop over every collection of the store (Object.entries of
// getData(), of a `Data`, or of what is cast from either; any other `data` is not the store); (c) a door write left
// unawaited, and any function round the door that answers a promise since Step 5 (ASYNC_ROUND_THE_DOOR) called without
// await, under its own name, an alias or a namespace (`Q.setChatReaction(…)`), or returned but read as a value; (d) a "use client" file importing app/lib/chat for more than types; (e) the seeds' own handle in the app.
// Imports are resolved (relative and `@/`), so `./chat/rows` and `../lib/chat/rows` are the same door.
//   node scripts/check-chat-door.mjs     (npm run check:chat; scripts/build.mjs runs it before next build)
// A line that must name the chat or walk the store says why with `// chat-door:` on it or just before it.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP = path.join(ROOT, "app");
const rel = (f) => path.relative(ROOT, f).split(path.sep).join("/");

/** Where the chat may be named and the store walked: the door itself, the Postgres store, the store's types. */
const INSIDE = (r) => r.startsWith("app/lib/chat/") || r.startsWith("app/lib/pg/") || r === "app/lib/db.ts";
const MARK = "chat-door:";
/** The door's writes: each one changes memory as it is called and must be awaited (or handed on) by its caller. */
const WRITES = new Set(["insertChatRow", "setReaction", "editText", "deleteRow", "setLink", "setPinned", "setLook", "swapPath", "deleteClientChat", "wipeAllChat"]);
/**
 * The functions round the door that answer a promise since Step 5 (a chat write, or a file check whose answer decides a
 * deletion): one called without await would carry on before the chat changed, or read a promise as "yes". Checked in
 * every file, wherever they are imported from (a call that isn't awaited, returned, voided or held and awaited).
 */
const ASYNC_ROUND_THE_DOOR = new Set([
  "sendChatMessage",
  "deleteChatMessage",
  "deleteClientChatMessage",
  "editChatMessage",
  "editClientChatMessage",
  "editMealComment",
  "removeMealComment",
  "removeClient",
  "replyToMedia",
  "sendFormReview",
  "setChatMediaLook",
  "setChatMessageLink",
  "setChatMessagePinned",
  "setChatReaction",
  "swapChatMedia",
  "buildDemoClient",
  "chatUsesFile",
  "chatFileLeft",
  "chatMediaLacksLook",
  "fileShown",
  "chatShowsFile",
  "chatFileLacksLook",
  "chatMediaWithoutLook",
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
/** The repo path an import names (relative, or `@/` from the root), or null for a package. */
function resolved(file, spec) {
  if (spec.startsWith("@/")) return rel(path.join(ROOT, spec.slice(2)));
  if (spec.startsWith(".")) return rel(path.resolve(path.dirname(file), spec));
  return null;
}
/** Every import of this file: the names it takes and where from (`import {a, b as c} from "…"`, and `import x from`). */
function importsOf(file, src) {
  const out = [];
  for (const m of src.matchAll(/\bimport\s+(type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/g)) {
    // Types only (`import type {…}`, or every name `type x`): erased, nothing of the module reaches a bundle.
    const names = m[2].trim();
    const typeOnly = !!m[1] || /^\{\s*(?:type\s+\w+(?:\s+as\s+\w+)?\s*,?\s*)+\}$/.test(names);
    out.push({ what: names, from: resolved(file, m[3]), typeOnly });
  }
  for (const m of src.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) out.push({ what: "", from: resolved(file, m[1]), typeOnly: false });
  return out;
}
const isDoor = (from) => from != null && (from === "app/lib/chat" || from.startsWith("app/lib/chat/"));

/** A bracket opened by `start` (the last one in `text`) is still open at the end of `text`. */
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

/** Where the bracket opened just before `from` closes on this line (the line's end when it runs on). */
function closeOf(line, from) {
  let depth = 1;
  for (let i = from; i < line.length; i++) {
    if (line[i] === "(") depth++;
    else if (line[i] === ")" && --depth === 0) return i + 1;
  }
  return line.length;
}

/** A marker on the line or up to three lines either side of it. */
const marked = (lines, i) => lines.slice(Math.max(0, i - 3), i + 4).some((l) => l.includes(MARK));

for (const file of walk(APP)) {
  const r = rel(file);
  const src = fs.readFileSync(file, "utf8");
  const lines = src.split(/\r?\n/);
  const inside = INSIDE(r);
  // The names that hold the store in this file: getData()'s value, a `Data` parameter, and what is cast from either
  // (`const store = data as unknown as Record<…>`). A loop over any other `data` (a chart's, a report's) is not the store.
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
  // (d) A browser bundle never imports the door (a type alone is erased, so it may).
  if (/^\s*["']use client["']/m.test(src.split(/\r?\n/).slice(0, 5).join("\n")) && imports.some((im) => isDoor(im.from) && !im.typeOnly)) {
    say(file, 1, `a "use client" file imports app/lib/chat`);
  }

  lines.forEach((line, i) => {
    const n = i + 1;
    // (a) The name itself, outside the door.
    if (!inside && line.includes("chat_messages") && !marked(lines, i)) say(file, n, "names chat_messages outside app/lib/chat (go through the door)");
    // (b) A loop over every collection of the store, or the store cast to walk it.
    if (!inside && !marked(lines, i)) {
      if (walks.test(line)) say(file, n, "walks the store's collections (chat is not among them after the cut-over): mark it `// chat-door:` with how chat is handled");
      if (casts.test(line)) say(file, n, "casts the store to walk it: mark it `// chat-door:` with how chat is handled");
    }
    // (e) The seeds' handle, in the app.
    if (r !== "app/lib/chat/rows.ts" && /\bseedChatRows\b/.test(line)) say(file, n, "seedChatRows is for scripts/ alone");
  });

  // (c) Every door write awaited, returned, voided, or held and awaited later in the file; and, in every file but the
  // door's own, every function round it that answers a promise.
  const imported = new Set();
  if (!inside) {
    for (const im of imports) {
      if (im.from !== "app/lib/chat/rows" || im.typeOnly || !im.what.startsWith("{")) continue;
      for (const part of im.what.replace(/^\{|\}$/g, "").split(",")) {
        const [name, alias] = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/);
        if (name && WRITES.has(name)) imported.add((alias ?? name).trim());
      }
    }
  }
  const checked = new Map([...imported].map((n) => [n, "is a door write"]));
  if (!r.startsWith("app/lib/chat/")) {
    const what = "answers a promise (a chat write or a file check)";
    for (const n of ASYNC_ROUND_THE_DOOR) if (src.includes(`${n}(`)) checked.set(n, what);
    // The same functions under another name: `import { setChatReaction as react }`, and through a namespace,
    // `import * as Q from "./queries"` then `Q.setChatReaction(…)` (a plain `name(` never matches after a dot).
    for (const im of imports) {
      if (im.typeOnly) continue;
      const ns = /^\*\s+as\s+(\w+)$/.exec(im.what);
      if (ns) for (const n of ASYNC_ROUND_THE_DOOR) if (src.includes(`${ns[1]}.${n}(`)) checked.set(`${ns[1]}.${n}`, what);
      if (!im.what.startsWith("{")) continue;
      for (const part of im.what.replace(/^\{|\}$/g, "").split(",")) {
        const [name, alias] = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/);
        if (name && alias && ASYNC_ROUND_THE_DOOR.has(name.trim())) checked.set(alias.trim(), what);
      }
    }
  }
  if (!checked.size) continue;
  lines.forEach((raw, i) => {
    const trimmed = raw.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
    // A comment after the code is not code (a URL's // has no space before it).
    const line = raw.replace(/\s\/\/\s.*$/, "");
    for (const [name, what] of checked) {
      const call = new RegExp(`(^|[^\\w.])${name.replace(".", "\\.")}\\(`, "g");
      for (const m of line.matchAll(call)) {
        const before = line.slice(0, m.index + m[1].length);
        // Its own definition.
        if (/\bfunction\s*$/.test(before)) continue;
        // Returned, but read as a value on the way (`return chatUsesFile(p) && …`): the promise is the truthy thing.
        if (/\breturn\s*$/.test(before) && /^\s*(&&|\|\||\?)/.test(line.slice(closeOf(line, m.index + m[0].length)))) {
          say(file, i + 1, `${name}(…) ${what}: its promise is read as a value (await it first)`);
          continue;
        }
        if (/\b(await|return|void)\s*\(?\s*$/.test(before)) continue;
        // Inside an awaited (or returned, voided) bracket still open: `await (coach ? deleteChatMessage(…) : …)`.
        if (openAfter(before, /\b(await|return|void)\s*\(/g)) continue;
        // A wrapper that is itself on the list, handing its promise on: `const chatMediaLacksLook = (p) => chatFileLacksLook(…)`.
        const wrap = /\bconst\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=]*)?=>\s*$/.exec(before);
        if (wrap && ASYNC_ROUND_THE_DOOR.has(wrap[1])) continue;
        const held = /\bconst\s+(\w+)\s*=\s*$/.exec(before);
        if (held && new RegExp(`\\bawait\\s+${held[1]}\\b`).test(lines.slice(i + 1).join("\n"))) continue;
        say(file, i + 1, `${name}(…) ${what}: await it (or return, void, or hold it and await it later)`);
      }
    }
  });
}

if (problems.length) {
  console.error(`[check-chat-door] ${problems.length} problem${problems.length === 1 ? "" : "s"}:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log("[check-chat-door] ok: chat rows go through app/lib/chat/rows.ts alone");
