"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { SETTINGS, resolveSetting, sectionOf } from "../settingsNav";
import { logoutAction } from "../../../lib/auth-actions";
import { SaveHost, useUnsaved } from "./SaveHost";
import { onGoToSetting, sayOpen } from "./settingsScroll";
import { Toaster } from "../../../components/ui/toast";
import { SectionShell } from "./Rows";

// The Settings page (27 Oct, Alex: mockup B, "go for b"; before, one page of folding sections): Training's bare
// header, then the sections as a list on the left, each its name over one quiet fact ("EUR | 21% VAT"), and the one
// picked on the right, its title (20px/600) and its parts. One section shows at a time, the others kept mounted and
// hidden, so what was typed in one stays on the page's one bar (SaveHost) and an ink dot after its name in the list
// says so. A section is its key: #invoicing on arrival picks it, the rail's Settings rows pick theirs
// (settingsScroll.ts), and the address follows the pick. Profile first when none is asked for. An old key merged into
// another section on 23 Nov (#billing, #notifications, #data; settingsNav's SETTINGS_ALIASES) picks the section that
// holds it and brings its part (`rst-part-<key>`, Rows.tsx's `Part id`) to the top.

export type SettingsSection = {
  /** Its id and the address's #key; the rail's row when SETTINGS has one. */
  key: string;
  /** Its title; the rail's label when left out. */
  label?: string;
  /** One quiet fact under its name in the list ("EUR | 21% VAT"). */
  fact?: ReactNode;
  /** A state tag after its title (Profile: Published). */
  tag?: ReactNode;
  /** On the right of its title (Plans' + Plan). A body that holds the state its action needs puts it there itself
   *  (`SectionActions`, Rows.tsx). */
  actions?: ReactNode;
  /** Its content; none (null) leaves the section out, as Support for the owner. */
  body: ReactNode;
};

/** The address with this section picked, the rest of it as it is (?coachId), less ?stripe: back from Stripe is said
 *  once, so a save drawing the page again doesn't ask Stripe again (page.tsx). */
function follow(key: string) {
  const want = `#${key}`;
  const q = new URLSearchParams(window.location.search);
  const back = q.has("stripe");
  q.delete("stripe");
  if (window.location.hash === want && !back) return;
  const search = q.toString();
  window.history.replaceState(null, "", `${window.location.pathname}${search ? `?${search}` : ""}${want}`);
}

export default function SettingsBoard({ className, sections }: { className: string; sections: SettingsSection[] }) {
  return (
    <SaveHost className={className}>
      {/* Training's header, bare: no fact line, so no room kept for one. */}
      <header className="trn-head bare">
        <div className="trn-head-main">
          <div className="trn-name-row">
            <h1 className="trn-name">Settings</h1>
          </div>
        </div>
      </header>
      <Sections sections={sections.filter((s) => s.body != null && s.body !== false)} />
      {/* Its toasts (Saved, Couldn't save, a login's errors) need a host: the page has no RedesignShell (16 Nov, Alex: the audit). */}
      <Toaster />
    </SaveHost>
  );
}

function Sections({ sections }: { sections: SettingsSection[] }) {
  const first = sections[0]?.key ?? "";
  const [picked, setPicked] = useState(first);
  const unsaved = useUnsaved();
  const keys = useRef<string[]>([]);
  const content = useRef<HTMLDivElement>(null);
  // A part to land on once its section shows (an old key: #billing is Account's Norcoach part).
  const [part, setPart] = useState<{ id: string; n: number } | null>(null);
  useEffect(() => {
    keys.current = sections.map((s) => s.key);
  });

  // From the list, the rail, a link on the page or the address: show it, the page back at the top of it.
  const pick = useRef((asked: string, fromList = false) => {
    const to = resolveSetting(asked);
    if (!to || !keys.current.includes(to.key)) return;
    const key = to.key;
    setPicked(key);
    follow(key);
    const top = content.current?.getBoundingClientRect().top ?? 0;
    if (top < 0) window.scrollBy(0, top - 24);
    if (!fromList) document.getElementById(`rst-${key}-tab`)?.focus({ preventScroll: true });
    // A pick with no part lets the last one go, so a later section (or this one again from the list) opens at its top.
    const at = to.part;
    setPart((p) => (at ? { id: at, n: (p?.n ?? 0) + 1 } : null));
  });

  // The part asked for, once its section is drawn: its top 24px under the window's; nothing when the section has no
  // such part (Billing, off for the owner and until subscriptions are switched on).
  useEffect(() => {
    if (!part) return;
    const el = document.getElementById(`rst-part-${part.id}`);
    if (el) window.scrollBy(0, el.getBoundingClientRect().top - 24);
  }, [part, picked]);

  useEffect(() => {
    const fromHash = () => window.location.hash.slice(1);
    const asked = fromHash();
    if (asked) pick.current(asked);
    const onHash = () => {
      const k = fromHash();
      if (k) pick.current(k);
    };
    window.addEventListener("hashchange", onHash);
    const off = onGoToSetting((k) => pick.current(k));
    return () => {
      window.removeEventListener("hashchange", onHash);
      off();
    };
  }, []);

  // The rail marks the one showing.
  useEffect(() => {
    sayOpen(picked);
  }, [picked]);

  const labelOf = (s: SettingsSection) => s.label ?? SETTINGS.find((x) => x.key === s.key)?.label ?? s.key;

  return (
    <div className="rst-split">
      <nav className="rst-list" aria-label="Settings sections">
        {sections.map((s) => {
          const on = picked === s.key;
          const held = unsaved.some((k) => sectionOf(k) === s.key);
          return (
            <button
              key={s.key}
              type="button"
              id={`rst-${s.key}-tab`}
              className={`rst-item${on ? " on" : ""}`}
              aria-current={on ? "page" : undefined}
              aria-controls={`rst-${s.key}`}
              onClick={() => pick.current(s.key, true)}
            >
              <span className="rst-item-name">
                {labelOf(s)}
                {held && <span className="rd-due rst-unsaved" role="img" aria-label="Not saved" title="Not saved" />}
              </span>
              {s.fact ? <span className="rst-item-fact">{s.fact}</span> : null}
            </button>
          );
        })}
        {/* Sign out, at the foot of the sections, in red words (22 Nov, Alex: Settings left the rail, Sign out with it). */}
        <button type="button" className="rst-signout" onClick={() => logoutAction()}>
          Sign out
        </button>
      </nav>
      <div className="rst-shown" ref={content}>
        {sections.map((s) => (
          <section key={s.key} id={`rst-${s.key}`} className="rst-sec" hidden={picked !== s.key} aria-labelledby={`rst-${s.key}-title`}>
            {/* Its actions on the right of its title: the page's (s.actions) and the body's own (SectionActions). */}
            <SectionShell titleId={`rst-${s.key}-title`} title={labelOf(s)} tag={s.tag} actions={s.actions}>
              {s.body}
            </SectionShell>
          </section>
        ))}
      </div>
    </div>
  );
}
