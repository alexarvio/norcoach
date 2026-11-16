import { timingSafeEqual } from "node:crypto";
import { clerkClient } from "@clerk/nextjs/server";
import { clerkOn } from "../../lib/clerk";
import { isReviewEmail, REVIEW_EMAIL } from "../../lib/reviewAccount";

// The App Review sign-in (16 Nov, Alex): the review address and the fixed code from the server's settings (REVIEW_CODE)
// buy a Clerk sign-in ticket good for a minute, which the sign-in screen signs in with. Off unless REVIEW_CODE is set
// (six characters or more). A handful of wrong codes in an hour locks it until the hour is up.
export const dynamic = "force-dynamic";

const json = (body: object, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

const HOUR = 60 * 60 * 1000;
const MAX_WRONG = 8;
let wrong: number[] = [];

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export async function POST(request: Request) {
  const secret = (process.env.REVIEW_CODE ?? "").trim();
  if (!clerkOn() || secret.length < 6) return json({ error: "off" }, 404);
  let body: { email?: unknown; code?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  const email = typeof body.email === "string" ? body.email : "";
  const code = typeof body.code === "string" ? body.code.trim() : "";
  const now = Date.now();
  wrong = wrong.filter((t) => now - t < HOUR);
  if (wrong.length >= MAX_WRONG) return json({ error: "locked" }, 429);
  if (!isReviewEmail(email) || !same(code, secret)) {
    wrong.push(now);
    return json({ error: "wrong" }, 400);
  }
  try {
    const clerk = await clerkClient();
    const found = await clerk.users.getUserList({ emailAddress: [REVIEW_EMAIL] });
    const user = found.data[0] ?? (await clerk.users.createUser({ emailAddress: [REVIEW_EMAIL], skipPasswordRequirement: true }));
    const token = await clerk.signInTokens.createSignInToken({ userId: user.id, expiresInSeconds: 60 });
    return json({ ticket: token.token });
  } catch (error) {
    console.error("[review sign-in] ticket failed:", error instanceof Error ? error.message : error);
    return json({ error: "ticket" }, 500);
  }
}
