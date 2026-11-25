"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { CheckIcon } from "../components/icons";
import { logMetricPeriodAction, saveMeasurementCheckInAction } from "../lib/actions";
import { pic } from "../lib/pic";
import { useCoachIdentity } from "./CheckInContext";
import { cleanNumeric, isWholeMetric } from "./CheckInLine";
import type { CheckInMetric, CheckInSection } from "./CheckInScreen";
import { Bars } from "./Bars";
import { dayWords } from "../lib/clientDates";
import { nativePlatform } from "../lib/native";
import { connectHealth, useHealthConnected } from "./HealthSync";
import "./health-block.css";

// A day's check-in as a centred pop-up (13 Oct, "Rows"): the gym pop-up's
// language, a sand glow at the top, one bordered row a metric, one navy
// button. Home's lifestyle card opens it with Log, the Check-in screen's
// day rows with Fill in or Edit. The header carries a ring with a segment
// a metric that takes the metric's group colour as it is filled; the rows
// sit by frequency (ALL DAY, THIS WEEK, THIS MONTH); a number has a box
// with the last value as its placeholder, a scale a bar that fills as a
// gradient; the note to the coach is last; Save sends what is filled, some
// or all, and folds the pop-up away. Nothing else on the page moves.

type RowSource = "daily" | "weekly" | "monthly" | "measurements";
export type Row = { key: string; source: RowSource; metric: CheckInMetric };
type Group = { id: "morning" | "day" | "evening" | "week" | "month"; label: string; rows: Row[] };

// Today's lines by when in the day they're asked for (the coach's "Asked":
// metricAskAt): the morning, all day, the evening; then the week's. The
// Check-in screen counts with this; the pop-up groups by frequency only.
const DAY_PARTS = [
  { id: "morning", label: "Morning", holds: ["morning"] },
  { id: "day", label: "All day", holds: ["anytime"] },
  { id: "evening", label: "Evening", holds: ["evening"] },
] as const;

const rowsOf = (s: CheckInSection | undefined, source: RowSource): Row[] => (s?.metrics ?? []).map((m) => ({ key: `${source}${m.id}`, source, metric: m }));

export function buildGroups(sections: CheckInSection[], weeklyOpen: boolean, monthlyOpen: boolean, weekLabel = "This week", monthLabel = "This month"): Group[] {
  const daily = sections.find((s) => s.id === "daily");
  const weekly = sections.find((s) => s.id === "weekly");
  const monthly = sections.find((s) => s.id === "monthly");
  const measure = sections.find((s) => s.id === "measurements");
  const groups: Group[] = [];
  const today = rowsOf(daily, "daily");
  for (const part of DAY_PARTS) {
    const rows = today.filter((r) => (part.holds as readonly string[]).includes(r.metric.askAt ?? "anytime"));
    if (rows.length) groups.push({ id: part.id, label: part.label, rows });
  }
  const week = weeklyOpen ? [...rowsOf(weekly, "weekly"), ...rowsOf(measure, "measurements")] : [];
  if (week.length) groups.push({ id: "week", label: weekLabel, rows: week });
  const month = monthlyOpen ? rowsOf(monthly, "monthly") : [];
  if (month.length) groups.push({ id: "month", label: monthLabel, rows: month });
  return groups;
}

// The one note goes with the first period on screen: the day's when there
// are daily metrics, else the week's, else the measurements'.
export function noteOf(sections: CheckInSection[], rows: Row[]) {
  const source = rows[0]?.source ?? null;
  return { source, saved: (source && sections.find((s) => s.id === source)?.note) ?? "" };
}
export const seedOf = (rows: Row[]) => Object.fromEntries(rows.map((r) => [r.key, r.metric.value]));

// "82.5", "82,5" and "82.50" are the same reading.
export function sameNumber(a: string, b: string) {
  if (a === b) return true;
  if (a === "" || b === "") return false;
  return Number(a.replace(",", ".")) === Number(b.replace(",", "."));
}

/** "Tue 13 Oct" or "Tuesday 13 October" (3 Nov, Alex: dates through clientDates). */
export const dayLabel = (iso: string, long = false) => (long ? dayWords(iso, { weekday: "long", long: true }) : dayWords(iso, { weekday: "short" }));

export type CheckInForm = {
  /** The day the lines are for (yyyy-mm-dd). */
  date: string;
  sections: CheckInSection[];
  weeklyOpen: boolean;
  monthlyOpen: boolean;
  /** "This week" / "This month" for today; "That week" / "That month" for a past day. */
  weekLabel?: string;
  monthLabel?: string;
};

// Lifestyle's beige, the one it wears everywhere (DESIGN-RULES §4).
const SAND_RGB = "160,138,92";
const buzz = (ms = 5) => {
  try {
    navigator.vibrate?.(ms);
  } catch {}
};

/** "Last logged 55 kg", "Last logged 7 of 10", or "First time": the reading alone, no day (2 Nov, Alex: "take out the
 *  date and just say last logged"; a date read as the check-in's own day). */
function lastLine(m: CheckInMetric): string {
  if (!m.last) return "First time";
  const v = m.last.value;
  const n = isWholeMetric(m) ? Math.round(v).toLocaleString("en-US") : String(v);
  const reading = m.scaleMax ? `${Math.round(v)} of ${m.scaleMax}` : `${n}${m.unit ? ` ${m.unit}` : ""}`;
  return `Last logged ${reading}`;
}

/** The day a check-in is for, as its line says it: "Mon 2 Nov". */
// Filled is green, whatever the metric (13 Oct, Alex: no colour coding for now).
const GREEN = { hex: "#2f7a3f", rgb: "47,122,63" };
const colourOf = () => GREEN;

export default function CheckInDialog({
  clientId,
  form,
  today,
  coachName,
  phaseName = null,
  onClose,
  onSaved,
}: {
  clientId: number;
  form: CheckInForm;
  today: string;
  coachName: string;
  /** The lifestyle phase's name, for the eyebrow. */
  phaseName?: string | null;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const router = useRouter();
  const coach = useCoachIdentity();
  const isToday = form.date === today;
  // The rows by frequency: the day's in the coach's order, the week's (with
  // the measurements), the month's.
  const groups: { id: string; label: string; rows: Row[] }[] = [];
  const daily = rowsOf(form.sections.find((s) => s.id === "daily"), "daily");
  // The day's rows with no label over them (17 Nov, Alex: "All day" said nothing the pop-up's title doesn't).
  if (daily.length) groups.push({ id: "day", label: "", rows: daily });
  const week = form.weeklyOpen ? [...rowsOf(form.sections.find((s) => s.id === "weekly"), "weekly"), ...rowsOf(form.sections.find((s) => s.id === "measurements"), "measurements")] : [];
  if (week.length) groups.push({ id: "week", label: form.weekLabel ?? "This week", rows: week });
  const month = form.monthlyOpen ? rowsOf(form.sections.find((s) => s.id === "monthly"), "monthly") : [];
  if (month.length) groups.push({ id: "month", label: form.monthLabel ?? "This month", rows: month });
  const rows = groups.flatMap((g) => g.rows);
  // Apple Health connected in the app (23 Nov, Alex: "can we still have it show with 0 steps on our app", "with all the
  // metrics"): steps sits in the From Apple Health block, reading 0 until the phone counts some (nothing saved for it, so
  // the phone's figure takes it when it comes). Weight, sleep and heart rate join it only once the phone has sent one in
  // the last 30 days (25 Nov, Alex: "I only have the means of tracking steps… the weight I will keep putting manually"),
  // typeable there until this period's figure comes; a phone that never sends one leaves them ordinary fields in the list.
  const healthOn = useHealthConnected() && nativePlatform() != null;
  const isSteps = (r: Row) => r.source === "daily" && /\bsteps?\b/i.test(r.metric.name);
  const inBlock = (r: Row) => !!r.metric.live || (healthOn && !!r.metric.phone && (isSteps(r) || !!r.metric.fed));
  const stepsWait = (r: Row) => healthOn && !!r.metric.phone && !r.metric.live && isSteps(r);
  const { source: noteSource, saved: savedNote } = noteOf(form.sections, rows);

  const [typed, setValues] = useState<Record<string, string>>(() => seedOf(rows));
  // A row the phone filled, even one it filled while the pop-up is open (connected from its line, 17 Nov): the phone's
  // figure, read-only, is what shows and goes with Save, never what was typed before it came.
  const values: Record<string, string> = { ...typed, ...Object.fromEntries(rows.filter((r) => r.metric.live).map((r) => [r.key, r.metric.value])) };
  const [note, setNote] = useState(savedNote);
  const [pending, setPending] = useState(false);
  const [phase, setPhase] = useState<"open" | "closing" | "saved">("open");
  const [confirming, setConfirming] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // A number is valid when it is a number at or above zero; a scale, 1..max.
  const problem = (r: Row): string | null => {
    const v = (values[r.key] ?? "").trim();
    if (v === "") return null;
    const n = Number(v.replace(",", "."));
    if (!Number.isFinite(n)) return "Numbers only";
    if (r.metric.scaleMax) return n >= 1 && n <= r.metric.scaleMax ? null : `Between 1 and ${r.metric.scaleMax}`;
    return n >= 0 ? null : "Can't be below 0";
  };
  const isFilled = (r: Row) => stepsWait(r) || ((values[r.key] ?? "").trim() !== "" && problem(r) == null);
  const filled = rows.filter(isFilled);
  const total = rows.length;
  const allIn = total > 0 && filled.length === total;
  const noteDirty = note.trim() !== savedNote.trim();
  const changedRow = (r: Row) => !sameNumber(values[r.key] ?? "", r.metric.value);
  const dirty = rows.some(changedRow) || noteDirty;
  const savedSomething = rows.some((r) => r.metric.value.length > 0);
  const canSave = !pending && (filled.length > 0 || (noteDirty && savedSomething)) && dirty;

  const finish = (afterMs = 180) => {
    setPhase("closing");
    setTimeout(onClose, afterMs);
  };
  const close = () => {
    if (phase !== "open" || pending) return;
    if (dirty) {
      setConfirming(true);
      return;
    }
    finish();
  };
  // Escape asks the same; the first empty line has the focus; the opener has it back after.
  const card = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== "Tab" || !card.current) return;
      const items = Array.from(card.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex="0"]'));
      if (!items.length) return;
      const i = items.indexOf(document.activeElement as HTMLElement);
      if (e.shiftKey && i <= 0) {
        e.preventDefault();
        items[items.length - 1].focus();
      } else if (!e.shiftKey && i === items.length - 1) {
        e.preventDefault();
        items[0].focus();
      }
    };
    document.addEventListener("keydown", onKey);
    // The first metric still to fill, in view; the body stays at its top when it already is, so the line on the phone's
    // connection over the list stays in sight (17 Nov).
    const t = setTimeout(() => {
      const first = body.current?.querySelector<HTMLElement>(".cki-row:not(.filled)");
      if (first && body.current && first.offsetTop + first.offsetHeight > body.current.clientHeight) body.current.scrollTop = Math.max(0, first.offsetTop - 8);
    }, 60);
    return () => {
      clearTimeout(t);
      document.removeEventListener("keydown", onKey);
      before?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on open
  }, []);
  // The keyboard (12 Nov): the card lifts clear of it by --kb under kb-open (the end of globals.css), and the line being
  // typed in is brought into the body by the app's one reveal (keyboard.ts), a .cki-row or the note's box whole.
  // The note grows with what is typed, from 56px up to 120.
  const noteBox = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = noteBox.current;
    if (!el) return;
    el.style.height = "56px";
    el.style.height = `${Math.min(120, Math.max(56, el.scrollHeight))}px`;
  }, [note]);
  // The number boxes in order, for Next on the keyboard.
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});
  const numberKeys = rows.filter((r) => !r.metric.scaleMax).map((r) => r.key);
  const focusNextEmpty = (from: string) => {
    const i = numberKeys.indexOf(from);
    const next = numberKeys.slice(i + 1).find((k) => (values[k] ?? "").trim() === "") ?? numberKeys.slice(i + 1)[0];
    if (next) inputs.current[next]?.focus();
    else inputs.current[from]?.blur();
  };

  const save = async () => {
    if (!canSave) return;
    setPending(true);
    try {
      // Each period is posted when something in it changed, or when it
      // carries the note and the note changed. A line out of range is left
      // out, so the rest still go.
      const send = (r: Row) => (isFilled(r) ? (values[r.key] ?? "") : (values[r.key] ?? "").trim() === "" ? "" : r.metric.value);
      for (const source of ["daily", "weekly", "monthly"] as const) {
        const mine = rows.filter((r) => r.source === source);
        const withNote = noteSource === source;
        if (mine.length === 0 || !(mine.some((r) => changedRow(r) && (isFilled(r) || (values[r.key] ?? "").trim() === "")) || (withNote && noteDirty))) continue;
        const fd = new FormData();
        fd.set("clientId", String(clientId));
        fd.set("date", form.date);
        fd.set("frequency", source);
        // Only the rows the client changed (24 Nov: a client's Apple Health weight went missing): a row left as the pop-up
        // opened it is not on the form, so a figure the phone filled meanwhile is never sent back empty over it (the action
        // leaves a field not on the form untouched).
        mine.forEach((r) => changedRow(r) && fd.set(`metric_${r.metric.id}`, send(r)));
        fd.set("note", withNote ? note : form.sections.find((s) => s.id === source)?.note ?? "");
        await logMetricPeriodAction(fd);
      }
      const measureRows = rows.filter((r) => r.source === "measurements");
      const noteWithMeasure = noteSource === "measurements";
      if (measureRows.length > 0 && (measureRows.some((r) => changedRow(r) && (isFilled(r) || (values[r.key] ?? "").trim() === "")) || (noteWithMeasure && noteDirty))) {
        const fd = new FormData();
        fd.set("clientId", String(clientId));
        fd.set("date", form.date);
        measureRows.forEach((r) => fd.set(`field_${r.metric.id}`, send(r)));
        if (noteWithMeasure) fd.set("note", note);
        await saveMeasurementCheckInAction(fd);
      }
      router.refresh();
      onSaved?.();
      setPhase("saved");
      setToast("Check-in saved");
      setTimeout(onClose, 1500);
    } catch {
      setToast("Couldn't save. Try again");
      setTimeout(() => setToast(null), 2500);
    } finally {
      setPending(false);
    }
  };

  // The ring: a segment a metric, clockwise, a 6° gap between them.
  const seg = total > 0 ? 360 / total : 360;
  const gap = total > 1 ? 6 : 0;
  // Filled clockwise from the top, whichever rows are done (17 Nov, Alex: "always filled in clockwise, like a clock"):
  // the first so many segments green, the rest sand, never a gap where an earlier row is still to do.
  const filledCount = rows.filter(isFilled).length;
  const ring =
    total === 0
      ? `rgba(${SAND_RGB},0.15)`
      : `conic-gradient(${rows
          .map((_, i) => {
            const a0 = i * seg + gap / 2;
            const a1 = (i + 1) * seg - gap / 2;
            const c = i < filledCount ? GREEN.hex : `rgba(${SAND_RGB},0.15)`;
            return `transparent ${i * seg}deg ${a0}deg, ${c} ${a0}deg ${a1}deg, transparent ${a1}deg ${(i + 1) * seg}deg`;
          })
          .join(", ")})`;
  const initial = (coach?.name ?? coachName).trim().slice(0, 1).toUpperCase();

  if (phase === "saved") {
    return createPortal(
      <div className="cki-toast" role="status">
        {toast}
      </div>,
      document.body
    );
  }
  return createPortal(
    <>
      <div className={`gpk-overlay${phase === "closing" ? " closing" : ""}`} onClick={close}>
        <div ref={card} className={`cki-card${phase === "closing" ? " closing" : ""}`} role="dialog" aria-modal="true" aria-labelledby="cki-title" onClick={(e) => e.stopPropagation()}>
          <span className="cki-glow" aria-hidden="true" />
          <span className="cki-wash" aria-hidden="true" />
          <div className="cki-head">
            <span className="cki-ring" style={{ background: ring }} aria-hidden="true">
              <span className="cki-ring-in">
                <b>{filled.length}</b>
                <small>of {total}</small>
              </span>
            </span>
            <div className="cki-head-text">
              <span className="cki-eyebrow"><Bars parts={["Lifestyle", phaseName]} /></span>
              <h2 id="cki-title" className="cki-title">
                {isToday ? "Today's check-in" : dayLabel(form.date, true)}
              </h2>
              {/* No line under the title while filling (17 Nov, Alex: the ring says where it stands, the title the day); a check
                  and Saved once all is in and saved (23 Oct, Alex). */}
              {total > 0 && allIn && !dirty && (
                <p className="cki-sub done saved" aria-live="polite">
                  <CheckIcon />
                  Saved
                </p>
              )}
            </div>
            <button type="button" className="gpk-round" onClick={close} aria-label="Close">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </div>

          <div ref={body} className="cki-body">
            {/* The list is only what the client fills (17 Nov, Alex: B3 of docs/boards/auto-metric-b-block-mockup.html); the
                phone's figures sit apart under it, read-only. */}
            {/* The phone could fill some of these and isn't connected yet (17 Nov, Alex): one line, first, with Connect. */}
            {rows.some((r) => r.metric.phone && !r.metric.live) && <HealthOff onSynced={(saved) => saved && router.refresh()} />}
            {groups.map((g) => ({ ...g, rows: g.rows.filter((r) => !inBlock(r)) })).filter((g) => g.rows.length > 0).map((g) => (
              <div key={g.id} className="cki-group">
                {g.label && <div className="cki-group-label">{g.label}</div>}
                <div className="cki-rows">
                  {g.rows.map((r) => (
                    <MetricRow
                      key={r.key}
                      row={r}
                      date={form.date}
                      value={values[r.key] ?? ""}
                      problem={problem(r)}
                      filled={isFilled(r)}
                      inputRef={(el) => (inputs.current[r.key] = el)}
                      onChange={(v) => setValues((prev) => ({ ...prev, [r.key]: v }))}
                      onNext={() => focusNextEmpty(r.key)}
                    />
                  ))}
                </div>
              </div>
            ))}
            {rows.some(inBlock) && (
              <AutoBlock
                rows={rows.filter(inBlock)}
                values={values}
                waiting={stepsWait}
                field={(r) => {
                  const whole = isWholeMetric(r.metric);
                  const bad = problem(r);
                  return (
                    <label className={`cki-auto-fig cki-auto-in${bad ? " bad" : ""}${isFilled(r) ? " filled" : ""}`}>
                      <input
                        ref={(el) => {
                          inputs.current[r.key] = el;
                        }}
                        type="text"
                        inputMode={whole ? "numeric" : "decimal"}
                        enterKeyHint="next"
                        autoComplete="off"
                        value={values[r.key] ?? ""}
                        onFocus={(e) => e.currentTarget.select()}
                        onChange={(e) => {
                          const v = cleanNumeric(e.target.value, whole);
                          setValues((prev) => ({ ...prev, [r.key]: v }));
                        }}
                        onKeyDown={(e) => {
                          if (e.key !== "Enter") return;
                          e.preventDefault();
                          focusNextEmpty(r.key);
                        }}
                        aria-label={`${r.metric.name}${r.metric.unit ? ` in ${r.metric.unit}` : ""}`}
                        aria-invalid={!!bad || undefined}
                      />
                      <span className="cki-unit">{r.metric.unit}</span>
                    </label>
                  );
                }}
              />
            )}
            <div className="cki-group">
              <div className="cki-group-label">Note for {coachName}</div>
              <label className={`cki-note-box${note.trim() ? " has" : ""}`}>
                <span className="cki-avatar" aria-hidden="true">
                  {/* eslint-disable-next-line @next/next/no-img-element -- an upload */}
                  {coach?.photoPath ? <img src={pic(coach.photoPath, 96)} alt="" /> : initial}
                </span>
                <textarea ref={noteBox} value={note} onChange={(e) => setNote(e.target.value)} placeholder={isToday ? "Anything worth knowing today? (optional)" : "Anything worth knowing about that day? (optional)"} maxLength={500} aria-label={`Note for ${coachName}`} />
              </label>
            </div>
          </div>

          <div className="cki-foot">
            {confirming ? (
              <div className="cki-confirm" role="alertdialog" aria-label="Discard changes?">
                <span className="cki-confirm-text">Discard changes?</span>
                <button type="button" className="keep" onClick={() => setConfirming(false)}>
                  Keep editing
                </button>
                <button type="button" className="discard" onClick={() => finish()}>
                  Discard
                </button>
              </div>
            ) : (
              <>
                <button type="button" className="cki-save" disabled={!canSave} onClick={() => void save()}>
                  {pending && <span className="cki-spin" aria-hidden="true" />}
                  <span>{pending ? "Saving…" : "Save"}</span>
                </button>
              </>
            )}
          </div>
        </div>
      </div>
      {toast && (
        <div className="cki-toast" role="status">
          {toast}
        </div>
      )}
    </>,
    document.body
  );
}

/**
 * "Apple Health not connected" and Connect (17 Nov, Alex: clients turn it on in Settings, and a check-in asking for steps,
 * weight, sleep or heart rate should say when it isn't). In the app alone, only while the phone isn't connected; the
 * AutoBlock's grey, one line. Connect does what Settings' switch does, the phone's own sheet then the first sync, and the
 * line goes; what the phone fills moves into the AutoBlock as the page reads again. A short fact in rust when it didn't go.
 */
function HealthOff({ onSynced }: { onSynced: (saved: boolean) => void }) {
  const connected = useHealthConnected();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  if (connected) return null;
  const store = nativePlatform() === "android" ? "Health Connect" : "Apple Health";
  const connect = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(null);
    try {
      const { note, result } = await connectHealth();
      if (note) setFailed(note);
      else onSynced(!!result?.saved);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="cki-auto cki-health-off" role="status">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        <path d="M12 20.3 4.6 13a4.6 4.6 0 0 1 6.5-6.5l.9.9.9-.9a4.6 4.6 0 0 1 6.5 6.5L12 20.3z" />
      </svg>
      <span className={`cki-health-off-words${failed ? " bad" : ""}`}>{failed ?? `${store} not connected`}</span>
      <button type="button" className="cki-health-off-go" onClick={() => void connect()} disabled={busy}>
        Connect
      </button>
    </div>
  );
}

// ---- One metric: the name and the last reading on the left; a number box
// on the right, or a scale bar underneath that fills as a gradient. The row
// tints and outlines in its group's colour once it is filled.
/**
 * The phone's figures, apart under the list (17 Nov, Alex: B3 of docs/boards/auto-metric-b-block-mockup.html): a soft
 * grey block "From Apple Health" with a small heart, read-only rows. The grey reaches past the form on both sides, so
 * inside it the heart and the names start where the form's names start, the figures end where the form's figures end
 * and the units sit in the form's unit column.
 */
function AutoBlock({ rows, values, waiting, field }: { rows: Row[]; values: Record<string, string>; /** Steps the phone hasn't counted yet: 0. */ waiting: (r: Row) => boolean; /** A metric the phone could fill and hasn't: typed here until it does. */ field: (r: Row) => React.ReactNode }) {
  const store = nativePlatform() === "android" ? "Health Connect" : "Apple Health";
  return (
    <div className="cki-auto" role="group" aria-label={`From ${store}`}>
      <div className="cki-auto-head">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
          <path d="M12 20.3 4.6 13a4.6 4.6 0 0 1 6.5-6.5l.9.9.9-.9a4.6 4.6 0 0 1 6.5 6.5L12 20.3z" />
        </svg>
        From {store}
        {/* Live (17 Nov, Alex: "a pulsating green dot… that it is an ongoing thing"): the phone keeps these filled. */}
        <span className="cki-live cki-auto-live" aria-label="Live">
          <i />
        </span>
      </div>
      {rows.map((r) => {
        const m = r.metric;
        const raw = (values[r.key] ?? m.value ?? "").trim();
        const n = Number(raw);
        const shown = raw && Number.isFinite(n) && isWholeMetric(m) ? Math.round(n).toLocaleString("en-GB") : raw;
        const unit = m.scaleMax ? `/${m.scaleMax}` : m.unit;
        return (
          <div key={r.key} className="cki-auto-row">
            <span className="cki-auto-name">{m.name}</span>
            {m.live || waiting(r) ? (
              <span className="cki-auto-fig">
                <b>{m.live ? shown : "0"}</b>
                <span className="cki-unit">{unit}</span>
              </span>
            ) : (
              field(r)
            )}
          </div>
        );
      })}
    </div>
  );
}

function MetricRow({ row, value, problem, filled, inputRef, onChange, onNext }: { row: Row; date: string; value: string; problem: string | null; filled: boolean; inputRef: (el: HTMLInputElement | null) => void; onChange: (v: string) => void; onNext: () => void }) {
  const m = row.metric;
  const c = colourOf();
  const whole = isWholeMetric(m);
  const last = lastLine(m);
  const placeholder = m.last ? (whole ? String(Math.round(m.last.value)) : String(m.last.value)) : "—";
  const unit = m.scaleMax ? "" : m.unit;
  const style = { "--c": c.hex, "--c-rgb": c.rgb } as React.CSSProperties;
  return (
    <div className={`cki-row${filled ? " filled" : ""}${m.live ? " live" : ""}`} style={style}>
      <div className="cki-row-top">
        <div className="cki-row-text">
          <span className="cki-row-name">{m.name}</span>
          {m.live ? (
            // Filled by the phone (16 Nov, Alex: A of docs/boards/auto-metric-mockup.html): live, nothing to type.
            <span className="cki-row-last cki-live">
              <i aria-hidden="true" />
              Live from {nativePlatform() === "android" ? "Health Connect" : "Apple Health"}
            </span>
          ) : (
            <span className="cki-row-last">{last}</span>
          )}
        </div>
        {m.live && !m.scaleMax && (
          <span className="cki-num cki-num-live" aria-label={`${m.name} ${value}${unit ? ` ${unit}` : ""}, from the phone`}>
            <svg className="cki-lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
              <rect x="5" y="11" width="14" height="9" rx="2" />
              <path d="M8 11V8a4 4 0 0 1 8 0v3" />
            </svg>
            <b>{Number.isFinite(Number(value)) && whole ? Number(value).toLocaleString("en-GB") : value}</b>
            <span className="cki-unit">{unit}</span>
          </span>
        )}
        {!m.live && !m.scaleMax && (
          <label className={`cki-num${problem ? " bad" : ""}`}>
            <input
              ref={inputRef}
              type="text"
              inputMode={whole ? "numeric" : "decimal"}
              enterKeyHint="next"
              autoComplete="off"
              // No grey figure in the field (17 Nov, Alex): last time is said once, under the name.
              value={value}
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => onChange(cleanNumeric(e.target.value, whole))}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                onNext();
              }}
              aria-label={`${m.name}${unit ? ` in ${unit}` : ""}${m.last ? `, last ${placeholder}` : ""}`}
              aria-invalid={!!problem || undefined}
            />
            <span className="cki-unit">{unit}</span>
          </label>
        )}
      </div>
      {m.scaleMax && <ScaleBar max={m.scaleMax} value={value} name={m.name} onChange={onChange} />}
      {problem && <span className="cki-error">{problem}</span>}
    </div>
  );
}

// The scale: a track with a button a value and a gradient fill up to the
// one picked. A tap picks (a second tap on the same clears); a finger
// drawn across it scrubs, a light buzz a step. Arrow keys move it.
function ScaleBar({ max, value, name, onChange }: { max: number; value: string; name: string; onChange: (v: string) => void }) {
  const n = Number(value) || 0;
  const track = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const lastN = useRef(n);
  const valueAt = (clientX: number) => {
    const el = track.current;
    if (!el) return n;
    const r = el.getBoundingClientRect();
    return Math.max(1, Math.min(max, Math.ceil(((clientX - r.left) / Math.max(1, r.width)) * max)));
  };
  const scrubTo = (clientX: number) => {
    const v = valueAt(clientX);
    if (v !== lastN.current) {
      lastN.current = v;
      buzz();
      onChange(String(v));
    }
  };
  return (
    <div
      ref={track}
      className="cki-scale"
      role="radiogroup"
      aria-label={name}
      onPointerDown={(e) => {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        dragging.current = false;
        lastN.current = n;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return;
        if (!dragging.current && e.buttons === 0) return;
        dragging.current = true;
        scrubTo(e.clientX);
      }}
      onPointerUp={(e) => {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
        if (dragging.current) {
          dragging.current = false;
          return;
        }
        // A tap: the value under the finger, or clear when it is the one already picked.
        const v = valueAt(e.clientX);
        onChange(v === n ? "" : String(v));
        buzz();
      }}
      onKeyDown={(e) => {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        e.preventDefault();
        onChange(String(Math.min(max, Math.max(1, n + (e.key === "ArrowRight" ? 1 : -1)))));
      }}
    >
      {n > 0 && <span className="cki-scale-fill" style={{ width: `${(n / max) * 100}%` }} aria-hidden="true" />}
      {Array.from({ length: max }, (_, i) => i + 1).map((v) => (
        <button key={v} type="button" role="radio" aria-checked={v === n} aria-label={`${v} of ${max}`} tabIndex={v === n || (n === 0 && v === 1) ? 0 : -1} className={v <= n ? "in" : ""}>
          {v}
        </button>
      ))}
    </div>
  );
}
