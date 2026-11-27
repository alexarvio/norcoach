"use client";

// ---- New invoice (26 Nov, Alex: B of docs/boards/invoice-new-mockup.html, "B on new invoice"), the pop-up on a client's
// Invoices tab: the form on the left, what the client gets on the right, drawn as it is typed.
//
// CONTRACT (for InvoicesDraft.tsx, which opens it):
//   export function NewInvoiceDialog(props: { clientId: number; firstName: string; clientName: string; plan: DraftInvoices;
//     onClose: () => void; onDone: (r: { invoiceId?: number; sent: boolean }) => void })
//   - Renders its own <Dialog open> (backdrop, card, Esc and the scrim closing it): mount it while it should show,
//     `{adding && <NewInvoiceDialog … />}`; Cancel, ✕, Esc and the scrim call onClose.
//   - Calls createInvoiceAction itself, with the lines (the month chip kept as "{month}"), the note, the issue day, the
//     repeat, how the client pays (`pays`), Charge automatically (`auto`), the plan picked (`planId`) and the template
//     used. A price on the plan's line other than the plan's becomes the client's own price (the action does it, on a
//     repeat tied to their plan). Send: sent now, and every one the series makes sent by itself. Save draft: not sent,
//     the series' ones waiting too.
//   - On an answer it refreshes the page (router.refresh) and calls onDone({ invoiceId, sent }); the tab closes it there.
//     A failure stays open with `Not created. Try again` in red on the footer.
//
// The form: the client's plan first (picked from the start; the floating list of the coach's plans with price | rhythm,
// Custom at its foot clearing to one empty line and Once), the month as a chip in a line's words (+ Month on the line's
// hover adds it, its × takes it out), Issued and Due, the lines and their sums, the note empty, Repeat said back under
// its capsule (its room kept on Once), How {First} pays (Pay by link | Bank transfer) and, on a repeat paid by link,
// Charge automatically; Cancel, Save draft in words, Send the brand pill. The preview: WHAT {FIRST} GETS, Email | Page,
// the invoice email and our invoice page as they are drawn for real (lib/mail.ts invoiceEmail, app/invoice/[id]).

import { useMemo, useRef, useState, useTransition, type CSSProperties } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { adminView } from "../paths";
import { createInvoiceAction, deleteInvoiceTemplateAction, saveInvoiceTemplateAction } from "../../../lib/actions";
import type { InvoiceEvery, InvoiceLine, InvoicePays, InvoiceTemplate } from "../../../lib/db";
import { Dialog, DialogClose, DialogContent, DialogDescription } from "../../../components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover";
import { CheckIcon, ChevronDownIcon, PlusIcon } from "../../../components/icons";
import { NorCoachLogo } from "../../../components/NorCoachLogo";
import { Bars } from "../../../client/Bars";
import DatePick from "../DatePick";
import { PopupTitle } from "../PopupWho";
import { SepJoin } from "../Sep";
import type { DraftInvoices } from "../loaders";
import { dayMonth } from "../../../lib/dayMonth";
import { dayWords } from "../../../lib/clientDates";
import { newOnceKey } from "../../../lib/onceKey";
import { planFacts, planMoney } from "../../../lib/planText";
import { brandWord, ordinal } from "../../../lib/payWords";
import { addDays, cents, EVERY, figure, fill, firstNext, inDays, MONTHS, money, num, planLineIndex, totals, wholeMoney } from "./invoiceBits";
import "./new-invoice.css";
// Our invoice page's own styles, so the Page preview is drawn exactly as the client's browser draws it.
import "../../../invoice/[id]/invoice-page.css";

type Pays = InvoicePays;
type View = "mail" | "page";
/** A line as typed: its words before the month chip, whether the chip is in it, the words after it, the figures as typed. */
type Draft = { pre: string; chip: boolean; post: string; quantity: string; unit_price: string };
const CUSTOM = "custom";
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const blankLine = (): Draft => ({ pre: "", chip: false, post: "", quantity: "1", unit_price: "" });
/** "Online coaching, {month}" → the words, the chip, the words after it (the first {month} is the chip). */
function draftOf(l: Pick<InvoiceLine, "description" | "quantity" | "unit_price">): Draft {
  const d = String(l.description ?? "");
  const at = d.search(/\{month\}/i);
  const figures = { quantity: String(l.quantity ?? 1), unit_price: l.unit_price ? String(l.unit_price) : "" };
  if (at < 0) return { pre: d, chip: false, post: "", ...figures };
  return { pre: d.slice(0, at).replace(/\s+$/, ""), chip: true, post: d.slice(at + "{month}".length), ...figures };
}
/** The line's words as stored: the chip as "{month}", which the server fills with each invoice's month. */
const wordsOf = (l: Draft) => (l.chip ? `${l.pre}${l.pre.trim() ? " " : ""}{month}${l.post}` : l.pre);
/** The words as the client reads them on the day it is issued. */
const readOf = (l: Draft, day: string) => fill(wordsOf(l), day).trim();

export function NewInvoiceDialog({ clientId, firstName, clientName, plan, onClose, onDone }: { clientId: number; firstName: string; clientName: string; plan: DraftInvoices; onClose: () => void; onDone: (r: { invoiceId?: number; sent: boolean }) => void }) {
  const router = useRouter();
  const c = plan.compose;
  const inv = c.invoicing;
  const cur = inv.currency;
  const m = (n: number) => money(n, cur);
  // The plans to pick: every one still offered, and the client's own even when it was archived.
  const plans = useMemo(() => c.plans.filter((p) => !p.archived || p.id === c.clientPlanId), [c.plans, c.clientPlanId]);
  const priceFor = (p: (typeof plans)[number]) => (p.id === c.clientPlanId && c.ownPrice != null ? c.ownPrice : p.price);
  const linesFor = (p: (typeof plans)[number]): Draft[] => {
    const price = priceFor(p);
    return [{ pre: p.every === "month" ? `${p.name},` : p.name, chip: p.every === "month", post: "", quantity: "1", unit_price: price != null && price > 0 ? String(price) : "" }];
  };
  const start = plans.find((p) => p.id === c.clientPlanId) ?? null;

  const [planId, setPlanId] = useState<string>(start ? start.id : CUSTOM);
  const [issue, setIssue] = useState(plan.today);
  const [lines, setLines] = useState<Draft[]>(start ? linesFor(start) : [blankLine()]);
  const [note, setNote] = useState("");
  const [repeat, setRepeat] = useState<InvoiceEvery | null>(start?.every ?? null);
  // Pay by link unless the coach can't take cards and has bank details to print instead.
  const [pays, setPays] = useState<Pays>(!c.canPayByLink && inv.bank ? "bank" : "link");
  const [auto, setAuto] = useState(true);
  const [templates, setTemplates] = useState<InvoiceTemplate[]>(plan.templates);
  const [tpl, setTpl] = useState<string | null>(null);
  const [view, setView] = useState<View>("page");
  const [listOpen, setListOpen] = useState(false);
  const [error, setError] = useState(false);
  const [busy, run] = useTransition();
  const onceKey = useRef<string | null>(null);

  const picked = plans.find((p) => p.id === planId) ?? null;
  const pickPlan = (id: string) => {
    setListOpen(false);
    setPlanId(id);
    setTpl(null);
    const p = plans.find((x) => x.id === id);
    if (!p) {
      setLines([blankLine()]);
      setRepeat(null);
      return;
    }
    setLines(linesFor(p));
    setRepeat(p.every ?? null);
  };

  // The lines as numbers; a line is whole with words and a quantity, and every figure readable.
  const clean = lines.map((l) => ({ description: wordsOf(l).trim(), quantity: num(l.quantity), unit_price: num(l.unit_price) }));
  const bad = (l: (typeof clean)[number]) => !Number.isFinite(l.quantity) || !Number.isFinite(l.unit_price);
  const whole = (l: (typeof clean)[number]) => !!l.description && l.quantity > 0 && !bad(l);
  const good = clean.filter(whole);
  // A line started but not whole (a price and no words, an amount that won't read): nothing goes until it is.
  const unfinished = clean.some((l, i) => (l.description || lines[i].unit_price.trim()) && !whole(l));
  const t = totals(good, inv.vatRate, inv.pricesIncludeVat);
  const ready = good.length > 0 && !unfinished && !!issue && !busy;
  const setLine = (i: number, patch: Partial<Draft>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const month = issue ? MONTHS[new Date(`${issue}T12:00:00`).getMonth()] : "";

  // The plan's line and the price typed on it: another than the plan's is the client's own (struck plan price, theirs in ink).
  const planLine = picked ? planLineIndex(lines.map((l) => ({ description: wordsOf(l), quantity: 1, unit_price: 0 })), picked.name) : -1;
  const typedPrice = planLine >= 0 && lines[planLine] ? num(lines[planLine].unit_price) : NaN;
  const ownTyped = !!picked && picked.price != null && Number.isFinite(typedPrice) && typedPrice > 0 && cents(typedPrice) !== cents(picked.price);
  // It is kept as theirs only where the action keeps it: a repeat tied to their plan, which nothing bills yet.
  const keptAsTheirs = ownTyped && !!repeat && planId === c.clientPlanId && !plan.billing.series?.planId;

  const due = issue ? addDays(issue, inv.termsDays) : "";
  const next = repeat && issue ? firstNext(issue, repeat, plan.today) : null;
  const linkWorks = pays === "link" && c.canPayByLink;
  const autoShown = !!repeat && linkWorks;
  const autoOn = autoShown && auto;

  // Said back under Repeat: "€89 on the 26th of every month | next 26/12".
  const anchor = issue ? Number(issue.slice(8, 10)) : 1;
  const weekday = issue ? WEEKDAYS[new Date(`${issue}T12:00:00`).getDay()] : "";
  const rhythm = repeat === "month" ? `on the ${ordinal(anchor)} of every month` : repeat === "2weeks" ? `every other ${weekday}` : repeat === "week" ? `every ${weekday}` : "";
  const saidBack = t.total > 0 ? `${wholeMoney(t.total, cur)} ${rhythm}` : rhythm.charAt(0).toUpperCase() + rhythm.slice(1);

  const create = (send: boolean) => {
    if (!ready) return;
    setError(false);
    onceKey.current ??= newOnceKey();
    const key = onceKey.current;
    run(async () => {
      const id = await createInvoiceAction(clientId, { issueDate: issue, lines: good, note: note.trim(), sent: send, repeat, template: tpl, planId: picked ? picked.id : null, pays, auto: autoOn }, key).catch(() => null);
      if (id == null) {
        // A new attempt gets a new key; the one that failed answered nothing to keep.
        onceKey.current = null;
        setError(true);
        return;
      }
      router.refresh();
      onDone({ invoiceId: id, sent: send });
    });
  };

  const useTemplate = (x: InvoiceTemplate) => {
    const ls = x.lines.length ? x.lines.map(draftOf) : [blankLine()];
    setLines(ls);
    setNote(x.note ?? "");
    setTpl(x.name);
    // Still the plan when the template has the plan's line, else it is custom.
    if (picked && !ls.some((l) => wordsOf(l).trim().toLowerCase().startsWith(picked.name.trim().toLowerCase()))) setPlanId(CUSTOM);
  };

  const brandStyle = { ...(c.coach.brand ? { "--brand": c.coach.brand.hex, "--brand-ink": c.coach.brand.ink } : {}), ...(c.coach.mark ? { "--bg-mark": `url("${c.coach.mark}")` } : {}) } as CSSProperties;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="dlh nvb">
        <div className="dlh-head">
          <PopupTitle>New invoice</PopupTitle>
          <DialogClose className="dlh-x" aria-label="Close">
            ✕
          </DialogClose>
        </div>

        <div className="nvb-split">
          <div className="nvb-form">
            <div className="nvb-sub">
              <DialogDescription className="nvb-num">
                <span className="sr-only">{`${clientName}, invoice `}</span>
                {inv.nextNumber}
              </DialogDescription>
              <TemplatePicker templates={templates} current={tpl} lines={good} note={note.trim()} onUse={useTemplate} onSaved={(list, name) => (setTemplates(list), setTpl(name))} onDeleted={(list) => setTemplates(list)} />
            </div>

            {/* ---- The plan leads: the client's own picked from the start. */}
            <div className="nvb-field">
              <span className="dlh-label">Plan</span>
              <Popover modal open={listOpen} onOpenChange={setListOpen}>
                <PopoverTrigger className="nvb-pick" aria-label={`Plan: ${picked ? picked.name : "Custom"}`}>
                  <span className="nvb-pick-name">{picked ? picked.name : "Custom"}</span>
                  {picked && (
                    <span className="nvb-pick-facts">
                      {ownTyped && picked.price != null ? (
                        <SepJoin
                          parts={[
                            <span key="p">
                              <s>{planMoney(picked.price, cur)}</s> <em>{`${planMoney(typedPrice, cur)}${keptAsTheirs ? ` for ${firstName}` : ""}`}</em>
                            </span>,
                            planFacts({ price: null, every: picked.every }, cur)[0],
                          ]}
                        />
                      ) : (
                        <SepJoin parts={planFacts(picked, cur)} />
                      )}
                    </span>
                  )}
                  <ChevronDownIcon />
                </PopoverTrigger>
                <PopoverContent align="start" className="pb-menu nvb-planpop">
                  <div className="nvb-planlist">
                    {plans.map((p) => (
                      <button key={p.id} type="button" className={`nvb-planrow${p.id === planId ? " on" : ""}`} onClick={() => pickPlan(p.id)}>
                        <CheckIcon />
                        <span className="nvb-planrow-name">{p.name}</span>
                        <small>
                          <SepJoin parts={planFacts(p, cur)} />
                        </small>
                      </button>
                    ))}
                  </div>
                  {/* Pinned at its foot (design rules 6). */}
                  <div className="nvb-planfoot">
                    <button type="button" className={`nvb-planrow${planId === CUSTOM ? " on" : ""}`} onClick={() => pickPlan(CUSTOM)}>
                      <CheckIcon />
                      <span className="nvb-planrow-name">Custom</span>
                    </button>
                  </div>
                </PopoverContent>
              </Popover>
            </div>

            <div className="nvb-dates">
              <div className="nvb-field">
                <span className="dlh-label">Issued</span>
                <DatePick value={issue} onChange={setIssue} label="Issued" className="nvb-daypick" />
              </div>
              <div className="nvb-field">
                <span className="dlh-label">Due</span>
                <span className="nvb-static">
                  <SepJoin parts={[due ? dayMonth(due) : <span key="n" className="nvb-faint">—</span>, <small key="in">{inDays(inv.termsDays)}</small>]} />
                </span>
              </div>
            </div>

            {/* ---- The lines: the month a chip in the words, then qty, price, amount, ✕ on hover. */}
            <div className="nvb-field">
              <span className="dlh-label">
                <SepJoin parts={["Lines", inv.vatRate > 0 && <small key="vat">{`Prices ${inv.pricesIncludeVat ? "include" : "exclude"} ${inv.taxLabel}`}</small>]} />
              </span>
              <div className="nvb-lines">
                <div className="nvb-line head" aria-hidden="true">
                  <span>Description</span>
                  <span>Qty</span>
                  <span>Price</span>
                  <span>Amount</span>
                  <span />
                </div>
                {lines.map((l, i) => {
                  const cl = clean[i];
                  const words = !!wordsOf(l).trim();
                  return (
                    <div key={i} className="nvb-line">
                      <div className={`nvb-desc${!words && l.unit_price.trim() ? " bad" : ""}${l.chip ? "" : " nochip"}`}>
                        <input className="nvb-desc-in pre" value={l.pre} size={Math.max(2, l.pre.length + 1)} onChange={(e) => setLine(i, { pre: e.target.value })} maxLength={200} autoFocus={i === 0 && !l.pre} aria-label="Description" />
                        {l.chip && (
                          <>
                            <span className="nvb-chip" title="The month each invoice is for">
                              {month}
                              <button type="button" className="nvb-chip-x" onClick={() => setLine(i, { chip: false, pre: `${l.pre.replace(/,\s*$/, "")}${l.post}`, post: "" })} aria-label="Take the month out">
                                ✕
                              </button>
                            </span>
                            <input className="nvb-desc-in post" value={l.post} onChange={(e) => setLine(i, { post: e.target.value })} maxLength={200} aria-label="Description, after the month" />
                          </>
                        )}
                        {!l.chip && (
                          <button type="button" className="nvb-addmonth" onClick={() => setLine(i, { chip: true, pre: l.pre && !/[,\s]$/.test(l.pre) ? `${l.pre},` : l.pre })}>
                            + Month
                          </button>
                        )}
                      </div>
                      <input className={`nvb-in num${!Number.isFinite(cl.quantity) || (words && cl.quantity <= 0) ? " bad" : ""}`} inputMode="decimal" value={l.quantity} onChange={(e) => setLine(i, { quantity: figure(e.target.value) })} aria-label="Quantity" />
                      <input className={`nvb-in num${Number.isFinite(cl.unit_price) ? "" : " bad"}`} inputMode="decimal" value={l.unit_price} onChange={(e) => setLine(i, { unit_price: figure(e.target.value) })} aria-label="Price" />
                      <span className="nvb-amount">{bad(cl) || !l.unit_price.trim() ? <span className="nvb-faint">—</span> : m(cents(cl.quantity * cl.unit_price))}</span>
                      <button type="button" className="nvb-x" onClick={() => setLines((ls) => (ls.length === 1 ? [blankLine()] : ls.filter((_, j) => j !== i)))} aria-label="Remove this line" title="Remove">
                        ✕
                      </button>
                    </div>
                  );
                })}
                <button type="button" className="nvb-addline" onClick={() => setLines((ls) => [...ls, blankLine()])}>
                  <PlusIcon /> Line
                </button>
                <dl className="nvb-totals">
                  <dt>Subtotal</dt>
                  <dd>{t.total > 0 ? m(t.subtotal) : <span className="nvb-faint">—</span>}</dd>
                  {/* No tax line where there is no tax (the US, no country yet), as the page and the sheet print it (26 Nov). */}
                  {inv.vatRate > 0 && (
                    <>
                      <dt>{`${inv.taxLabel} ${inv.vatRate}%`}</dt>
                      <dd>{t.total > 0 ? m(t.vat) : <span className="nvb-faint">—</span>}</dd>
                    </>
                  )}
                  <dt className="grand">Total</dt>
                  <dd className="grand">{t.total > 0 ? m(t.total) : <span className="nvb-faint">—</span>}</dd>
                </dl>
              </div>
            </div>

            <label className="nvb-field">
              <span className="dlh-label">Note</span>
              <textarea
                className="nvb-note"
                rows={1}
                value={note}
                onChange={(e) => {
                  setNote(e.target.value);
                  e.target.style.height = "auto";
                  e.target.style.height = `${e.target.scrollHeight}px`;
                }}
                maxLength={600}
              />
            </label>

            {/* ---- Repeat, said back in facts under it; its room kept on Once, so nothing under it moves. */}
            <div className="nvb-field">
              <span className="dlh-label">Repeat</span>
              <div className="rd-btn-group nvb-cap" role="radiogroup" aria-label="Repeat">
                {EVERY.map((e) => (
                  <button key={e.label} type="button" role="radio" aria-checked={repeat === e.value} className={repeat === e.value ? "on" : ""} onClick={() => setRepeat(e.value)}>
                    {e.label}
                  </button>
                ))}
              </div>
              <div className={`nvb-back${repeat && next ? "" : " hide"}`} aria-hidden={!repeat}>
                {repeat && next ? <SepJoin parts={[saidBack, <span key="n" className="nvb-grey">{`next ${dayMonth(next)}`}</span>]} /> : " "}
              </div>
            </div>

            {/* ---- How the client pays: our page's Pay (on the coach's own Stripe), or a bank transfer marked paid by hand. */}
            <div className="nvb-field">
              <span className="dlh-label">{`How ${firstName} pays`}</span>
              <div className="rd-btn-group nvb-cap" role="radiogroup" aria-label={`How ${firstName} pays`}>
                {(
                  [
                    ["link", "Pay by link"],
                    ["bank", "Bank transfer"],
                  ] as const
                ).map(([v, label]) => (
                  <button key={v} type="button" role="radio" aria-checked={pays === v} className={pays === v ? "on" : ""} onClick={() => setPays(v)}>
                    {label}
                  </button>
                ))}
              </div>
              <div className="nvb-back">
                {pays === "link" ? (
                  c.canPayByLink ? (
                    <SepJoin parts={["Card", cur.toUpperCase() === "EUR" ? "iDEAL" : null, "Apple Pay"]} />
                  ) : (
                    <span className="nvb-fix">
                      <span>Card payments aren&rsquo;t set up</span>
                      <Link href={adminView("settings", "#invoicing")}>Set up</Link>
                    </span>
                  )
                ) : inv.bank ? (
                  <SepJoin parts={[inv.bank.iban ? spaced(inv.bank.iban) : "Your bank details", <span key="h" className="nvb-grey">You mark it paid</span>]} />
                ) : (
                  <span className="nvb-fix">
                    <span>No bank details</span>
                    <Link href={adminView("settings", "#invoicing")}>Add them</Link>
                  </span>
                )}
              </div>
              <div className={`nvb-swrow${autoShown ? "" : " hide"}`} aria-hidden={!autoShown}>
                <div className="nvb-swrow-words">
                  <b>Charge automatically</b>
                  <small>{plan.billing.autopay ? `Charged to ${autopayLine(plan.billing.autopay)}` : `Asked on ${firstName}’s first payment`}</small>
                </div>
                <button type="button" role="switch" aria-checked={auto} aria-label="Charge automatically" tabIndex={autoShown ? 0 : -1} className={`nvb-switch${auto ? " on" : ""}`} onClick={() => setAuto((a) => !a)}>
                  <i />
                </button>
              </div>
            </div>
          </div>

          {/* ---- What the client gets, as it is typed: the email, or the page its button opens. */}
          <aside className="nvb-pv" aria-label={`What ${firstName} gets`}>
            <div className="nvb-pvhead">
              <span className="dlh-label">{`What ${firstName} gets`}</span>
              <div className="rd-btn-group nvb-cap" role="radiogroup" aria-label="Preview">
                {(
                  [
                    ["mail", "Email"],
                    ["page", "Page"],
                  ] as const
                ).map(([v, label]) => (
                  <button key={v} type="button" role="radio" aria-checked={view === v} className={view === v ? "on" : ""} onClick={() => setView(v)}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <Preview
              view={view}
              style={brandStyle}
              number={inv.nextNumber}
              seller={c.coach.business || c.coach.first || "Coach"}
              coachName={c.coach.first}
              email={c.email}
              currency={cur}
              lines={lines.filter((_, i) => whole(clean[i])).map((l) => ({ words: readOf(l, issue || plan.today), quantity: num(l.quantity), unit_price: num(l.unit_price) }))}
              totals={t}
              vat={{ label: inv.taxLabel, rate: inv.vatRate }}
              issue={issue || plan.today}
              due={due || null}
              payable={linkWorks}
              offer={autoOn && !plan.billing.autopay && next ? offerFact(t.total, cur, repeat!, anchor, next) : null}
              kept={autoOn && plan.billing.autopay ? autopayLine(plan.billing.autopay) : null}
              bank={inv.bank}
            />
          </aside>
        </div>

        <div className="dlh-foot nvb-foot">
          {error && <span className="dlh-error nvb-error">Not created. Try again</span>}
          <DialogClose className="dlh-cancel">Cancel</DialogClose>
          <button type="button" className="nvb-draft" disabled={!ready} onClick={() => create(false)}>
            Save draft
          </button>
          <button type="button" className="dlh-go" disabled={!ready} onClick={() => create(true)}>
            Send
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const spaced = (s: string) => s.replace(/\s+/g, "").replace(/(.{4})/g, "$1 ").trim();
/** A kept way to pay as the page says it: "Visa •••• 4242", "SEPA •••• 3000". */
const autopayLine = (a: NonNullable<DraftInvoices["billing"]["autopay"]>) => {
  const head = a.kind === "card" ? brandWord(a.brand) : a.brand || "SEPA";
  return a.last4 ? `${head} •••• ${a.last4}` : head;
};
/** The tick's fact on the page, as autopayOfferFor writes it: "€89 on the 26th of each month from 26 Dec". */
const offerFact = (total: number, currency: string, every: InvoiceEvery, anchor: number, next: string) => {
  const amount = wholeMoney(total, currency);
  if (every === "month") return `${amount} on the ${ordinal(anchor)} of each month from ${dayWords(next)}`;
  return `${amount} every ${every === "week" ? "week" : "2 weeks"} from ${dayWords(next)}`;
};

// ---- The preview: the invoice email (lib/mail.ts invoiceEmail) and our page (app/invoice/[id]/page.tsx), drawn from
// the form. The page wears its own classes (invoice-page.css), the email its inline styles redrawn here.
type PreviewLine = { words: string; quantity: number; unit_price: number };
function Preview({
  view,
  style,
  number,
  seller,
  coachName,
  email,
  currency,
  lines,
  totals: t,
  vat,
  issue,
  due,
  payable,
  offer,
  kept,
  bank,
}: {
  view: View;
  style: CSSProperties;
  number: string;
  seller: string;
  coachName: string;
  email: string | null;
  currency: string;
  lines: PreviewLine[];
  totals: { subtotal: number; vat: number; total: number };
  vat: { label: string; rate: number };
  issue: string;
  due: string | null;
  payable: boolean;
  offer: string | null;
  kept: string | null;
  bank: DraftInvoices["compose"]["invoicing"]["bank"];
}) {
  const m = (n: number) => money(n, currency);
  const [ticked, setTicked] = useState(false);
  // The bank details as both print them: the holder, the IBAN, the reference (or the coach's own words).
  const bankRows: { label: string; value: string }[] = [];
  if (bank?.iban) bankRows.push({ label: "IBAN", value: spaced(bank.iban) });
  const bankWords = !bankRows.length && bank?.words ? bank.words : null;
  if (bank?.holder && (bankRows.length || bankWords)) bankRows.unshift({ label: "Account holder", value: bank.holder });
  const hasBank = bankRows.length > 0 || !!bankWords;
  const first = lines[0]?.words ?? "";
  const what = lines.length > 1 ? `${first} + ${lines.length - 1} more` : first;
  const host = typeof window !== "undefined" ? window.location.host : "";

  if (view === "mail") {
    const facts: [string, string][] = [["Invoice", number], ["For", what || "—"], ["Issued", dayWords(issue)], ...(due ? ([["Due", dayWords(due)]] as [string, string][]) : [])];
    return (
      <div className="nvb-mail" style={style}>
        <div className="nvb-mailmeta">
          <SepJoin parts={[<b key="f">{seller}</b>, email ?? "No email address"]} />
          <br />
          {`Invoice ${number} from ${seller}`}
        </div>
        <div className="nvb-mailcard">
          <div className="nvb-mail-label">Invoice</div>
          <div className="nvb-mail-seller">{seller}</div>
          <div className="nvb-mail-amount">{m(t.total)}</div>
          <table className="nvb-mail-facts">
            <tbody>
              {facts.map(([k, v]) => (
                <tr key={k}>
                  <td>{k}</td>
                  <td className={k === "For" ? "" : "num"}>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="nvb-mail-btns">
            {payable && <span className="nvb-mail-pill main">{`Pay ${m(t.total)}`}</span>}
            <span className={`nvb-mail-pill${payable ? "" : " main"}`}>View invoice</span>
          </div>
          {hasBank && (
            <div className="nvb-mail-bank">
              <div className="nvb-mail-label">Bank transfer</div>
              <table className="nvb-mail-facts">
                <tbody>
                  {[...bankRows, { label: "Reference", value: number }].map((b) => (
                    <tr key={b.label}>
                      <td>{b.label}</td>
                      <td className="num">{b.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {bankWords && <p className="nvb-mail-words">{bankWords}</p>}
            </div>
          )}
        </div>
        <div className="nvb-mail-foot">Norcoach</div>
      </div>
    );
  }

  return (
    <div className="nvb-page">
      <div className="nvb-url">{`${host || "norcoachapp.com"}/invoice/…`}</div>
      <div className="ivw nvb-ivw" style={style}>
        <div className="ivw-card">
          <header className="ivw-dark">
            <div className="ivw-label">Invoice {number}</div>
            <div className="ivw-business">{seller}</div>
            {coachName && coachName !== seller && <div className="ivw-coach">{coachName}</div>}
          </header>
          <section className="ivw-paper">
            <div className="ivw-small">Amount due</div>
            <div className="ivw-amount">{m(t.total)}</div>
            <div className="ivw-facts">
              <Bars parts={[due ? `Due ${dayWords(due, { weekday: "short" })}` : null, `Issued ${dayWords(issue, { weekday: "short" })}`]} />
            </div>
            <div className="ivw-lines">
              {lines.map((l, i) => (
                <div key={i} className="ivw-line">
                  <span>
                    {l.words}
                    {l.quantity !== 1 && <small>{`${l.quantity} × ${m(l.unit_price)}`}</small>}
                  </span>
                  <b>{m(cents(l.quantity * l.unit_price))}</b>
                </div>
              ))}
              {vat.rate > 0 && (
                <>
                  <div className="ivw-sum">
                    <span>Subtotal</span>
                    <b>{m(t.subtotal)}</b>
                  </div>
                  <div className="ivw-sum">
                    <span>{`${vat.label} ${vat.rate}%`}</span>
                    <b>{m(t.vat)}</b>
                  </div>
                </>
              )}
              <div className="ivw-sum total">
                <span>Total</span>
                <b>{m(t.total)}</b>
              </div>
            </div>
            {payable && (
              <div className="ivw-pay">
                {offer && (
                  <label className="ivw-auto">
                    <input type="checkbox" checked={ticked} onChange={(e) => setTicked(e.target.checked)} />
                    <span>
                      Pay automatically from now on
                      <small>{offer}</small>
                    </span>
                  </label>
                )}
                <span className="ivw-btn nvb-ivw-btn">{`Pay ${m(t.total)}`}</span>
                <div className="ivw-methods">
                  <Bars parts={["Card", currency.toUpperCase() === "EUR" ? "iDEAL" : null, "Apple Pay"]} />
                </div>
                {kept && (
                  <div className="ivw-methods">
                    <Bars parts={["Automatic", kept]} />
                  </div>
                )}
              </div>
            )}
            {!payable && hasBank && (
              <div className="ivw-bank">
                <div className="ivw-small">Bank transfer</div>
                {[...bankRows, { label: "Reference", value: number }].map((b) => (
                  <div key={b.label} className="ivw-sum">
                    <span>{b.label}</span>
                    <b>{b.value}</b>
                  </div>
                ))}
                {bankWords && <p className="ivw-words">{bankWords}</p>}
              </div>
            )}
          </section>
        </div>
        <footer className="ivw-foot">
          <span>Powered by</span>
          <NorCoachLogo word />
        </footer>
      </div>
    </div>
  );
}

// ---- Templates (21 Oct, Alex): the coach's saved invoices, a floating list (design rules 6): a pick fills the lines
// and the note; "Save as template" at its foot names what is typed now (the same name replaces one), ✕ removes one
// (asked first, in place). Kept as the old pop-up had it (26 Nov, Alex: B keeps the Template pill).
function TemplatePicker({
  templates,
  current,
  lines,
  note,
  onUse,
  onSaved,
  onDeleted,
}: {
  templates: InvoiceTemplate[];
  current: string | null;
  lines: InvoiceLine[];
  note: string;
  onUse: (t: InvoiceTemplate) => void;
  onSaved: (list: InvoiceTemplate[], name: string) => void;
  onDeleted: (list: InvoiceTemplate[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [asking, setAsking] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, start] = useTransition();
  const save = () =>
    start(async () => {
      const n = name.trim();
      const r = await saveInvoiceTemplateAction({ name: n, lines, note }).catch(() => null);
      if (!r?.ok) {
        setFailed(true);
        return;
      }
      onSaved(r.list, n);
      setNaming(false);
      setOpen(false);
    });
  const remove = (t: InvoiceTemplate) =>
    start(async () => {
      const list = await deleteInvoiceTemplateAction(t.id).catch(() => null);
      if (list) onDeleted(list);
      setAsking(null);
    });
  return (
    // Modal: inside the New invoice dialog, the list takes the top scroll lock, so the wheel and a finger scroll it.
    <Popover
      modal
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setNaming(false);
          setAsking(null);
          setFailed(false);
        }
      }}
    >
      <PopoverTrigger className="nvb-tpl-btn" aria-label={`Template${current ? `: ${current}` : ""}`}>
        <span>{current ?? "Template"}</span>
        <ChevronDownIcon />
      </PopoverTrigger>
      <PopoverContent align="end" className="pb-menu nvb-tpl-pop">
        {naming ? (
          <div className="nvb-tpl-new">
            <span className="dlh-label">Save as template</span>
            <input className="dlh-line" value={name} onChange={(e) => (setName(e.target.value), setFailed(false))} onKeyDown={(e) => e.key === "Enter" && name.trim() && lines.length > 0 && !busy && save()} maxLength={60} autoFocus aria-label="Template name" />
            {failed && <p className="dlh-error">Not saved. Try again</p>}
            <div className="nvb-tpl-foot">
              <button type="button" className="dlh-cancel" onClick={() => setNaming(false)}>
                Cancel
              </button>
              <button type="button" className="dlh-go" disabled={!name.trim() || lines.length === 0 || busy} onClick={save}>
                Save
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="nvb-tpl-list">
              {templates.length === 0 ? (
                <p className="nvb-tpl-none">None yet</p>
              ) : (
                templates.map((t) =>
                  asking === t.id ? (
                    <div key={t.id} className="nvb-tpl-row ask">
                      <span>Remove {t.name}?</span>
                      <button type="button" className="nvb-tpl-act" onClick={() => setAsking(null)}>
                        Cancel
                      </button>
                      <button type="button" className="nvb-tpl-act danger" disabled={busy} onClick={() => remove(t)}>
                        Remove
                      </button>
                    </div>
                  ) : (
                    <div key={t.id} className={`nvb-tpl-row${t.name === current ? " on" : ""}`}>
                      <button
                        type="button"
                        className="nvb-tpl-pick"
                        onClick={() => {
                          onUse(t);
                          setOpen(false);
                        }}
                      >
                        <b>{t.name}</b>
                        <small>
                          <SepJoin parts={[t.lines[0]?.description, t.lines.length > 1 ? `+ ${t.lines.length - 1} more` : null]} />
                        </small>
                      </button>
                      <button type="button" className="nvb-tpl-x" onClick={() => setAsking(t.id)} aria-label={`Remove ${t.name}`} title="Remove">
                        ✕
                      </button>
                    </div>
                  )
                )
              )}
            </div>
            {/* Pinned at the foot, outside the list's scroll (design rules 6). */}
            <button
              type="button"
              className="nvb-tpl-save"
              disabled={lines.length === 0}
              onClick={() => {
                setName(current ?? "");
                setNaming(true);
              }}
            >
              <PlusIcon /> Save as template
            </button>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
