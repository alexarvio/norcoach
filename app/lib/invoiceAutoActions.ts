"use server";

import { revalidatePath } from "next/cache";
import { requireCoach } from "./auth";
import { setInvoiceAuto, type InvoiceAuto } from "./invoiceAuto";

// Settings, Invoicing & payments (23 Nov, Alex: docs/boards/settings-harmony-mockup.html): the two switches, "Invoices
// by email" and "Start billing when a client gets a plan" (lib/invoiceAuto.ts), each saved the moment it is turned.

/** Turns one or both switches for the signed-in coach; answers what they are now. */
export async function setInvoiceAutoAction(patch: Partial<InvoiceAuto>): Promise<InvoiceAuto> {
  const coach = await requireCoach();
  const clean: Partial<InvoiceAuto> = {};
  if (typeof patch?.emailInvoices === "boolean") clean.emailInvoices = patch.emailInvoices;
  if (typeof patch?.billOnPlan === "boolean") clean.billOnPlan = patch.billOnPlan;
  const now = setInvoiceAuto(coach.id, clean);
  revalidatePath("/admin/redesign/settings");
  return now;
}
