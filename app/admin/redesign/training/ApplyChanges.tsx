"use client";

import { Fragment, useEffect, useState } from "react";
import type React from "react";
import { DialogClose, DialogContent, DialogDescription } from "../../../components/ui/dialog";
import { TRACK_ACCENT } from "../../phaseChrome";
import { dayMonth } from "../../../lib/dayMonth";
import { addDays } from "../phases/timeline";
import { Sep, SepJoin } from "../Sep";
import { inUnit, type ApplyFig, type ApplyPreview, type ApplySession } from "./applyShape";
import { PopupTitle } from "../PopupWho";
import "./apply-changes.css";

// The confirm of Apply to the rest and of a session's Apply to remaining weeks (27 Nov, Alex: B of
// docs/boards/apply-changes-mockup.html, "I just want to clearly and cleanly see the changes that I have done"): the
// title, then exactly what changes in the later weeks (applyPreview.ts reads it as the action would do it). A session at
// a time, the weeks it reaches on its head only where sessions reach different weeks; a line a change with its mark in
// a ring: an added exercise in green with its own figures, a changed one with each figure that changes, the old struck
// grey and the new in training purple, a removed one struck, the new order, logged sets going in rust. The list scrolls
// inside; the foot stays.
// A weight is read in the coach's unit (inUnit, applyShape.ts), as the page's read counts it to offer the apply at all.


/** "Week 8", "Weeks 8–9", "Weeks 8 and 10", "Weeks 2, 4 and 6". */
const weeksWords = (ws: number[]) => {
  if (ws.length === 1) return `Week ${ws[0]}`;
  if (ws.every((w, i) => i === 0 || w === ws[i - 1] + 1)) return `Weeks ${ws[0]}–${ws[ws.length - 1]}`;
  return `Weeks ${ws.slice(0, -1).join(", ")} and ${ws[ws.length - 1]}`;
};

export default function ApplyChangesDialog({ title, description, confirm, load, initial, startDate, lbs, onConfirm }: {
  title: string;
  description: string;
  confirm: string;
  /** Saves what is waiting, then reads what the copy would change. */
  load: () => Promise<ApplyPreview | null>;
  /** The list the page read already, when nothing waits to be saved (27 Nov, Alex: "the pop up of apply is quite slow to
   *  load"): drawn the moment it opens, the server's read taking its place when it lands (the same, unless something
   *  changed meanwhile). */
  initial?: ApplyPreview | null;
  /** The programme's first Monday, for the weeks' dates. */
  startDate: string | null;
  lbs: boolean;
  /** Given what the pop-up read (undefined while it reads, null if it couldn't), so the apply reaches the weeks it lists. */
  onConfirm: (read: ApplyPreview | null | undefined) => void;
}) {
  const [preview, setPreview] = useState<ApplyPreview | null | undefined>(initial ?? undefined);
  useEffect(() => {
    let alive = true;
    load()
      .then((p) => alive && setPreview((was) => p ?? was ?? null))
      .catch(() => alive && setPreview((was) => was ?? null));
    return () => {
      alive = false;
    };
    // Read once, as the pop-up opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A session at a time (27 Nov, Alex: "clearly and cleanly see the changes that I have done"): each session's changes
  // once, with the weeks they reach; a session that changes differently in some weeks is there once for each way.
  const entries: { key: string; weeks: number[]; session: ApplySession }[] = [];
  for (const w of preview?.weeks ?? []) {
    const nth = new Map<string, number>();
    for (const raw of w.sessions) {
      const one = inUnit(raw, lbs);
      if (!one) continue;
      const n = nth.get(one.name) ?? 0;
      nth.set(one.name, n + 1);
      const key = `${one.name}#${n}|${JSON.stringify(one)}`;
      const e = entries.find((x) => x.key === key);
      if (e) e.weeks.push(w.index);
      else entries.push({ key, weeks: [w.index], session: one });
    }
  }
  // The weeks a session reaches are said only where they differ between sessions (else the title says it).
  const reach = new Set(entries.map((e) => e.weeks.join(",")));
  const headed = reach.size > 1;

  const unit = lbs ? "lbs" : "kg";
  // Where a session's changes reach, on its head's right, only when sessions reach different weeks (else the title says
  // it): the weeks, their dates on hover.
  const reachOf = (ws: number[]): React.ReactNode => {
    if (!headed) return null;
    const monday = (i: number) => (startDate ? addDays(startDate, (i - 1) * 7) : null);
    const from = monday(ws[0]);
    const to = monday(ws[ws.length - 1]);
    return <span title={from && to ? `${dayMonth(from)} – ${dayMonth(addDays(to, 6))}` : undefined}>{weeksWords(ws)}</span>;
  };


  return (
    <DialogContent className="dlh apx" style={{ "--apx-c": TRACK_ACCENT.training } as React.CSSProperties}>
      <div className="dlh-head">
        <PopupTitle>{title}</PopupTitle>
        <DialogClose className="dlh-x" aria-label="Close">
          ✕
        </DialogClose>
      </div>
      {/* The changes alone on screen (23 Oct, Alex: "I do not need this explanation here"); the words stay for a screen reader. */}
      <DialogDescription className="sr-only">{description}</DialogDescription>
      {preview !== undefined && (
        <div className="apx-list" aria-label="What changes">
          {entries.length === 0 ? (
            <p className="apx-none">{preview ? "No changes" : "Couldn't read the weeks"}</p>
          ) : (
            entries.map((e) => <SessionChanges key={e.key} s={e.session} unit={unit} weeks={reachOf(e.weeks)} />)
          )}
        </div>
      )}
      <div className="dlh-foot">
        <DialogClose className="dlh-cancel">Cancel</DialogClose>
        <button type="button" className="dlh-go" onClick={() => onConfirm(preview)} autoFocus>
          {confirm}
        </button>
      </div>
    </DialogContent>
  );
}

/** The mark in a ring, as a session row wears its marks (27 Nov, Alex: B of docs/boards/apply-changes-mockup.html). */
function Mark({ kind }: { kind: "added" | "changed" | "removed" | "order" | "goes" }) {
  const path = { added: "M12 6v12M6 12h12", changed: "M4 20h4L19 9l-4-4L4 16z", removed: "M6 12h12", order: "M8 4v16M4 8l4-4 4 4M16 20V4M12 16l4 4 4-4", goes: "M12 7v6M12 17h.01" }[kind];
  return (
    <span className={`apb-ring ${kind}`} aria-hidden="true">
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d={path} />
      </svg>
    </span>
  );
}

/** An added row's own figures as they read on Training: `3 × 10–12`, `40 kg`, `Rest 90s`, a cardio's time and pace. */
function Brief({ figs, unit }: { figs: ApplyFig[]; unit: string }) {
  const get = (l: string) => figs.find((f) => f.label === l && !f.gym)?.to ?? null;
  const sets = get("Sets");
  const reps = get("Reps");
  const kg = figs.find((f) => f.kg && !f.gym)?.to ?? null;
  const parts = [sets && reps ? `${sets} × ${reps}` : sets ? `${sets} sets` : reps, kg ? `${kg} ${unit}` : null, get("Rest") ? `Rest ${get("Rest")}` : null, get("Time"), get("Pace")];
  return <SepJoin parts={parts} />;
}

function SessionChanges({ s, unit, weeks }: { s: ApplySession; unit: string; weeks: React.ReactNode }) {
  return (
    <div className="apb-session">
      <div className="apb-shead">
        <span>{s.name}</span>
        {weeks && <small>{weeks}</small>}
      </div>
      {s.added && (
        <div className="apb-line">
          <Mark kind="added" />
          <span className="apb-name">Added session</span>
          <span className="apb-figs plain">
            <SepJoin parts={[s.added.exercises > 0 && `${s.added.exercises} ${s.added.exercises === 1 ? "exercise" : "exercises"}`, s.added.cardio > 0 && `${s.added.cardio} cardio`]} />
          </span>
        </div>
      )}
      {s.was && (
        <div className="apb-line">
          <Mark kind="changed" />
          <span className="apb-name">Name</span>
          <span className="apb-figs">
            <Fig f={{ label: "", from: s.was, to: s.name }} unit={unit} />
          </span>
        </div>
      )}
      {s.items.map((it, i) => (
        <div key={i} className={`apb-line ${it.change}`}>
          <Mark kind={it.change} />
          <span className="apb-name" title={it.name}>
            {it.change === "removed" ? <s>{it.name}</s> : it.name}
          </span>
          <span className={`apb-figs${it.change === "changed" ? "" : " plain"}`}>
            {it.change === "added" ? (
              <Brief figs={it.figs} unit={unit} />
            ) : it.change === "removed" ? (
              "Removed"
            ) : (
              it.figs.map((f, j) => (
                <Fragment key={j}>
                  {j > 0 && <Sep />}
                  <Fig f={f} unit={unit} />
                </Fragment>
              ))
            )}
          </span>
        </div>
      ))}
      {s.reorder && (
        <div className="apb-line">
          <Mark kind="order" />
          <span className="apb-name">New order</span>
          <span className="apb-figs plain" />
        </div>
      )}
      {s.goes && (
        <div className="apb-line goes">
          <Mark kind="goes" />
          <span className="apb-name">{s.goes.sets > 0 ? `${s.goes.sets} logged ${s.goes.sets === 1 ? "set goes" : "sets go"}` : "Ticked cardio goes"}</span>
          <span className="apb-figs plain" />
        </div>
      )}
    </div>
  );
}

/** A figure that changes: its label, the old struck through, the new in purple (a weight already in the unit, inUnit). A value that goes reads None. */
function Fig({ f, unit }: { f: ApplyFig; unit: string }) {
  const shown = (v: string | null) => {
    if (v == null) return f.kg ? "—" : "None";
    return f.words ? `“${v}”` : v;
  };
  const label = f.kg ? (f.gym ? `${unit} at ${f.gym}` : unit) : f.label;
  return (
    <span className={`apx-fig${f.words ? " words" : ""}`}>
      {label && <span className="apx-lab">{label}</span>}
      {f.from != null && (
        <s className="apx-was" aria-label={`was ${shown(f.from)}`}>
          {shown(f.from)}
        </s>
      )}
      <span className="apx-now">{shown(f.to)}</span>
    </span>
  );
}
