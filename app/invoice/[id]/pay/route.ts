import { getRequestUser } from "../../../lib/auth";
import { getData } from "../../../lib/db";
import { getInvoiceView } from "../../../lib/queries";
import { checkoutForInvoice } from "../../../lib/invoiceCheckouts";
import { invoicePayTokenOk, invoiceViewUrl } from "../../../lib/invoicePayLink";
import { invoicePayPage } from "../../../lib/invoicePayPage";

// Pay, from an invoice email (23 Nov, Alex: "ok do the stripe also"; lib/invoiceCheckouts.ts): on to Stripe's hosted
// checkout for this invoice on the coach's own account, the same open checkout again on a second tap. For the client
// signed in whose invoice it is, or anyone holding the email's signed link for this one invoice (lib/invoicePayLink.ts);
// anyone else gets the same "not here" as an invoice that doesn't exist, so a guess learns nothing. Only an invoice the
// coach has sent; a paid one says Paid.
//   /invoice/12/pay?t=12.<signature>
export const dynamic = "force-dynamic";

const nothing = () => invoicePayPage(null, { state: "Not found", tone: "grey", status: 404 });

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const invoiceId = Number(id);
  if (!Number.isInteger(invoiceId) || invoiceId <= 0) return nothing();
  const inv = getData().invoices.find((i) => i.id === invoiceId);
  if (!inv || inv.status === "unpaid") return nothing();
  const token = new URL(request.url).searchParams.get("t");
  let allowed = invoicePayTokenOk(invoiceId, token);
  if (!allowed) {
    const user = await getRequestUser(request).catch(() => null);
    allowed = !!user && user.role === "client" && user.client_id === inv.client_id;
  }
  if (!allowed) return nothing();

  const v = getInvoiceView(invoiceId);
  const view = invoiceViewUrl(invoiceId);
  const answer = await checkoutForInvoice(invoiceId);
  if ("url" in answer) return new Response(null, { status: 303, headers: { Location: answer.url, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  if ("paid" in answer) return invoicePayPage(v, { state: "Paid", tone: "good", link: view ? { href: view, words: "View invoice" } : null });
  return invoicePayPage(v, { state: answer.error, tone: "rust", pill: view ? { href: view, words: "View invoice" } : null });
}
