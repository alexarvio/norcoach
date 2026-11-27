"use client";

import { useState } from "react";
import type { InvoiceEvery, InvoiceLine } from "../../../lib/db";
import { DialogClose, DialogContent, DialogDescription } from "../../../components/ui/dialog";
import { PlusIcon } from "../../../components/icons";
import { PopupTitle } from "../PopupWho";
import { SepJoin } from "../Sep";
import { dayMonth } from "../../../lib/dayMonth";
import type { DraftInvoices } from "../loaders";
import { cents, EVERY, figure, money, num, totals } from "./invoiceBits";

// Edit lines (26 Nov, Alex: docs/boards/client-invoices-mockup.html, A, from the Billing card's ⋯): the running series'
// lines and how often it comes, changing every invoice it makes from the next one on; the ones already made stay as they
// were sent. On the plan's series, the plan's line at a price other than the plan's is the client's own price (server).

type Draft = { description: string; quantity: string; unit_price: string };
export const blankLine = (): Draft => ({ description: "", quantity: "1", unit_price: "" });
export const draftOf = (l: InvoiceLine): Draft => ({ description: l.description, quantity: String(l.quantity), unit_price: String(l.unit_price) });

export function EditLinesDialog({ plan, series, onSave }: { plan: DraftInvoices; series: NonNullable<DraftInvoices["billing"]["series"]>; onSave: (v: { lines: InvoiceLine[]; every: InvoiceEvery }) => void }) {
  const d = plan.defaults;
  const [lines, setLines] = useState<Draft[]>(series.lines.length ? series.lines.map(draftOf) : [blankLine()]);
  const [every, setEvery] = useState<InvoiceEvery>(series.every);
  const clean = lines.map((l) => ({ description: l.description.trim(), quantity: num(l.quantity), unit_price: num(l.unit_price) }));
  const bad = (l: (typeof clean)[number]) => !Number.isFinite(l.quantity) || !Number.isFinite(l.unit_price);
  const good = clean.filter((l) => l.description && l.quantity > 0 && !bad(l));
  // A line started but not whole holds Save back, and shows why on the line (as New invoice).
  const unfinished = clean.some((l, i) => (l.description || lines[i].unit_price.trim()) && !(l.description && l.quantity > 0 && !bad(l)));
  const t = totals(good, d.vatRate, d.pricesIncludeVat);
  const ready = good.length > 0 && !unfinished;
  const setLine = (i: number, k: keyof Draft, v: string) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  return (
    <DialogContent className="dlh riv-new riv-lines-dlg">
      <div className="dlh-head">
        <PopupTitle>Edit lines</PopupTitle>
        <DialogClose className="dlh-x" aria-label="Close">
          ✕
        </DialogClose>
      </div>
      {/* From the next invoice on, said once on the paper under the head (as the phase pop-ups' fact line). */}
      <DialogDescription className="dlh-what">
        <SepJoin parts={[series.paused ? "Paused" : null, `From ${dayMonth(series.next)}`]} />
      </DialogDescription>

      <div className="riv-field">
        <span className="dlh-label">
          <SepJoin parts={["Lines", d.vatRate > 0 && <small key="vat">Prices {d.pricesIncludeVat ? "include" : "exclude"} {d.taxLabel}</small>]} />
        </span>
        <div className="riv-lines">
          <div className="riv-line head" aria-hidden="true">
            <span>Description</span>
            <span>Qty</span>
            <span>Price</span>
            <span>Amount</span>
            <span />
          </div>
          {lines.map((l, i) => {
            const c = clean[i];
            return (
              <div key={i} className="riv-line">
                <input className={`riv-in${!c.description && l.unit_price.trim() ? " bad" : ""}`} value={l.description} onChange={(e) => setLine(i, "description", e.target.value)} maxLength={200} aria-label="Description" />
                <input className={`riv-in num${!Number.isFinite(c.quantity) || (c.description && c.quantity <= 0) ? " bad" : ""}`} inputMode="decimal" value={l.quantity} onChange={(e) => setLine(i, "quantity", figure(e.target.value))} aria-label="Quantity" />
                <input className={`riv-in num${Number.isFinite(c.unit_price) ? "" : " bad"}`} inputMode="decimal" value={l.unit_price} onChange={(e) => setLine(i, "unit_price", figure(e.target.value))} aria-label="Price" />
                <span className="riv-amount">{bad(c) ? "—" : money(cents(c.quantity * c.unit_price), d.currency)}</span>
                <button type="button" className="riv-x" onClick={() => setLines((ls) => (ls.length === 1 ? [blankLine()] : ls.filter((_, j) => j !== i)))} aria-label="Remove this line" title="Remove">
                  ✕
                </button>
              </div>
            );
          })}
          <button type="button" className="riv-addline" onClick={() => setLines((ls) => [...ls, blankLine()])}>
            <PlusIcon /> Line
          </button>
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
        </div>
      </div>

      <div className="riv-field">
        <span className="dlh-label">Every</span>
        <div className="rd-btn-group riv-cap" role="radiogroup" aria-label="Every">
          {EVERY.filter((e) => e.value).map((e) => (
            <button key={e.label} type="button" role="radio" aria-checked={every === e.value} className={every === e.value ? "on" : ""} onClick={() => setEvery(e.value!)}>
              {e.label}
            </button>
          ))}
        </div>
      </div>

      <div className="dlh-foot">
        <DialogClose className="dlh-cancel">Cancel</DialogClose>
        <button type="button" className="dlh-go" disabled={!ready} onClick={() => ready && onSave({ lines: good, every })}>
          Save
        </button>
      </div>
    </DialogContent>
  );
}
