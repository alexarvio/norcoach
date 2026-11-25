import { NextResponse, type NextRequest } from "next/server";
import { verifyWebhook } from "@clerk/nextjs/webhooks";
import { mailConfigured, sendClerkEmailAsWritten, sendCodeEmail, type CodeKind } from "../../../lib/mail";

// Clerk's emails, sent by us in Norcoach's own look (25 Nov, Alex: "I want the email with our design"). In the Clerk
// Dashboard each email template whose "Delivered by Clerk" is switched off is handed here as `email.created` instead
// of being sent; a webhook endpoint at {APP_URL}/api/clerk/webhook subscribed to email.created, its signing secret in
// CLERK_WEBHOOK_SIGNING_SECRET. A code (sign-in, sign-up, new device, password reset) is drawn as ours (codeEmail in
// lib/mail.ts); any other template switched off goes out as Clerk wrote it, so nothing is lost. Sent through Resend
// (RESEND_API_KEY, MAIL_FROM). Only a signed body is read; no session (the proxy lets this path through).
export const dynamic = "force-dynamic";

const CODES: readonly CodeKind[] = ["verification_code", "reset_password_code"];

export async function POST(request: NextRequest) {
  let event;
  try {
    event = await verifyWebhook(request);
  } catch {
    return NextResponse.json({ error: "Bad signature" }, { status: 400 });
  }
  if (event.type !== "email.created") return NextResponse.json({ ok: true });
  const email = event.data;
  // Clerk sent it itself: nothing for us to do.
  if (email.delivered_by_clerk) return NextResponse.json({ ok: true });
  const to = email.to_email_address;
  if (!to) return NextResponse.json({ ok: true });
  // Not set up to send: fail, so Clerk's queue tries again once it is, rather than the code going nowhere quietly.
  if (!mailConfigured()) {
    console.error(`[clerk email] ${email.slug ?? "email"} to ${to}: mail isn't set up (RESEND_API_KEY, MAIL_FROM)`);
    return NextResponse.json({ error: "Mail isn't set up" }, { status: 503 });
  }

  const code = typeof email.data?.otp_code === "string" ? email.data.otp_code : null;
  const kind = CODES.find((k) => k === email.slug);
  const sent =
    kind && code
      ? await sendCodeEmail({ to, code, kind })
      : await sendClerkEmailAsWritten({ to, subject: email.subject ?? "Norcoach", html: email.body ?? "", text: email.body_plain ?? "", what: `clerk ${email.slug ?? "email"}` });
  // A failed send is tried again by Clerk (it retries anything but a 2xx).
  return sent ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "Not sent" }, { status: 502 });
}
