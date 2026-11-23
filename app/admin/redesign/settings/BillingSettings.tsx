"use client";

import { useState, useTransition } from "react";
import { openBillingPortalAction } from "../../../lib/billingActions";
import type { BillingView } from "../../../lib/billing";
import { dayMonth } from "../../../lib/dayMonth";
import { Part, Pill, Row, State } from "./Rows";

// What the coach pays Norcoach (28 Oct, Alex; lib/billing.ts), a part of Account since 23 Nov (Alex:
// docs/boards/settings-harmony-mockup.html; #billing lands on it). One row: Monthly or Yearly, the date that matters
// under it (the trial's end, the next charge, the plan's end, read-only from), the state as its pill (Trial ink, Active
// green, Payment failed rust, Read-only red, Cancelled and Free grey), then at its end Manage billing, a white pill
// opening Stripe's own page for the card, the plan, receipts and cancelling, or Subscribe with no live plan.

const TONE = { live: "ink", good: "good", warn: "rust", bad: "bad" } as const;

export default function BillingSettings({ view }: { view: BillingView }) {
  const [busy, start] = useTransition();
  const [error, setError] = useState("");
  const manage = () =>
    start(async () => {
      const r = await openBillingPortalAction();
      if (r.url) window.location.href = r.url;
      else setError(r.error ?? "Stripe did not answer. Try again.");
    });
  const pill = view.pill;
  // The one date that matters now.
  const when =
    view.access.state === "grace" && view.access.until
      ? `Read-only from ${dayMonth(view.access.until)}`
      : view.status === "trialing" && view.trialEnd
        ? `Trial ends ${dayMonth(view.trialEnd)}`
        : view.status === "active" && view.periodEnd
          ? `${view.cancelAtPeriodEnd ? "Ends" : "Renews"} ${dayMonth(view.periodEnd)}`
          : null;
  return (
    <Part label="Norcoach">
      <Row name={view.status === "free" ? "Norcoach" : view.interval === "year" ? "Yearly" : "Monthly"} fact={when}>
        {error && (
          <span className="rst-err" role="alert">
            {error}
          </span>
        )}
        <State tone={pill.tone ? TONE[pill.tone] : undefined}>{pill.word}</State>
        {/* No live plan (never, or one that ended): Subscribe; Stripe's page can't start a new one. */}
        {view.canSubscribe && (
          <a className="rsr-pill" href="/auth/subscribe">
            Subscribe
          </a>
        )}
        {view.hasCustomer && (
          <Pill onClick={manage} disabled={busy}>
            {busy ? "Opening Stripe…" : "Manage billing"}
          </Pill>
        )}
      </Row>
    </Part>
  );
}
