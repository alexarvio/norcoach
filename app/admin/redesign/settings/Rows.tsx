"use client";

import { createContext, useContext, useState, useTransition,type ButtonHTMLAttributes, type CSSProperties, type HTMLAttributes, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { RowFold } from "../RowFold";
import { Sep } from "../Sep";

// Settings in one system (23 Nov, Alex: docs/boards/settings-harmony-mockup.html): every section drawn the same way.
// The section's title (SettingsBoard), then parts: a small caps label in ink, one grey fact after the drawn bar and its
// one action on the right, over one white hairline card (Part). In the card, rows: 58px, the name (15px/600) with one
// grey fact under it on the left, the value or its control on the right, #EEF0F3 between rows (Row). A row that is
// changed with a word (Change, Edit, Add) opens its fields under itself on the shared fold, Cancel in words and Save the
// pill (OpenRow). Only real forms (an address, a business, a bank) keep the clean-line form (Fields, Line). Two small
// parts sit side by side, one under the other once the section is narrow (Two). Styles: the "Rows" block at the end
// of settings.css, prefix rsr-; a word action is the admin's one (.rst-act, .rst-danger), a switch Settings' one.

/** The room on the right of the section's title, for its body's `SectionActions`. */
const ActionsRoom = createContext<HTMLElement | null>(null);

/** A section as SettingsBoard draws it: its head (the title, its one tag, its actions on the right, 36px), then its
 *  body, its parts 20px under the head and 24px apart. */
export function SectionShell({ titleId, title, tag, actions, children }: { titleId: string; title: ReactNode; tag?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  // Set as the head is drawn (a ref, so a section mounted on the client finds it too).
  const [room, setRoom] = useState<HTMLElement | null>(null);
  return (
    <>
      <div className="rst-sechead">
        <h2 className="rst-sechead-title" id={titleId}>
          <span className="rst-sectitle">{title}</span>
          {tag}
        </h2>
        <div className="rst-sechead-actions" ref={setRoom}>
          {actions}
        </div>
      </div>
      <ActionsRoom.Provider value={room}>
        <div className="rst-content">{children}</div>
      </ActionsRoom.Provider>
    </>
  );
}

/** Puts its children on the right of the section's title (Plans' + Plan), from inside the section's body, so an action
 *  that needs the body's state can sit in the head. Drawn once the head is in. */
export function SectionActions({ children }: { children: ReactNode }) {
  const room = useContext(ActionsRoom);
  return room ? createPortal(children, room) : null;
}

/** One white hairline card (radius 18), its rows parted by #EEF0F3. */
export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={`rsr-card${className ? ` ${className}` : ""}`}>{children}</div>;
}

/** A part of a section: its small caps label in ink (and one grey fact after the drawn bar), its one action on the
 *  right, over its card. `bare` for a part whose content is its own cards (How clients pay: Two cards). `id` lands an
 *  address on it (`rst-part-<id>`; settingsNav's SETTINGS_ALIASES: #billing is Account's part "billing"). */
export function Part({ label, fact, action, id, bare = false, className, cardClassName, children }: { label: ReactNode; fact?: ReactNode; action?: ReactNode; id?: string; bare?: boolean; className?: string; cardClassName?: string; children?: ReactNode }) {
  return (
    <section className={`rsr-part${className ? ` ${className}` : ""}`} id={id ? `rst-part-${id}` : undefined}>
      <div className="rsr-lbl">
        <h3 className="rsr-lw">
          <b>{label}</b>
          {fact != null && fact !== false && fact !== "" && (
            <>
              <Sep />
              <span>{fact}</span>
            </>
          )}
        </h3>
        {action && <div className="rsr-lbl-act">{action}</div>}
      </div>
      {bare ? children : <Card className={cardClassName}>{children}</Card>}
    </section>
  );
}

/** A row: the name with one grey fact under it (facts parted by the drawn bar, SepJoin) on the left, the value or its
 *  control on the right (children). `hover`: the row hover and its hover words (`.rst-hover`), for a row with actions
 *  shown on hover. `faded`: the name and fact at half strength (an archived plan, a deleted gym). */
export function Row({ name, fact, hover = false, faded = false, className, id, children }: { name: ReactNode; fact?: ReactNode; hover?: boolean; faded?: boolean; className?: string; id?: string; children?: ReactNode }) {
  return (
    <div className={`rsr-row${hover ? " hl" : ""}${faded ? " faded" : ""}${className ? ` ${className}` : ""}`} id={id}>
      <div className="rsr-rm">
        <b>{name}</b>
        {fact != null && fact !== false && fact !== "" && <span>{fact}</span>}
      </div>
      {children}
    </div>
  );
}

/** Rows side by side inside one card, an upright #EEF0F3 between them (Who is behind the app). */
export function Cells({ children }: { children: ReactNode }) {
  return <div className="rsr-cells">{children}</div>;
}

/** Two cards (or two parts) side by side, 20px apart, one under the other once the section is narrow. Their feet
 *  line up; `top` lines their tops up instead (parts of different heights). */
export function Two({ top = false, className, children }: { top?: boolean; className?: string; children: ReactNode }) {
  return <div className={`rsr-two${top ? " top" : ""}${className ? ` ${className}` : ""}`}>{children}</div>;
}

/** A word action in a row or a label (Change, Edit, Add; Disconnect in red; Cancel in the secondary grey): 32px,
 *  13px/600, the page grey behind it on hover (`.rst-act`). `hoverOnly` shows it on the row's hover alone. */
export function Word({ tone, hoverOnly = false, className, children, ...rest }: { tone?: "red" | "sec"; hoverOnly?: boolean; className?: string; children: ReactNode } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children">) {
  const cls = `${tone === "red" ? "rst-danger" : "rst-act"}${tone === "sec" ? " sec" : ""}${hoverOnly ? " rst-hover" : ""}${className ? ` ${className}` : ""}`;
  return (
    <button type="button" className={cls} {...rest}>
      {children}
    </button>
  );
}

/** A pill: white with the button hairline (34px), or `go`, the screen's one brand pill (36px; Save, Add). */
export function Pill({ go = false, className, children, ...rest }: { go?: boolean; className?: string; children: ReactNode } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children">) {
  return (
    <button type="button" className={`rsr-pill${go ? " go" : ""}${className ? ` ${className}` : ""}`} {...rest}>
      {children}
    </button>
  );
}

/** The state pill at a row's end (Connected, This device, Soon, Trial): white, a 1px edge, 24px, 11.5px/600, 84px at
 *  least so a column of them is one width. good green, ink ink, rust what needs doing, bad the danger red; else grey. */
export function State({ tone, children }: { tone?: "good" | "ink" | "rust" | "bad"; children: ReactNode }) {
  return <span className={`rsr-st${tone ? ` ${tone}` : ""}`}>{children}</span>;
}

/** On or off: Settings' switch, white while off and the brand colour while on (`.rst-switch`). */
export function Switch({ on, label, onChange, disabled }: { on: boolean; label: string; onChange: (on: boolean) => void; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={`rst-switch${on ? " on" : ""}`} onClick={() => onChange(!on)} disabled={disabled}>
      <i aria-hidden="true" />
    </button>
  );
}

/** Two or three short choices: the shared capsule (`.rd-btn-group`, which slides), the picked one in the brand colour. */
export function Capsule<T extends string>({ value, options, onChange, label }: { value: T; options: readonly { value: T; label: ReactNode }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="rd-btn-group rsr-caps" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={value === o.value ? "on" : ""} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A short figure typed on the row's right (21 %, 14 days, the prefix): a clean line `width` wide, the figure on its
 *  right, its unit grey after it. Empty until typed: no sample in it. */
export function InlineLine({ value, onChange, unit, width, label, inputMode, maxLength, invalid }: { value: string; onChange: (v: string) => void; unit?: ReactNode; width: number; label: string; inputMode?: HTMLAttributes<HTMLInputElement>["inputMode"]; maxLength?: number; invalid?: boolean }) {
  return (
    <label className={`rsr-iline${invalid ? " bad" : ""}`} style={{ width } as CSSProperties}>
      <input value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} inputMode={inputMode} maxLength={maxLength} aria-invalid={invalid || undefined} />
      {unit != null && <em>{unit}</em>}
    </label>
  );
}

/** A real form inside a card or under an opened row: its fields on clean lines in `cols` columns (one on a narrow
 *  page), 18px between rows and 24px between columns; `pad` for one that is the card's whole content. `fit` (a width
 *  in px) instead lays as many columns as the card's own width holds at that width at least, so a row of several
 *  fields (Registration's) wraps where the section is narrow, whatever the window. */
export function Fields({ cols = 2, fit, pad = false, className, children }: { cols?: number; fit?: number; pad?: boolean; className?: string; children: ReactNode }) {
  return (
    <div
      className={`rsr-form${fit ? " fit" : ""}${pad ? " pad" : ""}${className ? ` ${className}` : ""}`}
      style={(fit ? { "--rsr-min": `${fit}px` } : { "--rsr-cols": cols }) as unknown as CSSProperties}
    >
      {children}
    </div>
  );
}

/** A field in `Fields`: its small caps label (10px, grey) over its line. The line is the caller's: an input or a
 *  textarea with `dlh-line` (30px here; `tall` for a longer text), a `Picker` with `rsr-sel`, or a `.rsr-lined` box
 *  holding a fixed prefix (`<em className="rsr-pre">NL</em>`) and an input. `wide` across every column. */
export function Line({ label, wide = false, tall = false, group = false, error, className, children }: { label?: ReactNode; wide?: boolean; tall?: boolean; /** Not one input (a capsule, a list): a div, so a click on the label presses nothing. */ group?: boolean; error?: ReactNode; className?: string; children: ReactNode }) {
  const cls = `rsr-f${wide ? " wide" : ""}${tall ? " tall" : ""}${className ? ` ${className}` : ""}`;
  const inner = (
    <>
      {label != null && <span className="rsr-flabel">{label}</span>}
      {children}
      {error && <small className="rst-err">{error}</small>}
    </>
  );
  return group ? <div className={cls}>{inner}</div> : <label className={cls}>{inner}</label>;
}

/** Cancel in words and Save the pill, on the right under what they save; what went wrong in red on their left. */
export function Foot({ onCancel, onSave, saveWord = "Save", busy = false, canSave = true, error, className }: { onCancel: () => void; onSave: () => void; saveWord?: string; busy?: boolean; canSave?: boolean; error?: ReactNode; className?: string }) {
  return (
    <div className={`rsr-foot${className ? ` ${className}` : ""}`}>
      {error && <span className="rst-err">{error}</span>}
      <Word tone="sec" onClick={onCancel} disabled={busy}>
        Cancel
      </Word>
      <Pill go onClick={onSave} disabled={busy || !canSave}>
        {busy ? "Saving…" : saveWord}
      </Pill>
    </div>
  );
}

/** A row changed in place (Password's Change, Bank transfer's Edit, the VAT note's Add): at rest its word on the right
 *  (and `extra` before it); a click opens its fields (children) under it on the shared fold (RowFold), the word gone,
 *  Cancel in words and Save the pill under them. `onSave` resolves false (or throws) when it didn't save: the row
 *  stays open; else it shuts. Open or shut by itself, or held by the caller (`open`, `onOpenChange`). `onCancel` puts
 *  the fields back. */
export function OpenRow({
  name,
  fact,
  word = "Edit",
  extra,
  open: held,
  onOpenChange,
  onSave,
  onCancel,
  saveWord = "Save",
  canSave = true,
  error,
  hover = false,
  id,
  children,
}: {
  name: ReactNode;
  fact?: ReactNode;
  word?: ReactNode;
  extra?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onSave: () => Promise<boolean | void> | boolean | void;
  onCancel?: () => void;
  saveWord?: string;
  canSave?: boolean;
  error?: ReactNode;
  hover?: boolean;
  id?: string;
  children: ReactNode;
}) {
  const [own, setOwn] = useState(false);
  const open = held ?? own;
  const setOpen = (o: boolean) => {
    if (held === undefined) setOwn(o);
    onOpenChange?.(o);
  };
  const [busy, start] = useTransition();
  const save = () =>
    start(async () => {
      let ok = true;
      try {
        ok = (await onSave()) !== false;
      } catch {
        ok = false;
      }
      if (ok) setOpen(false);
    });
  const cancel = () => {
    onCancel?.();
    setOpen(false);
  };
  return (
    <>
      <Row name={name} fact={fact} hover={hover && !open} className={open ? "opened" : undefined} id={id}>
        {!open && extra}
        {!open && <Word onClick={() => setOpen(true)}>{word}</Word>}
      </Row>
      <RowFold open={open} className="rsr-unfold">
        {children}
        <Foot onCancel={cancel} onSave={save} saveWord={saveWord} busy={busy} canSave={canSave} error={error} />
      </RowFold>
    </>
  );
}
