import Link from "next/link";
import { notFound } from "next/navigation";
import { requireClient } from "../../../lib/auth";
import { getInvoiceView, listClientInvoices } from "../../../lib/queries";
import { canPayOnline } from "../../../lib/payments";
import { formatMoney } from "../../../lib/countries";
import InvoiceSheet from "../../../components/InvoiceSheet";
import InvoicePrintButton from "../../../components/InvoicePrintButton";
import PayButton from "./PayButton";
import { Bars } from "../../Bars";
import { dayWords } from "../../../lib/clientDates";
import { noteInvoiceOpened } from "../../../lib/invoiceEvents";
import { autopayOfferFor } from "../../../lib/invoiceCharges";

// One of the client's invoices, the sheet the coach sees, to read, print or
// save as PDF, and to pay online when the coach has Stripe connected
// (lib/payments.ts). Only their own, and only once the coach has sent it.
// Opened from the Invoices screen in the menu; Stripe sends them back here
// with ?paid=1.
//   /client/invoices/12
export const dynamic = "force-dynamic";

export default async function ClientInvoicePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ paid?: string }> }) {
  const { clientId } = await requireClient();
  const { id } = await params;
  const { paid } = await searchParams;
  const invoiceId = Number(id);
  if (!Number.isInteger(invoiceId) || !listClientInvoices(clientId).some((i) => i.id === invoiceId)) notFound();
  const v = getInvoiceView(invoiceId);
  if (!v) notFound();
  // Opened in their app (26 Nov, Alex: the coach's Invoices tab says so), once a day; requireClient lets only the
  // client themselves in here, never a coach looking.
  noteInvoiceOpened(invoiceId, "app");
  // Paid by bank transfer, no Pay (26 Nov, Alex): the bank details on the sheet are how.
  const payable = v.status !== "paid" && !v.refundedAt && v.pays !== "bank" && canPayOnline(v.coachId);
  // On a series charged automatically (26 Nov, Alex): "Pay automatically from now on", as the invoice's own page has it.
  const offer = payable ? autopayOfferFor(invoiceId) : null;
  return (
    <main className="ivp">
      <div className="ivp-bar">
        <Link href="/client?open=invoices" className="ivp-btn">
          ‹ Invoices
        </Link>
        <span className="ivp-state" />
        <InvoicePrintButton />
      </div>
      {paid && v.status !== "paid" && <p className="ivp-thanks">Thank you. Your payment is being confirmed; this invoice shows Paid in a moment.</p>}
      {v.status === "paid" && paid && <p className="ivp-thanks">Paid. Thank you.</p>}
      {payable && !paid && (
        <div className="ivp-paybar">
          <span>
            <Bars
              parts={[
                <b key="t">{formatMoney(v.total, v.currency, v.from.country_code)}</b>,
                v.dueDate && `due ${dayWords(v.dueDate)}`,
              ]}
            />
          </span>
          <PayButton invoiceId={v.id} label={`Pay ${formatMoney(v.total, v.currency, v.from.country_code)}`} auto={offer?.fact ?? null} />
        </div>
      )}
      <InvoiceSheet v={v} />
    </main>
  );
}
