"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { clockOf } from "../../../lib/guideSteps";
import { isUploadedVideo, posterOf, vimeoId, ytId } from "./guideMedia";

// The one player a guide plays in (24 Nov, Alex: docs/boards/help-docked-mockup.html, "watch a video of how to create a
// workout session and do it at the same time"). A playing guide never restarts or stops as the help panel changes view
// or shuts, so its video (or its YouTube or Vimeo frame) is drawn once, in a fixed layer of its own beside the panel
// (HelpButton, mounted once by RailFrame, so it follows the coach from screen to screen), and only moved, never put
// anywhere else in the page (that would load it again):
//   dock  over the panel's video slot, in the guide's own view;
//   line  over the small thumb of the line at the top of another view (Message us, the list), shrunk by a transform so
//         the player keeps its size and goes on playing, its sound with it;
//   mini  the small player, 300px wide, in a corner of the window just inside the right-edge gutter (never over the edge
//         tabs), the video then a dark bar with the guide's name and where it is, ⤢ opening help on it, × stopping it;
//         dragged, it snaps to the nearest of four corners, remembered on the device.
// Whether it plays: an uploaded clip's own events; YouTube's and Vimeo's players by their postMessage APIs (YouTube's
// widget channel with enablejsapi=1, Vimeo's addEventListener). Prefix hlp-.

export type StagePlace = "dock" | "line" | "mini";
export type StageInfo = { playing: boolean; time: number; duration: number | null; started: boolean };
export type StageControl = { seek: (t: number) => void };

/** Whether a video plays in the stage: an uploaded clip, or a YouTube or Vimeo link. Any other link opens in a tab. */
export const stageable = (video: string | null): video is string => !!video && (isUploadedVideo(video) || !!ytId(video) || !!vimeoId(video));

type Corner = "br" | "bl" | "tr" | "tl";
const CORNER_KEY = "norcoach:help-player-corner";
const MINI_W = 300;
/** The mini player's dark bar under the video. */
const MINI_BAR = 46;
/** The page keeps 60px on its right for the edge tabs (messages.css); the player sits 8px inside that. */
const EDGE = 68;
const AIR = 16;
/** How long the stage follows its slot frame by frame after a change (the panel's 280ms slide, and a little more). */
const FOLLOW_MS = 460;
const GLIDE_MS = 340;

const readCorner = (): Corner => {
  try {
    const c = window.localStorage.getItem(CORNER_KEY);
    if (c === "br" || c === "bl" || c === "tr" || c === "tl") return c;
  } catch {}
  return "br";
};

type Box = { top: number; left: number; width: number; scale: number; radius: number; under?: boolean };
const sameBox = (a: Box | null, b: Box) => !!a && Math.abs(a.top - b.top) < 0.5 && Math.abs(a.left - b.left) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.scale - b.scale) < 0.001 && !!a.under === !!b.under;

/** The narrowest the small player gets beside an open chat or To do before it goes under them instead. */
const MINI_MIN = 200;
/** What it rises above in a bottom corner, never covering it: Settings' Save bar, a tab's pending bar, a toast. */
const BELOW = ".rd.rst .rst-bar, .rd-pending.rd-pending-sticky, [data-sonner-toast]";

/** Where the small player sits in a corner: just left of the right-edge gutter, and beside an open chat (it holds the
 *  right side, the tabs riding its edge) rather than on them or their tabs, narrower when the room beside
 *  them is short; with not even that, it lies under them (`under`), still playing. In a bottom corner it rises above a
 *  Save bar or a toast under it. */
function miniBox(corner: Corner): Box & { under: boolean } {
  const vw = document.documentElement.clientWidth || window.innerWidth;
  const vh = window.innerHeight;
  const frame = document.querySelector(".rd-frame");
  // The To do drops from its pill now (25 Nov), holding no side: only the chat does.
  const side = frame?.getAttribute("data-chat") === "open" ? Math.min(460, vw) : 0;
  // The tabs ride the panel's edge, so the player keeps the same gutter from it as from the window's edge.
  const right = side + EDGE;
  const room = vw - right - AIR;
  const under = side > 0 && room < MINI_MIN;
  const width = side && !under ? Math.min(MINI_W, room) : Math.min(MINI_W, vw - 2 * AIR);
  const height = (width * 9) / 16 + MINI_BAR;
  const left = corner[1] === "l" || under ? AIR : Math.max(AIR, vw - right - width);
  let top = corner[0] === "t" ? AIR : Math.max(AIR, vh - height - 18);
  if (corner[0] === "b") {
    // Rise above anything in BELOW that shares its columns, until nothing is under it.
    const rects = Array.from(document.querySelectorAll(BELOW), (el) => el.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < vh && r.left < left + width && r.right > left);
    for (let moved = true, n = 0; moved && n < 6; n++) {
      moved = false;
      for (const r of rects) {
        if (r.top < top + height + 12 && r.bottom > top) {
          top = Math.max(AIR, r.top - height - 12);
          moved = true;
        }
      }
      if (top === AIR) break;
    }
  }
  return { top, left, width, scale: 1, radius: 14, under };
}

export function GuideStage({ video, title, place, slot, view, controlRef, onInfo, onWatched, onExpand, onStop, onKeyDown, fact }: {
  video: string;
  title: string;
  place: StagePlace;
  /** What it covers in the panel: the guide view's video slot (dock) or the line's thumb (line). */
  slot: HTMLElement | null;
  /** The panel's view: the line's thumb is the same element on every view, but moves with what sits over it (the
   *  back row on Message us), so a new view follows it afresh. */
  view?: string;
  controlRef: { current: StageControl | null };
  onInfo: (p: Partial<StageInfo>) => void;
  /** Once it first plays (the guide watched). */
  onWatched: () => void;
  onExpand: () => void;
  onStop: () => void;
  /** The panel's keys (Esc shuts help) while it lies over the guide view's slot, as if it were in the panel. */
  onKeyDown?: (e: ReactKeyboardEvent) => void;
  /** Where it is, for the small player's bar: `Step 4 of 5`, else the time. */
  fact: string;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Box | null>(null);
  // Drawn only once a guide is opened in the browser, never on the server, so the device's corner is read at once.
  const [corner, setCorner] = useState<Corner>(() => (typeof window === "undefined" ? "br" : readCorner()));
  // The width it had in the dock, kept for the line (it shrinks from that by a transform).
  const dockWidth = useRef(0);
  const [drag, setDrag] = useState<{ top: number; left: number } | null>(null);
  const dragFrom = useRef<{ x: number; y: number; top: number; left: number; id: number } | null>(null);

  const measure = useCallback(() => {
    let next: Box | null = null;
    if (place === "mini") next = miniBox(corner);
    else {
      const r = slot?.getBoundingClientRect();
      if (!r || r.width < 1) return;
      if (place === "dock") {
        dockWidth.current = r.width;
        next = { top: r.top, left: r.left, width: r.width, scale: 1, radius: 12 };
      } else {
        const vw = document.documentElement.clientWidth || window.innerWidth;
        const w = dockWidth.current || Math.max(240, Math.min(460, vw) - 36);
        const scale = r.width / w;
        next = { top: r.top, left: r.left, width: w, scale, radius: 6 / scale };
      }
    }
    if (next) setBox((b) => (sameBox(b, next) ? b : next));
  }, [place, slot, corner]);

  // Glides between places (the shrink to the line or the corner and back), not on its first draw nor while dragged.
  const [glide, setGlide] = useState(false);
  const lastPlace = useRef<StagePlace | null>(null);
  useLayoutEffect(() => {
    const was = lastPlace.current;
    lastPlace.current = place;
    if (was == null || was === place) return;
    setGlide(true);
    const t = window.setTimeout(() => setGlide(false), GLIDE_MS);
    return () => window.clearTimeout(t);
  }, [place]);

  // Follow the slot frame by frame for a moment after anything moves it (the panel sliding in, a view drawn), then on
  // resizes alone.
  useLayoutEffect(() => {
    let raf = 0;
    let until = 0;
    const loop = () => {
      measure();
      if (performance.now() < until) raf = requestAnimationFrame(loop);
    };
    const follow = () => {
      until = performance.now() + FOLLOW_MS;
      cancelAnimationFrame(raf);
      loop();
    };
    follow();
    window.addEventListener("resize", follow);
    const ro = slot && typeof ResizeObserver !== "undefined" ? new ResizeObserver(follow) : null;
    if (ro && slot) ro.observe(slot);
    // The chat opening moves the corner it sits in.
    const frame = document.querySelector(".rd-frame");
    const mo = frame ? new MutationObserver(follow) : null;
    if (mo && frame) mo.observe(frame, { attributes: true, attributeFilter: ["data-chat", "data-help"] });
    // In the corner, a Save bar or a toast coming in (or a page scrolled to its foot, where a sticky bar rests higher)
    // lifts it: looked at a few times a second and on scrolling, cheap, nothing drawn unless it moves.
    const mini = place === "mini";
    const look = mini ? window.setInterval(measure, 400) : 0;
    if (mini) window.addEventListener("scroll", measure, { capture: true, passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", follow);
      ro?.disconnect();
      mo?.disconnect();
      if (mini) {
        window.clearInterval(look);
        window.removeEventListener("scroll", measure, { capture: true });
      }
    };
  }, [measure, slot, place, view]);

  // Dragged by its bar, then let go into the nearest corner.
  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (place !== "mini" || !box || e.button !== 0 || (e.target as Element).closest("button")) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragFrom.current = { x: e.clientX, y: e.clientY, top: box.top, left: box.left, id: e.pointerId };
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const f = dragFrom.current;
    if (!f || f.id !== e.pointerId) return;
    const dx = e.clientX - f.x;
    const dy = e.clientY - f.y;
    if (!drag && Math.abs(dx) + Math.abs(dy) < 4) return;
    setDrag({ top: f.top + dy, left: f.left + dx });
  };
  const up = (e: ReactPointerEvent<HTMLDivElement>) => {
    const f = dragFrom.current;
    if (!f || f.id !== e.pointerId) return;
    dragFrom.current = null;
    if (!drag || !stage.current) return setDrag(null);
    const r = stage.current.getBoundingClientRect();
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const c: Corner = `${r.top + r.height / 2 < window.innerHeight / 2 ? "t" : "b"}${r.left + r.width / 2 < vw / 2 ? "l" : "r"}`;
    try {
      window.localStorage.setItem(CORNER_KEY, c);
    } catch {}
    setDrag(null);
    setGlide(true);
    window.setTimeout(() => setGlide(false), GLIDE_MS);
    setCorner(c);
  };

  const at = drag && box ? { ...box, top: drag.top, left: drag.left } : box;
  const style = at
    ? { top: at.top, left: at.left, width: at.width, transform: at.scale !== 1 ? `scale(${at.scale})` : undefined, borderRadius: at.radius }
    : { visibility: "hidden" as const };

  return (
    <div
      ref={stage}
      className={`hlp-stage ${place}${glide && !drag ? " glide" : ""}${drag ? " dragging" : ""}${place === "mini" && box?.under ? " under" : ""}`}
      style={style}
      role={place === "mini" ? "region" : undefined}
      aria-label={place === "mini" ? `Guide: ${title}` : undefined}
      inert={place === "line" ? true : undefined}
      onKeyDown={onKeyDown}
    >
      <div className="hlp-stage-media">
        <StageMedia video={video} title={title} controlRef={controlRef} onInfo={onInfo} onWatched={onWatched} />
      </div>
      {/* The small player's bar; only drawn in the corner, after the video, so the video itself never moves in the tree. */}
      <div className="hlp-mini-bar" hidden={place !== "mini"} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onClick={(e) => e.preventDefault()}>
        <span className="hlp-mini-w">
          <span className="hlp-mini-t">{title}</span>
          <span className="hlp-mini-s">{fact}</span>
        </span>
        <button type="button" className="hlp-mini-btn" aria-label={`Open ${title} in help`} title="Open in help" onClick={onExpand}>
          <ExpandIcon />
        </button>
        <button type="button" className="hlp-mini-btn" aria-label={`Stop ${title}`} title="Stop" onClick={onStop}>
          ✕
        </button>
      </div>
    </div>
  );
}

export function ExpandIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M8.5 1.75h3.75V5.5M12.25 1.75 8 6M5.5 12.25H1.75V8.5M1.75 12.25 6 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const PLAY = "M8 5v14l11-7z";
const YT_ORIGIN = "https://www.youtube.com";
const VIMEO_ORIGIN = "https://player.vimeo.com";
const YT_STATE_PLAYING = 1;
const YT_STATE_BUFFERING = 3;
const YT_STATE_UNSTARTED = -1;
const YT_STATE_CUED = 5;

/** The video itself: an uploaded clip with its own controls, or a link's poster that turns into its player on a click. */
function StageMedia({ video, title, controlRef, onInfo, onWatched }: { video: string; title: string; controlRef: { current: StageControl | null }; onInfo: (p: Partial<StageInfo>) => void; onWatched: () => void }) {
  const clip = useRef<HTMLVideoElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const yt = ytId(video);
  const vm = yt ? null : vimeoId(video);
  const uploaded = isUploadedVideo(video);
  // A link plays once clicked (its poster first), from `from` seconds.
  const [from, setFrom] = useState<number | null>(null);
  const [broken, setBroken] = useState(false);
  const report = useRef(onInfo);
  const watched = useRef(onWatched);
  useEffect(() => {
    report.current = onInfo;
    watched.current = onWatched;
  });
  // Whole seconds only, so the panel draws again once a second, not with every tick.
  const lastSecond = useRef(-1);
  const tell = useCallback((p: Partial<StageInfo>) => {
    if (p.time != null) {
      const s = Math.floor(p.time);
      if (s === lastSecond.current && Object.keys(p).length === 1) return;
      lastSecond.current = s;
      p = { ...p, time: s };
    }
    report.current(p);
  }, []);

  const send = useCallback(
    (msg: Record<string, unknown>) => {
      const win = frame.current?.contentWindow;
      if (!win) return;
      try {
        if (yt) win.postMessage(JSON.stringify({ ...msg, id: 1, channel: "widget" }), YT_ORIGIN);
        else win.postMessage(msg, VIMEO_ORIGIN);
      } catch {}
    },
    [yt]
  );

  // A link's player: say we're listening until it answers, then read its state and time as it plays.
  const linkOn = from != null && !!(yt || vm);
  // Whether its player has answered (a seek sent before then is dropped, so it waits), and whether it has played yet
  // (YouTube says "not started" or "cued" before autoplay begins; that never counts as a pause).
  const heardRef = useRef(false);
  const pendingSeek = useRef<number | null>(null);
  const everPlayed = useRef(false);
  const seekLink = useCallback(
    (t: number) => {
      if (yt) {
        send({ event: "command", func: "seekTo", args: [t, true] });
        send({ event: "command", func: "playVideo", args: [] });
      } else {
        send({ method: "setCurrentTime", value: t });
        send({ method: "play" });
      }
      tell({ time: t });
    },
    [yt, send, tell]
  );
  useEffect(() => {
    if (!linkOn) return;
    heardRef.current = false;
    let heard = false;
    let tries = 0;
    const answered = () => {
      if (heardRef.current) return;
      heardRef.current = true;
      const t = pendingSeek.current;
      pendingSeek.current = null;
      if (t != null) seekLink(t);
    };
    const hello = () => {
      if (yt) send({ event: "listening" });
      else for (const ev of ["play", "pause", "ended", "timeupdate", "playProgress"]) send({ method: "addEventListener", value: ev });
    };
    const knock = window.setInterval(() => {
      if (heard || ++tries > 40) return window.clearInterval(knock);
      hello();
    }, 300);
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      let d: unknown = e.data;
      if (typeof d === "string") {
        try {
          d = JSON.parse(d);
        } catch {
          return;
        }
      }
      if (!d || typeof d !== "object") return;
      const m = d as { event?: string; info?: unknown; data?: { seconds?: number; duration?: number } };
      if (yt) {
        heard = true;
        if (m.event === "onReady") send({ event: "command", func: "addEventListener", args: ["onStateChange"] });
        // Its commands are taken once it is ready (or already telling its state).
        if (m.event === "onReady" || m.event === "infoDelivery" || m.event === "initialDelivery") answered();
        const info = m.info as { playerState?: number; currentTime?: number; duration?: number } | number | null | undefined;
        const state = m.event === "onStateChange" && typeof info === "number" ? info : info && typeof info === "object" ? info.playerState : undefined;
        if (typeof state === "number") {
          const on = state === YT_STATE_PLAYING || state === YT_STATE_BUFFERING;
          if (on) everPlayed.current = true;
          if (on || everPlayed.current || (state !== YT_STATE_UNSTARTED && state !== YT_STATE_CUED)) tell({ playing: on });
        }
        if (info && typeof info === "object") {
          if (typeof info.duration === "number" && info.duration > 0) tell({ duration: info.duration });
          if (typeof info.currentTime === "number") tell({ time: info.currentTime });
        }
      } else {
        if (!m.event) return;
        if (!heard && m.event === "ready") {
          heard = true;
          hello();
        }
        heard = true;
        answered();
        if (m.event === "play") tell({ playing: true });
        else if (m.event === "pause" || m.event === "ended") tell({ playing: false });
        else if (m.event === "timeupdate" || m.event === "playProgress") {
          if (typeof m.data?.duration === "number" && m.data.duration > 0) tell({ duration: m.data.duration });
          if (typeof m.data?.seconds === "number") tell({ time: m.data.seconds });
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.clearInterval(knock);
      window.removeEventListener("message", onMessage);
    };
  }, [linkOn, yt, send, tell, seekLink]);

  const startLink = useCallback(
    (t: number) => {
      watched.current();
      // Started by a click: taken as playing until the player says otherwise, so a player that never answers still
      // carries on in the corner when the panel shuts rather than stopping.
      tell({ playing: true, started: true, time: t });
      setFrom(t);
    },
    [tell]
  );

  // The panel's seek (a timed step tapped).
  useEffect(() => {
    controlRef.current = {
      seek: (t: number) => {
        if (uploaded) {
          const v = clip.current;
          if (!v) return;
          v.currentTime = t;
          void v.play().catch(() => {});
          return;
        }
        if (from == null) return startLink(t);
        // Its player not answering yet: kept until it does, the ink and the time moving only with the video.
        if (!heardRef.current) {
          pendingSeek.current = t;
          return;
        }
        seekLink(t);
      },
    };
    return () => {
      controlRef.current = null;
    };
  }, [controlRef, uploaded, from, startLink, seekLink]);

  if (uploaded)
    return (
      <video
        ref={clip}
        src={video}
        poster={`${video}?poster=1`}
        controls
        playsInline
        preload="metadata"
        onPlay={() => {
          watched.current();
          tell({ playing: true, started: true });
        }}
        onPause={() => tell({ playing: false })}
        onEnded={() => tell({ playing: false })}
        onTimeUpdate={(e) => tell({ time: e.currentTarget.currentTime })}
        onLoadedMetadata={(e) => Number.isFinite(e.currentTarget.duration) && e.currentTarget.duration > 0 && tell({ duration: e.currentTarget.duration })}
      />
    );
  if (from != null && (yt || vm)) {
    const at = Math.floor(from);
    const origin = encodeURIComponent(window.location.origin);
    const src = yt ? `https://www.youtube.com/embed/${yt}?autoplay=1&rel=0&playsinline=1&enablejsapi=1&origin=${origin}${at ? `&start=${at}` : ""}` : `https://player.vimeo.com/video/${vm}?autoplay=1&playsinline=1${at ? `#t=${at}s` : ""}`;
    return <iframe ref={frame} src={src} title={title} allow="autoplay; fullscreen; picture-in-picture" allowFullScreen />;
  }
  const poster = posterOf(video);
  return (
    <button type="button" className="hlp-poster" onClick={() => startLink(0)} aria-label={`Play ${title}`}>
      {/* eslint-disable-next-line @next/next/no-img-element -- YouTube's own thumbnail */}
      {poster && !broken && <img src={poster} alt="" draggable={false} onError={() => setBroken(true)} />}
      <span className="hlp-playmark" aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <path d={PLAY} fill="currentColor" />
        </svg>
      </span>
    </button>
  );
}

/** A time as the line and the player say it: `2:10 / 4:30`, or the time alone with no length known. */
export const timeFact = (time: number, duration: number | null) => (duration ? `${clockOf(time)} / ${clockOf(duration)}` : clockOf(time));
