"use client";

import type { ReactNode } from "react";
import { DialogDescription } from "../../components/ui/dialog";
import { SepJoin } from "./Sep";

// A confirm pop-up's parts (11 Nov, Alex: A of docs/boards/popup-anatomy-mockup.html). Four parts, top to bottom: the
// title (the action and the thing, as a question), one or two plain sentences saying only what isn't obvious (what goes
// with it, what stays), an optional choice in its own soft grey well, and the action: Cancel in words and the verb alone
// as a pill (Delete or Remove a red pill, `dlh-danger`; anything else the ink one, `dlh-go`). Styles in training/trn.css.

/** The explanation: one or two plain sentences, who does what. */
export function ConfirmText({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <DialogDescription {...(id ? { id } : {})} className="dlh-text">
      {children}
    </DialogDescription>
  );
}

/** The optional choice, in its grey well: what ticking it adds, with its facts grey under it. */
export function ConfirmChoice({ checked, onChange, title, sub, id }: { checked: boolean; onChange: (v: boolean) => void; title: ReactNode; sub?: ReactNode; id?: string }) {
  return (
    <button type="button" role="checkbox" aria-checked={checked} id={id} className="dlh-choice" onClick={() => onChange(!checked)}>
      <span className={`dlh-box ink${checked ? " on" : ""}`} aria-hidden="true">
        {checked ? "✓" : ""}
      </span>
      <span className="dlh-choice-words">
        <span className="dlh-choice-t">{title}</span>
        {sub && <span className="dlh-choice-s">{sub}</span>}
      </span>
    </button>
  );
}

/** The thing itself on the paper (22 Nov, Alex: C of docs/boards/admin-popups-c-mockup.html): its name, its facts grey
 * parted by the drawn bar, and what goes with it in a soft rust box when something the client logged goes too. */
export type ConfirmThingProps = { name: ReactNode; facts?: ReactNode[]; lose?: ReactNode; aside?: ReactNode };
export function ConfirmThing({ name, facts, lose, aside }: ConfirmThingProps) {
  const shown = (facts ?? []).filter((p) => p != null && p !== false && p !== "");
  return (
    <div className="dlh-thing">
      <div className="dlh-thing-row">
        <div className="dlh-thing-words">
          <span className="dlh-thing-name">{name}</span>
          {shown.length > 0 && (
            <span className="dlh-thing-facts">
              <SepJoin parts={shown} />
            </span>
          )}
        </div>
        {aside != null && <span className="dlh-thing-aside">{aside}</span>}
      </div>
      {lose && <p className="dlh-thing-lose">{lose}</p>}
    </div>
  );
}
