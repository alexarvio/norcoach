"use client";

import { Fragment, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setApproveCoachesAction } from "../../lib/staffActions";
import { daysAgo } from "../../lib/staffWords";
import { dayMonth, logDate } from "../../lib/dayMonth";
import type { CoachApplication, WaitingCoach } from "../../lib/staffSignups";
import { SepJoin, StaffConfirm, StaffFold, StaffSwitch, StaffWho } from "../parts";
import { acceptCoachSignupAction, declineCoachSignupAction } from "./actions";
import { Fold } from "../../admin/redesign/Fold";
import "./signups.css";

// Sign-ups on the staff admin (26 Nov, Alex; the staff spec, screen 5). At the top `Accept new coaches by hand` with its
// switch (an owner changes it; everyone else reads it). Waiting: the coach accounts that signed up and wait for a yes, a
// row each, their face, name, business and email, country, `Signed up 2 days ago`, Accept the ink pill and Decline in
// red words, asking first. Applications: what the website's Apply form sent, the newest first, a row opening its
// answers on the shared fold. `None yet` when a list is empty.

function signedUp(iso: string): string {
  const n = daysAgo(iso);
  if (n <= 0) return "Signed up today";
  if (n === 1) return "Signed up yesterday";
  if (n < 14) return `Signed up ${n} days ago`;
  return `Signed up ${dayMonth(iso)}`;
}

export function SignupsScreen({
  approve,
  canSwitch,
  waiting,
  applications,
}: {
  /** Accept new coaches by hand (kv staff_settings.approveCoaches). */
  approve: boolean;
  /** Owners change the switch. */
  canSwitch: boolean;
  waiting: WaitingCoach[];
  applications: CoachApplication[];
}) {
  const router = useRouter();
  const [on, setOn] = useState(approve);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [gone, setGone] = useState<number[]>([]);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [rowError, setRowError] = useState<{ id: number; text: string } | null>(null);
  const [declining, setDeclining] = useState<WaitingCoach | null>(null);
  const [declineError, setDeclineError] = useState<string | null>(null);
  const [declineBusy, startDecline] = useTransition();
  const [openApp, setOpenApp] = useState<number | null>(null);

  const flip = (next: boolean) => {
    if (!canSwitch) return;
    setOn(next);
    setSwitchError(null);
    setApproveCoachesAction(next).then(
      (r) => {
        if (r.error) {
          setOn(!next);
          setSwitchError(r.error);
        } else router.refresh();
      },
      () => {
        setOn(!next);
        setSwitchError("Not saved. Try again.");
      }
    );
  };

  const accept = (c: WaitingCoach) => {
    if (busyId != null) return;
    setBusyId(c.id);
    setRowError(null);
    acceptCoachSignupAction(c.id)
      .then(
        (r) => {
          if (r.error) return setRowError({ id: c.id, text: r.error });
          setGone((g) => [...g, c.id]);
          router.refresh();
        },
        () => setRowError({ id: c.id, text: "Not saved. Try again." })
      )
      .finally(() => setBusyId(null));
  };

  const decline = () => {
    const c = declining;
    if (!c) return;
    setDeclineError(null);
    startDecline(async () => {
      const r = await declineCoachSignupAction(c.id).catch(() => ({ error: "Not saved. Try again." }));
      if (r.error) return setDeclineError(r.error);
      setGone((g) => [...g, c.id]);
      setDeclining(null);
      router.refresh();
    });
  };

  const shown = waiting.filter((c) => !gone.includes(c.id));
  return (
    <div className="stf-screen">
      <div className="stf-head">
        <h1 className="stf-title">Sign-ups</h1>
      </div>

      <div className="stf-card" style={{ marginTop: 20 }}>
        <div className="stf-toggle">
          <div>
            <b>Accept new coaches by hand</b>
          </div>
          <StaffSwitch on={on} onChange={flip} label="Accept new coaches by hand" disabled={!canSwitch} />
        </div>
      </div>
      {switchError && <p className="stf-error">{switchError}</p>}

      <div className="stf-sec">
        <h2>Waiting</h2>
        {shown.length > 0 && <span className="stf-n">{shown.length}</span>}
      </div>
      <div className="stf-card">
        {shown.length === 0 ? (
          <p className="stf-empty">None yet</p>
        ) : (
          <table className="stf-table stf-su-waiting">
            <tbody>
              {shown.map((c) => (
                <Fragment key={c.id}>
                  <tr>
                    <td className="stf-su-who">
                      <StaffWho name={c.name} photo={c.photo} sub={<SepJoin parts={[c.business, c.email]} />} />
                    </td>
                    <td>{c.country ?? <span className="stf-dash">—</span>}</td>
                    <td className="stf-grey">{signedUp(c.signedUpAt)}</td>
                    <td className="stf-su-acts">
                      <button type="button" className="stf-act red" onClick={() => (setDeclineError(null), setDeclining(c))} disabled={busyId === c.id}>
                        Decline
                      </button>
                      <button type="button" className="stf-pill ink small" onClick={() => accept(c)} disabled={busyId != null}>
                        Accept
                      </button>
                    </td>
                  </tr>
                  {rowError?.id === c.id && (
                    <tr>
                      <td colSpan={4} className="stf-foldcell">
                        <p className="stf-error stf-su-err" role="alert">
                          {rowError.text}
                        </p>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="stf-sec">
        <h2>Applications</h2>
        {applications.length > 0 && <span className="stf-n">{applications.length}</span>}
      </div>
      <div className="stf-card">
        {applications.length === 0 ? (
          <p className="stf-empty">None yet</p>
        ) : (
          <table className="stf-table stf-su-apps">
            <tbody>
              {applications.map((a) => {
                const isOpen = openApp === a.id;
                const toggle = () => setOpenApp(isOpen ? null : a.id);
                return (
                  <Fragment key={a.id}>
                    <tr
                      className={`stf-link${isOpen ? " open" : ""}`}
                      tabIndex={0}
                      aria-expanded={isOpen}
                      onClick={toggle}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          toggle();
                        }
                      }}
                    >
                      <td className="stf-su-date">
                        {logDate(a.receivedAt)}
                        <Fold open={isOpen} />
                      </td>
                      <td className="stf-su-who">
                        <StaffWho name={a.name} sub={a.email} />
                      </td>
                      <td>{a.business || <span className="stf-dash">—</span>}</td>
                      <td className="num">{a.clients ? `${a.clients} clients` : <span className="stf-dash">—</span>}</td>
                    </tr>
                    <tr>
                      <td colSpan={4} className="stf-foldcell">
                        <StaffFold open={isOpen}>
                          <div className="stf-rows stf-su-answers">
                            <div className="stf-kv">
                              <span className="stf-kv-k">Email</span>
                              <span className="stf-kv-v">{a.email}</span>
                              <a className="stf-act" href={`mailto:${a.email}`}>
                                Reply
                              </a>
                            </div>
                            <div className="stf-kv">
                              <span className="stf-kv-k">Uses today</span>
                              <span className="stf-kv-v">{a.uses.length ? a.uses.join(", ") : <span className="stf-dash">—</span>}</span>
                            </div>
                            <div className="stf-kv stf-su-long">
                              <span className="stf-kv-k">Friction</span>
                              <span className="stf-kv-v">{a.hardest || <span className="stf-dash">—</span>}</span>
                            </div>
                          </div>
                        </StaffFold>
                      </td>
                    </tr>
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <StaffConfirm
        open={!!declining}
        onClose={() => !declineBusy && setDeclining(null)}
        title={declining ? `Decline ${declining.name}?` : "Decline?"}
        thing={declining ? { name: declining.name, facts: [declining.business, declining.email] } : undefined}
        description="Their account is deleted, with its sign-in."
        confirm="Decline"
        danger
        busy={declineBusy}
        error={declineError}
        onConfirm={decline}
      />
    </div>
  );
}
