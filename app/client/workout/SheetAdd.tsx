"use client";

import { useEffect, useRef, useState } from "react";
import type { LibraryPick } from "../workoutShared";
import { groupLabel } from "./SwapExerciseDialog";

// A rogue session's next exercise on the sheet (16 Nov, Alex: A of docs/boards/rogue-add-mockup.html): where the next
// block will be, a dashed ring with a + in the number column and `Add an exercise` faint where its name goes. A tap
// makes that line the field (the ink underline, the keyboard up); the coach's library comes up under it as flat rows,
// the group grey on the right, and a name it doesn't know is the client's own, as Strength or Cardio. Cancel in words.
// A pick lands as the next block and the line is the dashed ring again.

type Pick = { exerciseId: number | null; name: string; group: string };

export default function SheetAdd({ library, onAdd }: { library: LibraryPick[]; /** Resolves once it is in the session (false when it could not be). */ onAdd: (pick: Pick) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) field.current?.focus();
  }, [open]);

  const needle = q.trim().toLowerCase();
  const matches = needle
    ? library
        .filter((e) => e.name.toLowerCase().includes(needle))
        .sort((a, b) => Number(!a.name.toLowerCase().startsWith(needle)) - Number(!b.name.toLowerCase().startsWith(needle)) || a.name.localeCompare(b.name))
        .slice(0, 8)
    : [];
  const exact = library.some((e) => e.name.toLowerCase() === needle);

  const close = () => {
    setOpen(false);
    setQ("");
    setProblem(null);
  };
  const add = async (pick: Pick) => {
    if (busy || !pick.name.trim()) return;
    setBusy(true);
    setProblem(null);
    const ok = await onAdd(pick).catch(() => false);
    setBusy(false);
    if (ok) close();
    else setProblem("That didn't add. Try again.");
  };

  if (!open)
    return (
      <button type="button" className="ws-addnext" onClick={() => setOpen(true)}>
        <span className="ws-addnext-ring" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" focusable="false">
            <path vectorEffect="non-scaling-stroke" d="M12 6v12M6 12h12" />
          </svg>
        </span>
        <span className="ws-addnext-name">Add an exercise</span>
      </button>
    );

  return (
    <div className="ws-addnext-open">
      <div className="ws-addnext on">
        <span className="ws-addnext-ring" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" focusable="false">
            <path vectorEffect="non-scaling-stroke" d="M12 6v12M6 12h12" />
          </svg>
        </span>
        <input
          ref={field}
          className="ws-addnext-field"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") return close();
            if (e.key !== "Enter" || !needle) return;
            const first = matches[0];
            if (first && first.name.toLowerCase() === needle) void add({ exerciseId: first.id, name: first.name, group: first.group });
            else if (!exact) void add({ exerciseId: null, name: q.trim(), group: "other" });
          }}
          aria-label="Add an exercise"
          enterKeyHint="done"
          autoComplete="off"
          autoCapitalize="sentences"
          disabled={busy}
        />
        <button type="button" className="ws-word" onClick={close} disabled={busy}>
          Cancel
        </button>
      </div>
      {problem && (
        <p className="ws-addnext-problem" role="alert">
          {problem}
        </p>
      )}
      {needle && (
        <div className="ws-addnext-list" role="listbox" aria-label="Exercises">
          {matches.map((e) => (
            <button key={e.id} type="button" role="option" aria-selected={false} className="ws-addnext-row" onClick={() => void add({ exerciseId: e.id, name: e.name, group: e.group })} disabled={busy}>
              <span className="ws-addnext-rname">{e.name}</span>
              <span className="ws-addnext-group">{groupLabel(e.group)}</span>
            </button>
          ))}
          {!exact && (
            // One's own: the name as typed, then which kind, in words.
            <div className="ws-addnext-row own">
              <span className="ws-addnext-rname">Add &ldquo;{q.trim()}&rdquo;</span>
              <span className="ws-addnext-kinds" role="group" aria-label={`Add ${q.trim()} as`}>
                <button type="button" className="ws-word" onClick={() => void add({ exerciseId: null, name: q.trim(), group: "other" })} disabled={busy}>
                  Strength
                </button>
                <button type="button" className="ws-word" onClick={() => void add({ exerciseId: null, name: q.trim(), group: "cardio" })} disabled={busy}>
                  Cardio
                </button>
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
