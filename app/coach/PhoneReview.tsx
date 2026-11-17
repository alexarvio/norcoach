"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { markVideoSeenAction, replyToMediaAction, sendChatMessageAction, sendFormReviewAction } from "../lib/actions";
import { COLORS, flattenPhoto, sameOrigin, upload, uploadChatReview, type ChatTarget } from "../admin/redesign/media-review/MediaReviewModal";
import { uploadFileFirst } from "../lib/uploadFirst";
import { pathOf, simplify, SIZES, STROKE, UNDERLAY, UNDERLAY_COLOR, unitFor, worthKeeping, type Pt, type Shape, type Tool } from "../admin/redesign/media-review/shapes";
import { recordingSupported, setClipMuted, useReviewRecorder } from "../admin/redesign/media-review/useReviewRecorder";
import type { PhoneReview as Review } from "../lib/coachPhone";
import { dayMonth } from "../lib/dayMonth";
import { newOnceKey } from "../lib/onceKey";
import { pic } from "../lib/pic";
import { useKeyboardInset } from "../client/useKeyboardInset";
import { coachReviewAction } from "./actions";
import { Avatar, Facts, Icon, Sheet } from "./parts";
import RingEdge from "../components/RingEdge";

// A client's exercise video (or photo) on the coach's phone (21 Oct): the
// laptop's review, laid out for a phone. It opens on the recorder, as the
// laptop's does: draw over the clip with a finger (pen, arrow, line, circle, a
// colour, a size, undo, clear) and talk; Record review, 3, 2, 1, Stop, watch it
// back, Send. The recording is made by the same recorder (useReviewRecorder),
// goes up the same way (/api/video-reply) and lands where the laptop's does: on
// the exercise, carried to the next session, and in the client's chat. Or a few
// words instead, on the one line under it, which is the recording's note too.
// Laid out as the laptop's panel (17 Nov, Alex: docs/boards/review-align-mockup.html):
// the stage takes the screen (it is the coach's workspace), under it the client's
// face and name, the exercise's name alone, their words and the coach's ask, what
// was said before, then the foot.

const TOOLS: { id: Tool; name: string; d: string }[] = [
  { id: "pen", name: "Pen", d: "M4.5 19.5l1-4L16 5a2.1 2.1 0 0 1 3 3L8.5 18.5zM14 7l3 3" },
  { id: "arrow", name: "Arrow", d: "M5 19L19 5M10 5h9v9" },
  { id: "line", name: "Line", d: "M5 19L19 5" },
  { id: "circle", name: "Circle", d: "M12 4a8 8 0 1 0 0 16 8 8 0 1 0 0-16z" },
];
// The phone's palette is the laptop's (17 Nov, Alex: the same eight on both).
const PALETTE = COLORS;
const RATES = [1, 0.5, 0.25];
// The camera bubble: its size and its room from the clip's corner on screen; the recording draws it in the same share.
const CAM_KEY = "cph-camera";
const BUBBLE = 76;
const BUBBLE_INSET = 12;
const clock = (s: number) => (Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}` : "0:00");
const isPicture = (url: string) => /\.(jpe?g|png|webp)(\?|$)/i.test(url);

function Glyph({ d, size = 18 }: { d: string; size?: number }) {
  return (
    <svg className="cph-ico" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

/** Someone's words on the clip: their face, who (small caps), the words. */
function Says({ face, label, children }: { face: React.ReactNode; label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="cph-says">
      {face}
      <small>{label}</small>
      <p>{children}</p>
    </div>
  );
}

/**
 * A video or photo a client sent in the chat, reviewed on the same screen as an exercise's (25 Oct, Alex: "if I review,
 * then it goes to that screen where I have the toolbar and I can record… as a whiteboard"): draw, talk, Send. The
 * recording, or a few words, lands in the chat as a reply to it.
 */
export function ChatReview({ clientId, messageId, first, name, avatarPath, media, words, when, onBack, onSent }: { clientId: number; messageId: number; first: string; name: string; avatarPath: string | null; media: { kind: "video" | "photo"; url: string }; words: string; when: string; onBack: () => void; onSent: () => void }) {
  const review: Review = {
    requestId: 0,
    unseen: false,
    client: { firstName: first, name, avatarPath },
    exercise: { name: media.kind === "video" ? "Video" : "Photo", session: when, week: 0, day: 0 },
    requested: false,
    media: [media],
    sentAt: null,
    sets: [],
    clientMessage: words ? { text: words, at: null } : null,
    thread: [],
    askNote: null,
    repliedAt: null,
    clientId,
  };
  return <Reviewer review={review} chat={{ clientId, replyTo: messageId }} onBack={onBack} onSent={onSent} />;
}

export default function PhoneReview({ requestId, onBack, onSent }: { requestId: number; onBack: () => void; onSent: () => void }) {
  // undefined while it loads, null when it is gone.
  const [review, setReview] = useState<Review | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    coachReviewAction(requestId)
      .then((r) => live && setReview(r))
      .catch(() => live && setReview(null));
    return () => {
      live = false;
    };
  }, [requestId]);
  // Seen, once opened: it stops being new on the laptop too.
  const unseen = review?.unseen ?? false;
  useEffect(() => {
    if (unseen) void markVideoSeenAction(requestId).catch(() => {});
  }, [unseen, requestId]);

  if (review === undefined || review === null) {
    return (
      <section className="cph-review" aria-label="Video">
        <div className="cph-stage">
          <button type="button" className="cph-stage-btn back" onClick={onBack} aria-label="Back to the videos">
            <Icon name="back" size={22} />
          </button>
          {review === null && <p className="cph-stage-empty">Gone</p>}
        </div>
      </section>
    );
  }
  return <Reviewer review={review} onBack={onBack} onSent={onSent} />;
}

function Reviewer({ review, chat = null, onBack, onSent }: { review: Review; chat?: ChatTarget | null; onBack: () => void; onSent: () => void }) {
  const first = review.client.firstName;
  const item = review.media[0];
  const canRecord = useMemo(() => recordingSupported(), []);
  // A sent review (or a photo sent back) on the stage in place of the client's clip.
  const [stageReview, setStageReview] = useState<{ kind: "video" | "photo"; url: string } | null>(null);

  // ---- The stage: the frame fits the room under the status bar and over the playback bar at the media's own shape (CSS, container units).
  const [natural, setNatural] = useState({ w: 1080, h: 1920 });
  const isVideo = item.kind === "video";
  const unit = unitFor(natural.w, natural.h);

  // ---- Playback.
  const mediaEl = useRef<HTMLVideoElement | HTMLImageElement | null>(null);
  const videoOf = () => (mediaEl.current instanceof HTMLVideoElement ? mediaEl.current : null);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(0);
  const [rate, setRate] = useState(1);
  // A speed change never moves the clip (17 Nov, Alex: "if I am in second 4 it stays in second 4"): where it was and
  // whether it played are held for a moment, and the clip is put back if it jumps back or stops or starts by itself (an
  // iPhone can reload a clip as its rate changes). Anything the coach does to it lets go at once.
  // A reload (the clip emptied and loading again) keeps the hold however long it takes: it lets go only once the clip has
  // a frame at or past where it was, then after the usual moment.
  const hold = useRef<{ t: number; playing: boolean; rate: number; reloading: boolean } | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
  }, []);
  const stopHoldTimer = () => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = null;
  };
  const letGoSoon = () => {
    stopHoldTimer();
    holdTimer.current = setTimeout(() => {
      hold.current = null;
      holdTimer.current = null;
    }, 1500);
  };
  const reloading = () => {
    if (!hold.current) return;
    hold.current.reloading = true;
    stopHoldTimer();
  };
  const keep = (v: HTMLVideoElement) => {
    const h = hold.current;
    if (!h) return;
    if (v.playbackRate !== h.rate) v.playbackRate = h.rate;
    if (v.readyState >= 1 && v.currentTime < h.t - 0.25) {
      try {
        v.currentTime = h.t;
      } catch {}
    }
    if (h.playing && v.paused && !v.ended) void v.play().catch(() => {});
    else if (!h.playing && !v.paused) v.pause();
    if (h.reloading && v.readyState >= 2 && !v.seeking && v.currentTime >= h.t - 0.25) {
      h.reloading = false;
      letGoSoon();
    }
    setT(h.reloading ? h.t : v.currentTime);
  };
  const toggle = () => {
    const v = videoOf();
    if (!v) return;
    hold.current = null;
    if (v.paused) void v.play().catch(() => {});
    else v.pause();
  };
  useEffect(() => {
    if (!playing) return;
    let id = 0;
    const tick = () => {
      const v = videoOf();
      if (v) setT(v.currentTime);
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [playing]);
  const scrubRef = useRef<HTMLDivElement>(null);
  const seekAt = (clientX: number) => {
    const el = scrubRef.current;
    const v = videoOf();
    if (!el || !v || !dur) return;
    hold.current = null;
    const r = el.getBoundingClientRect();
    v.currentTime = Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * dur;
    setT(v.currentTime);
  };
  // Slow motion (27 Oct, Alex: mockup C): 1× | 0.5× | 0.25× as a capsule at the bar's end.
  // The clip's sound off or on (27 Oct, Alex): in the speaker and the recording alike.
  const [muted, setMuted] = useState(false);
  const setMute = (next: boolean) => {
    setMuted(next);
    setClipMuted(videoOf(), next);
  };
  const setSpeed = (next: number) => {
    setRate(next);
    const v = videoOf();
    if (!v) return;
    // A speed picked again while a reload is still on keeps where it was before it, not the 0 it may read meanwhile.
    const prev = hold.current;
    const t0 = prev?.reloading ? prev.t : v.currentTime;
    const was = prev?.reloading ? prev.playing : !v.paused && !v.ended;
    hold.current = { t: t0, playing: was, rate: next, reloading: !!prev?.reloading };
    if (prev?.reloading) stopHoldTimer();
    else letGoSoon();
    v.defaultPlaybackRate = next;
    v.playbackRate = next;
    keep(v);
  };

  // ---- Drawing, with a finger: a touch on the picture pauses it.
  const [tool, setTool] = useState<Tool>("arrow");
  const [color, setColor] = useState(PALETTE[0].id);
  const [size, setSize] = useState<number>(1);
  const sizeNow = SIZES.find((s) => s.id === size) ?? SIZES[1];
  const nextSize = () => setSize(SIZES[(SIZES.findIndex((s) => s.id === size) + 1) % SIZES.length].id);
  const [palette, setPalette] = useState(false);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const shapesRef = useRef<Shape[]>([]);
  useEffect(() => {
    shapesRef.current = shapes;
  }, [shapes]);
  const liveRef = useRef<Shape | null>(null);
  const [liveShape, setLiveShape] = useState<Shape | null>(null);
  const redraw = () => setLiveShape(liveRef.current ? { ...liveRef.current, pts: [...liveRef.current.pts] } : null);
  const [drawn, setDrawn] = useState(0);
  const svgRef = useRef<SVGSVGElement>(null);
  const toMedia = (e: React.PointerEvent): Pt => {
    const r = svgRef.current!.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * natural.w, ((e.clientY - r.top) / r.height) * natural.h];
  };
  const down = (e: React.PointerEvent<SVGSVGElement>) => {
    setPalette(false);
    e.currentTarget.setPointerCapture(e.pointerId);
    // Drawing never stops the video (27 Oct, Alex): only pause does.
    const p = toMedia(e);
    liveRef.current = { tool, color, size, pts: [p, p] };
    redraw();
  };
  const move = (e: React.PointerEvent<SVGSVGElement>) => {
    const s = liveRef.current;
    if (!s) return;
    const p = toMedia(e);
    if (s.tool === "pen") s.pts.push(p);
    else s.pts[s.pts.length - 1] = p;
    redraw();
  };
  const up = () => {
    const s = liveRef.current;
    liveRef.current = null;
    if (s && worthKeeping(s, unit)) {
      const kept = s.tool === "pen" ? { ...s, pts: simplify(s.pts, 0.8 * unit) } : s;
      setShapes((list) => [...list, kept]);
      setDrawn((n) => n + 1);
    }
    setLiveShape(null);
  };
  const clearAll = () => {
    liveRef.current = null;
    setLiveShape(null);
    setShapes([]);
    setPalette(false);
  };

  // ---- The front camera (17 Nov, Alex: "toggle for coaches to turn on the front camera… so we also record ourselves…
  // on the top right"): the coach's face in a round bubble at the clip's top right, in the recording too, as the
  // laptop's camera bubble. Off until turned on; remembered on the phone.
  const [camOn, setCamOn] = useState(false);
  useEffect(() => {
    try {
      if (localStorage.getItem(CAM_KEY) === "1") Promise.resolve().then(() => setCamOn(true));
    } catch {}
  }, []);
  const camVideo = useRef<HTMLVideoElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [camStream, setCamStream] = useState<MediaStream | null>(null);
  const [camDenied, setCamDenied] = useState(false);
  useEffect(() => {
    if (!camOn || !canRecord) return;
    let live = true;
    let got: MediaStream | null = null;
    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 640 } }, audio: false })
      .then((st) => {
        if (!live) return st.getTracks().forEach((x) => x.stop());
        got = st;
        setCamStream(st);
        setCamDenied(false);
      })
      .catch(() => live && setCamDenied(true));
    return () => {
      live = false;
      got?.getTracks().forEach((x) => x.stop());
      setCamStream(null);
    };
  }, [camOn, canRecord]);
  // Where the clip's right edge runs under the tools (a landscape clip fills the width), the bubble steps in from the
  // corner past them, as far down as it steps left (the recorder takes one inset for both), so it is never hidden.
  const [frameEl, setFrameEl] = useState<HTMLDivElement | null>(null);
  const frameRefCb = useCallback((el: HTMLDivElement | null) => {
    frameRef.current = el;
    setFrameEl(el);
  }, []);
  const [toolsEl, setToolsEl] = useState<HTMLDivElement | null>(null);
  const [camInset, setCamInset] = useState(BUBBLE_INSET);
  useEffect(() => {
    if (!camOn || !frameEl) return;
    const measure = () => {
      const f = frameEl.getBoundingClientRect();
      const tl = toolsEl?.getBoundingClientRect();
      let inset = BUBBLE_INSET;
      if (tl && tl.width) {
        const top = f.top + BUBBLE_INSET;
        const under = f.right - BUBBLE_INSET > tl.left - 6 && top < tl.bottom && top + BUBBLE > tl.top;
        if (under) inset = Math.max(BUBBLE_INSET, Math.ceil(f.right - tl.left + 6));
      }
      setCamInset((was) => (was === inset ? was : inset));
    };
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    // The frame, the room it is centred in (the stage growing or shrinking moves it) and the tools.
    for (const el of [frameEl, frameEl.parentElement, toolsEl]) if (el) ro?.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [camOn, frameEl, toolsEl]);
  const camInsetRef = useRef(BUBBLE_INSET);
  useEffect(() => {
    camInsetRef.current = camInset;
  }, [camInset]);
  const toggleCam = () => {
    setCamOn((on) => {
      try {
        localStorage.setItem(CAM_KEY, on ? "0" : "1");
      } catch {}
      return !on;
    });
  };

  // ---- The recorder: the clip, the drawing, the coach's voice and, with the camera on, their face, one video.
  const [micOn, setMicOnState] = useState(true);
  const recorder = useReviewRecorder({
    media: () => mediaEl.current,
    size: () => natural,
    shapes: () => (liveRef.current ? [...shapesRef.current, liveRef.current] : shapesRef.current),
    unit: () => unit,
    camera: () => (camOn && camStream ? camVideo.current : null),
    bubble: () => {
      const fw = Math.max(1, frameRef.current?.clientWidth ?? 1);
      return { corner: "tr", share: BUBBLE / fw, inset: camInsetRef.current / fw };
    },
  });
  const setMicOn = (on: boolean) => {
    setMicOnState(on);
    recorder.setMicOn(on);
  };
  const rec = recorder.state;
  const recording = rec === "recording" || rec === "paused";
  // The countdown (3, 2, 1) before the take, as the laptop's (17 Nov, Alex), which Cancel calls off.
  const [count, setCount] = useState<number | null>(null);
  const countTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const cancelCount = () => {
    countTimers.current.forEach(clearTimeout);
    countTimers.current = [];
    setCount(null);
  };
  useEffect(() => () => countTimers.current.forEach(clearTimeout), []);
  const counting = count != null || recorder.starting;
  const startRecording = () => {
    // Once: a second tap while it counts or starts does nothing.
    if (count != null || rec !== "ready" || recorder.starting) return;
    setStageReview(null);
    setPalette(false);
    setDrawn(shapes.length);
    hold.current = null;
    const reduce = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const beat = reduce ? 400 : 600;
    setCount(3);
    countTimers.current = [
      setTimeout(() => setCount(2), beat),
      setTimeout(() => setCount(1), beat * 2),
      setTimeout(() => {
        countTimers.current = [];
        setCount(null);
        void recorder.start({ mic: micOn });
      }, beat * 3),
    ];
  };
  // Cancel before the take runs (the countdown, or the mic still being asked for) calls it off.
  const cancelStart = () => (count != null ? cancelCount() : recorder.retake());
  const dirty = rec !== "ready" || counting;

  // ---- Sending: one line of words (17 Nov, Alex), the recording's note once there is one, else the reply alone.
  const [words, setWords] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reviewTry = useRef<{ blob: Blob; key: string } | null>(null);
  const wordsTry = useRef<{ what: string; shapes: Shape[]; key: string } | null>(null);
  // Words alone never carry a drawing on a video (17 Nov, Alex: sending them dropped it): it goes in a recording.
  const drawingOnVideo = isVideo && shapes.length > 0;
  const sendReview = async () => {
    const blob = recorder.blob;
    if (!blob || progress != null) return;
    const note = words.trim();
    setError(null);
    setProgress(0);
    if (chat) {
      // From the chat: the recording and the note go back into it, as one message answering theirs.
      const err = await uploadChatReview(chat.clientId, chat.replyTo, note, blob, setProgress);
      setProgress(null);
      if (err) return setError(err);
      recorder.retake();
      onSent();
      onBack();
      return;
    }
    const err = await upload(review.requestId, blob, setProgress);
    if (err) {
      setProgress(null);
      return setError(err);
    }
    // A one-time key a recording (6 Nov): Send again after a failure keeps it, so a review that in fact landed is not
    // posted twice.
    const onceKey = reviewTry.current?.blob === blob ? reviewTry.current.key : newOnceKey();
    reviewTry.current = { blob, key: onceKey };
    const ok = await sendFormReviewAction(review.requestId, note, { durationMs: recorder.secs * 1000, annotations: drawn }, onceKey).catch(() => false);
    setProgress(null);
    if (!ok) return setError("The review is up, but the reply did not save. Try Send again.");
    reviewTry.current = null;
    recorder.retake();
    onSent();
    onBack();
  };
  const sendWords = async () => {
    const clean = words.trim();
    if (!clean || busy) return;
    const drawing = shapesRef.current;
    if (isVideo && drawing.length > 0) return;
    // A one-time key a send (6 Nov); the same words (and drawing) sent again after "Not sent" keep the failed one's key.
    const onceKey = wordsTry.current?.what === clean && wordsTry.current.shapes === drawing ? wordsTry.current.key : newOnceKey();
    wordsTry.current = { what: clean, shapes: drawing, key: onceKey };
    setBusy(true);
    setError(null);
    const fail = (why: string) => {
      setBusy(false);
      setError(why);
    };
    // Words on a photo send the photo back with them, as the laptop does (17 Nov, Alex: the reply showed no picture in
    // the chat, only its link): the drawing flattened in, a JPEG. From the chat, only a photo drawn on goes back, as the
    // laptop's chat does. A photo the phone can't read back sends the words alone, unless something is drawn on it.
    let handle: string | null = null;
    if (!isVideo && (!chat || drawing.length > 0)) {
      let blob: Blob | null = null;
      try {
        blob = await flattenPhoto(item.url, drawing);
      } catch {
        if (drawing.length > 0) return fail("The drawing could not be added to the photo.");
      }
      if (blob) {
        try {
          const up = await uploadFileFirst(blob, chat ? "chat" : "media", chat?.clientId);
          if ("refused" in up) return fail(up.refused);
          handle = up.handle;
        } catch {
          return fail("The picture did not go up. Try again.");
        }
      }
    }
    const ok = chat
      ? await (async () => {
          const fd = new FormData();
          fd.set("clientId", String(chat.clientId));
          fd.set("text", clean);
          fd.set("replyTo", String(chat.replyTo));
          fd.set("quiet", "1");
          fd.set("nonce", onceKey);
          if (handle) fd.set("upload", handle);
          return sendChatMessageAction(fd).then(() => true, () => false);
        })()
      : await replyToMediaAction(review.requestId, clean, onceKey, handle).catch(() => false);
    setBusy(false);
    if (!ok) return setError("Not sent. Check the connection and try again.");
    wordsTry.current = null;
    setShapes([]);
    onSent();
    onBack();
  };

  // ---- Leaving: a recording in hand (or on its way) is never thrown away without asking.
  const [confirm, setConfirm] = useState(false);
  // Back during 3, 2, 1 calls the take off and leaves: nothing is recorded yet, so there is nothing to ask about.
  const leave = () => {
    if (count != null) {
      cancelCount();
      return onBack();
    }
    if (dirty) setConfirm(true);
    else onBack();
  };

  // The page held still while reviewing (25 Oct, Alex: drawing with a finger moved the whole screen): nothing behind
  // scrolls or bounces, and a finger on the picture only draws (iOS scrolls on a touch unless the touch is stopped).
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("cph-locked");
    return () => root.classList.remove("cph-locked");
  }, []);
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const stopTouch = (e: TouchEvent) => {
      if (el.classList.contains("on")) e.preventDefault();
    };
    el.addEventListener("touchstart", stopTouch, { passive: false });
    el.addEventListener("touchmove", stopTouch, { passive: false });
    return () => {
      el.removeEventListener("touchstart", stopTouch);
      el.removeEventListener("touchmove", stopTouch);
    };
  });

  const kb = useKeyboardInset();
  const all = liveShape ? [...shapes, liveShape] : shapes;
  const own = rec === "done" && recorder.preview ? { kind: "video" as const, url: recorder.preview } : stageReview;
  const canDraw = rec !== "done" && !stageReview;
  const clientFace = (n: number) => <Avatar name={review.client.name} src={review.client.avatarPath} size={n} />;
  const coachFace = (n: number) => <Avatar name={review.coach?.name ?? "You"} src={review.coach?.photoPath ?? null} size={n} />;
  const when = (at: number) => (at ? dayMonth(new Date(at)) : null);
  const hasConvo = !!review.askNote || !!review.clientMessage || review.thread.length > 0;

  return (
    <section className={`cph-review${kb > 0 ? " kb" : ""}`} style={{ bottom: kb }} aria-label={`${first}, ${review.exercise.name}`}>
      <div className="cph-stage">
        <div className={`cph-stage-room${isVideo && !own ? " with-bar" : ""}`}>
          {own ? (
            own.kind === "photo" ? (
              // eslint-disable-next-line @next/next/no-img-element -- the coach's own upload, served by the app
              <img className="cph-stage-own" src={own.url} alt="The photo you sent back" />
            ) : (
              // The recording just made (or a review already sent), to watch back.
              <video key={own.url} className="cph-stage-own" src={own.url} controls playsInline autoPlay />
            )
          ) : (
            <div ref={frameRefCb} className="cph-frame" style={{ "--r": natural.w / natural.h } as React.CSSProperties}>
              {isVideo ? (
                <video
                  ref={(el) => {
                    mediaEl.current = el;
                  }}
                  src={sameOrigin(item.url)}
                  playsInline
                  preload="auto"
                  onLoadedMetadata={(e) => {
                    const v = e.currentTarget;
                    if (v.videoWidth && v.videoHeight) setNatural({ w: v.videoWidth, h: v.videoHeight });
                    setDur(v.duration || 0);
                    v.defaultPlaybackRate = rate;
                    v.playbackRate = rate;
                    setClipMuted(v, muted);
                    keep(v);
                  }}
                  onPlay={(e) => {
                    setPlaying(true);
                    keep(e.currentTarget);
                  }}
                  onPause={(e) => {
                    setPlaying(false);
                    keep(e.currentTarget);
                  }}
                  onEmptied={reloading}
                  onLoadStart={reloading}
                  onCanPlay={(e) => keep(e.currentTarget)}
                  onSeeked={(e) => keep(e.currentTarget)}
                  onTimeUpdate={(e) => keep(e.currentTarget)}
                  onRateChange={(e) => keep(e.currentTarget)}
                  onEnded={() => setPlaying(false)}
                />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element -- the client's own upload, served by the app
                <img
                  ref={(el) => {
                    mediaEl.current = el;
                  }}
                  src={sameOrigin(item.url)}
                  alt={`${first}'s photo`}
                  onLoad={(e) => {
                    const im = e.currentTarget;
                    if (im.naturalWidth && im.naturalHeight) setNatural({ w: im.naturalWidth, h: im.naturalHeight });
                  }}
                />
              )}
              <svg ref={svgRef} className={`cph-draw${canDraw ? " on" : ""}`} viewBox={`0 0 ${natural.w} ${natural.h}`} preserveAspectRatio="none" aria-hidden="true" onPointerDown={canDraw ? down : undefined} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
                {all.map((s, i) => {
                  const d = pathOf(s, unit);
                  return (
                    <g key={i}>
                      <path d={d} stroke={UNDERLAY_COLOR} strokeWidth={UNDERLAY * unit * (s.size ?? 1)} fill="none" strokeLinecap="round" strokeLinejoin="round" />
                      <path d={d} stroke={s.color} strokeWidth={STROKE * unit * (s.size ?? 1)} fill="none" strokeLinecap="round" strokeLinejoin="round" />
                    </g>
                  );
                })}
              </svg>
              {camOn && camStream && (
                <div className="cph-cam" style={{ width: BUBBLE, height: BUBBLE, top: camInset, right: camInset }} role="img" aria-label="Your camera">
                  <video
                    ref={(el) => {
                      camVideo.current = el;
                      if (el && el.srcObject !== camStream) {
                        el.srcObject = camStream;
                        void el.play().catch(() => {});
                      }
                    }}
                    muted
                    playsInline
                    autoPlay
                  />
                </div>
              )}
            </div>
          )}
        </div>

        <button type="button" className="cph-stage-btn back" onClick={stageReview ? () => setStageReview(null) : leave} aria-label={stageReview ? "Back to the clip" : "Back to the videos"}>
          <Icon name="back" size={22} />
        </button>
        {recording && (
          <span className={`cph-rec${rec === "paused" ? " paused" : ""}`} aria-live="polite">
            <i aria-hidden="true" />
            {rec === "paused" ? "Paused" : "Rec"} {clock(recorder.secs)}
          </span>
        )}
        {count != null && (
          <span key={count} className="cph-countdown" aria-live="assertive">
            {count}
          </span>
        )}

        {canDraw && (
          <div ref={setToolsEl} className="cph-tools" role="toolbar" aria-label="Drawing">
            {TOOLS.map((x) => (
              <button key={x.id} type="button" className={`cph-tool${tool === x.id ? " on" : ""}`} aria-pressed={tool === x.id} aria-label={x.name} onClick={() => setTool(x.id)}>
                <Glyph d={x.d} />
              </button>
            ))}
            <button type="button" className="cph-tool" aria-expanded={palette} aria-label={`Colour: ${PALETTE.find((c) => c.id === color)?.name ?? ""}`} onClick={() => setPalette((o) => !o)}>
              <span className="cph-swatch" style={{ background: color }} />
            </button>
            <button type="button" className="cph-tool" aria-label={`Size: ${sizeNow.name}`} onClick={nextSize}>
              <i className="cph-size" style={{ height: Math.round(sizeNow.dot / 2) }} aria-hidden="true" />
            </button>
            <button type="button" className="cph-tool" disabled={!shapes.length} aria-label="Undo" onClick={() => setShapes((list) => list.slice(0, -1))}>
              <Icon name="undo" size={18} />
            </button>
            <button type="button" className="cph-tool" disabled={!shapes.length} aria-label="Clear" onClick={clearAll}>
              <Icon name="trash" size={18} />
            </button>
            {palette && (
              <span className="cph-palette" role="listbox" aria-label="Colours">
                {PALETTE.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    role="option"
                    aria-selected={color === c.id}
                    aria-label={c.name}
                    className={color === c.id ? "on" : ""}
                    style={{ background: c.id }}
                    onClick={() => {
                      setColor(c.id);
                      setPalette(false);
                    }}
                  >
                    <RingEdge size={30} />
                  </button>
                ))}
              </span>
            )}
          </div>
        )}

        {isVideo && !own && (
          <div className="cph-play">
            <button type="button" onClick={toggle} aria-label={playing ? "Pause" : "Play"}>
              <Icon name={playing ? "pause" : "play"} />
            </button>
            <div
              ref={scrubRef}
              className="cph-scrub"
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                seekAt(e.clientX);
              }}
              onPointerMove={(e) => e.buttons && seekAt(e.clientX)}
              role="slider"
              aria-label="Position"
              aria-valuemin={0}
              aria-valuemax={Math.round(dur)}
              aria-valuenow={Math.round(t)}
            >
              <span>
                <i style={{ width: `${dur ? (t / dur) * 100 : 0}%` }} />
              </span>
            </div>
            <span className="cph-play-time">
              {clock(t)} / {clock(dur)}
            </span>
            <button type="button" className="cph-mute" aria-pressed={muted} aria-label={muted ? "Sound off" : "Sound on"} title={muted ? "Sound off" : "Sound on"} onClick={() => setMute(!muted)}>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M11 5L6 9H3v6h3l5 4z" />
                {muted ? <path d="M16 9.5l5 5M21 9.5l-5 5" /> : <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />}
              </svg>
            </button>
            <span className="cph-rate" role="radiogroup" aria-label="Speed">
              {RATES.map((r) => (
                <button key={r} type="button" role="radio" aria-checked={rate === r} className={rate === r ? "on" : ""} onClick={() => rate !== r && setSpeed(r)}>
                  {r}×
                </button>
              ))}
            </span>
          </div>
        )}
      </div>

      {/* Who sent it and the exercise alone (17 Nov, Alex: no session, week, day or sets). */}
      <div className="cph-review-head">
        <div className="cph-review-who">
          {clientFace(32)}
          <b>{review.client.name}</b>
        </div>
        <h1>{review.exercise.name}</h1>
      </div>

      {hasConvo && (
        <div className="cph-review-convo">
          {review.askNote && <Says face={coachFace(28)} label="You asked">{review.askNote}</Says>}
          {review.clientMessage && <Says face={clientFace(28)} label={first}>{review.clientMessage.text}</Says>}
          {review.thread.length > 0 && (
            <section className="cph-before" aria-label="Before">
              <h2>Before</h2>
              {review.thread.map((m) =>
                m.kind === "text" ? (
                  <Says key={m.id} face={m.mine ? coachFace(28) : clientFace(28)} label={<Facts parts={[m.mine ? "You" : first, when(m.at)]} />}>
                    {m.text}
                  </Says>
                ) : (
                  (() => {
                    const photo = !!m.photo || isPicture(m.url);
                    return (
                      <button
                        key={m.id}
                        type="button"
                        className="cph-past"
                        disabled={dirty}
                        onClick={() => setStageReview({ kind: photo ? "photo" : "video", url: m.url })}
                        aria-label={photo ? "Show the photo you sent back" : "Play your review on the stage"}
                      >
                        <span className="cph-past-thumb">
                          {photo ? (
                            // eslint-disable-next-line @next/next/no-img-element -- the coach's own upload
                            <img src={pic(m.url, 480)} alt="" />
                          ) : (
                            <>
                              {/* Its first frame as a small picture, as the Videos list draws one, never the video loading. */}
                              {/* eslint-disable-next-line @next/next/no-img-element -- the coach's own upload's poster */}
                              <img
                                src={`${m.url}${m.url.includes("?") ? "&" : "?"}poster=1`}
                                alt=""
                                onError={(e) => {
                                  e.currentTarget.style.visibility = "hidden";
                                }}
                              />
                              <i aria-hidden="true" />
                            </>
                          )}
                        </span>
                        <span className="cph-past-text">
                          <span className="cph-past-facts">
                            <Facts parts={[photo ? "Your photo" : "Your review", !photo && m.durationMs ? clock(m.durationMs / 1000) : null, when(m.at)]} />
                          </span>
                          {m.message && <span className="cph-past-msg">{m.message}</span>}
                        </span>
                      </button>
                    );
                  })()
                )
              )}
            </section>
          )}
        </div>
      )}

      <footer className="cph-review-foot">
        {error && (
          <p className="cph-error" role="alert">
            {error}
          </p>
        )}
        {recorder.problem && <p className="cph-error">{recorder.problem}</p>}
        {camOn && camDenied && <p className="cph-error">Camera blocked</p>}
        {rec === "done" && recorder.micDenied && <p className="cph-note-line">No mic: the review has no voice.</p>}
        {counting ? (
          // 3, 2, 1 (or the mic being asked for): Cancel calls it off.
          <div className="cph-note-acts">
            <button type="button" className="cph-text-btn" onClick={cancelStart}>
              Cancel
            </button>
          </div>
        ) : recording ? (
          // Mic, camera, stop, pause (17 Nov, Alex: the camera beside the mic during the take, as the laptop keeps both).
          <div className="cph-rec-row">
            <button type="button" className={`cph-round${micOn ? " ink" : ""}`} onClick={() => setMicOn(!micOn)} aria-pressed={micOn} aria-label={micOn ? "Mute the mic" : "Turn the mic on"}>
              <Icon name={micOn ? "mic" : "micoff"} />
              <RingEdge size={46} />
            </button>
            <button type="button" className={`cph-round${camOn ? " ink" : ""}`} onClick={toggleCam} aria-pressed={camOn} aria-label={camOn ? "Turn the camera off" : "Turn the camera on"}>
              <Icon name="video" />
              <RingEdge size={46} />
            </button>
            <button type="button" className="cph-stop" onClick={recorder.stop} aria-label="Stop recording">
              <i />
              <RingEdge size={68} stroke={3} />
            </button>
            <button type="button" className="cph-round" onClick={rec === "paused" ? recorder.resume : recorder.pause} aria-label={rec === "paused" ? "Go on recording" : "Pause recording"}>
              <Icon name={rec === "paused" ? "play" : "pause"} />
              <RingEdge size={46} />
            </button>
          </div>
        ) : (
          <>
            {/* One line for the words, before the take and after it (17 Nov, Alex): Record again keeps them. */}
            <textarea
              className="cph-note"
              rows={1}
              value={words}
              placeholder={`Write to ${first}…`}
              aria-label={rec === "done" ? `A note with the review for ${first}` : `Reply to ${first}`}
              onChange={(e) => setWords(e.target.value)}
            />
            {rec === "done" ? (
              <div className="cph-done-row">
                <button
                  type="button"
                  className="cph-text-btn"
                  disabled={progress != null}
                  onClick={() => {
                    recorder.retake();
                    setStageReview(null);
                  }}
                >
                  Record again
                </button>
                <button type="button" className="cph-pill ink small" disabled={progress != null} onClick={() => void sendReview()}>
                  {progress != null ? `Sending ${Math.round(progress * 100)}%` : "Send"}
                </button>
              </div>
            ) : (
              <>
                {rec === "ready" && drawingOnVideo && !!words.trim() && <p className="cph-warn">A drawing on a video goes in a recording</p>}
                {words.trim() && (
                  <div className="cph-note-acts">
                    <button type="button" className="cph-text-btn" onClick={() => setWords("")}>
                      Cancel
                    </button>
                    <button type="button" className="cph-pill ink small" disabled={busy || drawingOnVideo} onClick={() => void sendWords()}>
                      {busy ? "Sending…" : "Send"}
                    </button>
                  </div>
                )}
                {canRecord && (
                  <div className="cph-recstart">
                    {/* Send is the ink pill once words are typed, so Record review steps back to white (one ink pill). */}
                    <button type="button" className={`cph-pill ${words.trim() ? "white" : "ink"}`} disabled={busy} onClick={startRecording}>
                      <i className="cph-recdot" aria-hidden="true" />
                      Record review
                    </button>
                    <button type="button" className={`cph-round${micOn ? " ink" : ""}`} onClick={() => setMicOn(!micOn)} aria-pressed={micOn} aria-label={micOn ? "Mute the mic" : "Turn the mic on"}>
                      <Icon name={micOn ? "mic" : "micoff"} />
                      <RingEdge size={46} />
                    </button>
                    <button type="button" className={`cph-round${camOn ? " ink" : ""}`} onClick={toggleCam} aria-pressed={camOn} aria-label={camOn ? "Turn the camera off" : "Turn the camera on"}>
                      <Icon name="video" />
                      <RingEdge size={46} />
                    </button>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </footer>

      {confirm && (
        <Sheet onClose={() => setConfirm(false)} label="Discard the review">
          <div className="cph-confirm">
            <h2>Discard this review?</h2>
            <div className="cph-confirm-row">
              <button type="button" className="cph-text-btn" onClick={() => setConfirm(false)}>
                Keep
              </button>
              <button
                type="button"
                className="cph-text-btn danger"
                onClick={() => {
                  cancelCount();
                  recorder.retake();
                  setConfirm(false);
                  onBack();
                }}
              >
                Discard
              </button>
            </div>
          </div>
        </Sheet>
      )}
    </section>
  );
}
