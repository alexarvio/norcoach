import "server-only";
import { clerkOn } from "./clerk";

// Whether Clerk takes passwords, known on the server (18 Nov, Alex: "whenever I open the app, there's email, and then the
// password text box appears a second later"): the sign-in's password box, the coach sign-up's and both Settings' Password
// rows are drawn with the page, not once Clerk has loaded in the browser. Read from Clerk's own public settings (its
// Frontend API, what the browser reads), kept five minutes; past that the one kept still answers at once while the next
// is fetched, so only the very first page after a start waits, and never more than a second and a half. Null when it
// can't tell (Clerk off, not answering): the browser then decides once Clerk has loaded, as before. The browser's own
// reading wins once it has one (usePasswordsOn), so a switch flipped in the Dashboard shows within the page.

const KEEP_MS = 5 * 60_000;
const WAIT_MS = 1_500;
// A read that failed is tried again a minute on, the last answer (or none) given at once meanwhile: only the first read
// after a start is ever waited for.
const RETRY_MS = 60_000;

let kept: { on: boolean | null; at: number } | null = null;
let asking: Promise<boolean | null> | null = null;

/** Clerk's Frontend API host, from the publishable key (pk_live_ or pk_test_, then the host and a `$`, in base64). */
function frontendApi(): string | null {
  const m = /^pk_(?:live|test)_(.+)$/.exec(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? "");
  if (!m) return null;
  const host = Buffer.from(m[1], "base64").toString("utf8").replace(/\$$/, "");
  return /^[a-z0-9.-]+$/i.test(host) ? host : null;
}

async function ask(): Promise<boolean | null> {
  const on = await read();
  if (on === null) {
    kept = { on: kept?.on ?? null, at: Date.now() - KEEP_MS + RETRY_MS };
    return kept.on;
  }
  kept = { on, at: Date.now() };
  return on;
}

async function read(): Promise<boolean | null> {
  const host = frontendApi();
  if (!host) return null;
  try {
    const res = await fetch(`https://${host}/v1/environment`, { cache: "no-store", signal: AbortSignal.timeout(WAIT_MS) });
    if (!res.ok) return null;
    const body = (await res.json()) as { user_settings?: { attributes?: { password?: { enabled?: unknown } } } };
    const on = body.user_settings?.attributes?.password?.enabled;
    return typeof on === "boolean" ? on : null;
  } catch {
    return null;
  }
}

/** True or false as Clerk's settings say; null when it can't tell. */
export async function passwordsOnHint(): Promise<boolean | null> {
  if (!clerkOn()) return null;
  if (!asking && (!kept || Date.now() - kept.at > KEEP_MS)) {
    asking = ask().finally(() => {
      asking = null;
    });
  }
  return kept ? kept.on : asking;
}
