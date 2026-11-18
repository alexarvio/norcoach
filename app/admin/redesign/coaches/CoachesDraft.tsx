"use client";

import { useRef, useState, useTransition, type FormEvent } from "react";
import { newOnceKey } from "../../../lib/onceKey";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Toaster } from "../../../components/ui/toast";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "../../../components/ui/dialog";
import { PlusIcon, SearchIcon } from "../../../components/icons";
import { norcode, typedNorcode } from "../../../lib/norcode";
import { pic } from "../../../lib/pic";
import { SepJoin } from "../Sep";
import { ConfirmDialog } from "../training/TrainingDraft";
import { addCoach, removeCoach, resetCoachPassword, type CoachOutcome } from "./actions";
import { setCoachPaysAction } from "../../../lib/billingActions";
import type { SupportInboxRow } from "../../../lib/support";
import SupportInbox from "./SupportInbox";

// The owner's Coaches (22 Oct, Alex: the old /admin?view=coaches in the new style, root "rd trn rls rco"): Training's
// bare header with Add coach as a white pill; the coaches' Support threads
// (SupportInbox, 23 Oct), then every coach account, each a row
// in one hairline card: the name semi-bold, the email grey, the clients, when one of them last logged something, the
// password as a state pill, and the owner's actions in words on hover (Remove asks first). No sign-ups to let in since
// 17 Nov (Alex): a coach is in at once. Add coach and
// Reset password are .dlh pop-ups on clean lines. Never any client's name or data. Ink, never navy; 500 and 600.
// Finding a coach (18 Nov, Alex: "a way for us to find coach profiles easy in our admin"): the search pill beside
// Accounts reads the name, the business, the email and the Norcode (typed with or without its NC-); a row leads with
// the coach's face, its name opens their profile (Settings, Profile, as the owner's Whose profile does), and their
// business and Norcode sit grey after it.

export type CoachRow = { id: number; email: string; name: string; /** Their business name, "" when none is set. */ business: string; /** Their Norcode's eight characters (lib/norcode.ts). */ code: string; /** Their profile photo, null when none. */ photo: string | null; clients: number; lastActivity: string | null; mustChangePassword: boolean; owner: boolean; /** What they pay Norcoach (28 Oct; lib/billing.ts): whether they pay, and the state as its pill. */ pays: boolean; billing: { word: string; tone: string } };

// The server's own check (createCoachAction), so Add waits for what it would accept.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN = 8;
const ERROR: Record<string, string> = {
  invalid: "That didn't go through.",
  taken: "That email already has an account.",
  hasclients: "That coach still has clients.",
  self: "Not your own account.",
  failed: "Not saved. Try again.",
};
const said = (code: string | null) => ERROR[code ?? ""] ?? ERROR.failed;

/** An action's answer, or "failed" when it never came (no connection). */
async function settle(p: Promise<CoachOutcome>): Promise<CoachOutcome> {
  try {
    return (await p) ?? { ok: null, error: "failed" };
  } catch {
    return { ok: null, error: "failed" };
  }
}

const accountGrid = { gridTemplateColumns: "minmax(0, 1fr) 64px 132px 104px 124px 300px", columnGap: 16 } as const;

export default function CoachesDraft({ accounts, support, billingOn = false }: { accounts: CoachRow[]; /** The coaches' Support threads, newest first (SupportInbox). */ support: SupportInboxRow[]; /** Subscriptions set up on the server (lib/billing.ts): the owner can switch who pays. */ billingOn?: boolean }) {
  const router = useRouter();
  const [, start] = useTransition();
  const [busy, setBusy] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [resetting, setResetting] = useState<CoachRow | null>(null);
  const [removing, setRemoving] = useState<CoachRow | null>(null);
  // The search: every word typed must be in the coach's name, business, email or Norcode.
  const [q, setQ] = useState("");
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const typedCode = typedNorcode(q);
  const shown = words.length
    ? accounts.filter((c) => {
        const hay = `${c.name} ${c.business} ${c.email} ${c.code} ${norcode(c.code)}`.toLowerCase();
        return words.every((w) => hay.includes(w)) || (typedCode.length >= 3 && c.code.includes(typedCode));
      })
    : accounts;

  // A row's action: faded while it goes, then the page read again and the outcome in a toast.
  const act = (id: number, call: () => Promise<CoachOutcome>, done: string) => {
    setBusy(id);
    start(async () => {
      const r = await settle(call());
      setBusy(null);
      if (r.ok) {
        router.refresh();
        toast.success(done);
      } else toast.error(said(r.error));
    });
  };

  return (
    <div className="rd trn rls rco">
      {/* ---- Header: Training's, bare (no fact line, so no room kept for one). */}
      <header className="trn-head bare">
        <div className="trn-head-main">
          <div className="trn-name-row">
            <h1 className="trn-name">Coaches</h1>
          </div>
        </div>
        <div className="trn-head-actions">
          <button type="button" className="trn-pill" onClick={() => setAdding(true)}>
            <PlusIcon /> Add coach
          </button>
        </div>
      </header>

      {/* ---- What the coaches wrote from Settings' Support: a coach a row, a thread opening under it. */}
      <SupportInbox initial={support} />

      {/* ---- Every coach account, oldest first. */}
      <section className="rls-section">
        <div className="trn-weekhead">
          <div>
            <h2>Accounts</h2>
          </div>
          {accounts.length > 0 && (
            <label className="rd-search rco-search">
              <SearchIcon />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search coaches" aria-label="Search coaches by name, business, email or Norcode" autoComplete="off" spellCheck={false} />
            </label>
          )}
        </div>
        <div className="rls-card rco-card">
          {accounts.length === 0 ? (
            <p className="rls-none">None yet</p>
          ) : shown.length === 0 ? (
            <p className="rls-none">No match</p>
          ) : (
            <>
              <div className="rls-cols rco-cols" style={accountGrid} aria-hidden="true">
                <span>Coach</span>
                <span>Clients</span>
                <span>Client activity</span>
                <span>Password</span>
                <span>Norcoach</span>
                <span />
              </div>
              {shown.map((c) => {
                // "9/11 · 14:05" from the server: the day, and its time faint after it.
                const [day, time] = (c.lastActivity ?? "").split(" · ");
                return (
                  <div key={c.id} className={`rls-row rco-row${busy === c.id ? " busy" : ""}`}>
                    <div className="rls-row-main" style={accountGrid}>
                      <span className="rls-name">
                        <span className="rco-face" aria-hidden="true">
                          {/* eslint-disable-next-line @next/next/no-img-element -- the coach's own uploaded photo */}
                          {c.photo ? <img src={pic(c.photo, 96)} alt="" /> : c.name.trim().slice(0, 1).toUpperCase()}
                        </span>
                        <a className="rco-name" href={`/admin/redesign/settings?coachId=${c.id}#profile`} title={`Open ${c.name}'s profile`}>
                          <b>{c.name}</b>
                        </a>
                        <small title={[c.business, c.email, c.code && norcode(c.code)].filter(Boolean).join(" | ")}>
                          <SepJoin parts={[c.business, c.code && norcode(c.code), c.email !== c.name && c.email, c.owner && "You"]} />
                        </small>
                      </span>
                      <span className="rco-num">{c.clients}</span>
                      <span className={`rco-when${day ? "" : " none"}`}>
                        {day || "–"}
                        {time && <small>{time}</small>}
                      </span>
                      <span>
                        <span className={`trn-state rco-state${c.mustChangePassword ? "" : " good"}`}>{c.mustChangePassword ? "Temporary" : "Set"}</span>
                      </span>
                      <span>
                        <span className={`trn-state rco-state${c.billing.tone ? ` ${c.billing.tone}` : ""}`}>{c.billing.word}</span>
                      </span>
                      <span className="rco-acts">
                        {/* The owner's own account isn't changed here. */}
                        {!c.owner && (
                          <>
                            {/* Who pays Norcoach (28 Oct, Alex): a coach let in from now on pays; one from before, once asked. */}
                            {billingOn && (
                              <button type="button" className="rco-act" disabled={busy === c.id} onClick={() => act(c.id, () => setCoachPaysAction(c.id, !c.pays).then((r): CoachOutcome => (r.ok ? { ok: "done", error: null } : { ok: null, error: r.error ?? "Not saved. Try again." })), c.pays ? `${c.name} uses Norcoach free` : `${c.name} pays from their next sign-in`)}>
                                {c.pays ? "Make it free" : "Make them pay"}
                              </button>
                            )}
                            <button type="button" className="rco-act" disabled={busy === c.id} onClick={() => setResetting(c)}>
                              Reset password
                            </button>
                            {c.clients === 0 ? (
                              <button type="button" className="rco-act danger" disabled={busy === c.id} onClick={() => setRemoving(c)}>
                                Remove
                              </button>
                            ) : (
                              <span className="rco-act off" title="A coach with clients can't be removed">
                                Remove
                              </span>
                            )}
                          </>
                        )}
                      </span>
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </div>
      </section>

      <Dialog open={adding} onOpenChange={setAdding}>
        {adding && (
          <AddCoachDialog
            onDone={(email) => {
              setAdding(false);
              router.refresh();
              toast.success(`${email} added`);
            }}
          />
        )}
      </Dialog>

      <Dialog open={resetting != null} onOpenChange={(o) => !o && setResetting(null)}>
        {resetting && (
          <ResetPasswordDialog
            coach={resetting}
            onDone={() => {
              setResetting(null);
              router.refresh();
              toast.success("Temporary password set");
            }}
          />
        )}
      </Dialog>

      <Dialog open={removing != null} onOpenChange={(o) => !o && setRemoving(null)}>
        {removing && (
          <ConfirmDialog
            title={`Remove ${removing.name}?`}
            description="Their Norcoach account is deleted. This can’t be undone."
            confirm="Remove"
            danger
            onConfirm={() => {
              const c = removing;
              setRemoving(null);
              act(c.id, () => removeCoach(c.id), `${c.name} removed`);
            }}
          />
        )}
      </Dialog>

      <Toaster />
    </div>
  );
}

// ---- Add coach: the .dlh card (design rules 4), the email and a temporary password on clean lines.
function AddCoachDialog({ onDone }: { onDone: (email: string) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const clean = email.trim().toLowerCase();
  const ready = EMAIL.test(clean) && password.length >= MIN && !busy;
  // A one-time key a tap (6 Nov); sent again after a failure for the same coach, it keeps the failed one's key, so one
  // that in fact landed is not added twice.
  const failedAdd = useRef<{ what: string; key: string } | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    const what = `${clean}\n${password}`;
    const onceKey = failedAdd.current?.what === what ? failedAdd.current.key : newOnceKey();
    start(async () => {
      const r = await settle(addCoach(clean, password, onceKey));
      failedAdd.current = r.ok ? null : { what, key: onceKey };
      if (r.ok) onDone(clean);
      else setError(said(r.error));
    });
  };
  return (
    <DialogContent className="dlh rco-dlg" aria-describedby={undefined}>
      <form className="rco-form" onSubmit={submit}>
        <div className="dlh-head">
          <DialogTitle className="dlh-title">Add a coach</DialogTitle>
          <DialogClose className="dlh-x" aria-label="Close">
            ✕
          </DialogClose>
        </div>
        <label className="rco-field">
          <span className="dlh-label">Email</span>
          <input
            className="dlh-line"
            name="email"
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setError(null);
            }}
            autoComplete="off"
            autoFocus
            required
          />
        </label>
        <label className="rco-field">
          <span className="dlh-label">Temporary password</span>
          <input className="dlh-line" name="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={MIN} autoComplete="new-password" required />
        </label>
        {error && (
          <p className="dlh-error" role="alert">
            {error}
          </p>
        )}
        <div className="dlh-foot">
          <DialogClose className="dlh-cancel">Cancel</DialogClose>
          <button type="submit" className="dlh-go" disabled={!ready}>
            Add
          </button>
        </div>
      </form>
    </DialogContent>
  );
}

// ---- Reset password: a new temporary one (they choose their own at their next sign-in).
function ResetPasswordDialog({ coach, onDone }: { coach: CoachRow; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const ready = password.length >= MIN && !busy;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    start(async () => {
      const r = await settle(resetCoachPassword(coach.id, password));
      if (r.ok) onDone();
      else setError(said(r.error));
    });
  };
  return (
    <DialogContent className="dlh rco-dlg">
      <form className="rco-form" onSubmit={submit}>
        <div className="dlh-head">
          <DialogTitle className="dlh-title">Reset password</DialogTitle>
          <DialogClose className="dlh-x" aria-label="Close">
            ✕
          </DialogClose>
        </div>
        <DialogDescription className="dlh-what">{coach.email}</DialogDescription>
        <label className="rco-field">
          <span className="dlh-label">Temporary password</span>
          <input
            className="dlh-line"
            name="password"
            type="password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setError(null);
            }}
            minLength={MIN}
            autoComplete="new-password"
            autoFocus
            required
            aria-label={`New temporary password for ${coach.email}`}
          />
        </label>
        {error && (
          <p className="dlh-error" role="alert">
            {error}
          </p>
        )}
        <div className="dlh-foot">
          <DialogClose className="dlh-cancel">Cancel</DialogClose>
          <button type="submit" className="dlh-go" disabled={!ready}>
            Set
          </button>
        </div>
      </form>
    </DialogContent>
  );
}
