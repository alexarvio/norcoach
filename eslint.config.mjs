import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // The chat's one door (18 Nov, Step 5 of docs/database-plan.md): the store's chat rows are reached through
  // app/lib/chat/rows.ts alone. Editor feedback; the build's own proof is tsc (a sealed type) and scripts/check-chat-door.mjs.
  {
    files: ["app/**/*.{ts,tsx}"],
    ignores: ["app/lib/chat/**", "app/lib/pg/**", "app/lib/db.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        { selector: "MemberExpression[property.name='chat_messages']", message: "Chat rows go through app/lib/chat/rows.ts (the one door)." },
        { selector: "MemberExpression[computed=true][property.value='chat_messages']", message: "Chat rows go through app/lib/chat/rows.ts (the one door)." },
        { selector: "TSIndexedAccessType[indexType.literal.value='chat_messages']", message: "Chat rows go through app/lib/chat/rows.ts (the one door)." },
      ],
    },
  },
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
