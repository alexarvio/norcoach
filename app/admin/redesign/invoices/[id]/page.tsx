import Link from "next/link";
import { notFound } from "next/navigation";
import { coachForClient, requireCoach } from "../../../../lib/auth";
import { getData } from "../../../../lib/db";
import { clientIdForInvoice } from "../../../../lib/tenancy";
import { getInvoiceView } from "../../../../lib/queries";
import InvoiceSheet from "../../../../components/InvoiceSheet";
import InvoicePrintButton from "../../../../components/InvoicePrintButton";
import { countryCodeFromName, countryOf, hasBankDetails } from "../../../../lib/countries";
import { startTiming } from "../../../../lib/timing";
import { invoiceStateOf, type InvoiceState } from "../../../../lib/invoiceEvents";

// The pill's word and look for the state the invoice is in (26 Nov, Alex: it said Sent on a paid invoice): one source,
// lib/invoiceEvents.ts, as the Invoices tab.
const STATE_PILL: Record<InvoiceState, { word: string; look: string }> = {
  not_sent: { word: "Not sent", look: "" },
  sent: { word: "Sent", look: " live" },
  pending: { word: "Pending", look: " live" },
  overdue: { word: "Overdue", look: " warn" },
  charge_failed: { word: "Charge failed", look: " warn" },
  paid: { word: "Paid", look: " good" },
  refunded: { word: "Refunded", look: "" },
};

// One invoice as it prints, for the coach: the sheet (components/InvoiceSheet)
// with a bar above it. While it is "Not sent" it reads Settings live and
// says what Settings still lacks; once sent, the details frozen onto it.
// Opened from the client's Invoices tab.
//   /invoices/12
export const dynamic = "force-dynamic";

export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  // Each loader timed (app/lib/timing.ts, /api/timing): measuring only, the page is what it was.
  const t = startTiming("invoice");
  const { id } = await params;
  const invoiceId = Number(id);
  // The coach's own client's invoice, or one they kept after the client was deleted (its client_id points at no
  // client then, and coach_id says whose it is; Business lists those as owed, 21 Oct).
  if (!Number.isInteger(invoiceId)) notFound();
  const ownsClient = !!(await t.time("auth", () => coachForClient(clientIdForInvoice(invoiceId))));
  const keptForCoach = !ownsClient && getData().invoices.find((i) => i.id === invoiceId)?.coach_id === (await t.time("auth", () => requireCoach())).id;
  if (!ownsClient && !keptForCoach) notFound();
  const v = t.time("invoiceView", () => getInvoiceView(invoiceId));
  if (!v) notFound();
  t.client(v.clientId);
  const row = getData().invoices.find((i) => i.id === invoiceId);
  const pill = STATE_PILL[row ? invoiceStateOf(row) : v.frozen ? "sent" : "not_sent"];
  const f = v.from;
  const missing = [!f.business_name && "business name", !(f.address && f.city) && "address", !hasBankDetails(f, countryOf(f.country_code || countryCodeFromName(f.country))) && "bank details"].filter(Boolean) as string[];

  // The admin's own bar (16 Nov, Alex: the audit; it was the old navy boxes and a sentence on how sending works): a
  // ghost back link, the state as its pill (Not sent grey, Sent ink), Print the ink pill; what Settings lacks a short rust
  // fact with its fix, as the Invoices tab says it. `.ivp-admin` in components/invoice-sheet.css.
  return t.end(
    <main className="ivp ivp-admin">
      <div className="ivp-bar">
        <Link href={`/clients/${v.clientId}/invoices`} className="ivp-back">
          ‹ Invoices
        </Link>
        <span className="ivp-state">
          <span className={`ivp-statepill${pill.look}`}>{pill.word}</span>
        </span>
        <InvoicePrintButton label="Print" />
      </div>
      {missing.length > 0 && !v.frozen && (
        <p className="ivp-missing">
          Missing from Settings: {missing.join(", ")}.
          <Link className="ivp-fix" href={missing.length === 1 && missing[0] === "bank details" ? "/settings#invoicing" : "/settings#business"}>
            Add them
          </Link>
        </p>
      )}
      <InvoiceSheet v={v} />
    </main>
  );
}
