"use client";

import { useMemo } from "react";
import { saveCoachNotifyAction, saveCoachPreferencesAction } from "../../../lib/actions";
import type { CoachNotify } from "../../../lib/db";
import { ArrowRightIcon } from "../../../components/icons";
import Picker from "../Picker";
import { RowFold } from "../RowFold";
import { SepJoin } from "../Sep";
import { useSaveSlot } from "./SaveHost";
import { useDraft } from "./SettingsForms";
import { Capsule, Part, Row, Switch, Two } from "./Rows";
import "./more.css";

// Settings' Preferences and Data & privacy's export (27 Oct, Alex: mockup B; in the one system since 23 Nov, Alex:
// docs/boards/settings-harmony-mockup.html). Preferences: Weights and Time zone side by side, a row each with its
// control on the right; then what reaches the coach's phone and quiet hours side by side, the hours a row of their own
// under the switch on the shared fold, shown while it is on (Notifications joined Preferences, 23 Nov). Each saves on
// the page's one bar, as the others do. Your data has nothing to save, only its download: one row, Export the white pill.
// No sample text in a field (23 Nov, Alex): the hours are empty until typed, unless quiet hours already run on the
// server's own 22:00 to 07:00.

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A time as typed, read the way TimePick reads it: 930 → 09:30, 2200 → 22:00, 9 → 09:00; as typed when it won't read. */
function tidyTime(s: string): string {
  const t = s.trim();
  if (!t || HHMM.test(t)) return t;
  const m = /^(\d{1,2})(?::?(\d{2}))?$/.exec(t);
  if (!m) return t;
  const h = Number(m[1]);
  const min = m[2] == null ? 0 : Number(m[2]);
  if (h > 23 || min > 59) return t;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

// ---- Notifications (a part of Preferences: #notifications lands on it)
export function NotificationsSettings({ initial, timezone }: { initial: CoachNotify; /** Quiet hours' zone, the fact on its label (the coach's time zone). */ timezone?: string }) {
  // Quiet hours on with no times of their own run 22:00 to 07:00 (coachPush.ts): those, as they are in force.
  const on = !!initial.quiet;
  const start = { chat: initial.chat !== false, video: initial.video !== false, quiet: on, quietFrom: initial.quietFrom ?? (on ? "22:00" : ""), quietTo: initial.quietTo ?? (on ? "07:00" : "") };
  // An empty time is never saved as one: the server keeps its own until two are typed.
  const d = useDraft(start, (v) => saveCoachNotifyAction({ chat: v.chat, video: v.video, quiet: v.quiet, quietFrom: v.quietFrom || undefined, quietTo: v.quietTo || undefined }));
  const timesBad = d.v.quiet && (!HHMM.test(d.v.quietFrom) || !HHMM.test(d.v.quietTo));
  useSaveSlot("notifications", { dirty: d.dirty, count: d.count, blocked: timesBad, problem: timesBad ? "Quiet hours in Preferences need a start and an end" : null, save: d.commit, cancel: d.discard });
  const toggle = (key: "chat" | "video", name: string) => (
    <Row name={name}>
      <Switch on={d.v[key]} label={name} onChange={(v) => d.set(key, v)} />
    </Row>
  );
  const time = (key: "quietFrom" | "quietTo", label: string) => (
    <input
      className="rsr-tbox"
      inputMode="numeric"
      maxLength={5}
      value={d.v[key]}
      onChange={(e) => d.set(key, e.target.value.replace(/[^\d:]/g, ""))}
      onBlur={(e) => d.set(key, tidyTime(e.target.value))}
      aria-label={label}
      aria-invalid={d.v[key] !== "" && !HHMM.test(d.v[key])}
    />
  );
  return (
    <Two top>
      <Part label="To your phone">
        {toggle("chat", "Messages from clients")}
        {toggle("video", "Videos to review")}
      </Part>
      <Part label="Quiet hours" fact={timezone}>
        <Row name="Hold notifications">
          <Switch on={d.v.quiet} label="Quiet hours" onChange={(v) => d.set("quiet", v)} />
        </Row>
        <RowFold open={d.v.quiet}>
          <Row name="Hours" className="rsm-lined">
            {time("quietFrom", "From")}
            <span className="rsr-arrow" aria-hidden="true">
              <ArrowRightIcon />
            </span>
            {time("quietTo", "To")}
          </Row>
        </RowFold>
      </Part>
    </Two>
  );
}

/** The time zones offered (23 Nov, Alex: "reduce the amount of options… just have a couple examples with the initials of
 *  the timezone and the + or -"): one a zone coaches are in, by its initials, standard and summer, and its offset now. */
const ZONES: { value: string; std: string; dst?: string }[] = [
  { value: "Pacific/Honolulu", std: "HST" },
  { value: "America/Anchorage", std: "AKST", dst: "AKDT" },
  { value: "America/Los_Angeles", std: "PST", dst: "PDT" },
  { value: "America/Denver", std: "MST", dst: "MDT" },
  { value: "America/Chicago", std: "CST", dst: "CDT" },
  { value: "America/New_York", std: "EST", dst: "EDT" },
  { value: "America/Sao_Paulo", std: "BRT" },
  { value: "Europe/London", std: "GMT", dst: "BST" },
  { value: "Europe/Amsterdam", std: "CET", dst: "CEST" },
  { value: "Europe/Athens", std: "EET", dst: "EEST" },
  { value: "Asia/Dubai", std: "GST" },
  { value: "Asia/Kolkata", std: "IST" },
  { value: "Asia/Bangkok", std: "ICT" },
  { value: "Asia/Singapore", std: "SGT" },
  { value: "Asia/Tokyo", std: "JST" },
  { value: "Australia/Sydney", std: "AEST", dst: "AEDT" },
  { value: "Pacific/Auckland", std: "NZST", dst: "NZDT" },
];

/** Minutes ahead of GMT for a zone at a moment; null when the browser can't say. */
function minutesAhead(zone: string, at: Date): number | null {
  const o = offsetOf(zone, at);
  const m = /^GMT(?:([+-])(\d{1,2})(?::(\d{2}))?)?$/.exec(o);
  if (!m) return null;
  return m[1] ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0;
}

/** A zone's initials now: its summer ones while its clocks are ahead of January's and July's lesser offset. */
function initialsOf(z: { value: string; std: string; dst?: string }): string {
  if (!z.dst) return z.std;
  const year = new Date().getFullYear();
  const now = minutesAhead(z.value, new Date());
  const jan = minutesAhead(z.value, new Date(year, 0, 1));
  const jul = minutesAhead(z.value, new Date(year, 6, 1));
  if (now == null || jan == null || jul == null) return z.std;
  return now > Math.min(jan, jul) ? z.dst : z.std;
}

/** "GMT+1" for a zone now; "" when the browser can't say. */
function offsetOf(zone: string, at: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: zone, timeZoneName: "shortOffset" }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}

// ---- Preferences
export function PreferencesSettings({ units, timezone }: { units: "kg" | "lbs"; timezone: string }) {
  const d = useDraft({ units, timezone }, (v) => saveCoachPreferencesAction(v));
  useSaveSlot("preferences", { dirty: d.dirty, count: d.count, save: d.commit, cancel: d.discard });
  // A short list, west to east: the initials, and the offset grey on the right. The coach's own zone, when it is none of
  // them (set from the computer at sign-up), first, by its city.
  const zones = useMemo(() => {
    const list = ZONES.map((z) => ({ value: z.value, label: initialsOf(z), hint: offsetOf(z.value) || undefined }));
    if (ZONES.some((z) => z.value === timezone)) return list;
    const city = timezone.split("/").pop()?.replace(/_/g, " ") ?? timezone;
    return [{ value: timezone, label: city, hint: offsetOf(timezone) || undefined }, ...list];
  }, [timezone]);
  const city = d.v.timezone.split("/").pop()?.replace(/_/g, " ") ?? d.v.timezone;
  return (
    <Two top>
      <Part label="Weights">
        <Row name="Show weights in" fact="Training opens in it">
          <Capsule
            value={d.v.units}
            options={[
              { value: "kg", label: "kg" },
              { value: "lbs", label: "lbs" },
            ]}
            onChange={(u) => d.set("units", u)}
            label="Show weights in"
          />
        </Row>
      </Part>
      <Part label="Time zone">
        <Row name="Your time zone" fact={<SepJoin parts={[city, offsetOf(d.v.timezone)]} />}>
          <Picker value={d.v.timezone} onChange={(v) => d.set("timezone", v)} label="Time zone" className="rsr-pick" options={zones} align="end" />
        </Row>
      </Part>
    </Two>
  );
}

// ---- Your data (a part of Data & privacy: #data lands on it)
export function DataSettings({ clients }: { clients: number }) {
  return (
    <Part label="Export">
      <Row name="Everything" fact={<SepJoin parts={[`${clients} ${clients === 1 ? "client" : "clients"}`, "programmes, logs, check-ins, food, calls, invoices", "one file"]} />}>
        <a className="rsr-pill" href="/api/export" download>
          Export
        </a>
      </Row>
    </Part>
  );
}
