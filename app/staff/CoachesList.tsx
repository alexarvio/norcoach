"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { StaffCoachFigures, StaffCoachRow } from "../lib/staffCoaches";
import { typedNorcode } from "../lib/norcode";
import { dayMonth } from "../lib/dayMonth";
import { daysAgo, lastInWords, lengthSince } from "../lib/staffWords";
import { SepJoin, StaffWho } from "./parts";

// Coaches (26 Nov, Alex; docs/boards/staff-admin-mockup.html, "1 · Coaches"): the figures, then a row a coach. The
// search finds a coach by name, business, email or Norcode (with or without its NC-, any case, spaces left out). A row
// opens the coach. Pays, Paying and A month come only for someone who may see what coaches pay (`money`); without it
// they are not in the props at all.

const squash = (s: string) => s.toLowerCase().replace(/\s+/g, "");

function matches(r: StaffCoachRow, q: string): boolean {
  const t = squash(q);
  if (!t) return true;
  if ([r.name, r.business ?? "", r.email].some((x) => squash(x).includes(t))) return true;
  if (!r.norcode) return false;
  const code = typedNorcode(q);
  const own = r.norcode.slice(3);
  // A bare "nc" or "nc-" is the start of every code.
  if (!code) return /^nc-?$/i.test(q.trim());
  return own.includes(code);
}

export function CoachesList({ figures, rows, money }: { figures: StaffCoachFigures; rows: StaffCoachRow[]; money: boolean }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const shown = useMemo(() => rows.filter((r) => matches(r, q)), [rows, q]);
  const perCoach = figures.coaches ? Math.round(figures.clients / figures.coaches) : 0;
  const cols = money ? 7 : 6;

  return (
    <div className="stf-screen">
      <div className="stf-head">
        <h1 className="stf-title">Coaches</h1>
        <div className="stf-head-right">
          <label className="rd-search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
              <circle cx="11" cy="11" r="6" />
              <path d="M20 20l-4.2-4.2" />
            </svg>
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, business, email or Norcode" aria-label="Find a coach" />
          </label>
        </div>
      </div>

      <div className="stf-card stf-figs" style={{ ["--stf-figs" as string]: money ? 4 : 2 }}>
        <div className="stf-fig">
          <small>Coaches</small>
          <b>{figures.coaches}</b>
          <span>{figures.newThisMonth > 0 ? `+${figures.newThisMonth} in ${figures.month}` : " "}</span>
        </div>
        {money && figures.paying && (
          <div className="stf-fig">
            <small>Paying</small>
            <b>{figures.paying.count}</b>
            <span>
              {figures.paying.trial || figures.paying.free ? <SepJoin parts={[figures.paying.trial ? `${figures.paying.trial} on trial` : null, figures.paying.free ? `${figures.paying.free} free` : null]} /> : " "}
            </span>
          </div>
        )}
        {money && figures.aMonth && (
          <div className="stf-fig">
            <small>A month</small>
            <b>{figures.aMonth.total}</b>
            <span>{figures.aMonth.each ? `${figures.aMonth.each} a coach` : <span className="stf-dash">—</span>}</span>
          </div>
        )}
        <div className="stf-fig">
          <small>Clients</small>
          <b>{figures.clients}</b>
          <span>{`${perCoach} a coach`}</span>
        </div>
      </div>

      <div className="stf-card">
        {rows.length === 0 ? (
          <div className="stf-empty">None yet</div>
        ) : (
          <table className="stf-table">
            <thead>
              <tr>
                <th>Coach</th>
                <th>Plan</th>
                {money && <th className="num">Pays</th>}
                <th>With us</th>
                <th className="num">Clients</th>
                <th>Last in</th>
                <th>Region</th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 ? (
                <tr>
                  <td colSpan={cols} className="stf-foldcell">
                    <div className="stf-empty">No match</div>
                  </td>
                </tr>
              ) : (
                shown.map((r) => {
                  const last = lastInWords(r.lastInAt);
                  const late = !!r.lastInAt && daysAgo(r.lastInAt) > 10;
                  const open = () => router.push(r.href);
                  return (
                    <tr
                      key={r.id}
                      className="stf-link"
                      tabIndex={0}
                      onClick={open}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          open();
                        }
                      }}
                      onMouseEnter={() => router.prefetch(r.href)}
                    >
                      <td>
                        <StaffWho name={r.name} photo={r.photo} sub={<SepJoin parts={[r.business, r.norcode]} />} />
                      </td>
                      <td>
                        <span className={`stf-state${r.plan.tone ? ` ${r.plan.tone}` : ""}`}>{r.plan.word}</span>
                      </td>
                      {money && <td className={`num${!r.pays || r.pays.trial ? " stf-dash" : ""}`}>{r.pays ? r.pays.words : "—"}</td>}
                      <td>
                        <SepJoin parts={[`Since ${dayMonth(r.joinedAt)}`, lengthSince(r.joinedAt)]} />
                      </td>
                      <td className="num">{r.clients}</td>
                      <td className={late ? "stf-rust" : undefined}>{last ?? <span className="stf-dash">—</span>}</td>
                      <td>{r.region ?? <span className="stf-dash">—</span>}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
