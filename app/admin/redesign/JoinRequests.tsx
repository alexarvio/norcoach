"use client";

import { useRef, useState, useSyncExternalStore, useTransition, type KeyboardEvent as KeyEvent } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { acceptJoinRequestAction, declineJoinRequestAction } from "../../lib/joinActions";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "../../components/ui/dialog";
import { CheckIcon, PlusIcon } from "../../components/icons";
import { ConfirmText, ConfirmThing } from "./ConfirmParts";
import { SepJoin } from "./Sep";
import { PopupTitle } from "./PopupWho";
import { useSidePanel } from "./help/sidePanels";
import { usePopoverClose, usePopoverPlace } from "./usePopover";
import { pic } from "../../lib/pic";
import type { FeedBoard, JoinRow } from "../../lib/feedBoard";
import "./feed/feed.css";
// The To do's pop-over look, on every page the rail is on (a client's screens load it with the To do).
import "./todo-panel.css";
import "./join-requests.css";

// Join requests behind a pill next to Clients in the rail (25 Nov, Alex: "instead of stacking these actions… we just put
// them in the to-do… it's the same thing… my idea was to add it there where the client's thing is"): the rust pill with
// how many are asking, its list dropping from it as a client's To do does from theirs (25 Nov, Alex:
// docs/boards/todo-popover-mockup.html; its look, todo-panel.css; was a panel from the right), over the page, the nub on
// the pill. Each request a row (27 Nov, Alex: no "Wants to join" under the name, "it's obvious"): their face, the name with
// their age after a comma (`Alex Arvio, 27`) and how long ago on the right as a notification's (`2 h ago`), then
// `email | phone` grey with Accept and Decline in words on its right. Accept asks where they go while the coach has clients never in the app (Assign Maya to Sam Taylor.),
// Decline asks first. Was a group at the top of the Feed's Needs you (18 Nov).

type Linkable = FeedBoard["linkable"];

/** A face: their own picture when they have one, else the initial on white. */
function Face({ name, src }: { name: string; src: string | null }) {
  return (
    <span className="jr-face" aria-hidden="true">
      {src ? <img src={pic(src, 96)} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" /> : name.trim().charAt(0).toUpperCase()}
    </span>
  );
}

/** How long ago a request came in, as a notification says it (27 Nov, Alex: "like any notification on the right side"):
 *  `Just now`, `12 min ago`, `2 h ago`, `1 day ago`, `3 days ago`; late (rust) past a day, as every wait. */
function waited(since: string, now: number): { text: string; late: boolean } {
  const ago = Math.max(0, now - new Date(since).getTime());
  const min = Math.floor(ago / 60_000);
  if (!Number.isFinite(min)) return { text: "", late: false };
  if (min < 1) return { text: "Just now", late: false };
  if (min < 60) return { text: `${min} min ago`, late: false };
  const h = Math.floor(min / 60);
  if (h < 24) return { text: `${h} h ago`, late: false };
  const days = Math.floor(h / 24);
  return { text: days === 1 ? "1 day ago" : `${days} days ago`, late: days > 1 };
}

export default function JoinRequests({ joins, linkable }: { joins: JoinRow[]; linkable: Linkable }) {
  const router = useRouter();
  const [, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(0);
  // Answered here: gone at once, while the server settles it and the rail reads again.
  const [gone, setGone] = useState<ReadonlySet<number>>(() => new Set());
  const asking = joins.filter((j) => !gone.has(j.id));
  const [declining, setDeclining] = useState<JoinRow | null>(null);
  const [accepting, setAccepting] = useState<JoinRow | null>(null);
  const [onto, setOnto] = useState<number | null>(null);
  // In the browser only (the panel goes to the page's body), the same on the server's first draw.
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  );

  const close = () => setOpen(false);
  // One of it, the chat, help and a client's To do at a time; it marks nothing on the frame, so nothing moves for it.
  useSidePanel("joins", open, close);
  // Under the pill, the list running on to the right over the page (the rail never clips it: it goes to the body). The
  // pill again, a press outside it or Esc closes it, as the To do's; never while one of its pop-ups is up.
  const pillRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const place = usePopoverPlace(pillRef, open, 460, "start");
  usePopoverClose(open, close, [popRef, pillRef], accepting != null || declining != null);
  // Nobody left asking: the panel goes with the pill.
  if (open && asking.length === 0) setOpen(false);

  const settle = (j: JoinRow, act: () => Promise<{ ok: boolean; error?: string; gone?: boolean }>) => {
    setGone((s) => new Set(s).add(j.id));
    start(async () => {
      const r = await act().catch(() => ({ ok: false, error: "Not saved. Try again.", gone: false }));
      // Done, or no longer there to answer (withdrawn, answered on another screen): it stays gone.
      if (r.ok || r.gone) return router.refresh();
      setGone((s) => {
        const next = new Set(s);
        next.delete(j.id);
        return next;
      });
      toast.error(r.error ?? "Not saved. Try again.");
    });
  };
  const accept = (j: JoinRow, linkTo: number | null = null) => settle(j, () => acceptJoinRequestAction(j.id, `${j.id}-${Date.now()}`, linkTo));
  const decline = (j: JoinRow) => settle(j, () => declineJoinRequestAction(j.id));
  // Accept asks where they go while the coach has clients never in the app (25 Nov, Alex: "create a new client… and
  // connect the client after"); with none, it makes them a client at once. Picked to start only on a match that can't be
  // someone else's: the email they asked with on that client, else the one client of their full name, else of their
  // first name; otherwise New client.
  const askAccept = (j: JoinRow) => {
    if (linkable.length === 0) return accept(j);
    const one = (list: Linkable) => (list.length === 1 ? list[0].id : null);
    const email = j.email.trim().toLowerCase();
    const full = j.name.trim().toLowerCase();
    const first = full.split(/\s+/)[0] ?? "";
    setOnto(
      linkable.find((c) => c.email && c.email === email)?.id ??
        one(linkable.filter((c) => c.name.toLowerCase() === full)) ??
        one(linkable.filter((c) => first && c.name.toLowerCase().split(/\s+/)[0] === first))
    );
    setAccepting(j);
  };
  const pick = onto != null && linkable.some((c) => c.id === onto) ? onto : null;
  const pickedName = linkable.find((c) => c.id === pick)?.name ?? null;
  const ontoIds: (number | null)[] = [null, ...linkable.map((c) => c.id)];
  const ontoKey = (e: KeyEvent<HTMLDivElement>) => {
    const group = e.currentTarget;
    const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const at = ontoIds.indexOf(pick);
    setOnto(ontoIds[(at + step + ontoIds.length) % ontoIds.length]);
    window.requestAnimationFrame(() => (group.querySelector('[aria-checked="true"]') as HTMLElement | null)?.focus());
  };

  if (asking.length === 0 && !accepting && !declining) return null;
  const first = (j: JoinRow) => j.name.trim().split(/\s+/)[0] || j.name;

  return (
    <>
      {asking.length > 0 && (
        <button
          ref={pillRef}
          type="button"
          className={`rr-joins${open ? " open" : ""}`}
          aria-expanded={open}
          aria-controls="rd-joins-pop"
          aria-label={`Join requests, ${asking.length}`}
          onClick={() => {
            setNow(Date.now());
            setOpen((o) => !o);
          }}
        >
          Requests <b>{asking.length}</b>
        </button>
      )}
      {mounted &&
        createPortal(
          <div ref={popRef} id="rd-joins-pop" className={`rd-todopanel jr-panel${open ? " open" : ""}`} style={place} role="region" aria-label="Join requests" aria-hidden={!open} inert={open ? undefined : true}>
            <div className="tdp-scroll">
              {/* Join requests alone (25 Nov, Alex: the board): no count, no ✕. */}
              <div className="tdp-head">
                <h2>Join requests</h2>
              </div>
              {/* A row each: the face, then the name and how long ago over how to reach them and Accept and Decline. */}
              <div className="jr-list">
                {asking.map((j) => {
                  const w = waited(j.since, now);
                  return (
                    <div key={j.id} className="tdp-row jr-row">
                      <Face name={j.name} src={j.photo} />
                      <div className="jr-body">
                        <span className="jr-name">
                          {j.name}
                          {j.age != null && <span className="jr-age">, {j.age}</span>}
                        </span>
                        <span className={`jr-when${w.late ? " late" : ""}`}>{w.text}</span>
                        <small className="jr-reach">
                          <SepJoin parts={[<span key="e" className="jr-whole">{j.email}</span>, j.phone ? <span key="p" className="jr-whole">{j.phone}</span> : null]} />
                        </small>
                        <span className="jr-acts">
                          <button type="button" className="tdp-act" onClick={() => askAccept(j)}>
                            Accept
                          </button>
                          <button type="button" className="tdp-act jr-decline" onClick={() => setDeclining(j)}>
                            Decline
                          </button>
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>,
          document.body
        )}

      {/* Accept: their face, Wants to join over the title, how to reach them under the name, then one plain line for the
          pick (25 Nov, Alex: "say assign maya to (client name)") and the clients never in the app, A to Z. */}
      <Dialog open={accepting != null} onOpenChange={(o) => !o && setAccepting(null)}>
        {accepting && (
          <DialogContent className="dlh" aria-describedby="accept-join-text">
            <div className="dlh-head">
              <div className="dlh-whohead">
                <span className="dlh-whoface" aria-hidden="true">
                  {accepting.photo ? <img src={pic(accepting.photo, 96)} alt="" decoding="async" referrerPolicy="no-referrer" /> : accepting.name.trim().charAt(0).toUpperCase()}
                </span>
                <div>
                  <span className="dlh-whoeye">Wants to join</span>
                  <DialogTitle className="dlh-title">Accept {accepting.name}?</DialogTitle>
                  <span className="rfd-reach">
                    <SepJoin parts={[accepting.email, accepting.phone]} />
                  </span>
                </div>
              </div>
              <DialogClose className="dlh-x" aria-label="Close">
                ✕
              </DialogClose>
            </div>
            <ConfirmText id="accept-join-text">{pickedName ? `Assign ${first(accepting)} to ${pickedName}.` : `Add ${first(accepting)} as a new client.`}</ConfirmText>
            <div className="rfd-onto" role="radiogroup" aria-label="Add them as" onKeyDown={ontoKey}>
              <button type="button" role="radio" aria-checked={pick == null} tabIndex={pick == null ? 0 : -1} className={`rfd-onto-row${pick == null ? " on" : ""}`} onClick={() => setOnto(null)}>
                <span className="rfd-onto-new" aria-hidden="true">
                  <PlusIcon />
                </span>
                <span className="rfd-onto-name">New client</span>
                {pick == null && <CheckIcon />}
              </button>
              {linkable.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="radio"
                  aria-checked={pick === c.id}
                  tabIndex={pick === c.id ? 0 : -1}
                  // An existing client picked to start: the focus on it, seen and in reach, never a one-key Accept.
                  autoFocus={pick === c.id}
                  className={`rfd-onto-row${pick === c.id ? " on" : ""}`}
                  onClick={() => setOnto(c.id)}
                >
                  <Face name={c.name} src={c.avatarPath} />
                  <span className="rfd-onto-name">{c.name}</span>
                  {pick === c.id && <CheckIcon />}
                </button>
              ))}
            </div>
            <div className="dlh-foot">
              <DialogClose className="dlh-cancel">Cancel</DialogClose>
              <button
                type="button"
                className="dlh-go"
                autoFocus={pick == null}
                onClick={() => {
                  const j = accepting;
                  setAccepting(null);
                  accept(j, pick);
                }}
              >
                Accept
              </button>
            </div>
          </DialogContent>
        )}
      </Dialog>

      {/* Decline asks first (nothing taken away on one click): the confirm anatomy, the red pill. */}
      <Dialog open={declining != null} onOpenChange={(o) => !o && setDeclining(null)}>
        {declining && (
          <DialogContent className="dlh" aria-describedby="decline-join-text">
            <div className="dlh-head">
              <PopupTitle>Decline {declining.name}?</PopupTitle>
              <DialogClose className="dlh-x" aria-label="Close">
                ✕
              </DialogClose>
            </div>
            <ConfirmThing name={declining.name} facts={["Wants to join", declining.age != null ? String(declining.age) : null, declining.email]} />
            <ConfirmText id="decline-join-text">They can send their request to another coach.</ConfirmText>
            <div className="dlh-foot">
              <DialogClose className="dlh-cancel">Cancel</DialogClose>
              <button
                type="button"
                className="dlh-danger"
                autoFocus
                onClick={() => {
                  const j = declining;
                  setDeclining(null);
                  decline(j);
                }}
              >
                Decline
              </button>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}
