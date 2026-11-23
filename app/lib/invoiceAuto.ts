import "server-only";
import { getData, persist } from "./db";

// What a coach's invoices do by themselves (23 Nov, Alex: docs/boards/settings-harmony-mockup.html, Invoicing &
// payments): "Invoices by email", each invoice emailed to the client as it is sent, on unless switched off; and "When a
// plan is assigned", billing started the day a client gets a priced plan, off unless switched on. A row a coach, only
// once one is changed; a coach with none reads the defaults. Not a Postgres table of its own: a top-level value of the
// store, kept in `kv` as every such value is (lib/healthOn.ts).

export type InvoiceAuto = { emailInvoices: boolean; billOnPlan: boolean };
type InvoiceAutoRow = InvoiceAuto & { coach_id: number; at: string };
type WithInvoiceAuto = { invoice_auto?: InvoiceAutoRow[] };

export const INVOICE_AUTO_DEFAULTS: InvoiceAuto = { emailInvoices: true, billOnPlan: false };

const rows = (): InvoiceAutoRow[] => {
  const data = getData() as unknown as WithInvoiceAuto;
  if (!Array.isArray(data.invoice_auto)) data.invoice_auto = [];
  return data.invoice_auto;
};

/** This coach's two switches, the defaults where they never changed one. */
export function getInvoiceAuto(coachId: number): InvoiceAuto {
  const row = rows().find((r) => r.coach_id === coachId);
  return {
    emailInvoices: typeof row?.emailInvoices === "boolean" ? row.emailInvoices : INVOICE_AUTO_DEFAULTS.emailInvoices,
    billOnPlan: typeof row?.billOnPlan === "boolean" ? row.billOnPlan : INVOICE_AUTO_DEFAULTS.billOnPlan,
  };
}

/** Changes one or both switches; a write only when something changes. Returns what they are now. */
export function setInvoiceAuto(coachId: number, patch: Partial<InvoiceAuto>): InvoiceAuto {
  const now = getInvoiceAuto(coachId);
  const next: InvoiceAuto = {
    emailInvoices: typeof patch.emailInvoices === "boolean" ? patch.emailInvoices : now.emailInvoices,
    billOnPlan: typeof patch.billOnPlan === "boolean" ? patch.billOnPlan : now.billOnPlan,
  };
  if (next.emailInvoices === now.emailInvoices && next.billOnPlan === now.billOnPlan) return now;
  const list = rows();
  const was = list.find((r) => r.coach_id === coachId);
  const at = new Date().toISOString();
  if (was) Object.assign(was, next, { at });
  else list.push({ coach_id: coachId, ...next, at });
  persist();
  return next;
}

/** A coach erased: their row goes too. */
export function dropInvoiceAuto(coachId: number): void {
  const data = getData() as unknown as WithInvoiceAuto;
  if (!data.invoice_auto?.some((r) => r.coach_id === coachId)) return;
  data.invoice_auto = data.invoice_auto.filter((r) => r.coach_id !== coachId);
  persist();
}
