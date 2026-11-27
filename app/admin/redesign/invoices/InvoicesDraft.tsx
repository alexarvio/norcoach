"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  createInvoiceAction,
  deleteInvoiceAction,
  forgetAutopayAction,
  markInvoicePaidAction,
  markInvoiceUnpaidAction,
  refundInvoiceAction,
  remindInvoiceAction,
  sendInvoiceLinkAction,
  setInvoiceStatusByIdAction,
  stopInvoiceRepeatAction,
  updateInvoiceRepeatAction,
  type InvoiceNudge,
} from "../../../lib/actions";
import type { InvoiceRow } from "../../../lib/invoiceBilling";
import { Dialog } from "../../../components/ui/dialog";
import { PlusIcon } from "../../../components/icons";
import type { DraftInvoices } from "../loaders";
import { dayMonth, logDate, logDateWidth } from "../../../lib/dayMonth";
import { newOnceKey } from "../../../lib/onceKey";
import { autopayWords } from "../../../lib/payWords";
import { landOn } from "../../../lib/landOn";
import { SepJoin } from "../Sep";
import { Fold } from "../Fold";
import { RowFold } from "../RowFold";
import Pager from "../Pager";
import { ConfirmDialog } from "../training/TrainingDraft";
import { NewInvoiceDialog } from "./NewInvoiceDialog";
import { StartBillingDialog } from "./StartBillingDialog";
import { EditLinesDialog } from "./EditLinesDialog";
import { BillingSection } from "./BillingCard";
import { InvoiceHistory, stepsOf } from "./InvoiceHistory";
import { everyLong, fill, money, sheetHref, stampDate } from "./invoiceBits";

// The sums and dates the tab's pop-ups share live in invoiceBits.ts (26 Nov); money stays here too for older imports.
export { money } from "./invoiceBits";

// A client's invoices (26 Nov, Alex: A of docs/boards/client-invoices-mockup.html, "A on clients invoices"; built as
// the track tabs are, root "rd trn rls riv"): Training's header with + New invoice as a white pill; what Settings still
// lacks as a fact and its fix; the Billing card (their plan, their own price, the series billing them, how they pay; Not
// billed, Start billing its one action), the figures (Outstanding, Paid, Last paid and how), then All invoices as a log:
// the day issued first with its chevron, the number, what for, due, the total and the state pill, which follows what
// happened and is no longer a menu. A row opens on the shared fold into what happened to it, its actions in words under
// it: Send now, Send link, Remind, Mark paid (and how), Not paid, Refund, Open (as it prints, a new tab), Remove.

const PAGE = 20;
/** The state pill (design rules 8): one width down the column, the word centred. */
const STATE: Record<InvoiceRow["state"], { text: string; cls: string }> = {
  not_sent: { text: "Not sent", cls: "" },
  sent: { text: "Sent", cls: " live" },
  overdue: { text: "Overdue", cls: " warn" },
  paid: { text: "Paid", cls: " good" },
  pending: { text: "Payment pending", cls: "" },
  charge_failed: { text: "Charge failed", cls: " warn" },
  refunded: { text: "Refunded", cls: "" },
};
const ONLINE = new Set(["card", "ideal", "apple_pay", "sepa_debit", "stripe"]);
const PAID_BY: { value: "bank" | "cash" | "other"; label: string }[] = [
  { value: "bank", label: "Bank transfer" },
  { value: "cash", label: "Cash" },
  { value: "other", label: "Other" },
];
const VIA_WORD: Record<string, string> = { card: "Card", ideal: "iDEAL", apple_pay: "Apple Pay", sepa_debit: "SEPA debit", bank: "Bank transfer", cash: "Cash", other: "Other", stripe: "Online" };

type Series = NonNullable<DraftInvoices["billing"]["series"]>;
type Repeat = DraftInvoices["repeats"][number];

export default function InvoicesDraft({ clientId, firstName, clientName, plan }: { clientId: number; firstName: string; clientName: string; plan: DraftInvoices }) {
  const router = useRouter();
  const [, start] = useTransition();
  const [adding, setAdding] = useState(false);
  const [starting, setStarting] = useState(false);
  const [lines, setLines] = useState<Series | null>(null);
  const [stopping, setStopping] = useState<Series | Repeat | null>(null);
  const [forgetting, setForgetting] = useState(false);
  const [removing, setRemoving] = useState<InvoiceRow | null>(null);
  const [refunding, setRefunding] = useState<InvoiceRow | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  // Mark paid asks how in place, on the opened row (a slip in a menu can no longer mark something Paid).
  const [marking, setMarking] = useState<{ id: number; via: "bank" | "cash" | "other" } | null>(null);
  // Acting on a row: its words greyed until the page has read it again.
  const [busy, setBusy] = useState<number | null>(null);

  const cur = plan.defaults.currency;
  const b = plan.billing;
  const coach = plan.compose.coach.first || "Coach";
  // A change, the page read again, and only a failure said (design rules 9: no Saved toast).
  const act = (fn: () => Promise<unknown>, failed: string, row?: number) => {
    if (row != null) setBusy(row);
    start(async () => {
      try {
        await fn();
      } catch {
        toast.error(failed);
      }
      router.refresh();
      setBusy(null);
    });
  };
  const must = (p: Promise<boolean | void | null | undefined>) => p.then((ok) => {
    if (ok === false || ok === null) throw new Error();
  });
  // Remind and Send link say only what didn't go (an email off here is still the bell in their app).
  const nudge = (p: Promise<InvoiceNudge>, row: number) => {
    setBusy(row);
    start(async () => {
      try {
        const r = await p;
        if (!r.ok) toast.error(r.error === "already_today" ? "Reminded today already" : r.error === "no_email" ? `No email for ${firstName}` : r.error === "not_owed" ? "Nothing owed on it" : "Not sent. Try again");
        else if (r.email === "failed") toast.error("The email didn't go. Try again");
        else if (r.email === "off") toast(`Emails are off here; ${firstName} sees it in the app`);
      } catch {
        toast.error("Not sent. Try again");
      }
      router.refresh();
      setBusy(null);
    });
  };

  // ---- The log's pages; a row's id is `invoice-<id>`, where a link lands (the To do's Open, a push: 26 Nov).
  const all = plan.invoices;
  const pages = Math.max(1, Math.ceil(all.length / PAGE));
  const at = Math.min(page, pages);
  const from = (at - 1) * PAGE;
  const rows = all.slice(from, from + PAGE);
  const listRef = useRef(all);
  useEffect(() => {
    listRef.current = all;
  });
  // A link lands on its invoice (#invoice-<id>): its page, the row opened, brought to the middle and lit; on arrival and
  // on a new # only, never on a read (design rules 8). An invoice just made lands the same way once it is in the list.
  const landing = useRef<number | null>(null);
  const landAt = (id: number) => {
    const idx = listRef.current.findIndex((r) => r.id === id);
    if (idx < 0) return false;
    setPage(Math.floor(idx / PAGE) + 1);
    setOpen(id);
    setTimeout(() => landOn(document.getElementById(`invoice-${id}`)), 120);
    return true;
  };
  useEffect(() => {
    let frame = 0;
    const arrive = () => {
      const id = Number(/^#invoice-(\d+)$/.exec(window.location.hash)?.[1]);
      if (!id) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!landAt(id)) landing.current = id;
      });
    };
    arrive();
    window.addEventListener("hashchange", arrive);
    return () => {
      window.removeEventListener("hashchange", arrive);
      cancelAnimationFrame(frame);
    };
  }, []);
  useEffect(() => {
    const id = landing.current;
    if (id != null && all.some((r) => r.id === id)) {
      landing.current = null;
      landAt(id);
    }
  }, [all]);

  // ---- The figures: what is owed, what is paid, and the last payment with how (26 Nov, Alex: Next number goes, a
  // Settings fact, not one about the client).
  const f = b.figures;
  const owed = all.filter((r) => r.state === "sent" || r.state === "overdue" || r.state === "pending" || r.state === "charge_failed");
  const latest = owed.reduce((m, r) => Math.max(m, r.lateDays), 0);
  const lastPaidRow = (() => {
    let best: { row: InvoiceRow; at: number; detail?: string; via?: string } | null = null;
    for (const r of all) {
      if (r.state !== "paid") continue;
      for (const e of r.events) {
        if (e.kind !== "paid" && e.kind !== "marked_paid") continue;
        const t = Date.parse(e.at) || 0;
        if (!best || t >= best.at) best = { row: r, at: t, detail: e.detail, via: e.via };
      }
    }
    return best;
  })();
  const lastHow = lastPaidRow?.detail || VIA_WORD[lastPaidRow?.via ?? f.lastPaid?.via ?? ""] || null;

  // The log's columns: the day with its chevron (the whole list's dates, so it keeps its width from page to page), the
  // number as wide as the longest, what for, due, the total, the state pill.
  const dateW = logDateWidth(all.map((r) => r.issueDate)) + 22;
  const numW = Math.max(72, ...all.map((r) => Math.ceil(r.number.length * 9.5)));
  const grid = { gridTemplateColumns: `${dateW}px ${numW}px minmax(0, 1fr) 64px 96px 132px`, columnGap: 16 } as const;

  const whatFor = (r: InvoiceRow) => r.lines[0]?.description || "Invoice";
  const paidOnline = (r: InvoiceRow) => (r.via ? ONLINE.has(r.via) : r.paidVia === "stripe");

  const actions = (r: InvoiceRow) => {
    const off = busy === r.id;
    const openIt = (
      <button key="open" type="button" className="riv-act grey" onClick={() => window.open(sheetHref(r.id), "_blank", "noopener")}>
        Open
      </button>
    );
    if (marking?.id === r.id) {
      return (
        <div className="riv-acts ask">
          <span className="rls-fig-label">Paid by</span>
          <div className="rd-btn-group riv-cap" role="radiogroup" aria-label="Paid by">
            {PAID_BY.map((p) => (
              <button key={p.value} type="button" role="radio" aria-checked={marking.via === p.value} className={marking.via === p.value ? "on" : ""} onClick={() => setMarking({ id: r.id, via: p.value })}>
                {p.label}
              </button>
            ))}
          </div>
          <span className="riv-gap" />
          <button type="button" className="riv-act grey" onClick={() => setMarking(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="riv-go"
            disabled={off}
            onClick={() => {
              const via = marking.via;
              setMarking(null);
              act(() => must(markInvoicePaidAction(r.id, { via })), "Not marked paid", r.id);
            }}
          >
            Mark paid
          </button>
        </div>
      );
    }
    const words: React.ReactNode[] = [];
    const markPaid = (
      <button key="mark" type="button" className="riv-act" disabled={off} onClick={() => setMarking({ id: r.id, via: "bank" })}>
        Mark paid
      </button>
    );
    switch (r.state) {
      case "not_sent":
        words.push(
          <button key="send" type="button" className="riv-act" disabled={off} onClick={() => act(() => setInvoiceStatusByIdAction(r.id, "sent"), "Not sent", r.id)}>
            Send now
          </button>,
          openIt
        );
        // Never sent: it can still go (asked first). Once it has reached the client it stays: it is their record.
        if (!r.frozen)
          words.push(
            <button key="remove" type="button" className="riv-act red" disabled={off} onClick={() => setRemoving(r)}>
              Remove
            </button>
          );
        break;
      case "sent":
      case "overdue":
        if (r.canRemind)
          words.push(
            <button key="remind" type="button" className="riv-act" disabled={off} onClick={() => nudge(remindInvoiceAction(r.id), r.id)}>
              Remind
            </button>
          );
        else if (r.remindedToday) words.push(<span key="reminded" className="riv-actfact">Reminded today</span>);
        words.push(markPaid, openIt);
        break;
      case "charge_failed":
        if (r.pays !== "bank")
          words.push(
            <button key="link" type="button" className="riv-act" disabled={off} onClick={() => nudge(sendInvoiceLinkAction(r.id), r.id)}>
              Send link
            </button>
          );
        words.push(markPaid, openIt);
        break;
      case "paid":
        words.push(openIt);
        if (paidOnline(r))
          words.push(
            <button key="refund" type="button" className="riv-act grey" disabled={off} onClick={() => setRefunding(r)}>
              Refund
            </button>
          );
        else
          words.push(
            <button key="unpaid" type="button" className="riv-act grey" disabled={off} onClick={() => act(() => must(markInvoiceUnpaidAction(r.id)), "Not changed", r.id)}>
              Not paid
            </button>
          );
        break;
      default:
        words.push(openIt);
    }
    return <div className="riv-acts">{words}</div>;
  };

  return (
    <div className="rd trn rls riv">
      {/* ---- Header: Training's. No fact line, so no room kept for one. */}
      <header className="trn-head bare">
        <div className="trn-head-main">
          <span className="trn-eyebrow">Invoices</span>
          <div className="trn-name-row">
            <h1 className="trn-name">{firstName}&rsquo;s invoices</h1>
          </div>
        </div>
        <div className="trn-head-actions">
          <button type="button" className="trn-pill" onClick={() => setAdding(true)}>
            <PlusIcon /> New invoice
          </button>
        </div>
      </header>

      {/* ---- A real problem: the fact and its fix (design rules 1). */}
      {plan.missing.length > 0 && (
        <section className="riv-fix" aria-label="Missing from Settings">
          <span>Missing from Settings: {plan.missing.join(", ").replace(/, ([^,]*)$/, " and $1")}</span>
          <Link className="trn-pill" href={plan.missing.includes("bank details") && plan.missing.length === 1 ? "/settings#invoicing" : "/settings#business"}>
            Add them
          </Link>
        </section>
      )}

      {/* ---- Billing: the plan, the price, the next invoice, how they pay (26 Nov, Alex: the rust strip and Recurring made one card). */}
      <BillingSection
        clientId={clientId}
        firstName={firstName}
        plan={plan}
        acts={{
          act,
          onStart: () => setStarting(true),
          onEditLines: (s) => setLines(s),
          onStop: (s) => setStopping(s),
          onForget: () => setForgetting(true),
        }}
      />

      {/* ---- The figures, in one hairline card (as Home's); only once there is an invoice or a series. */}
      {(all.length > 0 || b.series) && (
        <section className="rls-card rls-figs" aria-label="At a glance">
          <div className="rls-fig">
            <span className="rls-fig-label">Outstanding</span>
            <b className={f.outstanding > 0 ? "warn" : ""}>{money(f.outstanding, cur)}</b>
            <small>
              {f.outstandingCount > 0 ? (
                <SepJoin parts={[`${f.outstandingCount} invoice${f.outstandingCount === 1 ? "" : "s"}`, f.overdueCount === 0 ? null : f.outstandingCount === 1 ? `${latest} day${latest === 1 ? "" : "s"} late` : `${f.overdueCount} overdue`]} />
              ) : (
                "Nothing owed"
              )}
            </small>
          </div>
          <div className="rls-fig">
            <span className="rls-fig-label">Paid</span>
            <b>{money(f.paid, cur)}</b>
            <small>{f.paidCount > 0 && <SepJoin parts={[`${f.paidCount} invoice${f.paidCount === 1 ? "" : "s"}`, f.paidSince ? `since ${dayMonth(f.paidSince)}` : null]} />}</small>
          </div>
          <div className="rls-fig">
            <span className="rls-fig-label">Last paid</span>
            <b className={f.lastPaid ? "" : "none"}>{f.lastPaid ? dayMonth(f.lastPaid.date) : "—"}</b>
            <small>{f.lastPaid && <SepJoin parts={[money(f.lastPaid.amount, cur), lastHow]} />}</small>
          </div>
        </section>
      )}

      {/* ---- Every invoice, newest first: a log (design rules 8), each row opening on what happened to it. */}
      <section className="rls-section">
        <div className="trn-weekhead">
          <div>
            <h2>All invoices</h2>
          </div>
        </div>
        <div className="rls-card rls-log riv-log">
          {all.length === 0 && <p className="rls-none">None yet</p>}
          {all.length > 0 && (
            <div className={`rd-rows${pages > 1 ? " rd-steady" : ""}`} style={pages > 1 ? ({ "--log-rows": PAGE, "--log-row": "53px", "--log-head": "36px" } as React.CSSProperties) : undefined}>
              <div className="rd-cols" aria-hidden="true" style={grid}>
                <span>Issued</span>
                <span>Number</span>
                <span>What for</span>
                <span>Due</span>
                <span className="riv-right">Total</span>
                <span className="riv-center">Status</span>
              </div>
              {rows.map((r) => {
                const isOpen = open === r.id;
                const st = STATE[r.state];
                const late = r.lateDays > 0 && (r.state === "overdue" || r.state === "charge_failed" || r.state === "sent");
                const toggle = () => {
                  setOpen((x) => (x === r.id ? null : r.id));
                  if (marking && marking.id !== r.id) setMarking(null);
                };
                return (
                  <div key={r.id} id={`invoice-${r.id}`} className={`rd-row riv-item${isOpen ? " open" : ""}${busy === r.id ? " busy" : ""}`}>
                    {/* A click anywhere opens it; for the keyboard the date is the button. */}
                    <div className="rd-row-main" style={grid} onClick={toggle}>
                      <span className="rd-ex">
                        <span className="rd-ex-name">
                          <button type="button" className="rd-row-hit" aria-expanded={isOpen} aria-label={`${logDate(r.issueDate)}, ${r.number}`}>
                            <span className="rd-logdate">{logDate(r.issueDate)}</span>
                            <Fold open={isOpen} />
                          </button>
                        </span>
                      </span>
                      <span className="riv-number">{r.number}</span>
                      <span className="riv-what">
                        <span className="riv-what-main">{whatFor(r)}</span>
                        {r.lines.length > 1 && <small>+ {r.lines.length - 1} more</small>}
                      </span>
                      <span className={`riv-date${late ? " late" : ""}`}>{r.dueDate ? dayMonth(r.dueDate) : <span className="riv-none">—</span>}</span>
                      <span className="riv-total">{money(r.total, r.currency)}</span>
                      <span className={`trn-state riv-pill${st.cls}`}>{st.text}</span>
                    </div>
                    <RowFold open={isOpen} className="riv-body">
                      <InvoiceHistory steps={stepsOf(r, { first: firstName, coach, today: plan.today })} />
                      {actions(r)}
                    </RowFold>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {/* The pager floats under the card, not in it (21 Oct, Alex). */}
        {all.length > 0 && (
          <Pager
            page={at}
            pages={pages}
            from={from}
            shown={rows.length}
            total={all.length}
            noun="invoices"
            label="Invoice pages"
            onPage={(p) => {
              setPage(p);
              setOpen(null);
              setMarking(null);
            }}
          />
        )}
      </section>

      {/* ---- New invoice (B of docs/boards/invoice-new-mockup.html): its own dialog, mounted while it shows. */}
      {adding && (
        <NewInvoiceDialog
          clientId={clientId}
          firstName={firstName}
          clientName={clientName}
          plan={plan}
          onClose={() => setAdding(false)}
          onDone={(r) => {
            setAdding(false);
            // The new invoice lands in the log once the page has read it (opened, in the middle, lit).
            if (r.invoiceId) landing.current = r.invoiceId;
          }}
        />
      )}

      <Dialog open={starting} onOpenChange={setStarting}>
        {starting && b.plan && (
          <StartBillingDialog
            firstName={firstName}
            plan={plan}
            onStart={(v) => {
              const onceKey = newOnceKey();
              const p = b.plan!;
              setStarting(false);
              start(async () => {
                // The first invoice sent, and the series on the plan's rhythm sending the rest by themselves.
                const id = await createInvoiceAction(clientId, { issueDate: v.issueDate, lines: v.lines, note: "", sent: true, repeat: p.every ?? "month", template: null, planId: p.id, pays: v.pays, auto: false }, onceKey).catch(() => null);
                if (!id) toast.error("Billing didn't start. Try again");
                else landing.current = id;
                router.refresh();
              });
            }}
          />
        )}
      </Dialog>

      <Dialog open={lines != null} onOpenChange={(o) => !o && setLines(null)}>
        {lines && (
          <EditLinesDialog
            plan={plan}
            series={lines}
            onSave={(v) => {
              const s = lines;
              setLines(null);
              act(() => must(updateInvoiceRepeatAction(clientId, s.id, v)), "Lines not saved");
            }}
          />
        )}
      </Dialog>

      <Dialog open={stopping != null} onOpenChange={(o) => !o && setStopping(null)}>
        {stopping && (
          <ConfirmDialog
            thing={{
              name: fill(stopping.lines[0]?.description ?? "Invoice", stopping.next),
              facts: [everyLong(stopping.every), stopping.paused ? "Paused" : `Next ${dayMonth(stopping.next)}`],
              aside: money(stopping.total, cur),
            }}
            title="Stop billing?"
            description={`${firstName} isn’t billed by it again. The invoices it already made stay.`}
            confirm="Stop"
            danger
            onConfirm={() => {
              const s = stopping;
              setStopping(null);
              act(() => stopInvoiceRepeatAction(clientId, s.id), "Not stopped");
            }}
          />
        )}
      </Dialog>

      <Dialog open={forgetting} onOpenChange={setForgetting}>
        {forgetting && b.autopay && (
          <ConfirmDialog
            thing={{ name: autopayWords({ ...b.autopay }), facts: [`Since ${dayMonth(new Date(b.autopay.since))}`] }}
            title={`Forget ${firstName}’s ${autopayWords({ ...b.autopay })}?`}
            description={`Nothing is charged on it again. ${firstName} can keep a card again when paying by the link.`}
            confirm="Forget"
            danger
            onConfirm={() => {
              setForgetting(false);
              act(() => must(forgetAutopayAction(clientId)), "Not forgotten");
            }}
          />
        )}
      </Dialog>

      <Dialog open={refunding != null} onOpenChange={(o) => !o && setRefunding(null)}>
        {refunding && (
          <ConfirmDialog
            thing={{ name: fill(whatFor(refunding), refunding.issueDate), facts: [refunding.number, stampDate(refunding.paidAt) ? `Paid ${dayMonth(stampDate(refunding.paidAt)!)}` : null, [...refunding.events].reverse().find((e) => e.kind === "paid")?.detail], aside: money(refunding.total, refunding.currency) }}
            title={`Refund invoice ${refunding.number}?`}
            description={`The whole payment goes back to ${firstName}, from your Stripe.`}
            confirm="Refund"
            danger
            onConfirm={() => {
              const r = refunding;
              setRefunding(null);
              setBusy(r.id);
              start(async () => {
                const a = await refundInvoiceAction(r.id).catch(() => null);
                if (!a || !a.ok) toast.error(a && !a.ok && a.error === "not_paid_online" ? "Paid by hand: set it Not paid instead" : a && !a.ok && a.error === "off" ? "Online payments are off" : "Not refunded. Try again");
                router.refresh();
                setBusy(null);
              });
            }}
          />
        )}
      </Dialog>

      <Dialog open={removing != null} onOpenChange={(o) => !o && setRemoving(null)}>
        {removing && (
          <ConfirmDialog
            thing={{ name: fill(whatFor(removing), removing.issueDate), facts: [removing.number, "Not sent", `Issued ${dayMonth(removing.issueDate)}`], aside: money(removing.total, removing.currency) }}
            title={`Remove invoice ${removing.number}?`}
            description="This can’t be undone."
            confirm="Remove"
            danger
            onConfirm={() => {
              const inv = removing;
              setRemoving(null);
              act(() => must(deleteInvoiceAction(inv.id)), "Not removed", inv.id);
            }}
          />
        )}
      </Dialog>
    </div>
  );
}
