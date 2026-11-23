"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { addPlanAction, deletePlanAction, setPlanArchivedAction, updatePlanAction } from "../../../lib/planActions";
import type { InvoiceEvery } from "../../../lib/db";
import { newOnceKey } from "../../../lib/onceKey";
import { PLAN_EVERY, planFacts, planMoney, type PlanChoice } from "../../../lib/planText";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../../../components/ui/dropdown-menu";
import { Dialog } from "../../../components/ui/dialog";
import { MoreIcon, PlusIcon, TrashIcon } from "../../../components/icons";
import { ConfirmDialog } from "../training/TrainingDraft";
import { Capsule, Line, Part, Pill, SectionActions, Word } from "./Rows";
import "./more.css";

// Settings, Plans (28 Oct, Alex: mockup A, docs/boards/coaching-plans-mockup.html; as a list across the width since
// 23 Nov, Alex: docs/boards/settings-harmony-mockup.html): + Plan beside the section's title; with no plan, nothing
// under it. Else `Your plans` with the tax fact on its label (the business's country's, none for the US or before a
// country is set: page.tsx's vatFact), then one hairline card, a column each: the plan, its price, how often, how many
// clients are on it, ⋯ on hover. A click on a row types it in place (the name, the price after its currency, how often
// as the capsule; Cancel in words and the brand Save); + Plan adds a row the same way at the card's foot, faded until
// its save comes back. Each change saved at once, not on the page's bar. ⋯: Archive (out of the Details picker; the
// clients on it stay on it and are still billed) or Restore, and Delete for a plan no client is on (asked first). A new
// price is for new clients: those billed keep theirs (coachPlans.ts). No sample text in a field (23 Nov, Alex).

export type PlanRow = PlanChoice & { archived: boolean; clients: number };
type Draft = { name: string; price: string; every: InvoiceEvery };

const priceOf = (s: string) => (s.trim() === "" ? null : Number(s.replace(",", ".")));
const priceBad = (s: string) => {
  const n = priceOf(s);
  return n != null && !(Number.isFinite(n) && n >= 0);
};

/** The currency's sign before a price typed ("€", "$", "CHF"). */
function currencySign(currency: string): string {
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency }).formatToParts(0).find((p) => p.type === "currency")?.value ?? currency;
  } catch {
    return currency;
  }
}

const EVERY_OPTIONS = PLAN_EVERY.map((e) => ({ value: e.value, label: e.label }));

export default function PlansSettings({ plans, currency, vatFact }: { plans: PlanRow[]; currency: string; vatFact: string | null }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  // The row being typed in: a plan's id, or "new" for the one being added.
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>({ name: "", price: "", every: "month" });
  const [deleting, setDeleting] = useState<PlanRow | null>(null);
  // What was saved, shown at once until the page drawn again holds it (a name typed shows the moment it is saved; a
  // plan added, faded at the foot until it is in). Let go once the plans read change, or the save failed.
  const [shown, setShown] = useState<{ seen: string; edits: Record<string, PlanChoice>; added: PlanChoice | null }>({ seen: "", edits: {}, added: null });
  const plansKey = JSON.stringify(plans);
  if (shown.seen !== plansKey) setShown({ seen: plansKey, edits: {}, added: null });

  const live = plans.map((p) => (shown.edits[p.id] ? { ...p, ...shown.edits[p.id] } : p));
  const sorted = [...live.filter((p) => !p.archived), ...live.filter((p) => p.archived)];

  const open = (p: PlanRow | null) => {
    setDraft(p ? { name: p.name, price: p.price != null ? String(p.price) : "", every: p.every ?? "month" } : { name: "", price: "", every: "month" });
    setEditing(p ? p.id : "new");
  };
  const run = (fn: () => Promise<unknown>, said: string | ((r: unknown) => string | null)) =>
    start(async () => {
      let r: unknown = null;
      try {
        r = await fn();
      } catch {
        r = null;
      }
      const words = typeof said === "string" ? said : said(r);
      if (words) {
        toast.success(words);
        router.refresh();
      } else {
        setShown((s) => ({ ...s, edits: {}, added: null }));
        toast.error("Not saved. Try again.");
      }
    });
  const save = () => {
    const name = draft.name.trim();
    if (!name || priceBad(draft.price)) return;
    const v = { name, price: priceOf(draft.price), every: draft.every };
    const id = editing;
    setEditing(null);
    if (id === "new") {
      const onceKey = newOnceKey();
      setShown((s) => ({ ...s, added: { id: "new", ...v } }));
      run(() => addPlanAction(v, onceKey), (r) => (r ? `${name} added` : null));
    } else if (id) {
      setShown((s) => ({ ...s, edits: { ...s.edits, [id]: { id, ...v } } }));
      run(() => updatePlanAction(id, v), (r) => (r ? "Saved" : null));
    }
  };

  const form = (key: string) => (
    <form
      key={key}
      className="rsm-planform"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
      onKeyDown={(e) => e.key === "Escape" && setEditing(null)}
    >
      <Line label="Name">
        <input className="dlh-line" autoFocus value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={60} />
      </Line>
      <Line label="Price">
        <span className={`rsr-lined${priceBad(draft.price) ? " bad" : ""}`}>
          <em className="rsr-pre">{currencySign(currency)}</em>
          <input className="dlh-line" inputMode="decimal" value={draft.price} onChange={(e) => setDraft({ ...draft, price: e.target.value.replace(/[^\d.,]/g, "") })} aria-invalid={priceBad(draft.price) || undefined} />
        </span>
      </Line>
      <Capsule value={draft.every} options={EVERY_OPTIONS} onChange={(every) => setDraft({ ...draft, every })} label="How often" />
      <div className="rsr-foot">
        <Word tone="sec" onClick={() => setEditing(null)}>
          Cancel
        </Word>
        <Pill go type="submit" disabled={!draft.name.trim() || priceBad(draft.price) || busy}>
          {key === "new" ? "Add" : "Save"}
        </Pill>
      </div>
    </form>
  );

  const money = (p: Pick<PlanChoice, "price">) => (p.price != null ? planMoney(p.price, currency) : <span className="rsm-dash">—</span>);
  const every = (p: Pick<PlanChoice, "every">) => PLAN_EVERY.find((e) => e.value === p.every)?.label ?? <span className="rsm-dash">—</span>;
  const any = sorted.length > 0 || editing === "new" || shown.added != null;

  return (
    <>
      <SectionActions>
        <Pill onClick={() => open(null)} disabled={editing === "new"}>
          <PlusIcon /> Plan
        </Pill>
      </SectionActions>
      {any && (
        <Part label="Your plans" fact={vatFact}>
          <div className="rsm-plan head">
            <span>Plan</span>
            <span>Price</span>
            <span>Every</span>
            <span>Clients</span>
            <span />
          </div>
          {sorted.map((p) =>
            editing === p.id ? (
              form(p.id)
            ) : (
              <div key={p.id} className={`rsm-plan${p.archived ? " faded" : ""}`} onClick={(e) => !(e.target as HTMLElement).closest("button, [role=menuitem]") && open(p)}>
                <button type="button" className="rsm-plan-name" onClick={() => open(p)}>
                  {p.name}
                </button>
                <span className="rsm-plan-price">{money(p)}</span>
                <span className="rsm-plan-every">{every(p)}</span>
                <span className="rsm-plan-n">{p.archived ? "Archived" : p.clients === 0 ? "None" : `${p.clients} client${p.clients === 1 ? "" : "s"}`}</span>
                <DropdownMenu modal={false}>
                  <DropdownMenuTrigger className="trn-row-more" aria-label={`More for ${p.name}`}>
                    <MoreIcon />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="pb-menu">
                    <DropdownMenuItem onSelect={() => run(() => setPlanArchivedAction(p.id, !p.archived), (r) => (r ? (p.archived ? `${p.name} restored` : `${p.name} archived`) : null))}>{p.archived ? "Restore" : "Archive"}</DropdownMenuItem>
                    {p.clients === 0 && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(p)}>
                          <TrashIcon /> Delete
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )
          )}
          {shown.added && (
            <div className="rsm-plan saving" aria-busy="true">
              <span className="rsm-plan-name">{shown.added.name}</span>
              <span className="rsm-plan-price">{money(shown.added)}</span>
              <span className="rsm-plan-every">{every(shown.added)}</span>
              <span className="rsm-plan-n">None</span>
              <span />
            </div>
          )}
          {editing === "new" && form("new")}
        </Part>
      )}
      <Dialog open={deleting != null} onOpenChange={(o) => !o && setDeleting(null)}>
        {deleting && (
          <ConfirmDialog
            title={`Delete the plan “${deleting.name}”?`}
            thing={{ name: deleting.name, facts: planFacts(deleting, currency) }}
            description="This can’t be undone."
            confirm="Delete"
            danger
            onConfirm={() => {
              const p = deleting;
              setDeleting(null);
              run(() => deletePlanAction(p.id), (r) => (r ? `${p.name} deleted` : null));
            }}
          />
        )}
      </Dialog>
    </>
  );
}
