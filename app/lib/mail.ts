// Outgoing email: the client's invite, a password reset, and since 23 Nov each invoice as it reaches the client.
//
// Sent through Resend's HTTP API with a plain fetch, so there is no SDK to
// keep up to date. Off until two variables are set on the server:
//   RESEND_API_KEY  the key from resend.com
//   MAIL_FROM       a sender on a domain verified there, e.g.
//                   "Full Potential Coaching <coach@fullpotential.nl>"
// Until then the New client dialog says email isn't set up and the coach
// hands the login over themselves; nothing pretends to have been sent.

export function mailConfigured(): boolean {
  return !!process.env.RESEND_API_KEY && !!process.env.MAIL_FROM;
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * Who an email is from. The address is always the platform's (MAIL_FROM,
 * on the domain verified at Resend): a coach's own Gmail can't be sent as
 * by anyone but Google. What the client reads is the coach's name, and a
 * reply goes to the coach's own inbox (26 Sep).
 */
function sender(fromName?: string | null): string {
  const from = process.env.MAIL_FROM ?? "";
  const name = fromName?.replace(/["<>\r\n]/g, "").trim();
  if (!name) return from;
  const address = /<([^>]+)>/.exec(from)?.[1] ?? from.trim();
  return `"${name}" <${address}>`;
}

async function send(to: string, subject: string, text: string, html: string, what: string, opts: { fromName?: string | null; replyTo?: string | null } = {}): Promise<boolean> {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: sender(opts.fromName), to: [to], subject, text, html, ...(opts.replyTo ? { reply_to: opts.replyTo } : {}) }),
    });
    if (!res.ok) console.error(`[mail] ${what} to ${to} failed: ${res.status} ${await res.text().catch(() => "")}`);
    return res.ok;
  } catch (error) {
    console.error(`[mail] ${what} failed:`, error instanceof Error ? error.message : error);
    return false;
  }
}

/** A "forgot password" link. Resolves false rather than throwing. */
export async function sendPasswordResetEmail({ to, resetUrl }: { to: string; resetUrl: string }): Promise<boolean> {
  if (!mailConfigured()) return false;
  const text = [
    "Someone asked to reset the password for your Norcoach account.",
    "",
    `Choose a new password: ${resetUrl}`,
    "",
    "The link works once, for the next hour. If you didn't ask for this, ignore this email: your password stays as it is.",
  ].join("\n");
  const html = `<p>Someone asked to reset the password for your Norcoach account.</p>
<p><a href="${escape(resetUrl)}">Choose a new password</a></p>
<p>The link works once, for the next hour. If you didn&rsquo;t ask for this, ignore this email: your password stays as it is.</p>`;
  return send(to, "Reset your Norcoach password", text, html, "password reset");
}

/** The invite's words, as text and as HTML: sent below, and shown on the onboarding board. */
export function inviteEmail({ to, firstName, coachName, password, signInUrl }: { to: string; firstName: string; coachName: string; password: string; signInUrl: string }) {
  const subject = "Your Norcoach login";
  const text = [
    `Hi ${firstName},`,
    "",
    `${coachName} has set up your Norcoach account.`,
    "",
    `Sign in at ${signInUrl}`,
    `Email: ${to}`,
    `Temporary password: ${password}`,
    "",
    "The app asks you to choose your own password the first time you sign in.",
  ].join("\n");
  const html = `<p>Hi ${escape(firstName)},</p>
<p>${escape(coachName)} has set up your Norcoach account.</p>
<p><a href="${escape(signInUrl)}">Sign in to Norcoach</a><br>
Email: <b>${escape(to)}</b><br>
Temporary password: <b style="letter-spacing:0.04em">${escape(password)}</b></p>
<p>The app asks you to choose your own password the first time you sign in.</p>`;
  return { subject, text, html };
}

/** The client's first sign-in details, from the coach by name, answered to the coach. Resolves false rather than throwing: the client exists either way. */
export async function sendInviteEmail({ coachEmail, ...details }: { to: string; firstName: string; coachName: string; coachEmail: string; password: string; signInUrl: string }): Promise<boolean> {
  if (!mailConfigured()) return false;
  const { subject, text, html } = inviteEmail(details);
  return send(details.to, subject, text, html, "invite", { fromName: details.coachName, replyTo: coachEmail });
}

/** What an invoice email says (23 Nov, Alex: Settings, Invoicing & payments, "Invoices by email"). Every figure as the
    invoice has it: the money and the dates already written for the client (lib/invoiceEmails.ts). */
export type InvoiceMail = {
  seller: string;
  number: string;
  what: string;
  amount: string;
  issued: string;
  due: string | null;
  viewUrl: string | null;
  /** Card payment through the coach's own Stripe; null when it isn't on. */
  payUrl: string | null;
  /** How to pay by bank: a label and its value a row ("IBAN", "NL91 ABNA 0417 1643 00"), or the coach's own words. */
  bank: { label: string; value: string }[];
  bankWords: string | null;
  /** The coach's brand colour and the words on it, for the one pill (docs/DESIGN-RULES.md §4); ink with none. */
  brand: { hex: string; ink: string } | null;
};

/** The invoice email's words, as text and as HTML: facts, the money big, one pill (Pay, else View invoice). */
export function invoiceEmail(m: InvoiceMail) {
  const subject = `Invoice ${m.number} from ${m.seller}`;
  const facts: [string, string][] = [["Invoice", m.number], ["For", m.what], ["Issued", m.issued], ...(m.due ? ([["Due", m.due]] as [string, string][]) : [])];
  const text = [
    m.seller,
    "",
    `${m.amount}`,
    ...facts.map(([k, v]) => `${k}: ${v}`),
    "",
    ...(m.payUrl ? [`Pay: ${m.payUrl}`] : []),
    ...(m.viewUrl ? [`View invoice: ${m.viewUrl}`] : []),
    ...(m.bank.length || m.bankWords ? ["", "Bank transfer", ...m.bank.map((b) => `${b.label}: ${b.value}`), ...(m.bankWords ? [m.bankWords] : []), `Reference: ${m.number}`] : []),
    "",
    "Norcoach",
  ].join("\n");

  const font = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const label = `${font};font-size:11px;line-height:16px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:#5b6474`;
  const pillBg = m.brand?.hex ?? "#141a24";
  const pillInk = m.brand?.ink ?? "#ffffff";
  const pill = (href: string, words: string, main: boolean) =>
    `<a href="${escape(href)}" style="display:inline-block;${font};font-size:15px;line-height:20px;font-weight:600;text-decoration:none;border-radius:999px;padding:12px 22px;${main ? `background:${pillBg};color:${pillInk}` : "background:#ffffff;color:#141a24;border:1px solid #DCE1E8"}">${escape(words)}</a>`;
  const row = (k: string, v: string, mono = false) =>
    `<tr><td style="${font};font-size:14px;line-height:20px;font-weight:500;color:#8b93a1;padding:5px 16px 5px 0;vertical-align:top;white-space:nowrap">${escape(k)}</td><td style="${font};font-size:14px;line-height:20px;font-weight:500;color:#141a24;padding:5px 0;vertical-align:top;${mono ? "font-variant-numeric:tabular-nums;" : ""}">${escape(v)}</td></tr>`;
  const buttons = [m.payUrl ? pill(m.payUrl, `Pay ${m.amount}`, true) : "", m.viewUrl ? pill(m.viewUrl, "View invoice", !m.payUrl) : ""].filter(Boolean);
  const bank = m.bank.length || m.bankWords;
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#F5F6F8">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F6F8"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border:1px solid #E1E5EB;border-radius:20px">
<tr><td style="padding:28px 28px 0">
<div style="${label}">Invoice</div>
<div style="${font};font-size:16px;line-height:22px;font-weight:600;color:#141a24;padding-top:6px">${escape(m.seller)}</div>
<div style="${font};font-size:34px;line-height:40px;font-weight:600;color:#141a24;padding-top:18px;font-variant-numeric:tabular-nums">${escape(m.amount)}</div>
</td></tr>
<tr><td style="padding:14px 28px 0"><table role="presentation" cellpadding="0" cellspacing="0">${facts.map(([k, v]) => row(k, v, k !== "For")).join("")}</table></td></tr>
${buttons.length ? `<tr><td style="padding:24px 28px 0">${buttons.join('<span style="display:inline-block;width:8px"></span>')}</td></tr>` : ""}
${
  bank
    ? `<tr><td style="padding:28px 28px 0"><div style="${label}">Bank transfer</div><table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:8px">${m.bank.map((b) => row(b.label, b.value, true)).join("")}${row("Reference", m.number, true)}</table>${m.bankWords ? `<div style="${font};font-size:14px;line-height:20px;font-weight:500;color:#3a4250;padding-top:6px;white-space:pre-wrap">${escape(m.bankWords)}</div>` : ""}</td></tr>`
    : ""
}
<tr><td style="padding:28px"></td></tr>
</table>
<div style="${font};font-size:12px;line-height:16px;font-weight:500;color:#98A2B3;padding-top:16px">Norcoach</div>
</td></tr></table>
</body></html>`;
  return { subject, text, html };
}

/** One invoice to the client, from the coach by name, answered to the coach. Resolves false rather than throwing. */
export async function sendInvoiceEmail({ to, replyTo, ...m }: InvoiceMail & { to: string; replyTo: string | null }): Promise<boolean> {
  if (!mailConfigured()) return false;
  const { subject, text, html } = invoiceEmail(m);
  return send(to, subject, text, html, "invoice", { fromName: m.seller, replyTo });
}

/** Where the website's applications go (28 Oct, Alex: "email me"): APPLY_TO_EMAIL, else the owner's. */
export function applyInbox(): string | null {
  return process.env.APPLY_TO_EMAIL?.trim() || process.env.OWNER_EMAIL?.trim() || null;
}

export type Application = { name: string; email: string; business: string; clients: string; uses: string[]; hardest: string };

/** One founding-coach application from norcoachapp.com, to the inbox above, a reply going to the coach. False rather than throwing. */
export async function sendApplicationEmail(a: Application): Promise<boolean> {
  const to = applyInbox();
  if (!mailConfigured() || !to) return false;
  const rows: [string, string][] = [
    ["Name", a.name],
    ["Email", a.email],
    ["Business", a.business || "–"],
    ["Clients", a.clients || "–"],
    ["Uses today", a.uses.join(", ") || "–"],
    ["What causes friction in their business", a.hardest || "–"],
  ];
  const text = rows.map(([k, v]) => `${k}: ${v}`).join("\n") + "\n\nReply to this email to answer them.";
  const html = `<table style="border-collapse:collapse;font:15px/1.5 system-ui,sans-serif">${rows
    .map(([k, v]) => `<tr><td style="padding:4px 16px 4px 0;color:#5b6474;vertical-align:top">${escape(k)}</td><td style="padding:4px 0;white-space:pre-wrap">${escape(v)}</td></tr>`)
    .join("")}</table><p style="font:14px system-ui,sans-serif;color:#5b6474">Reply to this email to answer them.</p>`;
  return send(to, `Founding coach application: ${a.name}${a.clients ? ` (${a.clients} clients)` : ""}`, text, html, "application", { fromName: "Norcoach website", replyTo: a.email });
}

/** A coach who signed up is let in by the owner. Resolves false rather than throwing: they are in either way. */
export async function sendCoachApprovedEmail({ to, name, signInUrl }: { to: string; name: string; signInUrl: string }): Promise<boolean> {
  if (!mailConfigured()) return false;
  const first = name.split(" ")[0] || name;
  const text = [`Hi ${first},`, "", "Your Norcoach coach account is ready.", "", `Sign in: ${signInUrl}`].join("\n");
  const html = `<p>Hi ${escape(first)},</p>
<p>Your Norcoach coach account is ready.</p>
<p><a href="${escape(signInUrl)}">Sign in to Norcoach</a></p>`;
  return send(to, "You're in: your Norcoach coach account", text, html, "coach approved", { fromName: "Norcoach" });
}

/** The kinds of code Clerk asks us to send once its own delivery is off (Clerk Dashboard, Emails, each template's
 *  "Delivered by Clerk"): a sign-in, sign-up or new-device code, and a password reset's. */
export type CodeKind = "verification_code" | "reset_password_code";

/**
 * A sign-in code in Norcoach's own look (25 Nov, Alex: "I want the email with our design", then B of
 * docs/boards/code-email-mockup.html, "dark frame"), in place of Clerk's: the sign-in screen's dark head holding the logo
 * and the title, the paper rising over its foot with round corners, the code big at 600 in tabular figures under a small
 * caps label, one line on what it is for and one on ignoring it. The rail's big faint star behind the head, cut off at
 * its right edge (25 Nov, Alex). No IP address or place (Clerk's said "requested from 2001:fb1…,
 * Bangkok"). The code is in the subject too, so a phone's notification shows it.
 */
export function codeEmail({ code, kind }: { code: string; kind: CodeKind }) {
  const reset = kind === "reset_password_code";
  const subject = reset ? `${code} is your Norcoach password reset code` : `${code} is your Norcoach code`;
  const title = reset ? "Reset your password" : "Your sign-in code";
  const line = reset ? "Type it in Norcoach to choose a new password." : "Type it in Norcoach to carry on.";
  const ignore = "Didn't ask for it? You can ignore this email.";
  const text = [title, "", code, "", line, "", ignore, "", "Norcoach"].join("\n");

  const font = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const site = (process.env.APP_URL ?? "https://app.norcoachapp.com").replace(/\/$/, "");
  const logo = `${site}/brand/email-logo.png`;
  // The rail's big faint star, a third past the head's right edge (25 Nov, Alex); brand/build-email-star.mjs.
  const star = `${site}/brand/email-star.png`;
  const dark = "#141a24";
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"></head><body style="margin:0;padding:0;background:#F5F6F8">
<div style="display:none;max-height:0;overflow:hidden">${escape(line)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F6F8"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#ffffff;border-radius:20px;border-collapse:separate;overflow:hidden">
<tr><td bgcolor="${dark}" style="background-color:${dark};background-image:url(${escape(star)});background-repeat:no-repeat;background-position:right top;background-size:113px 177px;padding:26px 28px 34px;border-radius:20px 20px 0 0">
<img src="${escape(logo)}" width="120" height="24" alt="Norcoach" style="display:block;border:0;width:120px;height:24px">
<div style="${font};font-size:26px;line-height:32px;font-weight:600;color:#ffffff;padding-top:26px">${escape(title)}</div>
</td></tr>
<tr><td style="background:${dark};padding:0;line-height:0;font-size:0"><div style="background:#ffffff;border-radius:28px 28px 0 0;height:28px;line-height:28px;font-size:0">&nbsp;</div></td></tr>
<tr><td style="padding:2px 28px 0">
<div style="${font};font-size:11px;line-height:16px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:#5b6474">${reset ? "Reset code" : "Code"}</div>
<div style="${font};font-size:42px;line-height:50px;font-weight:600;color:#141a24;letter-spacing:.14em;padding-top:6px;font-variant-numeric:tabular-nums">${escape(code)}</div>
<div style="${font};font-size:15px;line-height:22px;font-weight:500;color:#3a4250;padding-top:16px">${escape(line)}</div>
</td></tr>
<tr><td style="padding:28px 28px 30px">
<div style="${font};font-size:13px;line-height:19px;font-weight:500;color:#8b93a1">${escape(ignore)}</div>
</td></tr>
</table>
<div style="${font};font-size:12px;line-height:16px;font-weight:500;color:#98A2B3;padding-top:16px">Norcoach</div>
</td></tr></table>
</body></html>`;
  return { subject, text, html };
}

/** A code Clerk handed us to send, as Norcoach. False rather than throwing. */
export async function sendCodeEmail({ to, code, kind }: { to: string; code: string; kind: CodeKind }): Promise<boolean> {
  if (!mailConfigured()) return false;
  const { subject, text, html } = codeEmail({ code, kind });
  return send(to, subject, text, html, kind, { fromName: "Norcoach" });
}

/** Any other email Clerk handed us (a template we haven't drawn): sent as Clerk wrote it, so nothing goes missing. */
export async function sendClerkEmailAsWritten({ to, subject, html, text, what }: { to: string; subject: string; html: string; text: string; what: string }): Promise<boolean> {
  if (!mailConfigured()) return false;
  return send(to, subject, text, html, what, { fromName: "Norcoach" });
}
