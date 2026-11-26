"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { newOnceKey } from "../../lib/onceKey";
import type { SupportLine } from "../../lib/support";
import { SepJoin } from "../parts";
import { loadStaffThreadAction, markStaffProblemDoneAction, markStaffThreadSeenAction, replyStaffSupportAction } from "./actions";
import "./support.css";

// One coach's Support thread on the staff admin (26 Nov, Alex: docs/boards/staff-admin-mockup.html, "2 · A coach"): the
// coach's lines white with the hairline on the left, Norcoach's on the right on the neutral tint, a heading over each
// day; a problem wears the rust `Problem` tag (green `Done` once closed), its screen grey after the time; under a line
// staff wrote, who wrote it, `Finlay | 14:20`. Then the reply line, `Done` while a problem is open (it closes the oldest
// one) and the ink `Send`, faded until something is typed. Writing into an empty thread is how staff message a coach.
// Opening it reads it (one read mark, shared with the owner); read again every 20 seconds while the tab is visible.

const POLL_MS = 20_000;

type Pending = { key: string; text: string };

export function StaffThread({
  coachId,
  coachName,
  initial,
  onLines,
}: {
  coachId: number;
  coachName: string;
  /** The thread as the page drew it; fetched on opening when not given (the inbox's folds). */
  initial?: SupportLine[];
  /** The thread as it now stands, after a read, a send or a Done (the inbox keeps its row in step). */
  onLines?: (lines: SupportLine[]) => void;
}) {
  const router = useRouter();
  const [lines, setLines] = useState<SupportLine[] | null>(initial ?? null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const report = useRef(onLines);
  const busyRef = useRef(false);
  useEffect(() => {
    report.current = onLines;
    busyRef.current = busy;
  });

  const take = useCallback((next: SupportLine[]) => {
    setLines(next);
    report.current?.(next);
  }, []);

  // The coach's lines are read once they are on screen: here at once, on the server after, and the rail's count with it.
  // (A thread's unread marks aren't drawn: only the rail's count and the inbox's say it.)
  const unreadKey = (lines ?? []).filter((l) => l.unread).map((l) => l.id).join(",");
  useEffect(() => {
    if (!unreadKey) return;
    void markStaffThreadSeenAction(coachId).then(
      (r) => {
        if (!r.error) router.refresh();
      },
      () => {}
    );
  }, [unreadKey, coachId, router]);

  const load = useCallback(() => {
    void loadStaffThreadAction(coachId).then(
      (r) => {
        if (r.error === undefined) take(r.lines);
      },
      () => {}
    );
  }, [coachId, take]);

  useEffect(() => {
    if (!initial) load();
    const tick = () => {
      if (document.visibilityState === "visible" && !busyRef.current) load();
    };
    const t = window.setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", tick);
    };
    // The first thread is the page's; later reads are the poll's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  // The words back on the line and sent again keep the failed send's key, so a line that in fact landed isn't posted twice.
  const failed = useRef<{ words: string; key: string } | null>(null);
  const send = () => {
    const words = text.trim();
    if (!words || busy) return;
    const onceKey = failed.current?.words === words ? failed.current.key : newOnceKey();
    failed.current = { words, key: onceKey };
    const key = `p${Date.now()}`;
    setBusy(true);
    setError(null);
    setPending((p) => [...p, { key, text: words }]);
    setText("");
    replyStaffSupportAction(coachId, words, onceKey)
      .then(
        (r) => {
          if (r.error !== undefined) {
            setError(r.error === "Nothing to send" ? r.error : "Not sent. Try again.");
            setText(words);
            return;
          }
          failed.current = null;
          take(r.lines);
          router.refresh();
        },
        () => {
          setError("Not sent. Check your connection and try again.");
          setText(words);
        }
      )
      .finally(() => {
        setBusy(false);
        setPending((p) => p.filter((x) => x.key !== key));
      });
  };

  const open = (lines ?? []).filter((l) => l.kind === "problem" && !l.done);
  const done = () => {
    const first = open[0];
    if (!first) return;
    setError(null);
    setLines((ls) => ls && ls.map((l) => (l.id === first.id ? { ...l, done: true } : l)));
    markStaffProblemDoneAction(first.id).then(
      (r) => {
        if (r.error !== undefined) setError("Not saved. Try again.");
        else {
          take(r.lines);
          router.refresh();
        }
      },
      () => setError("Not saved. Check your connection and try again.")
    );
  };

  // The box grows with what is typed, up to six lines.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [text]);

  const first = coachName.trim().split(/\s+/)[0] || coachName;
  const shown = lines ?? [];
  return (
    <div className="stf-sup-thread">
      {(shown.length > 0 || pending.length > 0) && (
        <div className="stf-thread">
          {shown.map((l, i) => {
            const newDay = i === 0 || shown[i - 1].day !== l.day;
            const by = l.mine && l.by ? l.by.split(/\s+/)[0] : null;
            return (
              <Fragment key={l.id}>
                {newDay && <p className="stf-day">{l.day}</p>}
                <div className={`stf-bub ${l.mine ? "us" : "them"}`}>
                  {l.kind === "problem" && <span className={`stf-tag${l.done ? " done" : ""}`}>{l.done ? "Done" : "Problem"}</span>}
                  {l.text}
                  {l.image && (
                    <a href={l.image} target="_blank" rel="noreferrer" aria-label="Open the screenshot">
                      {/* eslint-disable-next-line @next/next/no-img-element -- the coach's screenshot, served by /api/support */}
                      <img src={`${l.image}?w=480`} alt="" loading="lazy" decoding="async" />
                    </a>
                  )}
                  <small>
                    <SepJoin parts={[by, l.time, l.where]} />
                  </small>
                </div>
              </Fragment>
            );
          })}
          {pending.map((p) => (
            <div key={p.key} className="stf-bub us stf-sup-pending">
              {p.text}
            </div>
          ))}
        </div>
      )}
      <div className="stf-compose">
        <textarea
          ref={box}
          className="stf-line"
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={shown.length ? "Reply" : `Message ${first}`}
          aria-label={shown.length ? `Reply to ${coachName}` : `Message ${coachName}`}
          maxLength={4000}
        />
        {open.length > 0 && (
          <button type="button" className="stf-pill small" onClick={done}>
            Done
          </button>
        )}
        <button type="button" className="stf-pill ink small" onClick={send} disabled={!text.trim() || busy}>
          Send
        </button>
      </div>
      {error && (
        <p className="stf-error stf-sup-err" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
