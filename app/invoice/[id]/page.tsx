import { notFound } from "next/navigation";
import type { CSSProperties } from "react";
import { getSessionUser } from "../../lib/auth";
import { getData } from "../../lib/db";
import { getCoachProfile, getInvoiceView } from "../../lib/queries";
import { invoicePayTokenOk } from "../../lib/invoicePayLink";
import { sellerOf } from "../../lib/invoicePayPage";
import { canPayOnline } from "../../lib/payments";
import { stripeConfigured } from "../../lib/stripe";
import { invoiceEventsOf, invoiceStateOf, noteInvoiceOpened, OWED_STATES } from "../../lib/invoiceEvents";
import { autopayOfferFor, autopayWordsFor } from "../../lib/invoiceCharges";
import { countryCodeFromName, countryOf, formatMoney } from "../../lib/countries";
import { brandVars } from "../../lib/brandColour";
import { coachMark } from "../../lib/brandMark";
import { dayWords } from "../../lib/clientDates";
import { Bars } from "../../client/Bars";
import DoneCheck from "../../components/DoneCheck";
import { NorCoachLogo } from "../../components/NorCoachLogo";
import "./invoice-page.css";

// Our own invoice page in the browser (26 Nov, Alex: docs/boards/client-invoices-mockup.html, A: "every invoice email
// (and Invoices in Alex's app) links to our own page"), for a client who may not be signed in: opened by the email's
// signed link for this one invoice (lib/invoicePayLink.ts), or by the client signed in whose invoice it is; anyone else
// gets "not found", as an invoice that doesn't exist. In the client app's voice and the coach's brand: the coach's dark
// head (their colour, their logo faint in it) with their business and name, the amount due big, when it is due and
// was issued, the lines with their sums, and Pay (the brand pill, on to Stripe's checkout on the coach's own account,
// /invoice/<id>/pay); on a series charged automatically, "Pay automatically from now on" to tick with what it means
// grey under it. Paid by bank transfer, the bank details in Pay's place. Paid, the done check and how. Its opening is
// kept in the invoice's history ("opened, in the browser"), once a day, never for a coach looking.
//   /invoice/12?t=12.<signature>
export const dynamic = "force-dynamic";
export const metadata = { title: "Invoice", robots: { index: false, follow: false } };

const PAID_BY: Record<string, string> = { card: "Card", ideal: "iDEAL", apple_pay: "Apple Pay", sepa_debit: "SEPA debit", bank: "Bank transfer", cash: "Cash", other: "Paid by hand" };
const spaced = (s: string) => s.replace(/\s+/g, "").replace(/(.{4})/g, "$1 ").trim();

export default async function InvoiceWebPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ t?: string; paid?: string }> }) {
  const { id } = await params;
  const { t, paid } = await searchParams;
  const invoiceId = Number(id);
  if (!Number.isInteger(invoiceId) || invoiceId <= 0) notFound();
  const inv = getData().invoices.find((i) => i.id === invoiceId);
  if (!inv || inv.status === "unpaid") notFound();
  const signed = invoicePayTokenOk(invoiceId, t);
  const user = await getSessionUser().catch(() => null);
  const own = !!user && user.role === "client" && user.client_id === inv.client_id;
  if (!signed && !own) notFound();
  const v = getInvoiceView(invoiceId);
  if (!v) notFound();
  // Opened, in the browser: by the client, never a coach (signed in as one) looking at the link.
  if (!user || user.role === "client") noteInvoiceOpened(invoiceId, "browser");

  const events = invoiceEventsOf(inv);
  const state = invoiceStateOf(inv, undefined, events);
  const f = v.from;
  const cc = countryOf(f.country_code || countryCodeFromName(f.country)).code;
  const m = (n: number) => formatMoney(n, v.currency, cc);
  const coach = v.coachId != null ? getData().users.find((u) => u.id === v.coachId && u.role === "coach") : undefined;
  const coachName = v.coachId != null ? getCoachProfile(v.coachId)?.display_name?.trim() || "" : "";
  const business = sellerOf(v);
  const mark = coachMark(v.coachId);
  const style = { ...brandVars(coach?.coach_settings?.brand?.color), ...(mark ? { "--bg-mark": `url("${mark}")` } : {}) } as CSSProperties;

  const owed = OWED_STATES.includes(state);
  const byBank = v.pays === "bank";
  const payable = owed && state !== "pending" && !byBank && stripeConfigured() && canPayOnline(v.coachId);
  const offer = payable ? autopayOfferFor(invoiceId) : null;
  const kept = autopayWordsFor(invoiceId);
  // How it was paid, as its history says it ("Visa •••• 4242"), else the way it was marked.
  const paidEvent = [...events].reverse().find((e) => e.kind === "paid" || e.kind === "marked_paid");
  const paidHow = paidEvent?.detail || (inv.paid_method ? PAID_BY[inv.paid_method] : inv.paid_via === "manual" ? PAID_BY.bank : "");
  const onItsWay = state === "pending" || (!!paid && owed);

  // The bank details as the sheet prints them, for a series paid by bank transfer (or when Pay isn't on).
  const country = countryOf(f.country_code || countryCodeFromName(f.country));
  const bank: { label: string; value: string }[] = [];
  const holder = f.account_holder || f.legal_name || f.business_name;
  if (country.bank === "us" && f.routing_number) bank.push({ label: "Routing number", value: f.routing_number }, { label: "Account", value: f.account_number ?? "" });
  else if (country.bank === "au" && f.bsb) bank.push({ label: "BSB", value: f.bsb }, { label: "Account", value: f.account_number ?? "" });
  else if (country.bank === "uk" && f.sort_code) bank.push({ label: "Sort code", value: f.sort_code }, { label: "Account", value: f.account_number ?? "" });
  if (f.iban) bank.push({ label: "IBAN", value: spaced(f.iban) }, ...(f.bic ? [{ label: "BIC", value: f.bic }] : []));
  const bankWords = !bank.length && f.bank_details?.trim() ? f.bank_details.trim() : null;
  if (holder && (bank.length || bankWords)) bank.unshift({ label: "Account holder", value: holder });
  if (bank.length || bankWords) bank.push({ label: "Reference", value: v.number });
  const showBank = owed && !payable && (bank.length > 0 || !!bankWords);

  return (
    <main className="ivw" style={style}>
      <div className="ivw-card">
        <header className="ivw-dark">
          <div className="ivw-label">Invoice {v.number}</div>
          <div className="ivw-business">{business}</div>
          {coachName && coachName !== business && <div className="ivw-coach">{coachName}</div>}
        </header>
        <section className="ivw-paper">
          {state === "paid" ? (
            <div className="ivw-paid">
              <DoneCheck size={32} label="Paid" />
              <span>
                <Bars parts={[v.paidAt ? `Paid ${dayWords(v.paidAt)}` : "Paid", paidHow]} />
              </span>
            </div>
          ) : state === "refunded" ? (
            <div className="ivw-state">{v.refundedAt ? `Refunded ${dayWords(v.refundedAt)}` : "Refunded"}</div>
          ) : (
            <>
              <div className="ivw-small">Amount due</div>
              <div className="ivw-amount">{m(v.total)}</div>
            </>
          )}
          <div className="ivw-facts">
            <Bars parts={[owed && v.dueDate ? <span key="d" className={state === "overdue" ? "ivw-late" : undefined}>Due {dayWords(v.dueDate, { weekday: "short" })}</span> : null, `Issued ${dayWords(v.issueDate, { weekday: "short" })}`]} />
          </div>
          {onItsWay && state !== "paid" && <div className="ivw-way">Payment on its way</div>}

          <div className="ivw-lines">
            {v.lines.map((l, i) => (
              <div key={i} className="ivw-line">
                <span>
                  {l.description}
                  {l.quantity !== 1 && <small>{`${l.quantity} × ${m(l.unit_price)}`}</small>}
                </span>
                <b>{m(l.quantity * l.unit_price)}</b>
              </div>
            ))}
            {v.vatRate > 0 && (
              <>
                <div className="ivw-sum">
                  <span>Subtotal</span>
                  <b>{m(v.subtotal)}</b>
                </div>
                <div className="ivw-sum">
                  <span>{`${v.taxLabel} ${v.vatRate}%`}</span>
                  <b>{m(v.vat)}</b>
                </div>
              </>
            )}
            <div className="ivw-sum total">
              <span>Total</span>
              <b>{m(v.total)}</b>
            </div>
          </div>

          {payable && !onItsWay && (
            <form className="ivw-pay" method="get" action={`/invoice/${invoiceId}/pay`}>
              {signed && t && <input type="hidden" name="t" value={t} />}
              {offer && (
                <label className="ivw-auto">
                  <input type="checkbox" name="auto" value="1" />
                  <span>
                    Pay automatically from now on
                    <small>{offer.fact}</small>
                  </span>
                </label>
              )}
              <button type="submit" className="ivw-btn">{`Pay ${m(v.total)}`}</button>
              <div className="ivw-methods">
                <Bars parts={["Card", v.currency.toUpperCase() === "EUR" ? "iDEAL" : null, "Apple Pay"]} />
              </div>
              {kept && (
                <div className="ivw-methods">
                  <Bars parts={["Automatic", kept]} />
                </div>
              )}
            </form>
          )}

          {showBank && (
            <div className="ivw-bank">
              <div className="ivw-small">Bank transfer</div>
              {bank.map((b) => (
                <div key={b.label} className="ivw-sum">
                  <span>{b.label}</span>
                  <b>{b.value}</b>
                </div>
              ))}
              {bankWords && <p className="ivw-words">{bankWords}</p>}
            </div>
          )}
        </section>
      </div>
      <footer className="ivw-foot">
        <span>Powered by</span>
        <NorCoachLogo word />
      </footer>
    </main>
  );
}
