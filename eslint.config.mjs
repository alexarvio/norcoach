import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const CHAT_DOOR = [
  { selector: "MemberExpression[property.name='chat_messages']", message: "Chat rows go through app/lib/chat/rows.ts (the one door)." },
  { selector: "MemberExpression[computed=true][property.value='chat_messages']", message: "Chat rows go through app/lib/chat/rows.ts (the one door)." },
  { selector: "TSIndexedAccessType[indexType.literal.value='chat_messages']", message: "Chat rows go through app/lib/chat/rows.ts (the one door)." },
];
const NOTES_DOOR = [
  { selector: "MemberExpression[property.name=/^(coach_activity|notes_outbox)$/]", message: "Notifications go through app/lib/notes/rows.ts (the one door)." },
  { selector: "MemberExpression[computed=true][property.value=/^(coach_activity|notes_outbox)$/]", message: "Notifications go through app/lib/notes/rows.ts (the one door)." },
  { selector: "TSIndexedAccessType[indexType.literal.value='coach_activity']", message: "Notifications go through app/lib/notes/rows.ts (the one door)." },
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // The chat's one door (18 Nov, Step 5 of docs/database-plan.md): the store's chat rows are reached through
  // app/lib/chat/rows.ts alone. Editor feedback; the build's own proof is tsc (a sealed type) and scripts/check-chat-door.mjs.
  // The notifications' the same (19 Nov, quest 7): coach_activity and its outbox through app/lib/notes/rows.ts alone
  // (scripts/check-notes-door.mjs is the proof). One rule list a set of files, as a later block replaces an earlier one's.
  {
    files: ["app/**/*.{ts,tsx}"],
    ignores: ["app/lib/chat/**", "app/lib/notes/**", "app/lib/pg/**", "app/lib/db.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...CHAT_DOOR, ...NOTES_DOOR],
    },
  },
  { files: ["app/lib/notes/**/*.{ts,tsx}"], rules: { "no-restricted-syntax": ["error", ...CHAT_DOOR] } },
  { files: ["app/lib/chat/**/*.{ts,tsx}"], rules: { "no-restricted-syntax": ["error", ...NOTES_DOOR] } },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Native app shell (Capacitor): its own package, not part of the Next app.
    "mobile/**",
  ]),
]);

export default eslintConfig;
