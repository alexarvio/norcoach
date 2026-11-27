"use client";

import { useRef, useState } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../../../components/ui/dropdown-menu";
import { MoreIcon, TrashIcon } from "../../../components/icons";
import { setInvoiceRepeatPausedAction, updateInvoiceRepeatAction } from "../../../lib/actions";
import { setClientPlanPriceAction } from "../../../lib/planActions";
import { autopayWords } from "../../../lib/payWords";
import { dayMonth } from "../../../lib/dayMonth";
import { SepJoin } from "../Sep";
import type { DraftInvoices } from "../loaders";
import { cents, currencySign, daysBetween, everyLong, figure, fill, inDays, money, num, wholeMoney } from "./invoiceBits";

// The Billing card (26 Nov, Alex: docs/boards/client-invoices-mockup.html, A, "the billing is on the screen"): the rust
// strip and the Recurring table made one card of facts across, each a label over its value: the Plan (its rhythm, since
// when), the Price (the client's own with the plan's struck beside it, typed in place, from the next invoice on), the
// Next invoice (how soon and what it comes to), and how they pay (Automatic and the card, Link, or Bank transfer; a
// declined charge in rust with its next retry). Its state pill after the title, its actions in the ⋯ (a paused one's
// Resume in words on the head). Not billed, the same card with what it would bill and Start billing as its one action.

type Billing = DraftInvoices["billing"];
type Series = NonNullable<Billing["series"]>;
export type BillingActs = {
  /** Runs a change, reads the page again, and says only a failure. */
  act: (fn: () => Promise<unknown>, failed: string) => void;
  onStart: () => void;
  onEditLines: (s: Series) => void;
  onStop: (s: Series | DraftInvoices["repeats"][number]) => void;
  onForget: () => void;
};

export function BillingSection({ clientId, firstName, plan, acts }: { clientId: number; firstName: string; plan: DraftInvoices; acts: BillingActs }) {
  const b = plan.billing;
  const cur = b.currency;
  const s = b.series;
  const today = plan.today;
  // The series is the plan's when it bills the plan the client is on: only then is the price theirs to change here.
  const onPlan = !!(s && b.plan && s.planId === b.plan.id);
  const [editing, setEditing] = useState(false);
  // Change price from the ⋯: the menu gives its focus back to nothing, so the field keeps it (as Home's Details).
  const fromMenu = useRef(false);
  const [price, setPrice] = useState("");
  const startEdit = () => {
    setPrice(String(b.price ?? ""));
    setEditing(true);
  };
  const typed = num(price);
  const priceOk = Number.isFinite(typed) && typed > 0;
  const savePrice = (n: number | null) => {
    setEditing(false);
    acts.act(async () => {
      if (!(await setClientPlanPriceAction(clientId, n))) throw new Error();
    }, "Price not saved");
  };

  // A declined automatic charge on one of their invoices, the latest: the Pays by cell says so in rust.
  const failed = plan.invoices.find((r) => r.state === "charge_failed" && r.charge);
  const others = plan.repeats.filter((r) => r.id !== s?.id);

  const pill = b.state === "active" ? { cls: " live", text: "Active" } : b.state === "paused" ? { cls: "", text: "Paused" } : { cls: "", text: "Not billed" };

  // Nothing to bill and nothing billing: the one empty box (design rules 1), the plan is set on Details.
  if (!b.plan && !s) {
    return (
      <section className="rls-section" aria-label="Billing">
        <div className="trn-weekhead">
          <div>
            <h2>Billing</h2>
          </div>
        </div>
        <div className="rls-card">
          <p className="rls-none">No plan yet</p>
        </div>
      </section>
    );
  }

  const planFact = b.plan ? (
    <>
      <b>{b.plan.name}</b>
      <small>
        <SepJoin parts={[everyLong(s?.every ?? b.plan.every), s ? `since ${dayMonth(s.started)}` : null]} />
      </small>
    </>
  ) : (
    // A series of their own with no plan behind it: what it bills.
    <>
      <b>{fill(s!.lines[0]?.description || "Invoice", s!.next)}</b>
      <small>
        <SepJoin parts={[everyLong(s!.every), `since ${dayMonth(s!.started)}`]} />
      </small>
    </>
  );

  const priceShown =
    onPlan || !s ? (
      b.price != null ? (
        <>
          <b>
            {wholeMoney(b.price, cur)}
            {b.ownPrice != null && b.plan?.price != null && b.ownPrice !== b.plan.price && <s>{wholeMoney(b.plan.price, cur)}</s>}
          </b>
          <small>{b.ownPrice != null ? <SepJoin parts={[`${firstName}'s own`, b.ownSince ? `from ${dayMonth(b.ownSince)}` : null]} /> : "Plan price"}</small>
        </>
      ) : (
        <b className="none">—</b>
      )
    ) : (
      <>
        <b>{wholeMoney(s!.total, cur)}</b>
        <small>{s!.lines.length > 1 ? `${s!.lines.length} lines` : "Each invoice"}</small>
      </>
    );

  const payWords = () => {
    if (!s) return <b className="none">—</b>;
    if (s.pays === "bank")
      return (
        <>
          <b>Bank transfer</b>
          <small>Marked by hand</small>
        </>
      );
    if (b.autopay) {
      const card = autopayWords({ ...b.autopay });
      const declined = failed?.charge;
      return (
        <>
          <b>{card}</b>
          <small>
            {declined ? (
              <SepJoin parts={[<em key="d">Declined</em>, declined.attempt < declined.of && declined.nextAt ? `retry ${declined.attempt + 1} of ${declined.of} on ${dayMonth(new Date(declined.nextAt))}` : `${declined.of} retries failed`]} />
            ) : s.auto ? (
              <SepJoin parts={[<span key="a" className="ok">Automatic</span>, `since ${dayMonth(new Date(b.autopay.since))}`]} />
            ) : (
              "Automatic off"
            )}
          </small>
        </>
      );
    }
    return (
      <>
        <b>Link</b>
        <small>
          <SepJoin parts={[b.email, s.auto ? "Automatic offered" : null]} />
        </small>
      </>
    );
  };

  const nextFact = () => {
    if (!s) {
      return (
        <>
          <span className="rls-fig-label">First invoice</span>
          <b className="none">—</b>
        </>
      );
    }
    if (s.paused)
      return (
        <>
          <span className="rls-fig-label">Next invoice</span>
          <b className="none">—</b>
          <small>Paused</small>
        </>
      );
    return (
      <>
        <span className="rls-fig-label">Next invoice</span>
        <b>{dayMonth(s.next)}</b>
        <small>
          <SepJoin parts={[inDays(daysBetween(today, s.next)), money(s.total, cur)]} />
        </small>
      </>
    );
  };

  return (
    <section className="rls-section" aria-label="Billing">
      <div className="trn-weekhead riv-billhead">
        <div className="riv-billtitle">
          <h2>Billing</h2>
          <span className={`trn-state${pill.cls}`}>{pill.text}</span>
        </div>
        {s && (
          <div className="trn-weekhead-actions">
            {s.paused && (
              <button type="button" className="riv-act" onClick={() => acts.act(() => setInvoiceRepeatPausedAction(clientId, s.id, false), "Not resumed")}>
                Resume
              </button>
            )}
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger className="trn-row-more" aria-label="More for billing">
                <MoreIcon />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="pb-menu" onCloseAutoFocus={(e) => fromMenu.current && (e.preventDefault(), (fromMenu.current = false))}>
                {onPlan && <DropdownMenuItem onSelect={() => ((fromMenu.current = true), startEdit())}>Change price</DropdownMenuItem>}
                <DropdownMenuItem onSelect={() => acts.onEditLines(s)}>Edit lines</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => acts.act(() => setInvoiceRepeatPausedAction(clientId, s.id, !s.paused), s.paused ? "Not resumed" : "Not paused")}>{s.paused ? "Resume" : "Pause"}</DropdownMenuItem>
                {s.pays === "bank" ? (
                  <DropdownMenuItem onSelect={() => acts.act(() => okOr(updateInvoiceRepeatAction(clientId, s.id, { pays: "link" })), "Not changed")}>Switch to link</DropdownMenuItem>
                ) : (
                  <>
                    <DropdownMenuItem onSelect={() => acts.act(() => okOr(updateInvoiceRepeatAction(clientId, s.id, { pays: "bank" })), "Not changed")}>Switch to bank transfer</DropdownMenuItem>
                    {s.auto ? (
                      <DropdownMenuItem onSelect={() => acts.act(() => okOr(updateInvoiceRepeatAction(clientId, s.id, { auto: false })), "Not changed")}>Stop automatic payment</DropdownMenuItem>
                    ) : (
                      plan.compose.canPayByLink && <DropdownMenuItem onSelect={() => acts.act(() => okOr(updateInvoiceRepeatAction(clientId, s.id, { auto: true })), "Not changed")}>Charge automatically</DropdownMenuItem>
                    )}
                  </>
                )}
                {b.autopay && <DropdownMenuItem onSelect={acts.onForget}>Forget {autopayWords({ ...b.autopay })}</DropdownMenuItem>}
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => acts.onStop(s)}>
                  <TrashIcon /> Stop
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>

      <div className={`rls-card riv-bill${s ? "" : " start"}`}>
        <div className="riv-bgrid">
          <div className="riv-bf">
            <span className="rls-fig-label">Plan</span>
            {planFact}
          </div>
          {/* The price typed in place (A): a click on it, or Change price in the ⋯; Save from the next invoice on. */}
          {onPlan && editing ? (
            <div className="riv-bf editing">
              <span className="rls-fig-label">Price</span>
              <span className="riv-money big">
                <span className="riv-cur">{currencySign(cur)}</span>
                <input
                  className="riv-in num"
                  inputMode="decimal"
                  value={price}
                  onChange={(e) => setPrice(figure(e.target.value))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && priceOk) savePrice(cents(typed));
                    if (e.key === "Escape") setEditing(false);
                  }}
                  autoFocus
                  onFocus={(e) => e.currentTarget.select()}
                  aria-label={`${firstName}'s price`}
                />
                {b.plan?.price != null && priceOk && cents(typed) !== b.plan.price && <s>{wholeMoney(b.plan.price, cur)}</s>}
              </span>
              <span className="riv-editfoot">
                <span>From {dayMonth(s!.next)}</span>
                <span className="riv-gap" />
                {b.ownPrice != null && b.plan?.price != null && (
                  <button type="button" className="riv-act grey" onClick={() => savePrice(null)}>
                    Back to {wholeMoney(b.plan.price, cur)}
                  </button>
                )}
                <button type="button" className="riv-act grey" onClick={() => setEditing(false)}>
                  Cancel
                </button>
                <button type="button" className="riv-go" disabled={!priceOk} onClick={() => priceOk && savePrice(cents(typed))}>
                  Save
                </button>
              </span>
            </div>
          ) : onPlan ? (
            <button type="button" className="riv-bf edit" onClick={startEdit} aria-label={`Change ${firstName}'s price`}>
              <span className="rls-fig-label">Price</span>
              {priceShown}
            </button>
          ) : (
            <div className="riv-bf">
              <span className="rls-fig-label">Price</span>
              {priceShown}
            </div>
          )}
          <div className="riv-bf">{nextFact()}</div>
          <div className="riv-bf">
            <span className="rls-fig-label">Pays by</span>
            {payWords()}
          </div>
        </div>
        {/* Not billed: its one action, the white hairline pill (design rules 1, an empty box's action). */}
        {!s && b.canStart && (
          <button type="button" className="trn-pill riv-startbtn" onClick={acts.onStart}>
            Start billing
          </button>
        )}
      </div>

      {/* Another series of theirs beside the plan's (one made by hand with Repeat): compactly under the card. */}
      {others.length > 0 && (
        <div className="rls-card riv-others">
          {others.map((r) => (
            <div key={r.id} className="riv-other">
              <span className="riv-every">{everyLong(r.every)}</span>
              <span className="riv-what-main">{fill(r.lines[0]?.description ?? "Invoice", r.next)}</span>
              <span className="riv-date">{r.paused ? "—" : `Next ${dayMonth(r.next)}`}</span>
              <span className="riv-total">{money(r.total, r.currency)}</span>
              <span className={`trn-state riv-pill${r.paused ? "" : " live"}`}>{r.paused ? "Paused" : "Active"}</span>
              <span className="riv-othermore">
                <DropdownMenu modal={false}>
                  <DropdownMenuTrigger className="trn-row-more" aria-label="More for this series">
                    <MoreIcon />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="pb-menu">
                    <DropdownMenuItem onSelect={() => acts.act(() => setInvoiceRepeatPausedAction(clientId, r.id, !r.paused), r.paused ? "Not resumed" : "Not paused")}>{r.paused ? "Resume" : "Pause"}</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onSelect={() => acts.onStop(r)}>
                      <TrashIcon /> Stop
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

async function okOr(p: Promise<boolean>) {
  if (!(await p)) throw new Error();
}
