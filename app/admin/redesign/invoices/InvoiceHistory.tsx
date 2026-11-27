"use client";

import type { ReactNode } from "react";
import type { InvoiceEvent } from "../../../lib/db";
import { logDate } from "../../../lib/dayMonth";
import { SepJoin } from "../Sep";
import type { InvoiceRow } from "../../../lib/invoiceBilling";

// What happened to an invoice (26 Nov, Alex: docs/boards/client-invoices-mockup.html, A, "every invoice tells what
// happened to it"): one step a line on a thin spine, the day, the time, the thing in words and its facts grey after it;
// the dot in what it means (paid green, a decline rust, what was done ink, an opening hollow). A failed automatic charge
// is drawn as it runs: the retries still to come, a day apart, and the coach told after the third, faint. An overdue
// invoice has its due day on the spine in rust.

type Tone = "i" | "g" | "r" | "o" | "later";
type Step = { key: string; at: Date | null; day: string; tone: Tone; what: string; facts: ReactNode[]; ok?: boolean; bad?: boolean };

const METHOD: Record<string, string> = { card: "card", ideal: "iDEAL", apple_pay: "Apple Pay", sepa_debit: "SEPA debit", bank: "bank transfer", cash: "cash", other: "other", stripe: "online" };
/** "Visa •••• 4242 | insufficient funds" as its parts. */
const parts = (detail?: string) => (detail ? detail.split(" | ").filter(Boolean) : []);
const time = (d: Date) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

export function stepsOf(row: InvoiceRow, who: { first: string; coach: string; today: string }): Step[] {
  const out: Step[] = [];
  let retry = 0;
  const by = (e: InvoiceEvent) => (e.by === "coach" ? `by ${who.coach}` : e.by === "auto" ? "automatically" : null);
  row.events.forEach((e, i) => {
    const at = new Date(e.at);
    const base = { key: `${i}-${e.kind}`, at, day: logDate(at) };
    switch (e.kind) {
      case "made":
        out.push({ ...base, tone: "i", what: "Made", facts: [e.by === "auto" ? "by the series" : null] });
        break;
      case "sent":
        out.push({ ...base, tone: "i", what: `Sent to ${who.first}`, facts: [e.by === "auto" ? "by the series" : null] });
        break;
      case "emailed":
        out.push({ ...base, tone: "i", what: "Sent by email", facts: [e.detail] });
        break;
      case "opened":
        out.push({ ...base, tone: "o", what: "Opened", facts: [e.via === "browser" ? "in the browser" : `in ${who.first}'s app`] });
        break;
      case "reminded":
        out.push({ ...base, tone: "i", what: "Reminder sent", facts: [by(e)] });
        break;
      case "paid":
        out.push({ ...base, tone: "g", ok: true, what: e.by === "auto" ? "Paid automatically" : e.via ? `Paid by ${METHOD[e.via] ?? e.via}` : "Paid", facts: parts(e.detail) });
        break;
      case "auto_on":
        out.push({ ...base, tone: "g", ok: true, what: "Automatic payment on", facts: parts(e.detail) });
        break;
      case "charge_failed":
        out.push({ ...base, tone: "r", bad: true, what: e.by === "client" ? "Payment failed" : "Charge declined", facts: parts(e.detail) });
        break;
      case "retry":
        retry += 1;
        out.push({ ...base, tone: "r", bad: true, what: `Retry ${retry} of 3 declined`, facts: parts(e.detail) });
        break;
      case "coach_told":
        out.push({ ...base, tone: "i", what: `${who.coach} told`, facts: [] });
        break;
      case "marked_paid":
        out.push({ ...base, tone: "g", ok: true, what: "Marked paid", facts: [METHOD[e.via ?? "bank"] ?? e.via, by(e)] });
        break;
      case "marked_unpaid":
        out.push({ ...base, tone: "i", what: "Marked not paid", facts: [by(e)] });
        break;
      case "refunded":
        out.push({ ...base, tone: "i", what: e.via === "part" ? "Refunded in part" : "Refunded", facts: parts(e.detail) });
        break;
      case "paid_twice":
        out.push({ ...base, tone: "r", bad: true, what: "Paid twice", facts: ["refund one on Stripe"] });
        break;
      case "paid_wrong_amount":
        out.push({ ...base, tone: "r", bad: true, what: "Payment to check", facts: parts(e.detail) });
        break;
      case "pending":
        out.push({ ...base, tone: "i", what: "Payment on its way", facts: parts(e.detail) });
        break;
    }
  });
  // Overdue: its due day on the spine, in rust, where it falls (no time; it is a day).
  if (row.state === "overdue" && row.dueDate) {
    const due = new Date(`${row.dueDate}T00:00:00`);
    const step: Step = { key: "due", at: null, day: logDate(row.dueDate), tone: "r", bad: true, what: "Due", facts: [`${row.lateDays} day${row.lateDays === 1 ? "" : "s"} ago`] };
    const at = out.findIndex((s) => s.at && s.at.getTime() > due.getTime() + 86_399_000);
    if (at < 0) out.push(step);
    else out.splice(at, 0, step);
  }
  // A failed charge still running: the retries to come and the coach told after the third, faint.
  const c = row.state === "charge_failed" ? row.charge : null;
  if (c && c.attempt < c.of && c.nextAt) {
    const first = new Date(c.nextAt);
    for (let n = c.attempt + 1; n <= c.of; n++) {
      const at = new Date(first.getTime() + (n - c.attempt - 1) * 86_400_000);
      out.push({ key: `later-${n}`, at, day: logDate(at), tone: "later", what: `Retry ${n} of ${c.of}`, facts: [] });
      if (n === c.of) out.push({ key: "later-told", at, day: logDate(at), tone: "later", what: `${who.coach} told`, facts: [] });
    }
  }
  return out;
}

export function InvoiceHistory({ steps }: { steps: Step[] }) {
  return (
    <div className="riv-steps">
      {steps.map((s) => (
        <div key={s.key} className={`riv-step${s.tone === "later" ? " later" : ""}`}>
          <span className="riv-step-d">
            <i className={`riv-dot ${s.tone}`} aria-hidden="true" />
            {s.day}
          </span>
          <span className="riv-step-t">{s.at ? time(s.at) : ""}</span>
          <span className={`riv-step-w${s.ok ? " ok" : s.bad ? " bad" : ""}`}>
            {s.what}
            {s.facts.some((f) => f != null && f !== "") && (
              <span>
                <SepJoin parts={s.facts} />
              </span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}
