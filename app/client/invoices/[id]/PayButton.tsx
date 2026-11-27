"use client";

import { useState, useTransition } from "react";
import { payInvoiceAction } from "../../../lib/actions";

// Pay an invoice online: off to Stripe's checkout on the coach's account, back through /invoice/<id>/paid, which
// confirms it with Stripe, to this page. `auto` (26 Nov, Alex): on a series charged automatically, "Pay automatically
// from now on" to tick, with what it means grey under it ("€89 on the 26th of each month from 26 Dec"); ticked, the
// payment is kept for the series' next invoices (lib/invoiceCharges.ts).
export default function PayButton({ invoiceId, label, auto = null }: { invoiceId: number; label: string; auto?: string | null }) {
  const [busy, start] = useTransition();
  const [error, setError] = useState("");
  const [keep, setKeep] = useState(false);
  return (
    <span className="ivp-pay-wrap">
      {auto && (
        <label className="ivp-auto">
          <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} disabled={busy} />
          <span>
            Pay automatically from now on
            <small>{auto}</small>
          </span>
        </label>
      )}
      <button
        type="button"
        className="ivp-btn primary ivp-pay-btn"
        disabled={busy}
        onClick={() =>
          start(async () => {
            const r = await payInvoiceAction(invoiceId, { auto: !!auto && keep });
            if (r.url) window.location.href = r.url;
            else setError(r.error ?? "That didn't work. Try again.");
          })
        }
      >
        {busy ? "Opening…" : label}
      </button>
      {error && <small className="ivp-pay-error">{error}</small>}
    </span>
  );
}
