"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { ChevronLeftIcon, SearchIcon } from "../../../components/icons";
import type { SupportLine } from "../../../lib/support";
import { loadSupportThreadAction } from "../../../lib/supportActions";
import { helpUnreadAction, loadHelpAction, markGuideWatchedAction, type HelpState } from "../../../lib/guidesActions";
import type { GuideView } from "../../../lib/guides";
import { clockOf, hasTimedSteps, stepAt, stepIndexAt, stepText } from "../../../lib/guideSteps";
import { CLIENT_TAB_SLUG } from "../paths";
import type { RailData } from "../loaders";
import { SepJoin } from "../Sep";
import { CoachSupport } from "../settings/SupportSection";
import { GuidePlayer, GuideThumb, minutes } from "./guideMedia";
import { ExpandIcon, GuideStage, stageable, timeFact, type StageControl, type StageInfo, type StagePlace } from "./GuideStage";
import { useSidePanel } from "./sidePanels";
import "./help.css";

// Help on every admin screen (24 Nov, Alex: "tutorials… and… the option for them to contact us", B of
// docs/boards/coach-help-mockup.html; docked like the chat since the same day, docs/boards/help-docked-mockup.html: "talk
// to support… at the same time as you can browse through the panel, and… watch a video of how to create a workout
// session and do it at the same time"). A ? tab on the window's right edge, under the chat's tab and in its shape, on
// every framed admin screen (RailFrame mounts this once, so it stays from page to page): white with the hairline while
// shut, the coach's brand (ink with none) while its panel is open, the team's lines not read a rust dot on it. It opens
// help docked as the chat is: full height on the right, the chat panel's width, a hairline on its left, no dim; from
// 1100px the page makes room for it (`data-help` on the frame, help.css), narrower it lies over the page, which stays
// usable: nothing in the page closes it. Its ✕, its tab, Esc with the keyboard in it, or the chat or the To do opening
// (one panel on the right at a time, sidePanels.ts) shut it. In it the search over the guides, the guides for the screen
// on show first (For this screen), then every other guide under its topic; a guide opens on its video, then its steps,
// the step the video is on in ink (a timed step tapped plays from it); Message us at the foot turns the panel into the
// coach's thread with the team (Settings' Support, CoachSupport). The owner (the team) has no thread: no Message us and no
// dot. A guide playing never stops for the panel (GuideStage): on another view it is a line at the top, shut it is the
// small player in a corner. Prefix hlp-.

const POLL_MS = 60_000;

type Mode = { at: "list" } | { at: "guide"; id: number } | { at: "chat" };

/** The screen a guide is tagged with, as the address names it ("training", "shape-update", "feed"). A client's chat
 *  address opens the chat over their Home (RedesignShell's pageTab), so the screen under it is Home. */
const screenOf = (view: string | null): string | null => {
  if (!view) return null;
  if (view === "messages") return CLIENT_TAB_SLUG.home;
  return view in CLIENT_TAB_SLUG ? CLIENT_TAB_SLUG[view as keyof typeof CLIENT_TAB_SLUG] : view;
};

const NO_INFO: StageInfo = { playing: false, time: 0, duration: null, started: false };

function TickIcon() {
  return (
    <svg className="hlp-tick" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M2.5 6.3 5 8.6l4.5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The small moving bars of a guide playing; still while it is paused. */
function Equaliser({ on }: { on: boolean }) {
  return (
    <span className={`hlp-eq${on ? " on" : ""}`} aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
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
  // Mounted on first use, then kept, so it slides both ways (as the chat's panel).
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>({ at: "list" });
  const [help, setHelp] = useState<HelpState | null>(null);
  const [q, setQ] = useState("");
  const [thread, setThread] = useState<SupportLine[] | null>(null);
  const tab = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const search = useRef<HTMLInputElement>(null);

  // The guide whose player is drawn (GuideStage), and what it says of itself.
  const [live, setLive] = useState<GuideView | null>(null);
  const [info, setInfo] = useState<StageInfo>(NO_INFO);
  const playing = useRef(false);
  useEffect(() => {
    playing.current = info.playing;
  }, [info.playing]);
  const control = useRef<StageControl | null>(null);
  // Drawn again only when something it says changed (a link's player reports many times a second).
  const onInfo = useCallback((p: Partial<StageInfo>) => setInfo((i) => ((Object.keys(p) as (keyof StageInfo)[]).every((k) => i[k] === p[k]) ? i : { ...i, ...p })), []);
  const takeLive = (g: GuideView | null) => {
    setLive(g);
    setInfo(g ? { ...NO_INFO, duration: g.seconds } : NO_INFO);
    playing.current = false;
  };
  // The slots it covers in the panel: the guide view's video, and the thumb of the line on any other view.
  const [dockSlot, setDockSlot] = useState<HTMLDivElement | null>(null);
  const [lineSlot, setLineSlot] = useState<HTMLSpanElement | null>(null);

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

  // Shut: a guide playing carries on as the small player; one paused goes with the panel.
  const close = useCallback((refocus = false) => {
    setOpen(false);
    if (!playing.current) {
      setLive(null);
      setInfo(NO_INFO);
    }
    if (refocus) window.setTimeout(() => tab.current?.focus({ preventScroll: true }), 0);
  }, []);
  // One panel on the right at a time: the chat or the To do opening shuts help; help opening shuts them. The frame
  // makes room for it as for the chat (help.css, `.rd-frame[data-help="open"]`).
  useSidePanel("help", open, close, "data-help");

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
  const show = (at: Mode = { at: "list" }) => {
    setMode(at);
    setQ("");
    void read();
    // A chat marked open on a screen that has no chat any more never keeps the frame's room (sidePanels closes a real one).
    const frame = tab.current?.closest(".rd-frame");
    if (frame?.getAttribute("data-chat") === "open" && !document.querySelector(".rd-chatpanel.open")) frame.removeAttribute("data-chat");
    if (mounted) return setOpen(true);
    // In shut first, then open a frame later, so even the first one slides.
    setMounted(true);
    requestAnimationFrame(() => requestAnimationFrame(() => setOpen(true)));
  };

  // Focus into the panel as it opens: the search when there is one. Only from the tab, the panel itself, the small
  // player or nowhere: the page stays usable while help is open, so a field the coach went on to type in keeps the
  // keyboard when the guides' read lands.
  const loaded = help != null;
  const at = mode.at;
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => {
      const a = document.activeElement;
      if (a && a !== document.body && a !== tab.current && !panel.current?.contains(a) && !a.closest(".hlp-stage")) return;
      (search.current ?? panel.current)?.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(t);
  }, [open, at, loaded]);

  // Esc shuts it only while the keyboard is in it, unless something inside answered it first (the problem form) or a
  // dialog is over it (a screenshot shown big).
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    if (document.querySelector('[data-slot="dialog-content"]')) return;
    e.preventDefault();
    close(true);
  };

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
  // Leaving a guide's own view: playing, it goes on as the line at the top; paused, it goes.
  const leaveGuide = () => {
    if (live && !playing.current) takeLive(null);
  };
  const openGuide = (g: GuideView) => {
    setMode({ at: "guide", id: g.id });
    if (stageable(g.video)) {
      if (live?.id !== g.id) takeLive(g);
    } else {
      leaveGuide();
      // A guide with nothing to play is watched by reading it.
      if (!g.video) watch(g.id);
    }
  };
  const toList = () => {
    if (mode.at === "guide") leaveGuide();
    setMode({ at: "list" });
  };
  // The thread read afresh each time, never the one from an earlier open (CoachSupport takes its lines as it mounts).
  const messageUs = () => {
    if (mode.at === "guide") leaveGuide();
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
        const hay = `${g.title} ${g.topic} ${g.steps.map(stepText).join(" ")}`.toLowerCase();
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

  // The guide on show: from the list, else the one playing (opened from the small player before the list is read).
  const guide = mode.at === "guide" ? (guides.find((g) => g.id === mode.id) ?? (live?.id === mode.id ? live : null)) : null;
  const canMessage = !owner && !(help?.owner ?? false);
  const title = mode.at === "guide" ? (guide?.title ?? "Help") : mode.at === "chat" ? "Message us" : "Help";

  // Where the player is: over the guide's own video slot, a line at the top of any other view, or the small player.
  const inLiveGuide = open && live != null && mode.at === "guide" && mode.id === live.id;
  const place: StagePlace | null = !live ? null : !open ? "mini" : inLiveGuide ? "dock" : "line";
  // The step the video is on, once it has started; `Step 4 of 5` for the small player when the steps are timed.
  const liveSteps = live?.steps ?? [];
  const nowStep = live && info.started ? stepIndexAt(liveSteps, info.time) : -1;
  const miniFact = live && hasTimedSteps(liveSteps) ? `Step ${Math.max(1, nowStep + 1)} of ${liveSteps.length}` : timeFact(info.time, info.duration);
  const expand = () => {
    if (!live) return;
    show({ at: "guide", id: live.id });
  };
  const stop = () => takeLive(null);

  const back = mode.at === "list" ? null : mode.at === "chat" ? "Help" : "Guides";

  return (
    <>
      <button
        ref={tab}
        type="button"
        className={`hlp-tab${open ? " open" : ""}`}
        aria-label={open ? "Close help" : unread > 0 && !owner ? "Help, a reply from Norcoach" : "Help"}
        title={open ? "Close help" : "Help"}
        aria-expanded={open}
        aria-controls={mounted ? "hlp-panel" : undefined}
        onClick={() => (open ? close() : show())}
        onPointerEnter={prefetch}
        onFocus={prefetch}
      >
        <span className="hlp-tab-q" aria-hidden="true">
          ?
        </span>
        {unread > 0 && !owner && !open && <i className="hlp-tab-dot" aria-hidden="true" />}
      </button>
      {mounted && (
        <aside id="hlp-panel" ref={panel} className={`hlp-panel${open ? " open" : ""}`} aria-label={title} aria-hidden={!open} inert={open ? undefined : true} tabIndex={-1} onKeyDown={onKey}>
          {back && (
            <button type="button" className="hlp-backrow" onClick={toList}>
              <ChevronLeftIcon />
              {back}
            </button>
          )}
          <div className={`hlp-head${back ? " under" : ""}`}>
            <h2 className="hlp-title">{title}</h2>
            <button type="button" className="hlp-round hlp-x" aria-label="Close help" onClick={() => close(true)}>
              ✕
            </button>
          </div>

          {/* A guide playing, on any view but its own: a line at the top, its sound going on; a tap brings it back up. */}
          {live && open && !inLiveGuide && (
            <button type="button" className="hlp-now" onClick={() => setMode({ at: "guide", id: live.id })} aria-label={`Back to ${live.title}`}>
              <span ref={setLineSlot} className="hlp-now-thumb" aria-hidden="true" />
              <span className="hlp-now-w">
                <span className="hlp-now-t">{live.title}</span>
                <span className="hlp-now-s">
                  <Equaliser on={info.playing} />
                  {timeFact(info.time, info.duration)}
                </span>
              </span>
              <span className="hlp-now-go" aria-hidden="true">
                <ExpandIcon />
              </span>
            </button>
          )}

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
            <>
              {/* The video's place, outside the scroll, so it stays in sight while the steps are read. The player
                  itself is the stage's, laid over it (GuideStage). */}
              {guide && stageable(guide.video) && <div ref={setDockSlot} className="hlp-slot" />}
              {guide && guide.video && !stageable(guide.video) && (
                <div className="hlp-slotwrap">
                  <GuidePlayer key={guide.id} video={guide.video} title={guide.title} onPlay={() => watch(guide.id)} />
                </div>
              )}
              <div className="hlp-body">
                {guide && (
                  <div className="hlp-guide">
                    <p className="hlp-fact">
                      <SepJoin parts={[guide.topic, minutes(guide.seconds), watched.has(guide.id) && <span className="hlp-watched" key="w"><TickIcon /> Watched</span>]} />
                    </p>
                    {guide.steps.length > 0 && (
                      <ol className="hlp-steps">
                        {guide.steps.map((s, i) => {
                          const t = stepAt(s);
                          const now = inLiveGuide && i === nowStep;
                          const body = (
                            <>
                              <span className="hlp-stepn">{i + 1}</span>
                              <span>{stepText(s)}</span>
                            </>
                          );
                          return (
                            <li key={i} className={now ? "at" : undefined} aria-current={now ? "step" : undefined}>
                              {t != null && stageable(guide.video) ? (
                                <button type="button" className="hlp-stepgo" title={`Play from ${clockOf(t)}`} onClick={() => control.current?.seek(t)}>
                                  {body}
                                </button>
                              ) : (
                                body
                              )}
                            </li>
                          );
                        })}
                      </ol>
                    )}
                  </div>
                )}
              </div>
            </>
          )}

          {mode.at === "chat" && (
            <div className="hlp-chat">
              {thread && (
                <CoachSupport
                  initial={thread}
                  look="panel"
                  onSeen={() => {
                    setUnread(0);
                    reread();
                  }}
                />
              )}
            </div>
          )}

          {mode.at !== "chat" && canMessage && help && (
            <div className="hlp-foot">
              <button type="button" className="hlp-go" onClick={messageUs} aria-label={unread > 0 ? "Message us, a reply from Norcoach" : undefined}>
                Message us
                {unread > 0 && <i className="rd-due" aria-hidden="true" />}
              </button>
            </div>
          )}
        </aside>
      )}
      {live && place && stageable(live.video) && (
        <GuideStage
          key={live.id}
          video={live.video}
          title={live.title}
          place={place}
          slot={place === "dock" ? dockSlot : place === "line" ? lineSlot : null}
          view={mode.at === "guide" ? `guide-${mode.id}` : mode.at}
          controlRef={control}
          onInfo={onInfo}
          onWatched={() => watch(live.id)}
          onExpand={expand}
          onStop={stop}
          onKeyDown={place === "dock" ? onKey : undefined}
          fact={miniFact}
        />
      )}
    </>
  );
}
