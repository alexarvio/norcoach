import { getRequestUser } from "../../../lib/auth";
import { getData } from "../../../lib/db";
import { getInvoiceView } from "../../../lib/queries";
import { confirmInvoiceCheckout } from "../../../lib/invoiceCheckouts";
import { invoicePageUrl, invoicePayTokenOk, invoicePayUrl, invoiceViewUrl } from "../../../lib/invoicePayLink";
import { invoicePayPage } from "../../../lib/invoicePayPage";

// Back from Stripe's checkout for an invoice (lib/invoiceCheckouts.ts). With the checkout's id (paid): Stripe is asked
// about that checkout on the coach's account, and the invoice is marked Paid when it is paid and is this invoice's, as
// the webhook would (nothing twice); without one (the client went back): Not paid, with Pay again. The client signed in
// whose invoice it is lands on their own invoice page; someone holding the email's signed link sees this small page.
//   /invoice/12/paid?t=12.<signature>&session_id=cs_…
export const dynamic = "force-dynamic";

const nothing = () => invoicePayPage(null, { state: "Not found", tone: "grey", status: 404 });

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const invoiceId = Number(id);
  if (!Number.isInteger(invoiceId) || invoiceId <= 0) return nothing();
  const inv = getData().invoices.find((i) => i.id === invoiceId);
  if (!inv || inv.status === "unpaid") return nothing();
  const url = new URL(request.url);
  const session = url.searchParams.get("session_id");
  // Marking it paid needs no one's sign-in: it is Stripe's own word on a checkout made for this invoice.
  const state = session ? await confirmInvoiceCheckout(invoiceId, session) : null;

  const user = await getRequestUser(request).catch(() => null);
  const own = !!user && user.role === "client" && user.client_id === inv.client_id;
  const view = invoiceViewUrl(invoiceId);
  // "Being confirmed" only on Stripe's own word that this checkout went through; an unread or unknown one is not paid.
  const through = state === "paid" || state === "pending";
  if (own && view) return new Response(null, { status: 303, headers: { Location: through ? `${view}?paid=1` : view, "Cache-Control": "no-store" } });
  if (!own && !invoicePayTokenOk(invoiceId, url.searchParams.get("t"))) return state === "paid" ? invoicePayPage(null, { state: "Paid", tone: "good" }) : nothing();

  // Someone with the email's link lands back on the invoice's own page (26 Nov, Alex), paid or not.
  const page = invoicePageUrl(invoiceId, through ? { paid: "1" } : {});
  if (page) return new Response(null, { status: 303, headers: { Location: page, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  const v = getInvoiceView(invoiceId);
  const link = view ? { href: view, words: "View invoice" } : null;
  if (v?.status === "paid") return invoicePayPage(v, { state: "Paid", tone: "good", link });
  if (state === "pending") return invoicePayPage(v, { state: "Payment on its way", tone: "grey", link });
  const pay = invoicePayUrl(invoiceId);
  return invoicePayPage(v, { state: "Not paid", tone: "grey", pill: pay ? { href: pay, words: "Pay" } : null, link });
}
