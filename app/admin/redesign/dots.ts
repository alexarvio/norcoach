// The dot trail (22 Oct, Alex): what the coach owes a client, marked with a rust dot at each step down to it, so the
// rail's number leads somewhere: the client's tab, then on Training the week, then the session, then the exercise (its
// video mark, rust while it waits). The same things the rail counts (the Feed's Needs you), worked out once on the
// server (loadDots in loaders.ts) and handed to every tab. A dot goes when the thing is done (replied, reviewed, read,
// booked), never just by looking. The chat keeps its own dot on the chat tab (unread, gone on opening). Styles: .rd-due
// in training/draft.css. The same things say what they are and carry their action in the client's To do panel, one
// button at the end of their tabs (todo; 2 Nov, Alex, as a strip on each tab; since 24 Nov, Alex: "Build B", B of
// docs/boards/todo-button-mockup.html).

/** The client tabs as RedesignShell keys them. */
export type DotTab = "home" | "plan" | "measurements" | "training" | "nutrition" | "pictures" | "meetings" | "invoices";

export type DotTrail = {
  /** Tabs with something owed on them. */
  tabs: DotTab[];
  training: {
    /** Programme id → its screen weeks (1-based, as the week rail numbers them) with something owed: a video or photo to
     *  review, a note on a session to read, the live week with no sessions. */
    weeks: Record<number, number[]>;
    /** Sessions (program_day ids) with a video or photo to review or a note to read. */
    days: number[];
    /** Exercises (workout_assignment ids) with a video or photo waiting for review. */
    exercises: number[];
  };
  /** Food days (yyyy-mm-dd) with a note of theirs to read: the day → the notes' feed event ids, so opening the day marks
   *  them read (markSeenAction) and its dot goes. */
  food: Record<string, string[]>;
  /** A call they asked for, or a call over and not marked completed. */
  meetings: boolean;
  /** Locked out of signing in: App access on Home. */
  unlock: boolean;
  /** The To do panel's rows (2 Nov, Alex: "if we just use dots, it can be a little bit confusing"; one panel for all the
   *  client's tabs since 24 Nov, `todoRows`): every thing the rail counts, on the tab it is done on, in the rail's order. */
  todo: TodoItem[];
};

/** One row of the To do panel: what it is, since when it waits, and the action that does it (its words, 24 Nov). */
export type TodoItem = {
  /** The Needs-you id ("week", "complete-12", "read-…"), unique on one client. */
  key: string;
  tab: DotTab;
  kind: "setup" | "week" | "locked" | "video" | "ask-call" | "complete-call" | "read" | "missed" | "charge-failed";
  /** "Week 5 has no sessions", "Video of Back Squat", "Check-In, 2/11, to complete". */
  what: string;
  /** The client's own words, in quotes after it. */
  words: string | null;
  /** Since when it waits (ms), for "2 days"; null for a standing state (an empty week: "this week"). */
  since: number | null;
  /** The action's word: Add sessions, Unlock, Review, Book, Mark completed, Read, New phase. */
  action: string;
  /** Where the action goes when the tab doesn't do it in place: its tab, at the thing (#session-…, #day-…, #call-…). */
  href: string;
  /** The thing's id where the tab acts in place: the call to complete, the call asked for. */
  ref: number | null;
  /** A note of theirs to read: its feed event, marked read the moment Read is clicked, on any tab. */
  eventId?: string | null;
  /** A track with nothing live (`track-…`): the track New phase opens on. */
  track?: "lifestyle" | "training" | "nutrition" | null;
  /** Facts in grey after it, parted by the drawn bar, in place of their words (a target not reached: `Push | 150 kg |
   *  best 120 × 6`). */
  facts?: (string | null)[];
  /** How long it has waited, when it is not a time. */
  wait?: string;
  /** What happened, in rust between the bars (a target not reached: `60 kg not reached in 4 sessions`). */
  happened?: string;
  /** Every Needs-you id the row stands for, when it is more than its own `key` (a lift's missed figure in several
   *  sessions): its round check lets them all go, or the others come back as a row. */
  keys?: string[];
  /** A target not reached in 3 sessions (24 Nov, Alex: B of docs/boards/target-rule-mockup.html), one row a lift (24 Nov,
   *  Alex: B of docs/boards/todo-button-mockup.html, "Build B"): every session of the programme asking the same figure
   *  with the same offer, as `parts` (a row each, the figure it asks), the sessions' names in programme order, the figure
   *  and what Back to (or Set to) puts there, in kg, the run's best and its sessions. Its action acts on every part
   *  (backToTargetsAction). `assignmentId`, `dayId` and `session` are the first part's. Training says it in the unit
   *  picked. */
  missed?: {
    parts: { assignmentId: number; dayId: number; fromKg: number }[];
    sessionNames: string[];
    assignmentId: number;
    dayId: number;
    fromKg: number;
    toKg: number;
    back: boolean;
    best: { kg: number; reps: number } | null;
    session: string;
    sessions: number;
    /** The sessions of the run, newest first: the day (yyyy-mm-dd) and every set of the lift in it, in kg (25 Nov). */
    run: { date: string; sets: { kg: number; reps: number }[] }[];
    /** The row's rep range; `max` null for "that many or more". */
    range: { min: number; max: number | null };
  };
};

export const NO_DOTS: DotTrail = { tabs: [], training: { weeks: {}, days: [], exercises: [] }, food: {}, meetings: false, unlock: false, todo: [] };

/** The tabs a To do row can be on (24 Nov, Alex: "Build B"): every tab that had a to-do strip, and Invoices since 26 Nov
 *  (Alex: a failed automatic charge, after its third retry, "Finlay is told on his To do"). */
export const TODO_TABS: readonly DotTab[] = ["home", "plan", "measurements", "training", "nutrition", "pictures", "meetings", "invoices"];

/** Every row of the client's To do panel, across their tabs, and so its button's count: exactly the rows the strips
 *  showed, less any let go on the screen (`gone`, its keys). */
export function todoRows(dots: DotTrail | undefined, gone?: ReadonlySet<string>): TodoItem[] {
  return (dots?.todo ?? []).filter((i) => TODO_TABS.includes(i.tab) && !(gone && (gone.has(i.key) || i.keys?.some((k) => gone.has(k)))));
}

/** A week of this programme has a dot. */
export const weekDue = (dots: DotTrail | undefined, programId: number, weekIndex: number) => !!dots?.training.weeks[programId]?.includes(weekIndex);
