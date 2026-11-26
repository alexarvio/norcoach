"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { staffRemoveCoachAction, staffSetCoachPaysAction } from "../../coachActions";
import { StaffConfirm } from "../../parts";

// A coach's page's two actions (26 Nov, Alex; docs/boards/staff-admin-mockup.html "2 · A coach"), words on their rows,
// each asking first in the confirm anatomy: Make them pay / Make it free on Billing's Plan row, Remove on Account's last.

/** Make them pay (a free coach) or Make it free (one who pays). */
export function PlanAction({ coachId, name, first, pays }: { coachId: number; name: string; first: string; pays: boolean }) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const word = pays ? "Make it free" : "Make them pay";
  const go = () =>
    start(async () => {
      const res = await staffSetCoachPaysAction(coachId, !pays);
      if (res.error) {
        setError(res.error);
        return;
      }
      setAsking(false);
      router.refresh();
    });
  return (
    <>
      <button type="button" className="stf-act" onClick={() => (setError(null), setAsking(true))}>
        {word}
      </button>
      <StaffConfirm
        open={asking}
        onClose={() => setAsking(false)}
        title={pays ? `Make Norcoach free for ${first}?` : `Make ${first} pay?`}
        thing={{ name }}
        description={pays ? "A subscription they have on Stripe ends now, so nothing more is charged." : "They subscribe the next time they sign in."}
        confirm={word}
        busy={busy}
        error={error}
        onConfirm={go}
      />
    </>
  );
}

/** Remove a coach with no clients. */
export function RemoveCoach({ coachId, name, facts }: { coachId: number; name: string; facts: (string | null)[] }) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const go = () =>
    start(async () => {
      const res = await staffRemoveCoachAction(coachId);
      if (res.error) {
        setError(res.error);
        return;
      }
      setAsking(false);
      router.push("/");
      router.refresh();
    });
  return (
    <>
      <button type="button" className="stf-act red" onClick={() => (setError(null), setAsking(true))}>
        Remove
      </button>
      <StaffConfirm
        open={asking}
        onClose={() => setAsking(false)}
        title={`Remove ${name}?`}
        thing={{ name, facts }}
        description="Their account, library and Support thread are deleted, their example client with them."
        confirm="Remove"
        danger
        busy={busy}
        error={error}
        onConfirm={go}
      />
    </>
  );
}
