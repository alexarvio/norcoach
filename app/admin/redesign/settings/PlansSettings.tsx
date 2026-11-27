"use client";

import { useState, useTransition, type MouseEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { addPlanAction, deletePlanAction, setClientPlanPriceAction, setPlanArchivedAction, updatePlanAction } from "../../../lib/planActions";
import type { InvoiceEvery } from "../../../lib/db";
import type { PlanClientRow } from "../../../lib/coachPlans";
import { newOnceKey } from "../../../lib/onceKey";
import { PLAN_EVERY, monthWorth, planMoney, vatSplit, type PlanChoice } from "../../../lib/planText";
import { dayMonth } from "../../../lib/dayMonth";
import { pic } from "../../../lib/pic";
import { num } from "../invoices/invoiceBits";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../../components/ui/dropdown-menu";
import { MoreIcon, PlusIcon } from "../../../components/icons";
import { ConfirmChoice } from "../ConfirmParts";
import { Sep, SepJoin } from "../Sep";
import { Capsule, Line, Part, Pill, SectionActions, Word } from "./Rows";
import "./more.css";
import "./plans.css";

// Settings › Plans as cards (26 Nov, Alex: A of docs/boards/plans-redesign-mockup.html; was a list of rows, 23 Nov). A
// card a plan, two across (one where the section is narrow): its name, the price big with its rhythm grey, the VAT in
// it grey under it (the business's rate, none where there is no tax line), then its clients' faces, `3 clients | €257
// a month` (what they really pay, a month's worth, whole money; the example client in no sum) and `1 on their own
// price`. Archived plans last and faded. A click opens the card where it is (the card under it moves down, nothing
// beside it): Name and Price (the VAT split live as it is typed), Week | 2 weeks | Month, then, once a new price is
// typed and clients billed on the old one would stay there, a grey well to tick: Also move them, from their next
// invoice (unticked, the old price becomes theirs and their rows say Own price before Save); then its clients, each
// with their price on a clean line (a figure that isn't the plan's is their own price, `Own price`, and the row's
// hover `Back to €89`); Cancel in words and the brand Save. ⋯ on hover: Archive (out of the Details picker, its
// clients still billed) or Restore, and Delete only with no client on it, asking in the ⋯ itself. The dashed last tile
// is + Plan, turning into the new card in its own room; + Plan beside the title too. No plan: the title and + Plan
// alone. Each change saved at once through the plan actions (planActions.ts), never on the page's bar, no Saved toast
// (the card showing the new figures says it); only a failure pops up. No sample text in a field (23 Nov, Alex).

export type PlanRow = PlanChoice & { archived: boolean; clients: number; members: PlanClientRow[]; ownCount: number; monthWorth: number };
/** The business's tax for the VAT line: its rate in percent, whether prices hold it, and its word (VAT, GST/HST). */
export type PlanVat = { rate: number; included: boolean; label: string };

/** A client's price as typed on their row; `touched` once the coach typed it, else it follows the plan's. */
type ClientDraft = { val: string; touched: boolean };
type Draft = { name: string; price: string; every: InvoiceEvery; move: boolean; clients: Record<number, ClientDraft> };
type NewDraft = { name: string; price: string; every: InvoiceEvery };
/** What a save shows at once, until the page drawn again holds it. */
type Shown = { name: string; price: number | null; every: InvoiceEvery | null; archived?: boolean; members?: PlanClientRow[] };

/** A typed figure: null when empty, NaN when it isn't one. Read as an invoice line reads one (26 Nov: "1,250" is 1250,
    "89,50" is 89.5; a lone comma made a decimal turned €1,250 into €1.25). */
const priceOf = (s: string): number | null => {
  const t = s.trim();
  if (t === "") return null;
  const n = num(t);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : NaN;
};
const priceBad = (s: string) => Number.isNaN(priceOf(s));
/** A client's price must be a figure over nothing (setClientPlanPrice refuses 0); empty is the plan's. */
const clientBad = (s: string) => {
  const n = priceOf(s);
  return n != null && (Number.isNaN(n) || n <= 0);
};
const cleanTyped = (s: string) => s.replace(/[^\d.,]/g, "");
const PER: Record<InvoiceEvery, string> = { week: "a week", "2weeks": "every 2 weeks", month: "a month" };
const EVERY_OPTIONS = PLAN_EVERY.map((e) => ({ value: e.value, label: e.label }));
const firstOf = (name: string) => name.trim().split(/\s+/)[0] || name;
/** "Alex", "Alex and Esmee", "Alex, Esmee and Elena". */
const andJoin = (a: string[]) => (a.length <= 1 ? (a[0] ?? "") : `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`);

/** The currency's sign before a price typed ("€", "$", "CHF"). */
function currencySign(currency: string): string {
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency }).formatToParts(0).find((p) => p.type === "currency")?.value ?? currency;
  } catch {
    return currency;
  }
}

/** To the cent, for the VAT line ("€73.55"). */
function cents(n: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}

/** The client's face: their photo, else their initial (white, the hairline, ink at 600; 16 Nov, Alex: the audit). */
function Face({ name, src }: { name: string; src: string | null }) {
  return (
    <span className="rpl-face" aria-hidden="true">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- the client's own upload, served by the app
        <img src={pic(src, 96)} alt="" loading="lazy" decoding="async" />
      ) : (
        name.trim().charAt(0).toUpperCase()
      )}
    </span>
  );
}

export default function PlansSettings({ plans, currency, vatFact, vat }: { plans: PlanRow[]; currency: string; vatFact: string | null; vat: PlanVat | null }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  // The card open to change (a plan's id) and its draft; `adding` the new card in the tile's room.
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [adding, setAdding] = useState<NewDraft | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  // What was saved, shown at once (a plan's new figures, archived, deleted, added faded at the end) until the plans
  // read change after it; dropped when the save failed.
  const plansKey = JSON.stringify(plans);
  const [shown, setShown] = useState<{ seen: string; edits: Record<string, Shown>; gone: string[]; added: NewDraft | null; pending: number }>({ seen: plansKey, edits: {}, gone: [], added: null, pending: 0 });
  if (shown.pending === 0 && shown.seen !== plansKey && (Object.keys(shown.edits).length || shown.gone.length || shown.added)) setShown({ seen: plansKey, edits: {}, gone: [], added: null, pending: 0 });

  const live: PlanRow[] = plans
    .filter((p) => !shown.gone.includes(p.id))
    .map((p) => {
      const e = shown.edits[p.id];
      return e ? { ...p, name: e.name, price: e.price, every: e.every, archived: e.archived ?? p.archived, members: e.members ?? p.members } : p;
    });
  const sorted = [...live.filter((p) => !p.archived), ...live.filter((p) => p.archived)];

  const money = (n: number) => planMoney(n, currency);
  /** "€73.55 + €15.45 VAT": the price's net and its tax, live while typed; nothing with no tax, no price or 0. */
  const vatWords = (price: number | null) => {
    if (!vat || price == null || Number.isNaN(price) || price <= 0) return "";
    const s = vatSplit(price, vat.rate, vat.included);
    return `${cents(s.net, currency)} + ${cents(s.vat, currency)} ${vat.label}`;
  };

  /** One run of saves: what it shows at once (`show`), then each call in order; a failure says so and drops it. */
  const run = (show: (s: typeof shown) => typeof shown, calls: () => Promise<boolean>) => {
    const startedOn = plansKey;
    setShown((s) => ({ ...show(s), pending: s.pending + 1 }));
    start(async () => {
      let ok = false;
      try {
        ok = await calls();
      } catch {
        ok = false;
      }
      if (ok) {
        // Kept until the plans read change from what they were when it started (the last call's page may be in already).
        setShown((s) => ({ ...s, seen: startedOn, pending: Math.max(0, s.pending - 1) }));
      } else {
        setShown({ seen: startedOn, edits: {}, gone: [], added: null, pending: 0 });
        toast.error("Not saved. Try again.");
      }
      router.refresh();
    });
  };

  // ---- A plan opened: the draft and what follows from it.
  const openPlan = (p: PlanRow) => {
    setMenu(null);
    setAsking(null);
    setAdding(null);
    setOpen(p.id);
    setDraft({ name: p.name, price: p.price != null ? String(p.price) : "", every: p.every ?? "month", move: false, clients: {} });
  };
  const close = () => {
    setOpen(null);
    setDraft(null);
  };

  /** The draft's price when it is a figure (null: none), else the plan's own. */
  const planPriceNow = (p: PlanRow, d: Draft) => {
    const n = priceOf(d.price);
    return Number.isNaN(n) ? p.price : n;
  };
  /** A new price, as the server reads one (coachPlans.ts updateCoachPlan): a figure over nothing, not the old. */
  const priceChanged = (p: PlanRow, d: Draft) => {
    const n = priceOf(d.price);
    return n != null && !Number.isNaN(n) && n > 0 && n !== p.price;
  };
  /** Clients billed on the plan's old price, with none of their own: the ones Also move is about. */
  const onOld = (p: PlanRow) => p.members.filter((m) => !m.own && m.next != null && m.price === p.price);
  /** What a client's row shows: what the coach typed, else their own price, else the plan's price as it will be for
      them (a billed client kept on the old one while Also move is off, the rest on the new). */
  const shownVal = (p: PlanRow, d: Draft, m: PlanClientRow) => {
    const c = d.clients[m.clientId];
    if (c?.touched) return c.val;
    if (m.own) return m.price != null ? String(m.price) : "";
    if (priceChanged(p, d)) {
      const stays = m.next != null && !d.move;
      return stays ? (m.price != null ? String(m.price) : "") : d.price.trim();
    }
    const now = planPriceNow(p, d);
    return now != null ? String(now) : m.price != null ? String(m.price) : "";
  };
  const isOwn = (p: PlanRow, d: Draft, m: PlanClientRow) => {
    const n = priceOf(shownVal(p, d, m));
    return n != null && !Number.isNaN(n) && n !== planPriceNow(p, d);
  };
  const nameTaken = (name: string, id: string | null) => plans.some((p) => p.id !== id && p.name.trim().toLowerCase() === name.trim().toLowerCase());
  const canSave = (p: PlanRow, d: Draft) => d.name.trim() !== "" && !nameTaken(d.name, p.id) && !priceBad(d.price) && p.members.every((m) => !clientBad(shownVal(p, d, m)));

  const setClient = (m: PlanClientRow, val: string) => setDraft((d) => (d ? { ...d, clients: { ...d.clients, [m.clientId]: { val, touched: true } } } : d));

  const save = (p: PlanRow) => {
    const d = draft;
    if (!d || !canSave(p, d)) return;
    const name = d.name.trim();
    const price = priceOf(d.price) as number | null;
    const every = d.every;
    const changed = priceChanged(p, d);
    const move = changed && d.move;
    const planDiffers = name !== p.name || price !== p.price || every !== p.every;
    const finalPlan = price;
    // Each client's price as it should end, and what the plan's save alone leaves them on (updateCoachPlan): a client
    // whose own price that leaves wrong is set after it, their own or the plan's back (setClientPlanPriceAction).
    const asks: { clientId: number; own: number | null }[] = [];
    const members: PlanClientRow[] = p.members.map((m) => {
      const typed = priceOf(shownVal(p, d, m));
      const want = typed != null && !Number.isNaN(typed) && typed !== finalPlan ? typed : null;
      const leaves = m.own ? (changed && m.price === price ? null : m.price) : changed && m.next != null && !move && m.price !== price ? m.price : null;
      if (want !== leaves) asks.push({ clientId: m.clientId, own: want });
      return { ...m, price: want ?? finalPlan, own: want != null };
    });
    close();
    if (!planDiffers && asks.length === 0) return;
    run(
      (s) => ({ ...s, edits: { ...s.edits, [p.id]: { name, price, every, members } } }),
      async () => {
        if (planDiffers && !(await updatePlanAction(p.id, { name, price, every }, move))) return false;
        for (const a of asks) if (!(await setClientPlanPriceAction(a.clientId, a.own))) return false;
        return true;
      }
    );
  };

  const archive = (p: PlanRow) => {
    setMenu(null);
    run(
      (s) => ({ ...s, edits: { ...s.edits, [p.id]: { name: p.name, price: p.price, every: p.every, members: p.members, archived: !p.archived } } }),
      async () => !!(await setPlanArchivedAction(p.id, !p.archived))
    );
  };
  const remove = (p: PlanRow) => {
    setMenu(null);
    setAsking(null);
    if (open === p.id) close();
    run(
      (s) => ({ ...s, gone: [...s.gone, p.id] }),
      async () => !!(await deletePlanAction(p.id))
    );
  };

  // ---- + Plan: the new card in the tile's room.
  const startAdding = () => {
    if (adding) return;
    close();
    setMenu(null);
    setAdding({ name: "", price: "", every: "month" });
  };
  const canAdd = (n: NewDraft) => n.name.trim() !== "" && !priceBad(n.price);
  const add = () => {
    const n = adding;
    if (!n || !canAdd(n)) return;
    const v = { name: n.name.trim(), price: priceOf(n.price) as number | null, every: n.every };
    const onceKey = newOnceKey();
    setAdding(null);
    run(
      (s) => ({ ...s, added: { name: v.name, price: n.price, every: v.every } }),
      async () => !!(await addPlanAction(v, onceKey))
    );
  };

  /** A click on a card opens it, never one inside its ⋯ (whose menu is drawn elsewhere on the page). */
  const onCard = (e: MouseEvent<HTMLElement>, p: PlanRow) => {
    const t = e.target as HTMLElement;
    if (!e.currentTarget.contains(t) || t.closest("button, a, [role=menuitem], [data-slot=dropdown-menu-content]")) return;
    openPlan(p);
  };

  const card = (p: PlanRow) => {
    const n = p.members.length;
    const sum = p.members.filter((m) => !m.example && m.price != null).reduce((t, m) => t + (m.price as number), 0);
    const worth = monthWorth(sum, p.every);
    const own = p.members.filter((m) => m.own).length;
    const faces = p.members.slice(0, 4);
    return (
      <div key={p.id} className={`rpl-card${p.archived ? " faded" : ""}`} onClick={(e) => onCard(e, p)}>
        <button type="button" className="rpl-name" onClick={() => openPlan(p)}>
          {p.name}
        </button>
        <DropdownMenu
          modal={false}
          open={menu === p.id}
          onOpenChange={(o) => {
            setMenu(o ? p.id : null);
            if (!o) setAsking(null);
          }}
        >
          <DropdownMenuTrigger className="trn-row-more rpl-more" aria-label={`More for ${p.name}`}>
            <MoreIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="pb-menu rpl-menu">
            {asking === p.id ? (
              // Delete asks in the ⋯ itself (26 Nov, Alex: the board's A).
              <div className="rpl-ask">
                <b>Delete {p.name}?</b>
                <span>
                  <button type="button" className="rpl-ask-w" autoFocus onClick={() => setMenu(null)}>
                    Cancel
                  </button>
                  <button type="button" className="rpl-ask-w red" onClick={() => remove(p)}>
                    Delete
                  </button>
                </span>
              </div>
            ) : (
              <>
                <DropdownMenuItem onSelect={() => archive(p)}>{p.archived ? "Restore" : "Archive"}</DropdownMenuItem>
                {p.clients === 0 && n === 0 && (
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={(e) => {
                      e.preventDefault();
                      setAsking(p.id);
                    }}
                  >
                    Delete
                  </DropdownMenuItem>
                )}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="rpl-price">
          {p.price != null ? (
            <>
              <b>{money(p.price)}</b>
              {p.every && <span>{PER[p.every]}</span>}
            </>
          ) : (
            <b className="rpl-dash">—</b>
          )}
        </div>
        <span className="rpl-vat">{vatWords(p.price)}</span>
        <div className="rpl-who">
          {n > 0 && (
            <span className="rpl-stack" aria-hidden="true">
              {faces.map((m) => (
                <Face key={m.clientId} name={m.name} src={m.photo} />
              ))}
              {n > 4 && <span className="rpl-face plus">+{n - 4}</span>}
            </span>
          )}
          <div className="rpl-whowords">
            {n > 0 ? (
              <>
                <b>
                  <SepJoin parts={[p.archived && "Archived", n === 1 ? "1 client" : `${n} clients`, p.every && `${money(worth)} a month`]} />
                </b>
                {own > 0 && <small>{own} on their own price</small>}
              </>
            ) : (
              <span className="rpl-none">{p.archived ? "Archived" : "No clients"}</span>
            )}
          </div>
        </div>
      </div>
    );
  };

  const editCard = (p: PlanRow, d: Draft) => {
    const typed = priceOf(d.price);
    const now = planPriceNow(p, d);
    const old = priceChanged(p, d) ? onOld(p) : [];
    const sign = currencySign(currency);
    return (
      <form
        key={p.id}
        className="rpl-card edit"
        onSubmit={(e) => {
          e.preventDefault();
          save(p);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            close();
          }
        }}
      >
        <div className="rpl-frow">
          <Line label="Name">
            <input className="dlh-line" value={d.name} onChange={(e) => setDraft({ ...d, name: e.target.value })} maxLength={60} aria-invalid={nameTaken(d.name, p.id) || undefined} />
          </Line>
          <Line label="Price">
            <span className={`rsr-lined${priceBad(d.price) ? " bad" : ""}`}>
              <em className="rsr-pre">{sign}</em>
              <input className="dlh-line" inputMode="decimal" value={d.price} onChange={(e) => setDraft({ ...d, price: cleanTyped(e.target.value) })} aria-invalid={priceBad(d.price) || undefined} />
            </span>
            <small className="rpl-vat">{vatWords(typed)}</small>
          </Line>
        </div>
        <Capsule value={d.every} options={EVERY_OPTIONS} onChange={(every) => setDraft({ ...d, every })} label="How often" />
        {old.length > 0 && (
          <div className="rpl-well">
            <ConfirmChoice
              checked={d.move}
              onChange={(move) => {
                // The clients it is about follow the tick again, whatever was typed on their rows.
                const clients = { ...d.clients };
                for (const m of old) delete clients[m.clientId];
                setDraft({ ...d, move, clients });
              }}
              title={`Also move ${old.length > 3 ? `the ${old.length} clients on ${money(p.price as number)}` : andJoin(old.map((m) => firstOf(m.name)))} to ${money(typed as number)}`}
              sub="From their next invoice"
            />
          </div>
        )}
        {p.members.length > 0 && (
          <>
            <div className="rpl-clab">
              <b>Clients</b>
              <span>{p.members.length}</span>
            </div>
            {p.members.map((m) => {
              const val = shownVal(p, d, m);
              const own = isOwn(p, d, m);
              const next = m.next ? `Next ${dayMonth(m.next)}` : null;
              return (
                <div key={m.clientId} className="rpl-crow">
                  <Face name={m.name} src={m.photo} />
                  <div className="rpl-ct">
                    <b>{m.name}</b>
                    <small>
                      {own ? (
                        <>
                          <span className="rpl-own">Own price</span>
                          {(next || (now != null && now > 0)) && <Sep />}
                          {next && <span className="rpl-next">{next}</span>}
                          {now != null && now > 0 && (
                            <button type="button" className={`rpl-back${next ? "" : " always"}`} onClick={() => setClient(m, String(now))}>
                              Back to {money(now)}
                            </button>
                          )}
                        </>
                      ) : (
                        next
                      )}
                    </small>
                  </div>
                  <span className={`rsr-lined rpl-cprice${clientBad(val) ? " bad" : ""}`}>
                    <em className="rsr-pre">{sign}</em>
                    <input className="dlh-line" inputMode="decimal" value={val} onChange={(e) => setClient(m, cleanTyped(e.target.value))} aria-label={`${m.name}'s price`} aria-invalid={clientBad(val) || undefined} />
                  </span>
                </div>
              );
            })}
          </>
        )}
        <div className="rsr-foot">
          <Word tone="sec" onClick={close}>
            Cancel
          </Word>
          <Pill go type="submit" disabled={!canSave(p, d) || busy}>
            Save
          </Pill>
        </div>
      </form>
    );
  };

  const newCard = (n: NewDraft) => (
    <form
      className="rpl-card new"
      onSubmit={(e) => {
        e.preventDefault();
        add();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          setAdding(null);
        }
      }}
    >
      <div className="rpl-frow">
        <Line label="Name">
          <input className="dlh-line" autoFocus value={n.name} onChange={(e) => setAdding({ ...n, name: e.target.value })} maxLength={60} />
        </Line>
        <Line label="Price">
          <span className={`rsr-lined${priceBad(n.price) ? " bad" : ""}`}>
            <em className="rsr-pre">{currencySign(currency)}</em>
            <input className="dlh-line" inputMode="decimal" value={n.price} onChange={(e) => setAdding({ ...n, price: cleanTyped(e.target.value) })} aria-invalid={priceBad(n.price) || undefined} />
          </span>
          <small className="rpl-vat">{vatWords(priceOf(n.price))}</small>
        </Line>
      </div>
      <Capsule value={n.every} options={EVERY_OPTIONS} onChange={(every) => setAdding({ ...n, every })} label="How often" />
      <div className="rsr-foot">
        <Word tone="sec" onClick={() => setAdding(null)}>
          Cancel
        </Word>
        <Pill go type="submit" disabled={!canAdd(n) || busy}>
          Add
        </Pill>
      </div>
    </form>
  );

  const any = sorted.length > 0 || adding != null || shown.added != null;
  const added = shown.added;
  const addedPrice = added ? priceOf(added.price) : null;

  return (
    <>
      <SectionActions>
        <Pill onClick={startAdding} disabled={adding != null}>
          <PlusIcon /> Plan
        </Pill>
      </SectionActions>
      {any && (
        <Part label="Your plans" fact={vatFact} bare>
          <div className="rpl-grid">
            {sorted.map((p) => (open === p.id && draft ? editCard(p, draft) : card(p)))}
            {added && (
              <div className="rpl-card saving" aria-busy="true">
                <span className="rpl-name">{added.name}</span>
                <div className="rpl-price">
                  {addedPrice != null && !Number.isNaN(addedPrice) ? (
                    <>
                      <b>{money(addedPrice)}</b>
                      <span>{PER[added.every]}</span>
                    </>
                  ) : (
                    <b className="rpl-dash">—</b>
                  )}
                </div>
                <span className="rpl-vat">{vatWords(addedPrice)}</span>
                <div className="rpl-who">
                  <span className="rpl-none">No clients</span>
                </div>
              </div>
            )}
            {adding ? (
              newCard(adding)
            ) : sorted.length > 0 || added ? (
              <button type="button" className="rpl-tile" onClick={startAdding}>
                <PlusIcon /> Plan
              </button>
            ) : null}
          </div>
        </Part>
      )}
    </>
  );
}
