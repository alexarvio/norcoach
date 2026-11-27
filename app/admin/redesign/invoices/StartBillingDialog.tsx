"use client";

import { useState } from "react";
import type { InvoiceLine, InvoicePays } from "../../../lib/db";
import { DialogClose, DialogContent, DialogDescription } from "../../../components/ui/dialog";
import DatePick from "../DatePick";
import { PopupTitle } from "../PopupWho";
import { SepJoin } from "../Sep";
import { dayMonth } from "../../../lib/dayMonth";
import type { DraftInvoices } from "../loaders";
import { addDays, cents, currencySign, everyLong, figure, inDays, money, num, planLineIndex, totals, wholeMoney } from "./invoiceBits";

// Start billing (26 Nov, Alex: docs/boards/client-invoices-mockup.html, A, "Start billing is a short pop-up in C instead of
// the whole New invoice"): the Billing card's one action while nothing bills the client. Their plan and its rhythm, the
// price (their own, the plan's struck beside it), the first invoice's day, how they pay (Link: our page, Stripe on the
// coach's own account; or Bank transfer, marked by hand), when it is due and its sums; Cancel and Start. Start sends the
// first invoice and starts the series on the plan's rhythm; a price other than the plan's is the client's own from then.

export type StartBilling = { issueDate: string; lines: InvoiceLine[]; pays: InvoicePays };

export function StartBillingDialog({ firstName, plan, onStart }: { firstName: string; plan: DraftInvoices; onStart: (v: StartBilling) => void }) {
  const b = plan.billing;
  const d = plan.defaults;
  const p = b.plan!;
  const lines = p.lines.length ? p.lines : [{ description: p.name, quantity: 1, unit_price: b.price ?? p.price ?? 0 }];
  const at = planLineIndex(lines, p.name);
  const [price, setPrice] = useState(String(b.price ?? p.price ?? ""));
  const [issue, setIssue] = useState(plan.today);
  // Link only where the coach takes payments online; else the bank details print (26 Nov, Alex).
  const [pays, setPays] = useState<InvoicePays>(plan.compose.canPayByLink ? "link" : "bank");
  const typed = num(price);
  const ok = Number.isFinite(typed) && typed > 0 && !!issue;
  const filled = lines.map((l, i) => (i === at ? { ...l, unit_price: ok ? cents(typed) : 0 } : l));
  const t = totals(filled, d.vatRate, d.pricesIncludeVat);
  const own = ok && p.price != null && cents(typed) !== p.price;
  return (
    <DialogContent className="dlh riv-start">
      <div className="dlh-head">
        <PopupTitle>Start billing</PopupTitle>
        <DialogClose className="dlh-x" aria-label="Close">
          ✕
        </DialogClose>
      </div>
      {/* The thing itself first on the paper (C): the plan, its rhythm, what each invoice comes to. */}
      <div className="riv-thing">
        <div>
          <span className="riv-thing-name">{p.name}</span>
          <DialogDescription className="riv-thing-facts">{everyLong(p.every)}</DialogDescription>
        </div>
        <span className="riv-thing-amt">
          {own && <s>{wholeMoney(p.price!, d.currency)}</s>}
          {wholeMoney(t.total, d.currency)}
        </span>
      </div>

      <div className="riv-two">
        <label className="riv-field">
          <span className="dlh-label">Price</span>
          <span className="riv-money">
            <span className="riv-cur">{currencySign(d.currency)}</span>
            <input className="riv-in num" inputMode="decimal" value={price} onChange={(e) => setPrice(figure(e.target.value))} aria-label={`${firstName}'s price`} />
            {own && <s>{money(p.price!, d.currency)}</s>}
          </span>
        </label>
        <div className="riv-field">
          <span className="dlh-label">First invoice</span>
          <DatePick value={issue} onChange={setIssue} label="First invoice" className="riv-daypick" />
        </div>
      </div>

      <div className="riv-two">
        <div className="riv-field">
          <span className="dlh-label">How {firstName} pays</span>
          <div className="rd-btn-group riv-cap" role="radiogroup" aria-label={`How ${firstName} pays`}>
            {(["link", "bank"] as const).map((v) => (
              <button key={v} type="button" role="radio" aria-checked={pays === v} className={pays === v ? "on" : ""} onClick={() => setPays(v)}>
                {v === "link" ? "Link" : "Bank transfer"}
              </button>
            ))}
          </div>
        </div>
        <div className="riv-field">
          <span className="dlh-label">Due</span>
          <span className="riv-static">
            <SepJoin parts={[issue ? dayMonth(addDays(issue, d.termsDays)) : "—", <small key="in">{inDays(d.termsDays)}</small>]} />
          </span>
        </div>
      </div>

      <dl className="riv-totals">
        <dt>Subtotal</dt>
        <dd>{money(t.subtotal, d.currency)}</dd>
        {/* No tax line where there is no tax, as the sheet prints it (26 Nov). */}
        {d.vatRate > 0 && (
          <>
            <dt>
              {d.taxLabel} {d.vatRate}%
            </dt>
            <dd>{money(t.vat, d.currency)}</dd>
          </>
        )}
        <dt className="grand">Total</dt>
        <dd className="grand">{money(t.total, d.currency)}</dd>
      </dl>

      <div className="dlh-foot">
        <DialogClose className="dlh-cancel">Cancel</DialogClose>
        <button type="button" className="dlh-go" disabled={!ok} onClick={() => ok && onStart({ issueDate: issue, lines: filled, pays })}>
          Start
        </button>
      </div>
    </DialogContent>
  );
}
