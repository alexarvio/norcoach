"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Dialog } from "../../../components/ui/dialog";
import { pic } from "../../../lib/pic";
import { dayMonth } from "../../../lib/dayMonth";
import type { WaitingCoach } from "../../../lib/staffSignups";
import { SepJoin } from "../Sep";
import { ConfirmDialog } from "../training/TrainingDraft";
import { acceptSignupAction, declineSignupAction, setAcceptByHandAction } from "./signupActions";

// Sign-ups on the owner's Coaches (27 Nov, Alex: "I don't want random people joining Norcoach right now"; "Yes, build
// it"), until the staff admin's Sign-ups is online (docs/DESIGN-RULES-ADMIN.md §12): its title on the page over one
// hairline card. First row `Accept new coaches by hand` with Settings' switch (white while off, the brand colour while
// on); on, a coach who signs up waits on /auth/waiting. Under it a row a waiting coach: their face (24px), name 15px/600,
// business and email grey after the drawn bar, how long ago grey, then Decline in red words (asking first, the confirm
// anatomy) and Accept the ink pill. Nothing waiting, the switch row alone.

function signedUp(iso: string): string {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (!Number.isFinite(days) || days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 14) return `${days} days ago`;
  return dayMonth(iso);
}

export default function SignupsSection({ approve, waiting }: { approve: boolean; waiting: WaitingCoach[] }) {
  const router = useRouter();
  const [on, setOn] = useState(approve);
  const [gone, setGone] = useState<number[]>([]);
  const [busy, setBusy] = useState<number | null>(null);
  const [declining, setDeclining] = useState<WaitingCoach | null>(null);

  const flip = (next: boolean) => {
    setOn(next);
    setAcceptByHandAction(next).then(
      (r) => {
        if (r.error) {
          setOn(!next);
          toast.error(r.error);
        } else router.refresh();
      },
      () => {
        setOn(!next);
        toast.error("Not saved. Try again.");
      }
    );
  };

  const run = (c: WaitingCoach, call: (id: number) => Promise<{ error?: string }>, done: string) => {
    if (busy != null) return;
    setBusy(c.id);
    call(c.id)
      .then(
        (r) => {
          if (r.error) return void toast.error(r.error);
          setGone((g) => [...g, c.id]);
          toast.success(done);
          router.refresh();
        },
        () => toast.error("Not saved. Try again.")
      )
      .finally(() => setBusy(null));
  };

  const shown = waiting.filter((c) => !gone.includes(c.id));
  return (
    <section className="rls-section">
      <div className="trn-weekhead">
        <div>
          <h2>Sign-ups</h2>
        </div>
      </div>
      <div className="rls-card rco-card rco-su">
        <div className="rls-row rco-row">
          <div className="rls-row-main rco-su-switch">
            <span className="rls-name">
              <b>Accept new coaches by hand</b>
            </span>
            <span className="rd rst rco-su-switchwrap">
              <button type="button" role="switch" aria-checked={on} aria-label="Accept new coaches by hand" className={`rst-switch${on ? " on" : ""}`} onClick={() => flip(!on)}>
                <i aria-hidden="true" />
              </button>
            </span>
          </div>
        </div>
        {shown.map((c) => (
          <div key={c.id} className={`rls-row rco-row${busy === c.id ? " busy" : ""}`}>
            <div className="rls-row-main rco-su-row">
              <span className="rls-name">
                <span className="rco-face" aria-hidden="true">
                  {/* eslint-disable-next-line @next/next/no-img-element -- the coach's own uploaded photo */}
                  {c.photo ? <img src={pic(c.photo, 96)} alt="" /> : c.name.trim().slice(0, 1).toUpperCase()}
                </span>
                <b>{c.name}</b>
                <small title={[c.business, c.email, c.country].filter(Boolean).join(" | ")}>
                  <SepJoin parts={[c.business, c.email !== c.name && c.email, c.country]} />
                </small>
              </span>
              <span className="rco-when">{signedUp(c.signedUpAt)}</span>
              <span className="rco-su-acts">
                <button type="button" className="rco-act danger" disabled={busy != null} onClick={() => setDeclining(c)}>
                  Decline
                </button>
                <button type="button" className="rco-su-accept" disabled={busy != null} onClick={() => run(c, acceptSignupAction, `${c.name} is in`)}>
                  Accept
                </button>
              </span>
            </div>
          </div>
        ))}
      </div>

      <Dialog open={declining != null} onOpenChange={(o) => !o && setDeclining(null)}>
        {declining && (
          <ConfirmDialog
            title={`Decline ${declining.name}?`}
            thing={{ name: declining.name, facts: [declining.business, declining.email !== declining.name && declining.email] }}
            description="Their Norcoach account is deleted, with its sign-in."
            confirm="Decline"
            danger
            onConfirm={() => {
              const c = declining;
              setDeclining(null);
              run(c, declineSignupAction, `${c.name} declined`);
            }}
          />
        )}
      </Dialog>
    </section>
  );
}
