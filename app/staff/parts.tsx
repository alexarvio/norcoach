"use client";

import type { ReactNode } from "react";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "../components/ui/dialog";
import { ConfirmText, ConfirmThing, type ConfirmThingProps } from "../admin/redesign/ConfirmParts";

// The staff screens' shared parts (26 Nov, Alex; app/staff/staff.css). The drawn bar is the coach admin's own `Sep` /
// `SepJoin` (app/admin/redesign/Sep.tsx), the fold its `RowFold`, re-exported here so every staff screen takes them
// from one place.
export { Sep, SepJoin } from "../admin/redesign/Sep";
export { RowFold as StaffFold } from "../admin/redesign/RowFold";

/** A face: the picture when there is one (a `/uploads/…` path, asked small), else the initial on white with the hairline. */
export function StaffFace({ name, photo, big = false }: { name: string; photo?: string | null; big?: boolean }) {
  const first = name.trim().charAt(0).toUpperCase() || "?";
  const src = photo ? `${photo}${photo.includes("?") ? "&" : "?"}w=${big ? 192 : 96}` : null;
  return (
    <span className={`stf-face${big ? " big" : ""}`} aria-hidden="true">
      {src ? <img src={src} alt="" decoding="async" loading="lazy" /> : first}
    </span>
  );
}

/** A face, a name 15/600 and a grey line under it (a coach's business and Norcode, a staff member's email). */
export function StaffWho({ name, sub, photo }: { name: string; sub?: ReactNode; photo?: string | null }) {
  return (
    <div className="stf-who">
      <StaffFace name={name} photo={photo} />
      <div>
        <b>{name}</b>
        {sub != null && sub !== "" && <small>{sub}</small>}
      </div>
    </div>
  );
}

/** Every switch one drawing: 36×22, white while off, ink while on. */
export function StaffSwitch({ on, onChange, label, disabled }: { on: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={`stf-switch${on ? " on" : ""}`} disabled={disabled} onClick={() => onChange(!on)}>
      <i />
    </button>
  );
}

/**
 * A yes-or-no in the coach admin's confirm anatomy (docs/DESIGN-RULES-ADMIN.md §4, ConfirmDialog): the title as a
 * question, the thing itself, one or two plain sentences only where something isn't obvious, Cancel in words and the
 * verb alone as a pill (red when it takes something away). Open while `open`; `onClose` on Cancel, ✕ or Esc.
 */
export function StaffConfirm({
  open,
  onClose,
  title,
  thing,
  description,
  confirm,
  danger = false,
  busy = false,
  error,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  thing?: ConfirmThingProps;
  description?: ReactNode;
  confirm: string;
  danger?: boolean;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="dlh" {...(description ? {} : { "aria-describedby": undefined })}>
        <div className="dlh-head">
          <DialogTitle className="dlh-title">{title}</DialogTitle>
          <DialogClose className="dlh-x" aria-label="Close">
            ✕
          </DialogClose>
        </div>
        {thing && <ConfirmThing {...thing} />}
        {description && <ConfirmText>{description}</ConfirmText>}
        {error && <p className="stf-error">{error}</p>}
        <div className="dlh-foot">
          <DialogClose className="dlh-cancel">Cancel</DialogClose>
          <button type="button" className={danger ? "dlh-danger" : "dlh-go"} onClick={onConfirm} disabled={busy} autoFocus>
            {confirm}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** A `.dlh` pop-up of its own (Add someone, Message all coaches): the title, then what it holds, its foot included. */
export function StaffDialog({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="dlh" aria-describedby={undefined}>
        <div className="dlh-head">
          <DialogTitle className="dlh-title">{title}</DialogTitle>
          <DialogClose className="dlh-x" aria-label="Close">
            ✕
          </DialogClose>
        </div>
        {children}
      </DialogContent>
    </Dialog>
  );
}
