"use server";

import { coachForClient } from "./auth";
import { coachIdOfClient } from "./tenancy";
import { localDateStr } from "./queries";
import { getData } from "./db";
import { createInvoiceAction } from "./actions";
import { clientPlanBilling, clientPlanId } from "./coachPlans";
import { getInvoiceAuto } from "./invoiceAuto";
import { emailInvoiceInBackground } from "./invoiceEmails";

// When a plan is assigned (23 Nov, Alex: docs/boards/settings-harmony-mockup.html, Settings, Invoicing & payments,
// "Start billing when a client gets a plan", off unless switched on; lib/invoiceAuto.ts): picking a priced plan for a
// client in their Details starts billing it as the Invoices tab's Start billing does, through the same action
// (createInvoiceAction with the plan): the first invoice today, Sent, so it reaches the client (and their email), and
// the series on the plan's rhythm after it. Only while nothing bills the client yet: a series already there moves with
// the plan (setClientPlan) and none is added beside it.

/** After a plan pick in Details: starts billing it when the coach's switch is on and nothing bills the client yet.
    Answers the first invoice's id when it started billing, else null. */
export async function billPlanIfAutoAction(clientId: number): Promise<number | null> {
  const id = Number(clientId);
  if (!(await coachForClient(id))) return null;
  const coachId = coachIdOfClient(id);
  if (coachId == null || !getInvoiceAuto(coachId).billOnPlan) return null;
  const billing = clientPlanBilling(coachId, id);
  const plan = billing.plan;
  if (!billing.canStart || !plan || !plan.every || plan.id !== clientPlanId(id)) return null;
  const today = localDateStr();
  // One for the client's billing as it stands (a retry, a second tap, two tabs at once): the invoice action answers the
  // first one it made. The client's latest invoice is in the key, so billing started again the same day after it was
  // stopped (the plan set to None and back, 23 Nov, review) makes its invoice and series, never the first one's answer.
  const last = getData().invoices.reduce((m, i) => (i.client_id === id && i.id > m ? i.id : m), 0);
  const onceKey = `planbill-${id}-${last}-${today}-${plan.id}`.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
  const invoiceId = await createInvoiceAction(id, { issueDate: today, lines: plan.lines, sent: true, repeat: plan.every, planId: plan.id }, onceKey);
  if (typeof invoiceId === "number") emailInvoiceInBackground(invoiceId);
  return typeof invoiceId === "number" ? invoiceId : null;
}
