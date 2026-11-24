"use client";

import { createContext, useContext, useEffect, useRef, useState, useTransition, type CSSProperties, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CameraIcon, ChatIcon, CheckIcon } from "../../components/icons";
import { backToTargetsAction, dismissHomeActionAction, markSeenAction } from "../../lib/actions";
import { newOnceKey } from "../../lib/onceKey";
import { Dialog } from "../../components/ui/dialog";
import { ConfirmDialog } from "./training/TrainingDraft";
import { SepJoin } from "./Sep";
import { NEED_LOOK } from "./NeedGroups";
import { PopupTabZone } from "./PopupWho";
import { RowFold } from "./RowFold";
import { TRACK_ACCENT } from "../phaseChrome";
import { landOnSoon } from "../../lib/landOn";
import { useCloseOnEmptyClick } from "./useCloseOnEmptyClick";
import { useOpenChat } from "./ChatPanel";
import type { DotTab, TodoItem } from "./dots";
import "./todo-panel.css";

// The client's To do (24 Nov, Alex: "instead of having all these rows here… a button somewhere, and then we can expand…
// it's a bit too much"; "Build B", B of docs/boards/todo-button-mockup.html). Was a rust strip on top of each tab (2 Nov,
// Alex: mockup A of docs/boards/needs-strip-mockup.html). One rust pill at the end of the client's tabs with the count
// of everything owed on them (TodoButton), opening a panel from the window's right as the chat does (TodoPanel): the
// rows by tab in the tracks' order, three a group and the rest behind `N more`; a row its name (a tap opens the thing on
// its tab, landed on and lit), its facts grey with the drawn bar and what happened in rust, its action as its words, the
// round check on hover. The rows come from the dot trail (loadDots, dots.ts) through RedesignShell; what a tab does in
// place (Meetings' Mark completed and Book, Plan's New phase, Training's Back to) it hands the panel (useTodoHandlers).
// Styles: todo-panel.css.

/** What a tab does for a row on its own screen, handed to the panel (useTodoHandlers). Each says whether it did it. */
export type TodoHandlers = {
  /** The row's action in place (a dialog of the tab's, Back to through its save status). */
  act?: (item: TodoItem) => boolean;
  /** Opening the row's thing on the tab (Training's session on the week showing, another week coming first). */
  go?: (item: TodoItem) => boolean;
  /** The unit the tab shows weights in (Training's KG | LBS), for a target's figures. */
  unit?: () => "kg" | "lbs";
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
/** Rows a group shows before `N more`. */
const SHOWN = 3;

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

/** The pill at the end of the client's tabs (24 Nov, Alex: B of docs/boards/todo-button-mockup.html): rust, its count a
 *  rust disc, a soft rust tint while its panel is open. Not drawn when nothing is owed. */
export function TodoButton({ count, open, onClick }: { count: number; open: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`rd-todobtn${open ? " open" : ""}`} aria-expanded={open} aria-label={`To do, ${count}`} onClick={onClick}>
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
}) {
  const router = useRouter();
  const [, start] = useTransition();
  const [asking, setAsking] = useState<TodoItem | null>(null);
  // A group opened past its first three, by tab.
  const [more, setMore] = useState<ReadonlySet<DotTab>>(() => new Set());
  // Rows going (a target sent back): faded until the next read of the page.
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [seenItems, setSeenItems] = useState(items);
  if (seenItems !== items) {
    setSeenItems(items);
    setBusy(new Set());
  }

  // Closes on Esc (unless a pop-up, a menu or a floating list has it: Esc closes that alone, 24 Nov, Alex) and on a click
  // on empty page, as the chat does; never while the check's confirm is up, whose dim is no empty page.
  useCloseOnEmptyClick(open && !asking, onClose);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) =>
      e.key === "Escape" && !e.defaultPrevented && !document.querySelector("[role=dialog], [role=menu], [role=listbox], [data-radix-popper-content-wrapper]") && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const lbs = (handler("training")?.unit?.() ?? units) === "lbs";
  // A target not reached, told to the client in the chat (24 Nov, Alex: "the option here of texting the client, linking
  // the exercise… so the client also can see what am I talking about"): the chat opens on their thread linked to the
  // exercise in the session it was last missed in, as Training's exercise chat links it, the bar empty (nothing
  // pre-written). Opening the chat closes this panel (RedesignShell).
  const openChat = useOpenChat();
  const firstName = clientName.split(" ")[0] || clientName;
  const messageAbout = (item: TodoItem) => {
    const m = item.missed;
    if (!m || !openChat) return;
    const week = /[?&]week=(d+)/.exec(item.href)?.[1];
    openChat({ area: "Training", label: `${item.what} · ${m.session}${week ? `, Week ${week}` : ""}`, link: { kind: "exercise", dayId: m.dayId, assignmentId: m.assignmentId } });
  };
  /** A row's words: a target's in the unit shown (24 Nov), the rest as the server says them. */
  const told = (i: TodoItem) => {
    const m = i.missed;
    if (!m) return i;
    const unit = lbs ? "lbs" : "kg";
    return {
      ...i,
      facts: [m.sessionNames.join(", "), m.best ? `best ${weight(m.best.kg, lbs)} × ${m.best.reps}` : null],
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
  const markDone = (list: TodoItem[]) => {
    setAsking(null);
    const keys = list.flatMap(keysOf);
    letGo(keys, () => dismissHomeActionAction(clientId, keys));
  };

  const groups = groupsOf().map((g) => ({ ...g, rows: items.filter((i) => i.tab === g.tab).map(told) })).filter((g) => g.rows.length > 0);
  const askingGroup = asking ? items.filter((i) => i.tab === asking.tab && canDone(i)) : [];
  const others = askingGroup.length - 1;

  return (
    <aside className={`rd-todopanel${open ? " open" : ""}`} aria-label="To do" aria-hidden={!open} inert={open ? undefined : true}>
      <div className="tdp-head">
        <h2>
          To do<small>{clientName}</small>
        </h2>
        <button type="button" className="tdp-x" aria-label="Close" title="Close" onClick={onClose}>
          ✕
        </button>
      </div>
      {groups.map((g) => {
        const opened = more.has(g.tab);
        const row = (item: TodoItem) => {
          const wait = item.happened ?? item.wait ?? waitOf(item, now);
          return (
            <div key={item.key} className={`tdp-row${busy.has(item.key) ? " busy" : ""}`}>
              <div className="tdp-thing">
                <button type="button" className="tdp-name" onClick={() => openThing(item)}>
                  {item.what}
                </button>
                <small>
                  <SepJoin parts={[...(item.words ? [`“${item.words}”`] : (item.facts ?? []).slice(0, 1)), wait ? <em key="w">{wait}</em> : null, ...(item.words ? [] : (item.facts ?? []).slice(1))]} />
                </small>
              </div>
              {item.missed && openChat && (
                <button type="button" className="tdp-tool" title={`Message ${firstName} about ${item.what}`} aria-label={`Message ${firstName} about ${item.what}`} onClick={() => messageAbout(item)}>
                  <ChatIcon />
                </button>
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
          );
        };
        return (
          <section key={g.tab} className="tdp-group">
            <div className="tdp-ghead" style={{ "--c": g.color } as CSSProperties}>
              {g.icon}
              {g.label}
              <small>{g.rows.length}</small>
            </div>
            {g.rows.slice(0, SHOWN).map(row)}
            {g.rows.length > SHOWN && (
              <>
                <RowFold open={opened}>{g.rows.slice(SHOWN).map(row)}</RowFold>
                {!opened && (
                  <button type="button" className="tdp-more" onClick={() => setMore((s) => new Set([...s, g.tab]))}>
                    {g.rows.length - SHOWN} more
                  </button>
                )}
              </>
            )}
          </section>
        );
      })}
      {/* The confirm names the row's tab over its title, as a pop-up opened on that tab does (PopupTabZone). */}
      <PopupTabZone tab={asking?.tab ?? "home"} hidden={false}>
        <Dialog open={asking != null} onOpenChange={(o) => !o && setAsking(null)}>
          {asking && (
            <ConfirmDialog
              thing={{ name: asking.what, facts: asking.words ? [`“${asking.words}”`] : told(asking).facts ?? [null] }}
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
    </aside>
  );
}
