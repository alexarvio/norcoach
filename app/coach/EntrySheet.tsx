"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { createPortal } from "react-dom";
import { addCalendarEntryAction, updateCalendarEntryAction } from "../lib/actions";
import { TRAINING_ICON } from "../lib/eventTypes";
import { callLink, isClientCall, takesClient } from "../lib/calendarKinds";
import { dayMonth } from "../lib/dayMonth";
import { newOnceKey } from "../lib/onceKey";
import { MonthRange } from "../admin/redesign/MonthRange";
import { maskDate, typedDate } from "../admin/redesign/DateText";
import { paletteOf, type Category } from "../admin/redesign/palette";
import type { PhoneEntry } from "./calendar";
import { Avatar, Facts, Icon, Sheet } from "./parts";

// The Calendar's entry on the phone, added or changed (22 Oct): the laptop's
// entry pop-up (calendar/EntryDialog.tsx) for a thumb, written with the same
// actions, so it is on the laptop the moment it is saved. The same fields in
// the same order: the category as tiles, What, With, the day, timed or all
// day, the start and the end, the length, a note. The day, the times and the
// client are each picked on a page of the sheet of their own (the month is
// MonthRange, the admin's one calendar), so the sheet itself stays short.
// The sheet's voice (design rules 1): white, titles at 600, small grey
// uppercase labels, fields white with a hairline (ink while typing), the
// chosen choice ink, the category's colour on its icon, one ink pill.
// With is only for a Client call or Training (23 Oct, Alex; calendarKinds.ts):
// on any other category the row keeps its room unseen, and no client is saved.
// Link is a call's alone (25 Oct, Alex), the link the Meetings tab's Join opens: typed on a Client call, its room
// kept unseen on the rest as With's, and saved with the entry (none on any other category).
// 17 Nov, Alex (docs/boards/coach-entry-mockup.html B, coach-entry-title-mockup.html 2): Title with the client and
// the link as two square buttons on its row (each its own page of the sheet), one grey line under it once either is
// set; When the date typed or picked with All day as a switch beside it; the start and end as big light numerals, the
// length as the capsule under them, Other for an end of its own; All day folds the times away on the shared fold.

/** A preset category's icon, its placeholder and its usual length, as the laptop's pop-up has them. A coach's own category wears the tag. */
export const ENTRY_PRESET: Record<string, { icon: string; placeholder: string; length: number }> = {
  call: { icon: "M3 7h12v10H3zM15 10.5l6-3.5v10l-6-3.5", placeholder: "Week 1 check-in", length: 30 },
  training: { icon: TRAINING_ICON, placeholder: "Session with Mattia", length: 60 },
  admin: { icon: "M6 3h12v18H6zM9 8h6M9 12h6M9 16h4", placeholder: "Write programmes", length: 60 },
  personal: { icon: "M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z", placeholder: "Gym, lunch, school run", length: 60 },
  content: { icon: "M4 8h3.5l2-3h5l2 3H20v11H4zM12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z", placeholder: "Film the week's reels", length: 60 },
  other: { icon: "M5 12h.01M12 12h.01M19 12h.01", placeholder: "What is it?", length: 60 },
};
const TAG_ICON = "M20 12l-8 8-9-9V4h7l10 8zM7.5 7.5h.01";
export const entryIcon = (category: string | null | undefined) => (category && ENTRY_PRESET[category]?.icon) || TAG_ICON;
const LENGTHS = [15, 30, 45, 60];
// The laptop's key: the last category picked comes back first.
const LAST_CAT_KEY = "norcoach:cal-last-category";

export const toMin = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};
export const hhmm = (min: number) => `${String(Math.floor(min / 60) % 24).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
export const lengthLabel = (m: number) => (m < 60 ? `${m} min` : m % 60 ? `${Math.floor(m / 60)} h ${m % 60}` : `${m / 60} h`);
const isoOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
/** "Thu 22/10": the weekday before the day/month numerals (design rules 7). */
export const shortDay = (d: string) => `${new Date(`${d}T12:00:00`).toLocaleDateString("en-GB", { weekday: "short" })} ${dayMonth(d)}`;
const QUARTERS = Array.from({ length: 96 }, (_, i) => hhmm(i * 15));
function browserZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

export function CatIcon({ d, size = 18 }: { d: string; size?: number }) {
  return (
    <svg className="cph-ico" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export type EntryOpen = { entry: PhoneEntry | null; date: string; time: string };
type Client = { id: number; name: string; avatarPath: string | null };
type Page = "form" | "with" | "link" | "date" | "start" | "end";
/** The day as the field shows it while typing: dd/mm/yyyy (DateText's format). */
const typedShown = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
/** The day typed: a whole date, or dd/mm alone in the year that puts it nearest the day it held (05/01 typed over
 *  28/12/2026 is 05/01/2027, never almost a year back). */
const dayTyped = (raw: string, held: string): string | null => {
  const whole = typedDate(raw);
  if (whole) return whole;
  const r = /^\s*(\d{1,2})[/.\- ](\d{1,2})[/.\- ]?\s*$/.exec(raw);
  if (!r) return null;
  const y = Number(held.slice(0, 4));
  const at = new Date(`${held}T12:00:00`).getTime();
  const near = [y - 1, y, y + 1]
    .map((yy) => typedDate(`${r[1]}/${r[2]}/${yy}`))
    .filter((d): d is string => d != null)
    .sort((a, b) => Math.abs(new Date(`${a}T12:00:00`).getTime() - at) - Math.abs(new Date(`${b}T12:00:00`).getTime() - at));
  return near[0] ?? null;
};
/** A link's site alone, never the URL (25 Oct, Alex): meet.google.com. */
const linkHost = (url: string | null) => {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
};
const PERSON_ICON = "M12 12a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM5 19.5c1.2-3.3 3.8-5 7-5s5.8 1.7 7 5";

export default function EntrySheet({
  open,
  categories,
  clients,
  dayEntries,
  onClose,
  onSaved,
}: {
  open: EntryOpen;
  categories: Category[];
  clients: Client[];
  /** What else is on the day it opened on, for the overlap line. */
  dayEntries: PhoneEntry[];
  onClose: () => void;
  /** Saved: the day it is on now, and the day it was on. */
  onSaved: (date: string, was: string) => void;
}) {
  const e = open.entry;
  const [cat, setCat] = useState<string>(() => {
    if (e?.category) return e.category;
    // An entry with none keeps the colour it wears: a client's call blue, the coach's own grey.
    if (e) return e.clientId != null ? "call" : "other";
    try {
      const last = window.localStorage.getItem(LAST_CAT_KEY);
      if (last && categories.some((c) => c.id === last)) return last;
    } catch {}
    return "call";
  });
  const [topic, setTopic] = useState(e?.topic ?? "");
  const [date, setDate] = useState(open.date);
  const [allDay, setAllDay] = useState(e?.allDay ?? false);
  const [time, setTime] = useState(e?.time || open.time || "09:00");
  const [length, setLength] = useState<number>(e?.durationMinutes ?? ENTRY_PRESET[cat]?.length ?? 60);
  const [customLength, setCustomLength] = useState(e ? !LENGTHS.includes(e.durationMinutes) : false);
  const [clientId, setClientId] = useState<number | null>(e?.clientId ?? null);
  const [note, setNote] = useState(e?.note ?? "");
  const [link, setLink] = useState(e?.link ?? "");
  const [page, setPage] = useState<Page>("form");
  // The time list (17 Nov, Alex: "most apps just have a drop down… a column of all the times"): which time it drops for,
  // and where, under the numeral tapped (above it when there is no room below).
  const [drop, setDrop] = useState<{ which: "start" | "end"; top: number; left: number } | null>(null);
  const dropList = useRef<HTMLDivElement>(null);
  const openDrop = (which: "start" | "end", el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const W = 150;
    const H = 6 * 40 + 10;
    const below = r.bottom + 6 + H < window.innerHeight - 16;
    setDrop({ which, top: below ? r.bottom + 6 : Math.max(16, r.top - 6 - H), left: which === "start" ? r.left : Math.max(16, r.right - W) });
  };
  useLayoutEffect(() => {
    // Open on the time picked, in the middle of the list.
    const on = dropList.current?.querySelector<HTMLElement>(".on");
    if (on && dropList.current) dropList.current.scrollTop = on.offsetTop - dropList.current.clientHeight / 2 + on.clientHeight / 2;
  }, [drop]);
  // The date being typed (DateText's way: digits, the slashes filling in); null shows the day it holds.
  const [dateTyping, setDateTyping] = useState<string | null>(null);
  // A date typed that can't be read, left on the field: it stays on screen in rust and holds Add back, so the entry
  // never saves on the old day without a word.
  const [dateUnread, setDateUnread] = useState(false);
  const [q, setQ] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [today] = useState(() => isoOf(new Date()));
  const [cursor, setCursor] = useState(open.date.slice(0, 7));

  const current = categories.find((c) => c.id === cat) ?? categories[0];
  // Only a Client call or Training is with a client.
  const withClient = takesClient(cat);
  const client = withClient && clientId != null ? clients.find((c) => c.id === clientId) ?? null : null;
  const first = (name: string) => name.split(" ")[0];
  const endMin = toMin(time) + length;
  // Only a Client call has a link; one typed that isn't a link yet holds Save back, as the laptop's link pop-up.
  const withLink = isClientCall(cat);
  // One height whatever the category (25 Oct, Alex: "the toggle for the categories is always in the same place"): the
  // form is measured once with every row in, before it is painted, and keeps that height; a category with fewer rows
  // leaves the room under the note, Cancel and Add staying at the foot. The tiles never move.
  const form = useRef<HTMLDivElement>(null);
  const [measuring, setMeasuring] = useState(true);
  const [fullH, setFullH] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!measuring || !form.current) return;
    setFullH(form.current.scrollHeight);
    setMeasuring(false);
  }, [measuring]);
  // The times' fold is drawn as it was left (design rules 7): no easing while it is measured open and set back, only
  // a tap on All day eases it. Two frames, so the closed fold is painted before its transition comes back.
  const [still, setStill] = useState(true);
  useEffect(() => {
    if (measuring) return;
    let b = 0;
    const a = requestAnimationFrame(() => (b = requestAnimationFrame(() => setStill(false))));
    return () => (cancelAnimationFrame(a), cancelAnimationFrame(b));
  }, [measuring]);
  const linkBad = withLink && !!link.trim() && callLink(link) == null;
  const ok = !!date && (allDay || !!time) && !linkBad && !dateUnread;
  // A client picked with no title yet: the laptop's suggestion, kept when nothing is typed.
  // Words alone, as the laptop's (16 Nov, Alex: the audit): `Call with Anna`, `Training with Anna`.
  const suggested = client && !topic.trim() ? `${!current || isClientCall(current.id) ? "Call" : current.label} with ${first(client.name)}` : null;
  const title = topic.trim() || suggested || "";
  const host = withLink ? linkHost(callLink(link)) : null;
  // The one grey line under the title's row, once a client or a link is set: `With Alex Arvio | meet.google.com`.
  const setLine = [client ? `With ${client.name}` : null, host, linkBad ? <span className="cph-ent-bad">Not a link yet</span> : null];
  const hasSetLine = setLine.some(Boolean);
  const dateComplete = dateTyping != null && dateTyping.replace(/\D/g, "").length >= 8;
  const dateBad = dateUnread || (dateComplete && typedDate(dateTyping) == null);

  // Overlaps with the day's other entries, as a warning only (the laptop's line).
  const overlap = useMemo(() => {
    if (allDay || date !== open.date) return null;
    const s = toMin(time);
    const hit = dayEntries.find((x) => !x.allDay && x.id !== e?.id && x.time && toMin(x.time) < s + length && toMin(x.time) + x.durationMinutes > s);
    return hit ? `Overlaps “${hit.topic || hit.clientName || "an entry"}” ${hit.time}–${hhmm(toMin(hit.time) + hit.durationMinutes)}` : null;
  }, [allDay, date, open.date, time, length, dayEntries, e?.id]);

  const pickCat = (id: string) => {
    setCat(id);
    // The client picked stays in hand (a tile tapped by mistake and back loses nothing); save sends it only with With.
    if (!e && !customLength) setLength(ENTRY_PRESET[id]?.length ?? 60);
    try {
      window.localStorage.setItem(LAST_CAT_KEY, id);
    } catch {}
  };
  const failedAdd = useRef<{ what: string; key: string } | null>(null);
  const save = async () => {
    if (!ok || !title || saving) return;
    // A date still being typed that can't be read never saves on the old day.
    if (dateTyping != null && dateTyping.trim() && dayTyped(dateTyping, date) == null) return void setDateUnread(true);
    setSaving(true);
    setError(null);
    // The time is in this phone's timezone, as every time on the Calendar reads.
    const v = { date, time: allDay ? "" : time, tz: allDay ? null : browserZone(), durationMinutes: length, allDay, topic: title, clientId: withClient ? clientId : null, category: cat, note: note.trim(), link: withLink ? callLink(link) : null };
    // A new entry's one-time key (6 Nov), made with the tap; the same entry saved again after "Not saved. Try again."
    // goes with the failed one's key, so one that in fact landed is not added twice.
    const what = JSON.stringify(v);
    const onceKey = failedAdd.current?.what === what ? failedAdd.current.key : newOnceKey();
    try {
      if (e) await updateCalendarEntryAction(e.id, v);
      else if ((await addCalendarEntryAction(v, onceKey)) == null) throw new Error("not saved");
      failedAdd.current = null;
      onSaved(date, open.date);
    } catch {
      if (!e) failedAdd.current = { what, key: onceKey };
      setError("Not saved. Try again.");
      setSaving(false);
    }
  };

  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    return clients.filter((c) => !n || c.name.toLowerCase().includes(n));
  }, [clients, q]);

  // A list of times opens on the one picked, in the middle.
  const pickedTime = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (page === "start" || page === "end") pickedTime.current?.scrollIntoView({ block: "center" });
  }, [page]);

  const back = (
    <button type="button" className="cph-icon-btn" onClick={() => setPage("form")} aria-label="Back">
      <Icon name="back" />
    </button>
  );

  if (page === "with" && withClient)
    return (
      <Sheet onClose={onClose} label="With" className="tall">
        <div className="cph-ent-sub">
          {back}
          <h2>With</h2>
        </div>
        <label className="cph-search">
          <Icon name="search" />
          <input type="search" value={q} onChange={(x) => setQ(x.target.value)} placeholder="Search clients" aria-label="Search clients" enterKeyHint="search" />
        </label>
        <div className="cph-ent-scroll" role="listbox" aria-label="Clients">
          <button type="button" role="option" aria-selected={clientId == null} className="cph-ent-who" onClick={() => (setClientId(null), setPage("form"))}>
            <span className="cph-av cph-ent-none" style={{ width: 32, height: 32 }} aria-hidden="true">
              –
            </span>
            <b>Just you</b>
            {clientId == null && <Icon name="check" small />}
          </button>
          {shown.map((c) => (
            <button key={c.id} type="button" role="option" aria-selected={c.id === clientId} className="cph-ent-who" onClick={() => (setClientId(c.id), setQ(""), setPage("form"))}>
              <Avatar name={c.name} src={c.avatarPath} size={32} />
              <b>{c.name}</b>
              {c.id === clientId && <Icon name="check" small />}
            </button>
          ))}
          {shown.length === 0 && <p className="cph-empty">No match</p>}
        </div>
      </Sheet>
    );

  // The link, pasted on a page of its own (17 Nov, Alex: the chain on the title's row); one not a link yet says so on
  // its label's line and rings the box rust, and Done waits for a real one (or none).
  if (page === "link" && withLink)
    return (
      <Sheet onClose={onClose} label="Link">
        <div className="cph-ent-sub">
          {back}
          <h2>Link</h2>
        </div>
        <div className="cph-ent-page">
          <label className="cph-ent-label cph-ent-labelrow" htmlFor="cph-ent-link">
            Link
            {linkBad && <span className="cph-ent-bad">Not a link yet</span>}
          </label>
          <input
            id="cph-ent-link"
            className="cph-ent-box"
            type="url"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
            value={link}
            onChange={(x) => setLink(x.target.value)}
            onKeyDown={(x) => x.key === "Enter" && !linkBad && setPage("form")}
            placeholder="https://meet.google.com/abc-defg-hij"
            maxLength={500}
            enterKeyHint="done"
            aria-invalid={linkBad || undefined}
          />
          <div className="cph-ent-foot">
            {link.trim() && (
              <button type="button" className="cph-text-btn" onClick={() => setLink("")}>
                Clear
              </button>
            )}
            <button type="button" className="cph-pill ink small" disabled={linkBad} onClick={() => setPage("form")}>
              Done
            </button>
          </div>
        </div>
      </Sheet>
    );

  if (page === "date")
    return (
      <Sheet onClose={onClose} label="Date">
        <div className="cph-ent-sub">
          {back}
          <h2>Date</h2>
        </div>
        <div className="cph-ent-month">
          <MonthRange
            from={date}
            to={date}
            onPick={(d) => {
              setDate(d);
              setDateTyping(null);
              setDateUnread(false);
              setCursor(d.slice(0, 7));
              setPage("form");
            }}
            planned={[]}
            cursor={cursor}
            setCursor={setCursor}
            today={today}
            plain
            legend={null}
          />
        </div>
      </Sheet>
    );

  if (page === "start" || page === "end") {
    const isEnd = page === "end";
    // The ends run to midnight (24:00, read 00:00), so a late start always has one to pick and the page is never empty.
    const list = isEnd ? [...QUARTERS.map(toMin), 24 * 60].filter((m) => m > toMin(time)) : QUARTERS.map(toMin);
    const on = isEnd ? endMin : toMin(time);
    return (
      <Sheet onClose={onClose} label={isEnd ? "Ends" : "Starts"} className="tall">
        <div className="cph-ent-sub">
          {back}
          <h2>{isEnd ? "Ends" : "Starts"}</h2>
        </div>
        <div className="cph-ent-scroll cph-ent-times">
          {list.map((m) => (
            <button
              key={m}
              ref={m === on ? pickedTime : undefined}
              type="button"
              className={`cph-ent-time${m === on ? " on" : ""}`}
              aria-pressed={m === on}
              onClick={() => {
                if (isEnd) {
                  // An end of its own is Other, unless it lands on one of the lengths.
                  const l = m - toMin(time);
                  setLength(l);
                  setCustomLength(!LENGTHS.includes(l));
                } else setTime(hhmm(m));
                setPage("form");
              }}
            >
              {hhmm(m)}
            </button>
          ))}
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet onClose={onClose} label={e ? "Edit entry" : "New entry"} className="tall">
      <div className="cph-ent" ref={form} style={fullH ? ({ "--ent-h": `${fullH}px` } as React.CSSProperties) : undefined}>
        <h2 className="cph-ent-title">{e ? "Edit entry" : "New entry"}</h2>

        <span className="cph-ent-label">Category</span>
        <div className="cph-ent-tiles" role="radiogroup" aria-label="Category">
          {categories.map((c) => {
            const picked = c.id === cat;
            return (
              <button key={c.id} type="button" role="radio" aria-checked={picked} className={`cph-ent-tile${picked ? " on" : ""}`} style={{ "--tc": paletteOf(c.color).ink } as React.CSSProperties} onClick={() => pickCat(c.id)}>
                <CatIcon d={entryIcon(c.id)} />
                <span>{c.label}</span>
              </button>
            );
          })}
        </div>

        <label className="cph-ent-label" htmlFor="cph-ent-what">
          Title
        </label>
        {/* Title with the client and the link as square buttons on its row (17 Nov, Alex: option 2 of
            docs/boards/coach-entry-title-mockup.html). The client only on a Client call or Training (23 Oct, Alex), the
            link only on a Client call (25 Oct, Alex); a square not offered goes and the title takes its room. */}
        <div className="cph-ent-titlerow">
          <input id="cph-ent-what" className="cph-ent-box" value={topic} onChange={(x) => setTopic(x.target.value)} placeholder={suggested ?? ENTRY_PRESET[cat]?.placeholder ?? "What is it?"} maxLength={80} enterKeyHint="done" />
          {withClient && (
            <button type="button" className={`cph-ent-box cph-ent-sq${client ? " set" : ""}`} onClick={() => setPage("with")} aria-label={client ? `With ${client.name}` : "Pick a client"}>
              {client ? <Avatar name={client.name} src={client.avatarPath} size={26} /> : <CatIcon d={PERSON_ICON} />}
            </button>
          )}
          {withLink && (
            <button type="button" className={`cph-ent-box cph-ent-sq${host ? " set" : ""}`} onClick={() => setPage("link")} aria-label={linkBad ? "Link, not a link yet" : host ? `Link, ${host}` : "Add a link"} data-bad={linkBad || undefined}>
              <Icon name="link" size={18} />
            </button>
          )}
        </div>
        {/* Only once set; its room kept while the sheet is measured, so it never makes the sheet grow. */}
        {(hasSetLine || measuring) && (
          <p className="cph-ent-setline">
            <Facts parts={setLine} />
            {!hasSetLine && " "}
          </p>
        )}

        {/* When (17 Nov, Alex: B of docs/boards/coach-entry-mockup.html): the date typed or picked, the calendar on its
            icon (DatePick's way), and All day as a switch beside it, no Timed | All day. */}
        <span className="cph-ent-label">When</span>
        <div className="cph-ent-whenrow">
          <div className={`cph-ent-box cph-ent-date${dateBad ? " bad" : ""}`}>
            <button type="button" className="cph-ent-cal" onClick={() => setPage("date")} aria-label="Pick the date">
              <Icon name="calendar" size={18} />
            </button>
            <input
              value={dateTyping ?? shortDay(date)}
              inputMode="numeric"
              placeholder="dd/mm/yyyy"
              aria-label="Date"
              aria-invalid={dateBad || undefined}
              enterKeyHint="done"
              onFocus={(x) => {
                const el = x.currentTarget;
                // A date left unread comes back as it was typed, to fix; else the day it holds.
                if (!dateUnread) setDateTyping(typedShown(date));
                requestAnimationFrame(() => el.select());
              }}
              onChange={(x) => {
                const next = maskDate(x.target.value, dateTyping ?? "");
                setDateTyping(next);
                const d = typedDate(next);
                if (d) {
                  setDate(d);
                  setCursor(d.slice(0, 7));
                  setDateUnread(false);
                }
              }}
              onBlur={() => {
                const typed = dateTyping?.trim() ?? "";
                const d = typed ? dayTyped(typed, date) : null;
                if (d) {
                  setDate(d);
                  setCursor(d.slice(0, 7));
                }
                // Read, or emptied: the day it holds shows again. Typed and not a day: it stays, in rust, holding Add.
                setDateUnread(!!typed && !d);
                if (d || !typed) setDateTyping(null);
              }}
              onKeyDown={(x) => x.key === "Enter" && x.currentTarget.blur()}
            />
          </div>
          <button type="button" role="switch" aria-checked={allDay} className="cph-ent-allday" onClick={() => setAllDay((v) => !v)}>
            All day
            <span className={`cph-switch${allDay ? " on" : ""}`} aria-hidden="true">
              <i />
            </span>
          </button>
        </div>

        {/* The times, big: the start and end as light numerals, a tap on either picks it; the lengths as the capsule
            under them, Other for an end of its own. All day folds them away on the shared fold (open while measured). */}
        <div className={`so-fold cph-ent-timefold${!allDay || measuring ? " open" : ""}${still ? " still" : ""}`} aria-hidden={allDay && !measuring ? true : undefined} inert={allDay && !measuring}>
          <div className="so-fold-in">
            <div className="cph-ent-range">
              <button type="button" className="cph-ent-end" onClick={(e) => openDrop("start", e.currentTarget)} aria-label={`Starts, ${time}`} aria-expanded={drop?.which === "start"}>
                <small>Starts</small>
                <b>{time}</b>
              </button>
              <span className="cph-ent-arrow" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              </span>
              <button type="button" className="cph-ent-end right" onClick={(e) => openDrop("end", e.currentTarget)} aria-label={`Ends, ${hhmm(endMin)}`} aria-expanded={drop?.which === "end"}>
                <small>Ends</small>
                <b>{hhmm(endMin)}</b>
              </button>
            </div>
            <div className="cph-seg" role="radiogroup" aria-label="Length">
              {LENGTHS.map((m) => {
                const on = !customLength && length === m;
                return (
                  <button key={m} type="button" role="radio" aria-checked={on} className={on ? "on" : ""} onClick={() => (setLength(m), setCustomLength(false))}>
                    {lengthLabel(m)}
                  </button>
                );
              })}
              <button type="button" role="radio" aria-checked={customLength} className={customLength ? "on" : ""} onClick={() => { const end = document.querySelector<HTMLElement>(".cph-ent-end.right"); if (end) openDrop("end", end); }}>
                Other
              </button>
            </div>
            {/* Always a line, so an overlap appearing never moves the sheet. */}
            <small className="cph-ent-overlap">{overlap ?? " "}</small>
            {/* In the page itself, never inside the sheet (a sliding sheet would carry a fixed list with it). */}
            {drop &&
              createPortal(
              <>
                <button type="button" className="cph-ent-dropscrim" aria-label="Close the times" onClick={() => setDrop(null)} />
                <div ref={dropList} className="cph-ent-drop" role="listbox" aria-label={drop.which === "end" ? "Ends" : "Starts"} style={{ top: drop.top, left: drop.left }}>
                  {(drop.which === "end" ? [...QUARTERS.map(toMin), 24 * 60].filter((m) => m > toMin(time)) : QUARTERS.map(toMin)).map((m) => {
                    const on = m === (drop.which === "end" ? endMin : toMin(time));
                    return (
                      <button
                        key={m}
                        type="button"
                        role="option"
                        aria-selected={on}
                        className={on ? "on" : ""}
                        onClick={() => {
                          if (drop.which === "end") {
                            // An end of its own is Other, unless it lands on one of the lengths.
                            const l = m - toMin(time);
                            setLength(l);
                            setCustomLength(!LENGTHS.includes(l));
                          } else setTime(hhmm(m));
                          setDrop(null);
                        }}
                      >
                        {hhmm(m)}
                      </button>
                    );
                  })}
                </div>
              </>,
              document.body
            )}
          </div>
        </div>

        <label className="cph-ent-label" htmlFor="cph-ent-note">
          Note
        </label>
        {/* A note with Save right under it: no box and no line (design rules 6). */}
        <textarea id="cph-ent-note" className="cph-ent-note" value={note} onChange={(x) => setNote(x.target.value)} placeholder="What to bring up, what to prepare…" maxLength={2000} rows={2} />

        {error && (
          <p className="cph-error" role="alert">
            {error}
          </p>
        )}
        <div className="cph-ent-foot">
          <button type="button" className="cph-text-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="cph-pill ink small" disabled={!ok || !title || saving} onClick={() => void save()}>
            {e ? "Save" : "Add"}
          </button>
        </div>
      </div>
    </Sheet>
  );
}
