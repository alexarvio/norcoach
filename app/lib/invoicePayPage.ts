import "server-only";
import { getData } from "./db";
import { getCoachProfile, type InvoiceView } from "./queries";
import { nameParts } from "./coachNames";
import { countryCodeFromName, countryOf, formatMoney } from "./countries";
import { brandColour } from "./brandColour";

// The one small page around paying an invoice from its email (/invoice/<id>/pay and /paid): where it stands, for a
// client who may not be signed in. The pushed screens' voice (docs/DESIGN-RULES.md): the page colour, one white card
// with a hairline, a small caps label, the business at 600, the amount big, the state in its colour (Paid green), and
// one pill (the coach's brand colour, else ink). No sentences: facts.

/** Who bills the client, by name: the business on the invoice, else its legal name, else the coach by first name,
 *  else `Coach` (docs/DESIGN-RULES.md §8: never "your coach", and never Norcoach, which bills no one). */
export function sellerOf(v: InvoiceView | null): string {
  const f = v?.from;
  const named = f?.business_name?.trim() || f?.legal_name?.trim();
  if (named) return named;
  if (v?.coachId == null) return "Coach";
  const coach = getData().users.find((u) => u.id === v.coachId && u.role === "coach");
  return nameParts(coach?.coach_settings, getCoachProfile(v.coachId)?.display_name).first || "Coach";
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function invoicePayPage(v: InvoiceView | null, o: { state: string; tone: "good" | "grey" | "rust"; pill?: { href: string; words: string } | null; link?: { href: string; words: string } | null; status?: number }): Response {
  const f = v?.from ?? {};
  const cc = countryOf(f.country_code || countryCodeFromName(f.country)).code;
  const seller = sellerOf(v);
  const coach = v?.coachId != null ? getData().users.find((u) => u.id === v.coachId && u.role === "coach") : undefined;
  const b = coach?.coach_settings?.brand?.color ? brandColour(coach.coach_settings.brand.color) : null;
  const tone = o.tone === "good" ? "#2f7a3f" : o.tone === "rust" ? "#b8471f" : "#8b93a1";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(v ? `Invoice ${v.number}` : "Invoice")}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600&display=swap">
<style>
:root{--ink:#141a24;--body:#3a4250;--faint:#8b93a1;--line:#E1E5EB}
*{box-sizing:border-box}
body{margin:0;background:#F5F6F8;color:var(--ink);font:500 15px/1.4 Archivo,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-tap-highlight-color:transparent}
main{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:32px 16px}
.c{width:100%;max-width:420px;background:#fff;border-radius:20px;box-shadow:inset 0 0 0 1px var(--line);padding:28px}
.l{font-size:11px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:#5b6474}
.s{font-size:16px;font-weight:600;margin-top:6px}
.a{font-size:34px;line-height:40px;font-weight:600;margin-top:18px;font-variant-numeric:tabular-nums}
.st{margin-top:8px;font-size:13px;font-weight:600;color:${tone}}
.f{display:flex;gap:8px;flex-wrap:wrap;margin-top:24px}
.p{display:inline-flex;align-items:center;height:44px;padding:0 22px;border-radius:999px;font-weight:600;text-decoration:none;background:${b?.hex ?? "#141a24"};color:${b?.ink ?? "#fff"}}
.w{display:inline-flex;align-items:center;height:44px;padding:0 22px;border-radius:999px;font-weight:600;text-decoration:none;background:#fff;color:var(--ink);box-shadow:inset 0 0 0 1px #DCE1E8}
</style></head><body><main><div class="c">
<div class="l">${esc(v ? `Invoice ${v.number}` : "Invoice")}</div>
<div class="s">${esc(seller)}</div>
${v ? `<div class="a">${esc(formatMoney(v.total, v.currency, cc))}</div>` : ""}
<div class="st">${esc(o.state)}</div>
${o.pill || o.link ? `<div class="f">${o.pill ? `<a class="p" href="${esc(o.pill.href)}">${esc(o.pill.words)}</a>` : ""}${o.link ? `<a class="w" href="${esc(o.link.href)}">${esc(o.link.words)}</a>` : ""}</div>` : ""}
</div></main></body></html>`;
  return new Response(html, { status: o.status ?? 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}
