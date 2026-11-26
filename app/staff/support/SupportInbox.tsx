"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { newOnceKey } from "../../lib/onceKey";
import type { SupportInboxRow, SupportLine } from "../../lib/support";
import { StaffDialog, StaffFold, StaffWho } from "../parts";
import { StaffThread } from "./StaffThread";
import { loadStaffInboxAction, messageAllCoachesAction } from "./actions";
import "./support.css";

// The staff admin's Support (26 Nov, Alex; the staff spec, screen 3): what the coaches wrote from Settings' Support, a
// coach a row in one hairline card, the newest word first: their face, the name over the last line grey, a rust
// `1 problem` pill while one is open, the rust count unread, when. A row opens the thread in place under it on the shared
// fold, with the reply line, Done on an open problem and Send. On the head `Message all coaches`, the white pill, opens a
// `.dlh` pop-up: the words, Cancel and `Send to 14 coaches`, nothing more asked. The list is read again every 20 seconds
// while the tab is visible. `None yet` when no coach has written.

const POLL_MS = 20_000;

export function SupportInbox({ initial, coaches }: { initial: SupportInboxRow[]; /** How many coaches Message all coaches reaches. */ coaches: number }) {
  const router = useRouter();
  const [rows, setRows] = useState(initial);
  const [open, setOpen] = useState<number | null>(null);
  const [writing, setWriting] = useState(false);
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  });

  const reload = () =>
    loadStaffInboxAction().then(
      (r) => {
        if (r.error !== undefined) return;
        // The open thread is being read: its count stays at none here.
        setRows(r.rows.map((x) => (x.coachId === openRef.current ? { ...x, unread: 0 } : x)));
      },
      () => {}
    );

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") void reload();
    };
    const t = window.setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);

  // A thread as it now stands keeps its row in step: its last line, read, its problems; a new line moves it to the top.
  const stepRow = (coachId: number, lines: SupportLine[]) =>
    setRows((rs) => {
      const row = rs.find((r) => r.coachId === coachId);
      const last = lines[lines.length - 1];
      if (!row || !last) return rs;
      const moved = last.text !== row.last || (last.mine ? "owner" : "coach") !== row.lastFrom;
      const next: SupportInboxRow = {
        ...row,
        unread: 0,
        problems: lines.filter((l) => l.kind === "problem" && !l.done).length,
        last: last.text,
        lastFrom: last.mine ? "owner" : "coach",
        ...(moved ? { when: last.time, at: new Date().toISOString() } : {}),
      };
      return moved ? [next, ...rs.filter((r) => r.coachId !== coachId)] : rs.map((r) => (r.coachId === coachId ? next : r));
    });

  const toggle = (coachId: number) => setOpen((o) => (o === coachId ? null : coachId));

  return (
    <div className="stf-screen">
      <div className="stf-head">
        <h1 className="stf-title">Support</h1>
        <div className="stf-head-right">
          {coaches > 0 && (
            <button type="button" className="stf-pill" onClick={() => setWriting(true)}>
              Message all coaches
            </button>
          )}
        </div>
      </div>
      <div className="stf-card stf-sup-inbox" style={{ marginTop: 20 }}>
        {rows.length === 0 ? (
          <p className="stf-empty">None yet</p>
        ) : (
          <table className="stf-table">
            <tbody>
              {rows.map((r) => {
                const isOpen = open === r.coachId;
                return (
                  <Fragment key={r.coachId}>
                    <tr
                      className={`stf-link${isOpen ? " open" : ""}${r.unread ? " unread" : ""}`}
                      tabIndex={0}
                      aria-expanded={isOpen}
                      onClick={() => toggle(r.coachId)}
                      onKeyDown={(e) => {
                        if (e.target !== e.currentTarget) return;
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          toggle(r.coachId);
                        }
                      }}
                    >
                      <td className="stf-sup-who">
                        <StaffWho name={r.name} sub={r.last} photo={r.avatarPath} />
                      </td>
                      <td className="stf-sup-mark">{r.problems > 0 && <span className="stf-state rust small">{`${r.problems} problem${r.problems === 1 ? "" : "s"}`}</span>}</td>
                      <td className="stf-sup-mark">
                        {r.unread > 0 && (
                          <span className="stf-count" aria-label={`${r.unread} unread`}>
                            {r.unread}
                          </span>
                        )}
                      </td>
                      <td className="stf-sup-when">{r.when}</td>
                    </tr>
                    <tr>
                      <td colSpan={4} className="stf-foldcell">
                        <StaffFold open={isOpen}>
                          <StaffThread coachId={r.coachId} coachName={r.name} onLines={(lines) => stepRow(r.coachId, lines)} />
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
      <MessageAll
        open={writing}
        coaches={coaches}
        onClose={() => setWriting(false)}
        onSent={() => {
          setWriting(false);
          void reload();
          router.refresh();
        }}
      />
    </div>
  );
}

/** Message all coaches: the words, Cancel and Send to {n} coaches. */
function MessageAll({ open, coaches, onClose, onSent }: { open: boolean; coaches: number; onClose: () => void; onSent: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Sent again after a dropped signal, the same words keep their key: no coach gets them twice.
  const key = useRef<{ words: string; key: string } | null>(null);

  const close = () => {
    if (busy) return;
    setError(null);
    onClose();
  };

  const send = () => {
    const words = text.trim();
    if (!words || busy) return;
    const onceKey = key.current?.words === words ? key.current.key : newOnceKey();
    key.current = { words, key: onceKey };
    setBusy(true);
    setError(null);
    messageAllCoachesAction(words, onceKey)
      .then(
        (r) => {
          if (r.error !== undefined) return setError(r.error === "Nothing to send" ? r.error : "Not sent. Try again.");
          key.current = null;
          setText("");
          onSent();
        },
        () => setError("Not sent. Check your connection and try again.")
      )
      .finally(() => setBusy(false));
  };

  return (
    <StaffDialog open={open} onClose={close} title="Message all coaches">
      <div className="dlh-field stf-sup-all">
        <textarea className="dlh-line" value={text} onChange={(e) => setText(e.target.value)} aria-label="Message" maxLength={4000} autoFocus />
      </div>
      {error && <p className="stf-error">{error}</p>}
      <div className="dlh-foot">
        <button type="button" className="dlh-cancel" onClick={close} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="dlh-go" onClick={send} disabled={!text.trim() || busy}>
          {`Send to ${coaches} coach${coaches === 1 ? "" : "es"}`}
        </button>
      </div>
    </StaffDialog>
  );
}
