"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { NorCoachLogo } from "../components/NorCoachLogo";
import { logoutAction } from "../lib/auth-actions";
import type { StaffRailCounts } from "../lib/staffRail";
import type { StaffRole } from "../lib/staffTypes";
import { viewOfPath, type StaffView, type StaffViewKey } from "./views";

// The staff admin's rail (26 Nov, Alex; docs/boards/staff-admin-mockup.html): the dark top as the coach admin's rail
// (#1c1c1e, the faint star a third past its edge), NORCOACH and STAFF in small caps, the person signed in; the views as
// the white pill while on, a count soft rust (rust on the pill); the paper under them with Sign out in words at its foot.

const ICONS: Record<StaffViewKey, ReactNode> = {
  coaches: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19c.8-3 3-4.6 5.5-4.6s4.7 1.6 5.5 4.6M16 5.2a3 3 0 0 1 0 5.6M17.6 14.6c1.6.6 2.6 2 3 4.4" />
    </svg>
  ),
  signups: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="10" cy="8" r="3.2" />
      <path d="M4 19c.8-3 3-4.6 6-4.6 1.4 0 2.6.3 3.6.9M18 13.5v6M15 16.5h6" />
    </svg>
  ),
  support: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 6.5h16v10H9l-5 3.5z" />
    </svg>
  ),
  guides: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3.5" y="5" width="17" height="12" rx="2" />
      <path d="M10.5 9v4.5l3.8-2.25z" />
    </svg>
  ),
  staff: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3.5l7 3v5c0 4.5-3 7.8-7 9-4-1.2-7-4.5-7-9v-5z" />
    </svg>
  ),
};

export function StaffRail({ name, email, role, views, counts }: { name: string | null; email: string; role: StaffRole; views: StaffView[]; counts: StaffRailCounts }) {
  const on = viewOfPath(usePathname() ?? "/");
  const shown = name?.trim() || email;
  const count = (key: StaffViewKey) => (key === "signups" ? counts.signups : key === "support" ? counts.support : 0);
  return (
    <aside className="stf-rail">
      <div className="stf-rail-top">
        <NorCoachLogo word className="stf-word" />
        <div className="stf-kind">Staff</div>
        <div className="stf-me">
          <span className="stf-me-face" aria-hidden="true">
            {shown.charAt(0).toUpperCase()}
          </span>
          <div className="stf-me-words">
            <b>{shown}</b>
            <small>{role === "owner" ? "Owner" : "Staff"}</small>
          </div>
        </div>
      </div>
      <nav className="stf-views" aria-label="Staff">
        {views.map((v) => {
          const n = count(v.key);
          return (
            <Link key={v.key} href={v.href} className={`stf-view${on === v.key ? " on" : ""}`} aria-current={on === v.key ? "page" : undefined}>
              {ICONS[v.key]}
              {v.label}
              {n > 0 && <em>{n}</em>}
            </Link>
          );
        })}
      </nav>
      <div className="stf-paper">
        <form action={logoutAction} className="stf-signout">
          <button type="submit" className="stf-act">
            Sign out
          </button>
        </form>
      </div>
    </aside>
  );
}
