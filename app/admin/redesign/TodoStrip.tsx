"use client";

import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useTransition, type CSSProperties, type ReactNode, type RefObject } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CameraIcon, ChatIcon, CheckIcon } from "../../components/icons";
import { backToTargetsAction, dismissHomeActionAction, markSeenAction, setTargetsToAction } from "../../lib/actions";
import { newOnceKey } from "../../lib/onceKey";
import { displayToKg, kgToDisplay } from "../../lib/units";
import { Dialog } from "../../components/ui/dialog";
import { ConfirmDialog } from "./training/TrainingDraft";
import { SepJoin } from "./Sep";
import { RowFold } from "./RowFold";
import { logDate } from "../../lib/dayMonth";
import { NEED_LOOK } from "./NeedGroups";
import { PopupTabZone } from "./PopupWho";
import { TRACK_ACCENT } from "../phaseChrome";
import { landOnSoon } from "../../lib/landOn";
import { usePopoverClose, usePopoverPlace } from "./usePopover";
import { useOpenChat } from "./ChatPanel";
import type { DotTab, TodoItem } from "./dots";
import "./todo-panel.css";

// The client's To do (24 Nov, Alex: "instead of having all these rows here… a button somewhere, and then we can expand…
// it's a bit too much"; "Build B", B of docs/boards/todo-button-mockup.html). Was a rust strip on top of each tab (2 Nov,
// Alex: mockup A of docs/boards/needs-strip-mockup.html). One rust pill at the end of the client's tabs with the count
// of everything owed on them (TodoButton), opening a pop-over right under it, its nub on the pill (TodoPanel; 25 Nov,
// Alex: docs/boards/todo-popover-mockup.html; was a panel from the window's right as the chat's): the rows by tab in the
// tracks' order, every row shown (25 Nov; was three a group, then `N more`), on one grid down the list so every chat
// and every action line up (25 Nov, Alex: "the icons for the chat… are not aligned. It's not insanely clean"); a row
// its name (a tap opens the thing on its tab, landed on and lit), its facts grey with the drawn bar and what happened
// in rust, its action as its words, the round check on hover. A target not reached opens on its sessions and ends on
// your own weight and a note to the client (25 Nov, Alex: "so it is delivered to the chat and the client is aware that
// the coach is on top of them"). The rows come from the dot trail (loadDots, dots.ts) through RedesignShell; what a
// tab does in place (Meetings' Mark completed and Book, Plan's New phase, Training's Back to) it hands the panel
// (useTodoHandlers). Styles: todo-panel.css.

/** What a tab does for a row on its own screen, handed to the panel (useTodoHandlers). Each says whether it did it. */
export type TodoHandlers = {
  /** The row's action in place (a dialog of the tab's, Back to through its save status). */
  act?: (item: TodoItem) => boolean;
  /** Opening the row's thing on the tab (Training's session on the week showing, another week coming first). */
  go?: (item: TodoItem) => boolean;
  /** The unit the tab shows weights in (Training's KG | LBS), for a target's figures. */
  unit?: () => "kg" | "lbs";
  /** What the tab still has waiting for the row's sessions sent first (Training's queue), so a figure the To do puts
   *  there itself (your own weight, 25 Nov) lands on what is saved and nothing older is written over it after. */
  settle?: (item: TodoItem) => Promise<void>;
};

export const TodoContext = createContext<{ clientId: number; items: TodoItem[]; register: (tab: DotTab, h: TodoHandlers) => () => void }>({ clientId: 0, items: [], register: () => () => {} });

/** A tab hands the panel what it does in place, for as long as it is drawn. Every tab a row can be on calls it, with
 *  nothing to hand or not, so the panel knows the tab is there (an action asked of a tab not drawn yet waits for it). */
export function useTodoHandlers(tab: DotTab, h: TodoHandlers = {}) {
  const { register } = useContext(TodoContext);
  const latest = useRef(h);
  useEffect(() => {
    latest.current = h;
  });
  useEffect(
    () =>
      register(tab, {
        act: (i) => latest.current.act?.(i) ?? false,
        go: (i) => latest.current.go?.(i) ?? false,
        unit: () => latest.current.unit?.() ?? "kg",
        settle: (i) => latest.current.settle?.(i) ?? Promise.resolve(),
      }),
    [register, tab]
  );
}

/** To a # on the tab showing: the tab's own listener (#session-…, #day-…, #call-…) opens the thing, then it is landed on. */
export function goToHash(hash: string) {
  const here = window.location;
  window.history.replaceState(null, "", `${here.pathname}${here.search}${hash}`);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  landOnSoon(() => document.getElementById(hash.slice(1)), "center", 240);
}

const HOUR_MS = 3600000;
const DAY_MS = 24 * HOUR_MS;

/** How long it has waited, as the Feed's Needs you says it: "this week" for an empty week, "3 hours", "2 days". */
function waitOf(item: TodoItem, now: number): string {
  if (item.since == null) return item.kind === "week" ? "this week" : "";
  const ms = Math.max(0, now - item.since);
  if (ms < HOUR_MS) return "just now";
  if (ms < DAY_MS) {
    const h = Math.floor(ms / HOUR_MS);
    return `${h} ${h === 1 ? "hour" : "hours"}`;
  }
  const d = Math.floor(ms / DAY_MS);
  return `${d} ${d === 1 ? "day" : "days"}`;
}

/** The groups, a tab each, in the tracks' order and then the needs-you lists' (NEED_CATS): Lifestyle, Training,
 *  Nutrition, Shape update, Meetings, Sign-in, Plan. Home holds the sign-in lock alone, so its head is the needs-you
 *  lists' Sign-in, the lock in its grey (24 Nov, Alex: one head for one thing, never an invented "Home"). Read when the
 *  panel draws, never as this file loads: NeedGroups reaches back here through PlanDraft and TrainingDraft, so on a
 *  page loaded straight onto /feed NEED_LOOK isn't there yet at load (24 Nov: "Cannot access 'NEED_LOOK' before
 *  initialization"). */
const groupsOf = (): { tab: DotTab; label: string; color: string; icon: ReactNode }[] => [
  { tab: "measurements", ...NEED_LOOK.lifestyle },
  { tab: "training", ...NEED_LOOK.training },
  { tab: "nutrition", ...NEED_LOOK.nutrition },
  { tab: "pictures", label: "Shape update", color: TRACK_ACCENT.lifestyle, icon: <CameraIcon /> },
  { tab: "meetings", ...NEED_LOOK.meetings },
  { tab: "home", ...NEED_LOOK.account },
  { tab: "plan", ...NEED_LOOK.plan },
];

const LB = 2.20462;
/** A weight to the nearest half, in the unit shown (as Training's kgOf). */
const weight = (kg: number, lbs: boolean) => `${Math.round((lbs ? kg * LB : kg) * 2) / 2}`;

/** Every Needs-you id a row stands for: a lift's missed figure is one row for all its sessions. */
const keysOf = (i: TodoItem) => i.keys ?? [i.key];
/** The rows the coach can let go: what the Feed's round check clears (not a sign-in lock, which ends by itself, nor a
 *  new client's first phase, which is no Needs-you item). */
const canDone = (i: TodoItem) => i.kind !== "locked" && i.key !== "setup";
/** Done on the tab's own screen, the panel making way for it: Meetings' Mark completed and Book, Plan's New phase or
 *  Open, Home's Unlock. A target's Back to is done from the panel itself; the rest open their thing. */
const tabActs = (i: TodoItem) => i.kind === "complete-call" || i.kind === "ask-call" || i.kind === "locked" || (i.kind === "setup" && i.tab === "plan");

/** The pop-over the pill controls (aria-controls): one client's To do on a page at a time. */
const TODO_POP_ID = "rd-todo-pop";

/** The pill at the end of the client's tabs (24 Nov, Alex: B of docs/boards/todo-button-mockup.html): rust, its count a
 *  rust disc, a soft rust tint while its panel is open. Not drawn when nothing is owed. */
export function TodoButton({ count, open, onClick, anchor }: { count: number; open: boolean; onClick: () => void; /** The pill, which the pop-over drops from (25 Nov). */ anchor?: RefObject<HTMLButtonElement | null> }) {
  return (
    <button ref={anchor} type="button" className={`rd-todobtn${open ? " open" : ""}`} aria-expanded={open} aria-controls={TODO_POP_ID} aria-label={`To do, ${count}`} onClick={onClick}>
      To do
      <b>{count}</b>
    </button>
  );
}

export function TodoPanel({
  open,
  now,
  onClose,
  clientId,
  clientName,
  items,
  tab,
  show,
  handler,
  park,
  onGone,
  onBack,
  units,
  anchor,
}: {
  open: boolean;
  /** When it was opened (ms): the waits as of then, worked out in the browser alone (the panel is drawn once opened). */
  now: number;
  onClose: () => void;
  clientId: number;
  clientName: string;
  /** Every row owed, gone ones left out (todoRows). */
  items: TodoItem[];
  /** The tab showing. */
  tab: DotTab | "invoices";
  show: (tab: DotTab) => void;
  /** What a drawn tab does in place. */
  handler: (tab: DotTab) => TodoHandlers | undefined;
  /** Runs once the tab is drawn and has handed its handlers (or, failing that, after a moment with none). */
  park: (tab: DotTab, run: (h: TodoHandlers | undefined) => void) => void;
  /** Let go on the screen: gone at once, while the server lets them go. */
  onGone: (keys: string[]) => void;
  /** The server refused: the rows come back. */
  onBack: (keys: string[]) => void;
  /** The coach's weight unit, for a target when Training isn't drawn. */
  units: "kg" | "lbs";
  /** The To do pill it drops from. */
  anchor: RefObject<HTMLElement | null>;
}) {
  const router = useRouter();
  const [, start] = useTransition();
  const [asking, setAsking] = useState<TodoItem | null>(null);
  // Rows going (a target sent back): faded until the next read of the page.
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  // A target not reached opened on its sessions, by its key (25 Nov).
  const [openRuns, setOpenRuns] = useState<ReadonlySet<string>>(() => new Set());
  const toggleRun = (key: string) =>
    setOpenRuns((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const [seenItems, setSeenItems] = useState(items);
  if (seenItems !== items) {
    setSeenItems(items);
    setBusy(new Set());
  }

  // Under its pill, kept with it (25 Nov, Alex: docs/boards/todo-popover-mockup.html). Closes on the pill again, a press
  // outside it, or Esc (unless a pop-up, a menu or a floating list has it: Esc closes that alone, 24 Nov, Alex); never
  // while the check's confirm is up.
  const popRef = useRef<HTMLDivElement>(null);
  const place = usePopoverPlace(anchor, open, 560, "end");
  usePopoverClose(open, onClose, [popRef, anchor], asking != null);
  // Your own weight and a note to the client, by row (25 Nov): kept while the row is shut, a failed send keeping them.
  // `key` the one-time key of the send, kept until it goes through: the server keys the weight by its figure and the note
  // apart (setTargetsToAction), so a retry after a note that failed, edited or not, finds the weight taken and sends
  // the note alone, never twice.
  const [owns, setOwns] = useState<Record<string, { kg: string; note: string; key: string | null }>>({});
  const ownOf = (key: string) => owns[key] ?? { kg: "", note: "", key: null };
  const editOwn = (key: string, change: Partial<{ kg: string; note: string }>) => setOwns((o) => ({ ...o, [key]: { ...(o[key] ?? { kg: "", note: "", key: null }), ...change } }));

  const lbs = (handler("training")?.unit?.() ?? units) === "lbs";
  // A target not reached, told to the client in the chat (24 Nov, Alex: "the option here of texting the client, linking
  // the exercise… so the client also can see what am I talking about"): the chat opens on their thread linked to the
  // exercise in this week's session still asking the figure (missed.dayId, where a tap on the row lands too), as
  // Training's exercise chat links it, its week in the label, the bar empty (nothing pre-written). Opening the chat closes this panel (RedesignShell).
  const openChat = useOpenChat();
  const firstName = clientName.split(" ")[0] || clientName;
  const messageAbout = (item: TodoItem) => {
    const m = item.missed;
    if (!m || !openChat) return;
    const week = /[?&]week=(\d+)/.exec(item.href)?.[1];
    openChat({ area: "Training", label: `${item.what} · ${m.session}${week ? `, Week ${week}` : ""}`, link: { kind: "exercise", dayId: m.dayId, assignmentId: m.assignmentId } });
  };
  /** A row's words: a target's in the unit shown (24 Nov), the rest as the server says them. */
  const told = (i: TodoItem) => {
    const m = i.missed;
    if (!m) return i;
    const unit = lbs ? "lbs" : "kg";
    return {
      ...i,
      // The sessions go grey after the exercise's name (25 Nov, Alex: the board), so what happened and the best fit on one line.
      facts: [m.best ? `best ${weight(m.best.kg, lbs)} × ${m.best.reps}` : null],
      happened: `${weight(m.fromKg, lbs)} ${unit} not reached in ${m.sessions} sessions`,
      action: `${m.back ? "Back to" : "Set to"} ${weight(m.toKg, lbs)} ${unit}`,
    };
  };

  /** Gone at once while the server lets them go; a save it refuses brings them back, said in red (24 Nov, Alex: a failed
   *  save never hides a row for good). */
  const letGo = (keys: string[], save: () => Promise<unknown>) => {
    onGone(keys);
    start(async () => {
      try {
        await save();
      } catch {
        onBack(keys);
        toast.error("Not saved", { description: "Check the connection, then try again." });
        return;
      }
      router.refresh();
    });
  };
  const markRead = (item: TodoItem) => letGo(keysOf(item), () => (item.eventId ? markSeenAction(clientId, { ids: [item.eventId] }) : dismissHomeActionAction(clientId, item.key)));
  /** To the thing on its tab, as the strip's link went: the tab's own way (Training's session), else its address, a # on
   *  the tab landed on and lit. */
  const land = (item: TodoItem, h: TodoHandlers | undefined) => {
    if (h?.go?.(item)) return;
    const to = new URL(item.href, window.location.origin);
    const asks = [...to.searchParams.keys()].filter((k) => k !== "client");
    if (asks.length) router.push(item.href);
    else if (to.hash) goToHash(to.hash);
  };
  /** Its tab forward, then `run` once the tab is there. */
  const onTab = (item: TodoItem, run: (h: TodoHandlers | undefined) => void) => {
    onClose();
    if (item.tab !== tab) show(item.tab);
    park(item.tab, run);
  };
  /** The row's name: its thing, on its tab. A note of theirs is read by opening it, whichever tab it is on. */
  const openThing = (item: TodoItem) => {
    if (item.kind === "read") markRead(item);
    onTab(item, (h) => land(item, h));
  };
  /** The row's action, in its words. */
  const act = (item: TodoItem) => {
    // Read is reading it, as the strip's was (2 Nov; 24 Nov, Alex): the note marked read and opened, its session, food
    // day or check-in landed on and lit on its tab.
    if (item.kind === "read") return openThing(item);
    if (item.kind === "missed" && item.missed) {
      if (busy.has(item.key)) return;
      setBusy((b) => new Set([...b, item.key]));
      // Training drawn: its own Back to, settling what the session has waiting first and saying it in its status.
      if (handler("training")?.act?.(item)) return;
      const parts = item.missed.parts.map((p) => ({ assignmentId: p.assignmentId, fromKg: p.fromKg }));
      start(async () => {
        const r = await backToTargetsAction(parts, newOnceKey()).catch(() => null);
        if (!r || r.ok === false) {
          setBusy((b) => new Set([...b].filter((k) => k !== item.key)));
          toast.error("Not saved", { description: r && r.ok === false ? r.error : "Check the connection, then try again." });
          return;
        }
        router.refresh();
      });
      return;
    }
    if (tabActs(item)) return onTab(item, (h) => (h?.act?.(item) ? undefined : land(item, h)));
    openThing(item);
  };
  /** Your own weight typed (25 Nov, Alex: the board's "Set to" and a figure to type): read with a comma or a dot, in the
   *  unit shown; null with nothing typed (the row's own figure then), "bad" for one that is no weight. In kg. */
  // Figures alone (no 0x40, no 1e2), rounded as the weight is kept (to the quarter kg, 25 Nov, review), so what the pill
  // names is what is saved and a figure the server would refuse greys it.
  const typedKg = (s: string): number | null | "bad" => {
    const t = s.trim();
    if (!t) return null;
    if (!/^\d+([.,]\d+)?$/.test(t)) return "bad";
    const kg = displayToKg(Number(t.replace(",", ".")), lbs ? "lb" : "kg");
    return Number.isFinite(kg) && kg > 0 && kg < 1000 ? kg : "bad";
  };
  /** Your own weight (else the row's), and the note, when it has words, to the client's chat linked to the exercise, so
   *  they read it under it (25 Nov, Alex: "so it is delivered to the chat and the client is aware that the coach is on
   *  top of them"). What Training still has waiting for those sessions goes first, so nothing older lands after it. */
  const setOwn = (item: TodoItem) => {
    const m = item.missed;
    if (!m || busy.has(item.key)) return;
    const d = ownOf(item.key);
    const typed = typedKg(d.kg);
    if (typed === "bad") return;
    // Nothing typed: the row's own action, its own figures row by row (null), never one figure on every row.
    const kg = typed;
    const once = d.key ?? newOnceKey();
    setOwns((o) => ({ ...o, [item.key]: { ...d, key: once } }));
    setBusy((b) => new Set([...b, item.key]));
    const parts = m.parts.map((p) => ({ assignmentId: p.assignmentId, fromKg: p.fromKg }));
    const h = handler("training");
    start(async () => {
      await h?.settle?.(item).catch(() => undefined);
      const r = await setTargetsToAction(parts, kg, d.note, { dayId: m.dayId, assignmentId: m.assignmentId }, once).catch(() => null);
      if (!r || r.ok === false) {
        // The row comes back, what was typed kept.
        setBusy((b) => new Set([...b].filter((k) => k !== item.key)));
        toast.error("Not saved", { description: r && r.ok === false ? r.error : "Check the connection, then try again." });
        return;
      }
      setOwns((o) => {
        const next = { ...o };
        delete next[item.key];
        return next;
      });
      router.refresh();
    });
  };
  const markDone = (list: TodoItem[]) => {
    setAsking(null);
    const keys = list.flatMap(keysOf);
    letGo(keys, () => dismissHomeActionAction(clientId, keys));
  };

  const groups = groupsOf().map((g) => ({ ...g, rows: items.filter((i) => i.tab === g.tab).map(told) })).filter((g) => g.rows.length > 0);
  const askingGroup = asking ? items.filter((i) => i.tab === asking.tab && canDone(i)) : [];
  const others = askingGroup.length - 1;

  return (
    <div ref={popRef} id={TODO_POP_ID} className={`rd-todopanel${open ? " open" : ""}`} style={place} role="region" aria-label="To do" aria-hidden={!open} inert={open ? undefined : true}>
      <div className="tdp-scroll">
      {/* To do alone (25 Nov, Alex: "take that out because we know where we are"), no ✕: the pill, a press outside, Esc. */}
      <div className="tdp-head">
        <h2>To do</h2>
      </div>
      {/* One grid down the whole list (25 Nov, Alex: the board): the words, the chat's column, the action's (as wide as
          the widest, every action ending on one edge), the round check's. */}
      <div className="tdp-list">
      {groups.map((g) => {
        const row = (item: TodoItem) => {
          const wait = item.happened ?? item.wait ?? waitOf(item, now);
          const m = item.missed;
          const runOpen = !!m && openRuns.has(item.key);
          // A target not reached opens on its sessions (25 Nov, Alex: "I have to see the data of all of those sessions…
          // I don't have enough information for me to see what the solution could be"): what was said in rust is the way in.
          const happened =
            m && m.run.length > 0 ? (
              <button key="w" type="button" className={`tdp-runbtn${runOpen ? " open" : ""}`} aria-expanded={runOpen} onClick={() => toggleRun(item.key)}>
                <em>{wait}</em>
                <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M4.5 2.5 8 6l-3.5 3.5" />
                </svg>
              </button>
            ) : wait ? (
              <em key="w">{wait}</em>
            ) : null;
          return (
            // Sending: out of reach of the pointer and the keyboard both, so no Enter sends it twice (25 Nov, review).
            <div key={item.key} className={`tdp-item${busy.has(item.key) ? " busy" : ""}`} inert={busy.has(item.key) || undefined}>
            <div className="tdp-row">
              <div className="tdp-thing">
                {/* A target's sessions grey after the exercise's name, on its line (25 Nov, Alex: the board). */}
                <span className="tdp-nameline">
                  <button type="button" className="tdp-name" onClick={() => openThing(item)}>
                    {item.what}
                  </button>
                  {m && m.sessionNames.length > 0 && <i>{m.sessionNames.join(", ")}</i>}
                </span>
                <small className={m ? "tdp-oneline" : undefined}>
                  <SepJoin parts={m ? [happened, ...(item.facts ?? [])] : [...(item.words ? [`“${item.words}”`] : (item.facts ?? []).slice(0, 1)), happened, ...(item.words ? [] : (item.facts ?? []).slice(1))]} />
                </small>
              </div>
              {/* The chat's column, empty on a row without one, so every chat icon sits in one column. */}
              {item.missed && openChat ? (
                <button type="button" className="tdp-tool" title={`Message ${firstName} about ${item.what}`} aria-label={`Message ${firstName} about ${item.what}`} onClick={() => messageAbout(item)}>
                  <ChatIcon />
                </button>
              ) : (
                <span aria-hidden="true" />
              )}
              <button type="button" className="tdp-act" onClick={() => act(item)}>
                {item.action}
              </button>
              {/* Done without doing it: asks first, as the Feed's round check, green under the pointer. */}
              {canDone(item) ? (
                <button type="button" className="tdp-done" title="Mark done" aria-label={`Mark done: ${item.what}`} onClick={() => setAsking(item)}>
                  <CheckIcon />
                </button>
              ) : (
                <span className="tdp-done-room" aria-hidden="true" />
              )}
            </div>
            {/* The run, newest first: the target, then each session's day and every set of the lift in it, a set inside
                the range in ink and one outside it grey, on the shared fold. */}
            {m && m.run.length > 0 && (
              <RowFold open={runOpen}>
                <div className="tdp-run">
                  <p className="tdp-run-target">
                    Target {weight(m.fromKg, lbs)} {lbs ? "lbs" : "kg"} × {m.range.max == null ? `${m.range.min}+` : m.range.min === m.range.max ? m.range.min : `${m.range.min}–${m.range.max}`}
                  </p>
                  {m.run.map((s, si) => (
                    <div key={`${s.date}-${si}`} className="tdp-run-row">
                      <span className="tdp-run-day">{logDate(new Date(`${s.date}T12:00:00`))}</span>
                      <span className="tdp-run-sets">
                        <SepJoin
                          parts={s.sets.map((x, i) => (
                            <span key={i} className={x.reps < m.range.min || (m.range.max != null && x.reps > m.range.max) ? "off" : undefined}>
                              {weight(x.kg, lbs)} × {x.reps}
                            </span>
                          ))}
                        />
                      </span>
                    </div>
                  ))}
                  {/* Your own weight and a note to the client (25 Nov, Alex: the board, and "also add the option of adding a
                      comment on this… so it is delivered to the chat"): both empty until typed, no sample in them; the pill
                      says what it puts there, the typed figure or the row's own. */}
                  <OwnWeight
                    unit={lbs ? "lbs" : "kg"}
                    firstName={firstName}
                    own={ownOf(item.key)}
                    typed={typedKg(ownOf(item.key).kg)}
                    fallback={item.action}
                    onChange={(change) => editOwn(item.key, change)}
                    onSet={() => setOwn(item)}
                  />
                </div>
              </RowFold>
            )}
            </div>
          );
        };
        return (
          <section key={g.tab} className="tdp-group">
            <div className="tdp-ghead" style={{ "--c": g.color } as CSSProperties}>
              {g.icon}
              {g.label}
              <small>{g.rows.length}</small>
            </div>
            {/* Every row, always (25 Nov, Alex: "can you always show all the items in the to do"; was three, then N more). */}
            {g.rows.map(row)}
          </section>
        );
      })}
      </div>
      </div>
      {/* The confirm names the row's tab over its title, as a pop-up opened on that tab does (PopupTabZone). */}
      <PopupTabZone tab={asking?.tab ?? "home"} hidden={false}>
        <Dialog open={asking != null} onOpenChange={(o) => !o && setAsking(null)}>
          {asking && (
            <ConfirmDialog
              thing={{ name: asking.what, facts: asking.words ? [`“${asking.words}”`] : [...(asking.missed ? [asking.missed.sessionNames.join(", ")] : []), ...(told(asking).facts ?? [null])] }}
              title="Mark as done?"
              // A confirm pop-up's words (11 Nov, Alex: A of docs/boards/popup-anatomy-mockup.html).
              description="Nothing is sent."
              confirm="Done"
              // Several waiting in its group: all of them at once, ticked first.
              tick={others > 0 ? (others === 1 ? "Also mark the other one as done" : `Also mark the other ${others} as done`) : null}
              onConfirm={(all) => markDone(all ? askingGroup : [asking])}
            />
          )}
        </Dialog>
      </PopupTabZone>
    </div>
  );
}

/** The foot of a target's open run (25 Nov, Alex: docs/boards/todo-popover-mockup.html, and "also add the option of adding
 *  a comment on this… so it is delivered to the chat and the client is aware that the coach is on top of them"): `Set to`
 *  and a figure on the ink underline, `Note to {First}` over the note on its hairline underline, then one pill, the
 *  brand's, saying what it puts there: the figure typed, else the row's own (`Set to 65 kg`, `Back to 70 kg`). A figure
 *  that is no weight greys it, and it does nothing. Nothing written for the coach, nothing in the fields until typed. */
function OwnWeight({
  unit,
  firstName,
  own,
  typed,
  fallback,
  onChange,
  onSet,
}: {
  unit: "kg" | "lbs";
  firstName: string;
  own: { kg: string; note: string };
  /** The figure typed in kg, as it will be kept; null with nothing typed; "bad" for one that is no weight. */
  typed: number | null | "bad";
  fallback: string;
  onChange: (change: Partial<{ kg: string; note: string }>) => void;
  onSet: () => void;
}) {
  const bad = typed === "bad";
  // The figure as it will be saved, in the unit shown (25 Nov, review: 82.3 typed is 82.25 kept, and says so).
  const words = typeof typed === "number" ? `Set to ${kgToDisplay(typed, unit === "lbs" ? "lb" : "kg")} ${unit}` : fallback;
  const grow = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  // Its height from its words when it comes back too (the run shut and opened again, a failed send), not only as typed.
  const noteRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (noteRef.current) grow(noteRef.current);
  }, [own.note]);
  return (
    <div className="tdp-own">
      <label className="tdp-own-kg">
        Set to
        <input type="text" inputMode="decimal" autoComplete="off" value={own.kg} aria-invalid={bad || undefined} aria-label={`Weight in ${unit}`} onChange={(e) => onChange({ kg: e.target.value })} onKeyDown={(e) => e.key === "Enter" && !bad && onSet()} />
        <span className="u">{unit}</span>
      </label>
      <label className="tdp-own-note">
        <span>Note to {firstName}</span>
        <textarea ref={noteRef} rows={1} value={own.note} maxLength={2000} onChange={(e) => onChange({ note: e.target.value })} />
      </label>
      <button type="button" className="tdp-own-go" aria-disabled={bad || undefined} onClick={() => !bad && onSet()}>
        {words}
      </button>
    </div>
  );
}
