"use client";

import { Fragment, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { addStaffAction, removeStaffAction, setStaffPermAction, setStaffRoleAction } from "../../lib/staffActions";
import { STAFF_PERMS, STAFF_PERM_WORDS, staffFirst, type StaffPerm, type StaffRole, type StaffRow } from "../../lib/staffTypes";
import { dayMonth } from "../../lib/dayMonth";
import { lastInWords } from "../../lib/staffWords";
import { StaffConfirm, StaffDialog, StaffFold, StaffSwitch, StaffWho } from "../parts";

// The Staff screen (26 Nov, Alex: docs/boards/staff-admin-mockup.html, "3 · Staff"): a row a person, Person | Role |
// Added | Last in; a row opens what they can do under it on the shared fold, a switch a thing (an owner's row says they
// can do everything); Remove {First} in red words and Make owner / Make staff, each asking first. + Add someone opens the
// `.dlh` pop-up: Email, Owner | Staff, Add. Each change saves at once.

type Ask = { kind: "remove" | "role"; row: StaffRow } | null;

export function StaffScreen({ rows }: { rows: StaffRow[] }) {
  const router = useRouter();
  const [open, setOpen] = useState<string | null>(null);
  const [perms, setPerms] = useState<Record<string, StaffPerm[]>>({});
  const [error, setError] = useState<{ email: string; text: string } | null>(null);
  const [ask, setAsk] = useState<Ask>(null);
  const [askError, setAskError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, start] = useTransition();

  const permsOf = (r: StaffRow) => perms[r.email] ?? r.perms;

  const toggle = (r: StaffRow, perm: StaffPerm, on: boolean) => {
    const before = permsOf(r);
    const next = on ? STAFF_PERMS.filter((p) => p === perm || before.includes(p)) : before.filter((p) => p !== perm);
    setPerms((m) => ({ ...m, [r.email]: next }));
    setError(null);
    void setStaffPermAction(r.email, perm, on).then((res) => {
      if (res.error) {
        setPerms((m) => ({ ...m, [r.email]: before }));
        setError({ email: r.email, text: res.error });
      } else router.refresh();
    });
  };

  const confirm = () => {
    if (!ask) return;
    const { kind, row } = ask;
    setAskError(null);
    start(async () => {
      const res = kind === "remove" ? await removeStaffAction(row.email) : await setStaffRoleAction(row.email, row.role === "owner" ? "staff" : "owner");
      if (res.error) {
        setAskError(res.error);
        return;
      }
      setAsk(null);
      if (kind === "remove" && open === row.email) setOpen(null);
      setPerms((m) => {
        const { [row.email]: _gone, ...rest } = m;
        return rest;
      });
      router.refresh();
    });
  };

  const first = ask ? staffFirst(ask.row) : "";
  return (
    <div className="stf-screen">
      <div className="stf-head">
        <h1 className="stf-title">Staff</h1>
        <div className="stf-head-right">
          <button type="button" className="stf-pill" onClick={() => setAdding(true)}>
            + Add someone
          </button>
        </div>
      </div>
      <div className="stf-card" style={{ marginTop: 20 }}>
        <table className="stf-table">
          <thead>
            <tr>
              <th>Person</th>
              <th>Role</th>
              <th>Added</th>
              <th>Last in</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const isOpen = open === r.email;
              const last = lastInWords(r.lastInAt, { now: true });
              const can = permsOf(r);
              const fixed = r.envOwner || r.you;
              return (
                <Fragment key={r.email}>
                  <tr
                    className={`stf-link${isOpen ? " open" : ""}`}
                    tabIndex={0}
                    aria-expanded={isOpen}
                    onClick={() => setOpen(isOpen ? null : r.email)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setOpen(isOpen ? null : r.email);
                      }
                    }}
                  >
                    <td>
                      <StaffWho name={r.name ?? r.email} sub={r.name ? r.email : null} />
                    </td>
                    <td>
                      <span className={`stf-state ${r.role === "owner" ? "ink" : "grey"}`}>{r.role === "owner" ? "Owner" : "Staff"}</span>
                    </td>
                    <td>{r.addedAt ? dayMonth(r.addedAt) : <span className="stf-dash">—</span>}</td>
                    <td>{last ?? <span className="stf-dash">Not yet</span>}</td>
                  </tr>
                  <tr>
                    <td colSpan={4} className="stf-foldcell">
                      <StaffFold open={isOpen}>
                        <div className="stf-perms">
                          {r.role === "owner" ? (
                            <p className="stf-pall">Every screen and action</p>
                          ) : (
                            <>
                              <div className="stf-plab">What {staffFirst(r)} can do</div>
                              {STAFF_PERMS.map((p) => (
                                <div className="stf-perm" key={p}>
                                  <div>
                                    <b>{STAFF_PERM_WORDS[p].name}</b>
                                    <small>{STAFF_PERM_WORDS[p].fact}</small>
                                  </div>
                                  <StaffSwitch on={can.includes(p)} label={STAFF_PERM_WORDS[p].name} onChange={(v) => toggle(r, p, v)} />
                                </div>
                              ))}
                            </>
                          )}
                          {error?.email === r.email && <p className="stf-error">{error.text}</p>}
                          {!fixed && (
                            <div className="stf-pfoot">
                              <button type="button" className="stf-act red" onClick={() => (setAskError(null), setAsk({ kind: "remove", row: r }))}>
                                Remove {staffFirst(r)}
                              </button>
                              <button type="button" className="stf-act" onClick={() => (setAskError(null), setAsk({ kind: "role", row: r }))}>
                                {r.role === "owner" ? "Make staff" : "Make owner"}
                              </button>
                            </div>
                          )}
                        </div>
                      </StaffFold>
                    </td>
                  </tr>
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <StaffConfirm
        open={!!ask}
        onClose={() => setAsk(null)}
        title={ask?.kind === "remove" ? `Remove ${first}?` : ask?.row.role === "owner" ? `Make ${first} staff?` : `Make ${first} an owner?`}
        thing={ask ? { name: ask.row.name ?? ask.row.email, facts: [ask.row.name ? ask.row.email : null, ask.row.role === "owner" ? "Owner" : "Staff"] } : undefined}
        description={
          ask?.kind === "remove"
            ? `${first} can no longer get into the staff admin.`
            : ask?.row.role === "owner"
              ? `${first} keeps what was switched on for them before.`
              : `${first} can do everything, including adding people and setting what they can do.`
        }
        confirm={ask?.kind === "remove" ? "Remove" : ask?.row.role === "owner" ? "Make staff" : "Make owner"}
        danger={ask?.kind === "remove"}
        busy={busy}
        error={askError}
        onConfirm={confirm}
      />
      <AddSomeone open={adding} onClose={() => setAdding(false)} onAdded={() => (setAdding(false), router.refresh())} />
    </div>
  );
}

/** + Add someone: Email, Owner | Staff, Add. */
function AddSomeone({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: () => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<StaffRole>("staff");
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const close = () => {
    setEmail("");
    setRole("staff");
    setError(null);
    onClose();
  };
  const add = () =>
    start(async () => {
      const res = await addStaffAction(email.trim(), role);
      if (res.error) {
        setError(res.error);
        return;
      }
      setEmail("");
      setRole("staff");
      setError(null);
      onAdded();
    });
  return (
    <StaffDialog open={open} onClose={close} title="Add someone">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (ok && !busy) add();
        }}
        style={{ display: "contents" }}
      >
        <label className="dlh-field">
          <span className="dlh-label">Email</span>
          <input className="dlh-line" type="email" inputMode="email" autoComplete="off" value={email} onChange={(e) => (setEmail(e.target.value), setError(null))} maxLength={200} autoFocus />
        </label>
        <div className="dlh-field">
          <span className="dlh-label">Role</span>
          <div className="dlh-seg" role="radiogroup" aria-label="Role">
            {(["owner", "staff"] as const).map((r) => (
              <button key={r} type="button" role="radio" aria-checked={role === r} className={role === r ? "on" : undefined} onClick={() => setRole(r)}>
                {r === "owner" ? "Owner" : "Staff"}
              </button>
            ))}
          </div>
        </div>
        {error && <p className="stf-error">{error}</p>}
        <div className="dlh-foot">
          <button type="button" className="dlh-cancel" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="dlh-go" disabled={!ok || busy}>
            Add
          </button>
        </div>
      </form>
    </StaffDialog>
  );
}
