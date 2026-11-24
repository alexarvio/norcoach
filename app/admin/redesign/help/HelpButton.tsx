"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronLeftIcon, SearchIcon } from "../../../components/icons";
import type { SupportLine } from "../../../lib/support";
import { loadSupportThreadAction } from "../../../lib/supportActions";
import { helpUnreadAction, loadHelpAction, markGuideWatchedAction, type HelpState } from "../../../lib/guidesActions";
import type { GuideView } from "../../../lib/guides";
import { CLIENT_TAB_SLUG } from "../paths";
import type { RailData } from "../loaders";
import { SepJoin } from "../Sep";
import { CoachSupport } from "../settings/SupportSection";
import { GuidePlayer, GuideThumb, minutes } from "./guideMedia";
import "./help.css";

// Help on every admin screen (24 Nov, Alex: "tutorials… and… the option for them to contact us"; B of
// docs/boards/coach-help-mockup.html). A round ? at the bottom right of every framed admin screen (RailFrame mounts it
// once, so it stays from page to page), in the 60px the page keeps on its right for the chat's tab (messages.css), well
// under the tab at the top right and clear of a page's sticky bars, which sit in the page's own column. It stands aside
// while the chat is open and while a toast is up in that corner (help.css). It opens a panel over the page: Help and the
// round ghost ✕, the search over the guides, the guides for the screen the coach is on first (For this screen), then
// every other guide under its topic; a row its poster, title and length, a quiet green tick once watched. A guide opens
// in the panel on its video, then its steps; ‹ goes back. At the foot Message us, the ink pill, turns the panel into the
// coach's thread with the team (Settings' Support, the same thread: CoachSupport). The team's lines not read put a rust
// dot on the ?. The owner (the team) has no thread: the guides alone, no Message us and no dot. Prefix hlp-.

const POLL_MS = 60_000;

type Mode = { at: "list" } | { at: "guide"; id: number } | { at: "chat" };

/** The screen a guide is tagged with, as the address names it ("training", "shape-update", "feed"). A client's chat
 *  address opens the chat over their Home (RedesignShell's pageTab), and the ? stands aside while the chat is open, so
 *  the screen under it is Home. */
const screenOf = (view: string | null): string | null => {
  if (!view) return null;
  if (view === "messages") return CLIENT_TAB_SLUG.home;
  return view in CLIENT_TAB_SLUG ? CLIENT_TAB_SLUG[view as keyof typeof CLIENT_TAB_SLUG] : view;
};

function TickIcon() {
  return (
    <svg className="hlp-tick" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M2.5 6.3 5 8.6l4.5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function GuideRow({ g, watched, onOpen }: { g: GuideView; watched: boolean; onOpen: () => void }) {
  const len = minutes(g.seconds);
  return (
    <button type="button" className="hlp-row" onClick={onOpen}>
      <GuideThumb video={g.video} />
      <span className="hlp-row-w">
        <span className="hlp-row-t">{g.title}</span>
        {(len || watched) && (
          <span className="hlp-row-s">
            {len}
            {watched && (
              <>
                <TickIcon />
                <span className="sr-only">Watched</span>
              </>
            )}
          </span>
        )}
      </span>
    </button>
  );
}

export default function HelpButton({ view, rail, reread }: { /** The screen on show (paths.ts viewOfPath). */ view: string | null; /** The rail's newest read: who is signed in and their unread lines. */ rail: RailData | null; /** Reads the rail again (its Support dot, once the lines are read). */ reread: () => void }) {
  const owner = rail?.isOwner ?? false;
  const screen = screenOf(view);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>({ at: "list" });
  const [help, setHelp] = useState<HelpState | null>(null);
  const [q, setQ] = useState("");
  const [thread, setThread] = useState<SupportLine[] | null>(null);
  const fab = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);

  // The dot: the team's lines not read, from the rail's read (a newer one taken as it comes), the panel's own reads and
  // a small read every minute while the tab is on screen.
  const railUnread = rail && !rail.isOwner ? rail.supportUnread : 0;
  const [unread, setUnread] = useState(railUnread);
  const [seenRail, setSeenRail] = useState(railUnread);
  if (seenRail !== railUnread) {
    setSeenRail(railUnread);
    setUnread(railUnread);
  }
  useEffect(() => {
    if (owner) return;
    const tick = () => {
      if (document.visibilityState === "visible") helpUnreadAction().then(setUnread, () => {});
    };
    const t = window.setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [owner]);

  const close = useCallback(() => {
    setOpen(false);
    window.setTimeout(() => fab.current?.focus({ preventScroll: true }), 0);
  }, []);

  // Read afresh each time it opens, so a guide the team just published shows at once. A read that fails leaves no
  // guides, but Message us stays, so a stuck coach can still reach the team.
  const reading = useRef<Promise<void> | null>(null);
  const read = () => {
    const r = loadHelpAction().then(
      (h) => {
        setHelp(h);
        if (!h.owner) setUnread(h.unread);
      },
      () => setHelp((h) => h ?? { guides: [], watched: [], owner, unread: 0 })
    );
    reading.current = r;
    r.finally(() => {
      if (reading.current === r) reading.current = null;
    });
    return r;
  };
  // Read once ahead as the pointer or the keyboard comes to the ?, so the first open is drawn whole, not filled in after.
  const prefetch = () => {
    if (help == null && !reading.current) void read();
  };
  const show = () => {
    setOpen(true);
    setMode({ at: "list" });
    setQ("");
    void read();
  };

  // Opening the chat closes help (the chat sits over the same corner; the ? stands aside while it is open).
  useEffect(() => {
    if (!open) return;
    const frame = fab.current?.closest(".rd-frame") ?? panel.current?.closest(".rd-frame");
    if (!frame) return;
    if (frame.getAttribute("data-chat") === "open") setOpen(false);
    const mo = new MutationObserver(() => {
      if (frame.getAttribute("data-chat") === "open") setOpen(false);
    });
    mo.observe(frame, { attributes: true, attributeFilter: ["data-chat"] });
    return () => mo.disconnect();
  }, [open]);

  // Esc closes it, unless something inside answered it first (the problem form) or a dialog over it (a screenshot).
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector('[data-slot="dialog-content"]')) return;
      e.preventDefault();
      close();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [open, close]);

  // Focus into the panel as it opens: the search when there is one.
  const loaded = help != null;
  const at = mode.at;
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => (search.current ?? panel.current)?.focus({ preventScroll: true }), 0);
    return () => window.clearTimeout(t);
  }, [open, at, loaded]);

  const guides = useMemo(() => help?.guides ?? [], [help]);
  const watched = useMemo(() => new Set(help?.watched ?? []), [help]);
  const watch = (id: number) => {
    if (watched.has(id)) return;
    setHelp((h) => (h ? { ...h, watched: [...h.watched, id] } : h));
    markGuideWatchedAction(id).then(
      (w) => setHelp((h) => (h ? { ...h, watched: w } : h)),
      () => {}
    );
  };
  const openGuide = (g: GuideView) => {
    setMode({ at: "guide", id: g.id });
    // A guide with nothing to play is watched by reading it.
    if (!g.video) watch(g.id);
  };
  // The thread read afresh each time, never the one from an earlier open (CoachSupport takes its lines as it mounts).
  const messageUs = () => {
    setMode({ at: "chat" });
    setThread(null);
    loadSupportThreadAction().then(setThread, () => setThread((t) => t ?? []));
  };

  // The list: For this screen, then the rest under their topics; a search, every match in one run.
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const list: ReactNode = (() => {
    if (!help || guides.length === 0) return null;
    if (words.length) {
      const found = guides.filter((g) => {
        const hay = `${g.title} ${g.topic} ${g.steps.join(" ")}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      });
      if (!found.length) return <p className="hlp-none">No match</p>;
      return found.map((g) => <GuideRow key={g.id} g={g} watched={watched.has(g.id)} onOpen={() => openGuide(g)} />);
    }
    const here = screen ? guides.filter((g) => g.screens.includes(screen)) : [];
    const rest = guides.filter((g) => !here.includes(g));
    const topics: { topic: string; items: GuideView[] }[] = [];
    for (const g of rest) {
      const last = topics[topics.length - 1];
      if (last && last.topic === g.topic) last.items.push(g);
      else topics.push({ topic: g.topic, items: [g] });
    }
    return (
      <>
        {here.length > 0 && (
          <section className="hlp-group" aria-label="For this screen">
            <h3 className="hlp-label">For this screen</h3>
            {here.map((g) => (
              <GuideRow key={g.id} g={g} watched={watched.has(g.id)} onOpen={() => openGuide(g)} />
            ))}
          </section>
        )}
        {topics.map((t) => (
          <section key={t.topic} className="hlp-group" aria-label={t.topic}>
            <h3 className="hlp-label">{t.topic}</h3>
            {t.items.map((g) => (
              <GuideRow key={g.id} g={g} watched={watched.has(g.id)} onOpen={() => openGuide(g)} />
            ))}
          </section>
        ))}
      </>
    );
  })();

  const guide = mode.at === "guide" ? guides.find((g) => g.id === mode.id) ?? null : null;
  const canMessage = !owner && !(help?.owner ?? false);
  const title = mode.at === "guide" ? (guide?.title ?? "Help") : mode.at === "chat" ? "Message us" : "Help";

  return (
    <>
      <button
        ref={fab}
        type="button"
        className={`hlp-fab${open ? " away" : ""}`}
        aria-label={unread > 0 && !owner ? "Help, a reply from Norcoach" : "Help"}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => (open ? close() : show())}
        onPointerEnter={prefetch}
        onFocus={prefetch}
      >
        <span aria-hidden="true">?</span>
        {unread > 0 && !owner && <i className="hlp-fab-dot" aria-hidden="true" />}
      </button>
      {open && (
        <>
          <div className="hlp-dim" aria-hidden="true" onClick={close} />
          <div ref={panel} className="hlp-panel" role="dialog" aria-modal="false" aria-label={title} tabIndex={-1}>
            <div className="hlp-head">
              {mode.at !== "list" && (
                <button type="button" className="hlp-round hlp-back" aria-label="Back to the guides" onClick={() => setMode({ at: "list" })}>
                  <ChevronLeftIcon />
                </button>
              )}
              <h2 className="hlp-title">{title}</h2>
              <button type="button" className="hlp-round hlp-x" aria-label="Close" onClick={close}>
                ✕
              </button>
            </div>

            {mode.at === "list" && (
              <>
                {guides.length > 0 && (
                  <div className="hlp-search">
                    <label className="rd-search">
                      <SearchIcon />
                      <input ref={search} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search guides" aria-label="Search guides" autoComplete="off" spellCheck={false} />
                    </label>
                  </div>
                )}
                <div className="hlp-body">{list}</div>
              </>
            )}

            {mode.at === "guide" && (
              <div className="hlp-body">
                {guide && (
                  <div className="hlp-guide">
                    {guide.video && <GuidePlayer key={guide.id} video={guide.video} title={guide.title} onPlay={() => watch(guide.id)} />}
                    <p className="hlp-fact">
                      <SepJoin parts={[guide.topic, minutes(guide.seconds), watched.has(guide.id) && <span className="hlp-watched" key="w"><TickIcon /> Watched</span>]} />
                    </p>
                    {guide.steps.length > 0 && (
                      <ol className="hlp-steps">
                        {guide.steps.map((s, i) => (
                          <li key={i}>
                            <span className="hlp-stepn">{i + 1}</span>
                            <span>{s}</span>
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                )}
              </div>
            )}

            {mode.at === "chat" && <div className="hlp-chat">{thread && <CoachSupport initial={thread} look="panel" onSeen={() => {
              setUnread(0);
              reread();
            }} />}</div>}

            {mode.at !== "chat" && canMessage && help && (
              <div className="hlp-foot">
                <button type="button" className="hlp-go" onClick={messageUs} aria-label={unread > 0 ? "Message us, a reply from Norcoach" : undefined}>
                  Message us
                  {unread > 0 && <i className="rd-due" aria-hidden="true" />}
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
