"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { useRouter } from "next/navigation";
import { DialogContent, DialogDescription, DialogTitle } from "../../../components/ui/dialog";
import { markVideoSeenAction, mediaReviewClientAction, replyToMediaAction, sendChatMessageAction, sendFormReviewAction } from "../../../lib/actions";
import { pic } from "../../../lib/pic";
import { newOnceKey } from "../../../lib/onceKey";
import { uploadFileFirst } from "../../../lib/uploadFirst";
import { paintShapes, pathOf, simplify, SIZES, STROKE, UNDERLAY, UNDERLAY_COLOR, unitFor, worthKeeping, type Pt, type Shape, type Tool } from "./shapes";
import { recordingSupported, setClipMuted, useReviewRecorder, type Corner } from "./useReviewRecorder";

// The coach's media review (12 Oct, design 18a; one panel since 16 Nov, Alex: docs/boards/photo-review-mockup.html):
// one modal for every photo or video a client sends from an exercise. A dark stage on the left with the media and the
// drawing tools; on the right who sent it, the exercise's name alone, what the coach asked, their words, what was said before, and at the foot,
// always, the reply: a line to write on, and Record beside the mic and camera. A recording is the stage as one video
// (the coach draws over it while talking), sent as the reply; written words on a photo send the photo back with the
// drawing flattened into it. A reply lands on the exercise (and carries to the next session) and in the chat.

/** An upload drawn into the recorder's canvas must come from this origin (15 Oct): the plain path redirects to the bucket, which taints the canvas ("Canvas is not origin-clean"); ?stream=1 sends the bytes through the app. */
export const sameOrigin = (url: string) => (url.startsWith("/uploads/") ? `${url}${url.includes("?") ? "&" : "?"}stream=1` : url);

export type ThreadItem =
  | { id: string; kind: "text"; mine: boolean; text: string; at: number }
  /** `photo`: a written reply on a photo, its file the photo sent back with the drawing (16 Nov); else read from the url. */
  | { id: string; kind: "review"; url: string; durationMs: number | null; annotations: number | null; message: string | null; at: number; photo?: boolean };
export type MediaReview = {
  requestId: number;
  /** New to the coach: opening it marks it seen. */
  unseen: boolean;
  client: { firstName: string; name: string; avatarPath: string | null };
  exercise: { name: string; session: string; week: number; day: number };
  requested: boolean;
  media: { kind: "video" | "photo"; url: string }[];
  sentAt: string | null;
  sets: { n: number; label: string }[];
  clientMessage: { text: string; at: string | null } | null;
  /** What the coach wrote when asking for it (17 Nov, Alex): shown as theirs, `You asked`. */
  askNote?: string | null;
  thread: ThreadItem[];
};

// The palette (12 Oct): one swatch on the toolbox, the rest a click away. Eight on the laptop and the phone alike, in
// this order, yellow picked first (17 Nov, Alex: docs/boards/review-align-mockup.html).
export const COLORS = [
  { id: "#FFD60A", name: "Yellow" },
  { id: "#FF9F0A", name: "Orange" },
  { id: "#FF453A", name: "Red" },
  { id: "#30D158", name: "Green" },
  { id: "#0A84FF", name: "Blue" },
  { id: "#BF5AF2", name: "Purple" },
  { id: "#FFFFFF", name: "White" },
  { id: "#000000", name: "Black" },
];
// The keys still work (16 Nov, Alex: the legend under the panel is gone); each tool's tooltip names its key.
const TOOLS: { id: Tool; name: string; key: string; icon: string }[] = [
  { id: "pen", name: "Pen", key: "P", icon: "M4 20l4-1 11-11-3-3L5 16zM14 6l3 3" },
  { id: "arrow", name: "Arrow", key: "A", icon: "M5 19L19 5M10 5h9v9" },
  { id: "line", name: "Line", key: "L", icon: "M5 19L19 5" },
  { id: "circle", name: "Circle", key: "O", icon: "M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16z" },
];
const RATES = [1, 0.5, 0.25];
const FRAME = 1 / 30;
const CAM_KEY = "mrv-camera";
/** A photo sent back is kept at most this long on its longest side (as the app keeps every photo, fitPhoto). */
const PHOTO_MAX = 2048;

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const isPicture = (url: string) => /\.(jpe?g|png|webp)(\?|$)/i.test(url);
const Ico = ({ d, size = 18, w = 2.2 }: { d: string; size?: number; w?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);
const MIC = "M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21";
const CAM = "M3 6.5h13v11H3zM16 10.5l5-3v9l-5-3z";
const SEND = "M5 12h14M13 6l6 6-6 6";

/** The photo as the coach left it (16 Nov, Alex): the picture with the drawing flattened in, a JPEG, its longest side
    PHOTO_MAX at most. Drawn from the app's own copy (sameOrigin), so the canvas can be read. */
export async function flattenPhoto(url: string, shapes: Shape[]): Promise<Blob> {
  const im = new Image();
  im.src = sameOrigin(url);
  await im.decode();
  const w = im.naturalWidth || 1;
  const h = im.naturalHeight || 1;
  const k = Math.min(1, PHOTO_MAX / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * k));
  c.height = Math.max(1, Math.round(h * k));
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("No canvas");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(im, 0, 0, c.width, c.height);
  paintShapes(ctx, shapes, unitFor(w, h), c.width / w);
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/jpeg", 0.9));
  if (!blob) throw new Error("No picture");
  return blob;
}

/** Up with progress; null once it is up, else what went wrong. The coach's phone sends its reviews through it too. */
export function upload(id: number, blob: Blob, onProgress: (share: number) => void): Promise<string | null> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/video-reply/${id}`);
    xhr.setRequestHeader("Content-Type", blob.type.split(";")[0] || "video/webm");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve(null);
      let message = `The upload failed (${xhr.status || "no answer"}). Try again.`;
      try {
        message = JSON.parse(xhr.responseText).error ?? message;
      } catch {}
      resolve(message);
    };
    xhr.onerror = () => resolve("The upload broke off. Check the connection and try again.");
    xhr.send(blob);
  });
}

/** A review of a chat video or photo: the raw file to /api/chat-review, which posts it in the chat as a reply to their
    message. The laptop's chat and the coach's phone both send through it (26 Oct, Alex). */
export function uploadChatReview(clientId: number, replyTo: number, note: string, blob: Blob, onProgress: (share: number) => void): Promise<string | null> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/chat-review/${clientId}?replyTo=${replyTo}&note=${encodeURIComponent(note)}`);
    xhr.setRequestHeader("Content-Type", blob.type.split(";")[0] || "video/webm");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve(null);
      let message = `The upload failed (${xhr.status || "no answer"}). Try again.`;
      try {
        message = JSON.parse(xhr.responseText).error ?? message;
      } catch {}
      resolve(message);
    };
    xhr.onerror = () => resolve("The upload broke off. Check the connection and try again.");
    xhr.send(blob);
  });
}

/** Where a review from the chat goes back to: the client's message it answers. */
export type ChatTarget = { clientId: number; replyTo: number };

/** A photo or video a client sent in the chat, as a review (26 Oct, Alex: the laptop's chat had no Review, the phone's
    did): the same recorder, its recording or words going back into the chat as a reply to their message. */
export function chatMediaReview(first: string, kind: "video" | "photo", url: string, words: string, when: string, avatarPath: string | null = null): MediaReview {
  return {
    requestId: 0,
    unseen: false,
    client: { firstName: first, name: first, avatarPath },
    exercise: { name: kind === "video" ? "Video" : "Photo", session: when, week: 0, day: 0 },
    requested: false,
    media: [{ kind, url }],
    sentAt: null,
    sets: [],
    clientMessage: words ? { text: words, at: null } : null,
    thread: [],
  };
}

/** A face: the picture, else the initial. */
function Face({ path, name, className }: { path: string | null; name: string; className: string }) {
  return (
    <span className={className} aria-hidden="true">
      {path ? (
        // eslint-disable-next-line @next/next/no-img-element -- the client's own upload, served by the app
        <img src={pic(path, 96)} alt="" />
      ) : (
        name.charAt(0).toUpperCase()
      )}
    </span>
  );
}

export default function MediaReviewModal({ review, chat = null, onClose }: { review: MediaReview; /** From the chat: what it answers. */ chat?: ChatTarget | null; onClose: () => void }) {
  const router = useRouter();
  const first = review.client.firstName;
  const [idx, setIdx] = useState(0);
  const item = review.media[Math.min(idx, review.media.length - 1)];
  // A sent review playing (or a picture reply showing) on the stage in place of the client's media.
  const [stageReview, setStageReview] = useState<{ kind: "video" | "photo"; url: string } | null>(null);
  const showing = stageReview ?? item;
  const canRecord = useMemo(() => recordingSupported(), []);

  // Seen, once opened.
  useEffect(() => {
    if (review.unseen && !chat) void markVideoSeenAction(review.requestId);
  }, [review.unseen, review.requestId, chat]);

  // Their face and full name (16 Nov, Alex: the head showed an initial for a client with a photo): asked for when the
  // opener handed over none; the coach's own face with it, for "You asked" (17 Nov, Alex).
  const [who, setWho] = useState<{ name: string; avatarPath: string | null; coachName: string; coachAvatarPath: string | null } | null>(null);
  useEffect(() => {
    if (chat || review.requestId <= 0) return;
    let live = true;
    mediaReviewClientAction(review.requestId).then(
      (got) => live && got && setWho(got),
      () => {}
    );
    return () => {
      live = false;
    };
  }, [chat, review.requestId]);
  const face = review.client.avatarPath ?? who?.avatarPath ?? null;
  const fullName = who?.name || review.client.name;
  const coachFace = who?.coachAvatarPath ?? null;
  // A blank ring until their name is in, never a stand-in initial that then changes.
  const coachName = who?.coachName ?? "";
  // The coach's own lines wear their face too, as You asked does (mockup frame 4); a chat-opened review has no read
  // for it, so its lines stay without one.
  const coachFaced = !chat && review.requestId > 0;
  const askNote = chat ? null : review.askNote?.trim() || null;

  // ---- The stage and the frame the media sits in, fitted to it.
  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState({ w: 600, h: 650 });
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((e) => {
      const r = e[0]?.contentRect;
      if (r) setStage({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [natural, setNatural] = useState({ w: 1080, h: 1920 });
  // The frame is sized by CSS (12 Oct): as big as fits between the toolbox
  // on either side, the top and the playback bar, at the media's own shape
  // (.mrv-fit, container units). Measured here only for the camera bubble.
  const frameRef = useRef<HTMLDivElement>(null);
  const unit = unitFor(natural.w, natural.h);

  // ---- Playback.
  const mediaEl = useRef<HTMLVideoElement | HTMLImageElement | null>(null);
  const videoOf = () => (mediaEl.current instanceof HTMLVideoElement ? mediaEl.current : null);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(0);
  const [rate, setRate] = useState(1);
  const toggle = () => {
    const v = videoOf();
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
  };
  const step = (d: number) => {
    const v = videoOf();
    if (!v) return;
    v.pause();
    v.currentTime = Math.max(0, Math.min(v.duration || 0, v.currentTime + d));
    setT(v.currentTime);
  };
  // Slow motion (27 Oct, Alex: mockup C): 1× | 0.5× | 0.25× as a capsule at the bar's end.
  // The clip's sound off or on (27 Oct, Alex): in the speaker and the recording alike.
  const [muted, setMuted] = useState(false);
  const setMute = (next: boolean) => {
    setMuted(next);
    setClipMuted(videoOf(), next);
  };
  // A new speed never moves the clip (17 Nov, Alex: "if I am in second 4 it stays in second 4"): the place and whether
  // it plays are kept, and put back should the browser have moved either; the default rate too, so a reload keeps it.
  const setSpeed = (next: number) => {
    setRate(next);
    const v = videoOf();
    if (!v) return;
    const at = v.currentTime;
    const wasPlaying = !v.paused && !v.ended;
    v.defaultPlaybackRate = next;
    v.playbackRate = next;
    if (Math.abs(v.currentTime - at) > 0.05) v.currentTime = at;
    if (wasPlaying && v.paused) void v.play().catch(() => {});
    else if (!wasPlaying && !v.paused) v.pause();
    setT(v.currentTime);
  };
  // The time, smoothly, while it plays.
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
    const r = el.getBoundingClientRect();
    v.currentTime = Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * dur;
    setT(v.currentTime);
  };

  // ---- Drawing: always on the client's media (16 Nov: one panel), never over a sent review.
  const canDraw = !stageReview;
  const [tool, setTool] = useState<Tool>("arrow");
  const [color, setColor] = useState(COLORS[0].id);
  const [palette, setPalette] = useState(false);
  // How big the next shape is drawn (12 Oct): small, medium, large.
  const [size, setSize] = useState<number>(1);
  const stepSize = (d: number) => {
    const i = SIZES.findIndex((x) => x.id === size);
    setSize(SIZES[Math.max(0, Math.min(SIZES.length - 1, i + d))].id);
  };
  const [shapes, setShapes] = useState<Shape[]>([]);
  const shapesRef = useRef<Shape[]>([]);
  useEffect(() => {
    shapesRef.current = shapes;
  }, [shapes]);
  // The shape being drawn: in state for the screen, in a ref for the recorder's frames.
  const liveRef = useRef<Shape | null>(null);
  const [liveShape, setLiveShape] = useState<Shape | null>(null);
  const redraw = () => setLiveShape(liveRef.current ? { ...liveRef.current, pts: [...liveRef.current.pts] } : null);
  // Drawings made for this recording (those on screen when it started count too).
  const [drawn, setDrawn] = useState(0);
  const svgRef = useRef<SVGSVGElement>(null);
  const toMedia = (e: React.PointerEvent): Pt => {
    const r = svgRef.current!.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * natural.w, ((e.clientY - r.top) / r.height) * natural.h];
  };
  const down = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!canDraw) return;
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
  const undo = () => setShapes((list) => list.slice(0, -1));
  const clearAll = () => setShapes([]);

  // ---- Camera and mic: round toggles at the foot, white while off, ink while on.
  const [micOn, setMicOnState] = useState(true);
  const [camOn, setCamOn] = useState(false);
  useEffect(() => {
    try {
      if (localStorage.getItem(CAM_KEY) === "1") Promise.resolve().then(() => setCamOn(true));
    } catch {}
  }, []);
  const camVideo = useRef<HTMLVideoElement | null>(null);
  const [camStream, setCamStream] = useState<MediaStream | null>(null);
  const [camDenied, setCamDenied] = useState(false);
  useEffect(() => {
    if (!camOn || !canRecord) return;
    let live = true;
    let got: MediaStream | null = null;
    navigator.mediaDevices
      ?.getUserMedia({ video: true })
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
  useEffect(() => {
    if (camVideo.current && camStream) {
      camVideo.current.srcObject = camStream;
      void camVideo.current.play().catch(() => {});
    }
  }, [camStream]);
  const [corner, setCorner] = useState<Corner>("tr");
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const bubbleDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const r = stageRef.current!.getBoundingClientRect();
    setDrag({ x: e.clientX - r.left, y: e.clientY - r.top });
  };
  const bubbleMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const r = stageRef.current!.getBoundingClientRect();
    setDrag({ x: e.clientX - r.left, y: e.clientY - r.top });
  };
  const bubbleUp = () => {
    if (!drag) return;
    setCorner(`${drag.y < stage.h / 2 ? "t" : "b"}${drag.x < stage.w / 2 ? "l" : "r"}` as Corner);
    setDrag(null);
  };
  const toggleCam = () => {
    setCamOn((on) => {
      try {
        localStorage.setItem(CAM_KEY, on ? "0" : "1");
      } catch {}
      return !on;
    });
  };

  // ---- The recorder.
  const recorder = useReviewRecorder({
    media: () => mediaEl.current,
    size: () => natural,
    shapes: () => (liveRef.current ? [...shapesRef.current, liveRef.current] : shapesRef.current),
    unit: () => unit,
    camera: () => (camOn && camStream ? camVideo.current : null),
    bubble: () => {
      const fw = Math.max(1, frameRef.current?.clientWidth ?? 1);
      return { corner, share: 92 / fw, inset: 20 / fw };
    },
  });
  const setMicOn = (on: boolean) => {
    setMicOnState(on);
    recorder.setMicOn(on);
  };
  // The countdown (3, 2, 1) before the take, which Stop calls off.
  const [count, setCount] = useState<number | null>(null);
  const countTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const cancelCount = () => {
    countTimers.current.forEach(clearTimeout);
    countTimers.current = [];
    setCount(null);
  };
  useEffect(() => () => countTimers.current.forEach(clearTimeout), []);
  const startRecording = () => {
    if (count != null || recorder.state !== "ready" || recorder.starting) return;
    // On the client's media, never over a sent review.
    setStageReview(null);
    setPalette(false);
    setDrawn(shapes.length);
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
  // Stop before the take runs (the countdown, or the mic still being asked for) calls it off.
  const stopRecording = () => (count != null ? cancelCount() : recorder.starting ? recorder.retake() : recorder.stop());
  const recDirty = recorder.state !== "ready" || count != null || recorder.starting;
  const takingFoot = count != null || recorder.starting || recorder.state === "recording" || recorder.state === "paused";

  // ---- Leaving: a recording in hand is never thrown away without asking.
  const [confirm, setConfirm] = useState(false);
  const discardTake = () => {
    cancelCount();
    recorder.retake();
    setConfirm(false);
  };
  const askClose = () => (recDirty ? setConfirm(true) : onClose());

  // ---- Switching media: drawings do not carry over.
  const go = (d: number) => {
    if (review.media.length < 2 || recDirty) return;
    setIdx((i) => (i + d + review.media.length) % review.media.length);
    setShapes([]);
    setPlaying(false);
    setT(0);
  };

  // ---- The conversation, with what was just sent ahead of the server.
  const [sent, setSent] = useState<ThreadItem[]>([]);
  const thread = useMemo(() => [...review.thread, ...sent.filter((s) => !review.thread.some((r) => r.kind === s.kind && Math.abs(r.at - s.at) < 120000))].sort((a, b) => a.at - b.at), [review.thread, sent]);
  // One line for the reply (16 Nov): the words alone, or the note that goes with a recording.
  const [text, setText] = useState("");
  const lineRef = useRef<HTMLTextAreaElement>(null);
  const sizeLine = () => {
    const el = lineRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(120, el.scrollHeight)}px`;
  };
  useLayoutEffect(sizeLine, [text]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A one-time key a send (6 Nov); the same words sent again after "Try again" keep the failed one's key, and so does
  // the same recording, so one that in fact landed is not posted twice.
  // The key covers the drawing too (the shapes list is a new array on every change), so a changed drawing sent with the
  // same words is a new send, never answered with the one before.
  const textTry = useRef<{ what: string; shapes: Shape[]; key: string } | null>(null);
  const reviewTry = useRef<{ blob: Blob; key: string } | null>(null);
  // A drawing on a video goes only in a recording: words alone would leave it behind, so Send waits.
  const drawingLeftBehind = !stageReview && item.kind === "video" && shapes.length > 0;
  const sendText = async () => {
    const clean = text.trim();
    if (!clean || busy || drawingLeftBehind) return;
    const drawing = shapesRef.current;
    const onceKey = textTry.current?.what === clean && textTry.current.shapes === drawing ? textTry.current.key : newOnceKey();
    textTry.current = { what: clean, shapes: drawing, key: onceKey };
    setBusy(true);
    setError(null);
    if (chat) {
      // From the chat: the words go back into it, answering their message; a photo drawn on goes back with the drawing
      // flattened in, as a picture in the same message.
      const fd = new FormData();
      fd.set("clientId", String(chat.clientId));
      fd.set("text", clean);
      fd.set("replyTo", String(chat.replyTo));
      fd.set("quiet", "1");
      fd.set("nonce", onceKey);
      if (item.kind === "photo" && drawing.length > 0) {
        try {
          const blob = await flattenPhoto(item.url, drawing);
          const up = await uploadFileFirst(blob, "chat", chat.clientId);
          if ("refused" in up) {
            setBusy(false);
            return setError(up.refused);
          }
          fd.set("upload", up.handle);
        } catch {
          setBusy(false);
          return setError("The drawing did not go up. Try again.");
        }
      }
      const sentOk = await sendChatMessageAction(fd).then(
        () => true,
        () => false
      );
      setBusy(false);
      if (!sentOk) return setError("Not sent. Try again.");
      textTry.current = null;
      setShapes([]);
      onClose();
      return;
    }
    // Words on a photo send the photo back with them (16 Nov, Alex: "the client will get the pic sent back with the
    // comment of the coach"), the drawing flattened in; on a video, the words alone. A photo the browser can't read back
    // (an odd format) sends the words alone, unless something is drawn on it, which would be lost.
    let handle: string | null = null;
    let picture: string | null = null;
    if (item.kind === "photo") {
      let blob: Blob | null = null;
      try {
        blob = await flattenPhoto(item.url, drawing);
      } catch {
        if (drawing.length > 0) {
          setBusy(false);
          return setError("The drawing could not be added to the photo.");
        }
      }
      if (blob) {
        try {
          const up = await uploadFileFirst(blob, "media");
          if ("refused" in up) {
            setBusy(false);
            return setError(up.refused);
          }
          handle = up.handle;
          picture = URL.createObjectURL(blob);
        } catch {
          setBusy(false);
          return setError("The picture did not go up. Try again.");
        }
      }
    }
    const ok = await replyToMediaAction(review.requestId, clean, onceKey, handle).catch(() => false);
    setBusy(false);
    if (!ok) {
      if (picture) URL.revokeObjectURL(picture);
      return setError("Not sent. Try again.");
    }
    textTry.current = null;
    setSent((s) => [
      ...s,
      picture
        ? { id: `p${Date.now()}`, kind: "review", url: picture, durationMs: null, annotations: null, message: clean, at: Date.now(), photo: true }
        : { id: `t${Date.now()}`, kind: "text", mine: true, text: clean, at: Date.now() },
    ]);
    setText("");
    setShapes([]);
    router.refresh();
  };
  const [progress, setProgress] = useState<number | null>(null);
  const sendReview = async () => {
    const blob = recorder.blob;
    if (!blob || progress != null) return;
    const note = text.trim();
    setError(null);
    setProgress(0);
    if (chat) {
      // From the chat: the recording and the note go back into it, as one message answering theirs.
      const chatErr = await uploadChatReview(chat.clientId, chat.replyTo, note, blob, setProgress);
      setProgress(null);
      if (chatErr) return setError(chatErr);
      recorder.retake();
      onClose();
      return;
    }
    const err = await upload(review.requestId, blob, setProgress);
    if (err) {
      setProgress(null);
      return setError(err);
    }
    const meta = { durationMs: recorder.secs * 1000, annotations: drawn };
    const onceKey = reviewTry.current?.blob === blob ? reviewTry.current.key : newOnceKey();
    reviewTry.current = { blob, key: onceKey };
    const ok = await sendFormReviewAction(review.requestId, note, meta, onceKey);
    setProgress(null);
    if (!ok) return setError("The review is up, but the reply did not save. Try Send again.");
    reviewTry.current = null;
    setSent((s) => [...s, { id: `r${Date.now()}`, kind: "review", url: URL.createObjectURL(blob), durationMs: meta.durationMs, annotations: meta.annotations, message: note || null, at: Date.now() }]);
    setText("");
    setShapes([]);
    recorder.retake();
    router.refresh();
  };

  // ---- Keys. Never while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT" || confirm) return;
      const k = e.key.toLowerCase();
      if (k === " ") {
        e.preventDefault();
        toggle();
        return;
      }
      const v = videoOf();
      if (k === "arrowleft" || k === "arrowright") {
        if (v?.paused) step(k === "arrowleft" ? -FRAME : FRAME);
        else if (!v) go(k === "arrowleft" ? -1 : 1);
        return;
      }
      if (!canDraw) return;
      const t2 = TOOLS.find((x) => x.key.toLowerCase() === k);
      if (t2 && !e.metaKey && !e.ctrlKey) return setTool(t2.id);
      if (k === "z") {
        e.preventDefault();
        return undo();
      }
      if (k === "[") return stepSize(-1);
      if (k === "]") return stepSize(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ---- What the stage shows.
  const all = liveShape ? [...shapes, liveShape] : shapes;
  const isVideo = showing.kind === "video";
  const recording = recorder.state === "recording";
  const bubblePos: React.CSSProperties = drag
    ? { left: drag.x - 46, top: drag.y - 46 }
    : { [corner.startsWith("t") ? "top" : "bottom"]: corner.startsWith("t") ? 20 : 84, [corner.endsWith("l") ? "left" : "right"]: 20 };
  const label = `${fullName}, ${review.exercise.name}`;
  const problem = recorder.problem ?? error;

  return (
    <DialogContent
      className="mrv-modal"
      onEscapeKeyDown={(e) => {
        e.preventDefault();
        if (confirm) return setConfirm(false);
        if (palette) return setPalette(false);
        askClose();
      }}
      onInteractOutside={(e) => {
        if (recDirty) {
          e.preventDefault();
          setConfirm(true);
        }
      }}
    >
      <DialogTitle className="sr-only">{label}</DialogTitle>
      <DialogDescription className="sr-only">
        {first}&rsquo;s {item.kind} of {review.exercise.name}, and your reply to it.
      </DialogDescription>

      {/* ---- The stage */}
      <div ref={stageRef} className="mrv-stage">
        <div className="mrv-fit">
          <div ref={frameRef} className="mrv-frame" style={{ "--r": natural.w / natural.h } as React.CSSProperties}>
            {isVideo ? (
              <video
                key={showing.url}
                ref={(el) => {
                  mediaEl.current = el;
                }}
                src={sameOrigin(showing.url)}
                playsInline
                preload="metadata"
                onLoadedMetadata={(e) => {
                  const v = e.currentTarget;
                  if (v.videoWidth && v.videoHeight) setNatural({ w: v.videoWidth, h: v.videoHeight });
                  setDur(v.duration || 0);
                  v.defaultPlaybackRate = rate;
                  v.playbackRate = rate;
                  setClipMuted(v, muted);
                }}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onEnded={() => setPlaying(false)}
                onClick={toggle}
              />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element -- the client's own upload, served by the app
              <img
                key={showing.url}
                ref={(el) => {
                  mediaEl.current = el;
                }}
                src={sameOrigin(showing.url)}
                alt={`${first}'s photo`}
                onLoad={(e) => {
                  const im = e.currentTarget;
                  if (im.naturalWidth && im.naturalHeight) setNatural({ w: im.naturalWidth, h: im.naturalHeight });
                }}
              />
            )}
            {canDraw && (
              <svg ref={svgRef} className="mrv-draw on" viewBox={`0 0 ${natural.w} ${natural.h}`} preserveAspectRatio="none" aria-hidden="true" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
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
            )}
          </div>
        </div>

        {/* Playback, videos only. */}
        {isVideo && (
          <div className="mrv-bar">
            <button type="button" className="mrv-bar-btn" onClick={() => step(-FRAME)} aria-label="Back one frame" title="Back one frame">
              <Ico d="M6 5v14M18 6l-8 6 8 6z" size={16} />
            </button>
            <button type="button" className="mrv-bar-btn play" onClick={toggle} aria-label={playing ? "Pause" : "Play"}>
              {playing ? <Ico d="M8 5v14M16 5v14" size={16} w={2.6} /> : <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor" /></svg>}
            </button>
            <button type="button" className="mrv-bar-btn" onClick={() => step(FRAME)} aria-label="Forward one frame" title="Forward one frame">
              <Ico d="M18 5v14M6 6l8 6-8 6z" size={16} />
            </button>
            <div
              ref={scrubRef}
              className="mrv-scrub"
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
              tabIndex={0}
            >
              <span className="mrv-scrub-track">
                <span className="mrv-scrub-fill" style={{ width: `${dur ? (t / dur) * 100 : 0}%` }} />
                <span className="mrv-scrub-knob" style={{ left: `${dur ? (t / dur) * 100 : 0}%` }} />
              </span>
            </div>
            <span className="mrv-time">
              {clock(t)} / {clock(dur)}
            </span>
            <button type="button" className="mrv-mute" aria-pressed={muted} aria-label={muted ? "Sound off" : "Sound on"} title={muted ? "Sound off" : "Sound on"} onClick={() => setMute(!muted)}>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M11 5L6 9H3v6h3l5 4z" />
                {muted ? <path d="M16 9.5l5 5M21 9.5l-5 5" /> : <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />}
              </svg>
            </button>
            <span className="mrv-rate" role="radiogroup" aria-label="Speed">
              {RATES.map((r) => (
                <button key={r} type="button" role="radio" aria-checked={rate === r} className={rate === r ? "on" : ""} onClick={() => setSpeed(r)}>
                  {r}×
                </button>
              ))}
            </span>
          </div>
        )}

        {stageReview && (
          <button type="button" className="mrv-recpill back" onClick={() => setStageReview(null)}>
            ‹ Back to {first}&rsquo;s {item.kind}
          </button>
        )}
        {!recDirty && !stageReview && review.media.length > 1 && (
          <>
            <button type="button" className="mrv-edge left" onClick={() => go(-1)} aria-label="Previous">
              ‹
            </button>
            <button type="button" className="mrv-edge right" onClick={() => go(1)} aria-label="Next">
              ›
            </button>
          </>
        )}

        {/* A small REC on the stage while it records. */}
        {(recorder.state === "recording" || recorder.state === "paused") && (
          <span className={`mrv-rec${recorder.state === "paused" ? " paused" : ""}`} aria-live="polite">
            <i aria-hidden="true" />
            {recorder.state === "paused" ? "PAUSED" : "REC"}
          </span>
        )}

        {/* The tools, on the client's media. */}
        {canDraw && (
          <div className="mrv-tools" role="toolbar" aria-label="Drawing">
            {TOOLS.map((x) => (
              <button key={x.id} type="button" className={`mrv-tool${tool === x.id ? " on" : ""}`} aria-pressed={tool === x.id} aria-label={`${x.name} (${x.key})`} title={`${x.name} (${x.key})`} onClick={() => setTool(x.id)}>
                <Ico d={x.icon} />
              </button>
            ))}
            <span className="mrv-tools-div" />
            {/* The colour on, and the rest of the palette beside the toolbox when opened. */}
            <span className="mrv-palette-wrap">
              <button type="button" className="mrv-swatch on" aria-expanded={palette} aria-label={`Colour: ${COLORS.find((c) => c.id === color)?.name ?? "custom"}. Choose another`} title="Colour" onClick={() => setPalette((o) => !o)}>
                <i style={{ background: color }} />
              </button>
              {palette && (
                <span className="mrv-palette" role="listbox" aria-label="Colours">
                  {COLORS.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      role="option"
                      aria-selected={color === c.id}
                      className={`mrv-pal${color === c.id ? " on" : ""}`}
                      aria-label={c.name}
                      title={c.name}
                      onClick={() => {
                        setColor(c.id);
                        setPalette(false);
                      }}
                    >
                      <i style={{ background: c.id }} />
                    </button>
                  ))}
                </span>
              )}
            </span>
            <span className="mrv-tools-div" />
            {SIZES.map((z) => (
              <button key={z.id} type="button" className={`mrv-size${size === z.id ? " on" : ""}`} aria-pressed={size === z.id} aria-label={`${z.name} ([ or ])`} title={`${z.name} ([ or ])`} onClick={() => setSize(z.id)}>
                <i style={{ width: z.dot, height: z.dot, background: color }} />
              </button>
            ))}
            <span className="mrv-tools-div" />
            <button type="button" className="mrv-tool" disabled={!shapes.length} onClick={undo} aria-label="Undo (Z)" title="Undo (Z)">
              <Ico d="M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3" />
            </button>
            <button type="button" className="mrv-tool" disabled={!shapes.length} onClick={clearAll} aria-label="Clear the drawing" title="Clear">
              <Ico d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
            </button>
          </div>
        )}
        {camOn && camStream && !stageReview && (
          <div className={`mrv-cam${drag ? " dragging" : ""}`} style={bubblePos} onPointerDown={bubbleDown} onPointerMove={bubbleMove} onPointerUp={bubbleUp} onPointerCancel={bubbleUp} aria-label="Your camera" role="img">
            <video ref={camVideo} muted playsInline />
          </div>
        )}
        {count != null && (
          <span key={count} className="mrv-countdown" aria-live="assertive">
            {count}
          </span>
        )}
      </div>

      {/* ---- The panel */}
      <div className="mrv-panel">
        <header className="mrv-head">
          <Face path={face} name={fullName} className="mrv-avatar" />
          <b className="mrv-who">{fullName}</b>
          <button type="button" className="mrv-close" onClick={askClose} aria-label="Close">
            <Ico d="M6 6l12 12M18 6L6 18" size={13} w={1.8} />
          </button>
        </header>

        <div className="mrv-scroll">
          {/* The exercise's name alone (17 Nov, Alex: no session, week, day or sets on the review). */}
          <section className="mrv-ex">
            <h2>{review.exercise.name}</h2>
          </section>

          {/* What the coach asked, as their words with their own face (17 Nov, Alex: docs/boards/review-align-mockup.html). */}
          {askNote && (
            <section className="mrv-said">
              <Face path={coachFace} name={coachName} className="mrv-said-face" />
              <span className="mrv-label">You asked</span>
              <p>{askNote}</p>
            </section>
          )}

          {review.clientMessage && (
            <section className="mrv-said">
              <Face path={face} name={first} className="mrv-said-face" />
              <span className="mrv-label">{first}</span>
              <p>{review.clientMessage.text}</p>
            </section>
          )}

          {/* What was said before, kept simple: who, and the words or the review. */}
          {thread.length > 0 && (
            <section className="mrv-thread">
              {thread.map((m) =>
                m.kind === "text" ? (
                  <div key={m.id} className={`mrv-said${m.mine ? " mine" : ""}${m.mine && !coachFaced ? " bare" : ""}`}>
                    {!m.mine && <Face path={face} name={first} className="mrv-said-face" />}
                    {m.mine && coachFaced && <Face path={coachFace} name={coachName} className="mrv-said-face" />}
                    <span className="mrv-label">{m.mine ? "You" : first}</span>
                    <p>{m.text}</p>
                  </div>
                ) : (
                  <div key={m.id} className={`mrv-said mine${coachFaced ? "" : " bare"}`}>
                    {coachFaced && <Face path={coachFace} name={coachName} className="mrv-said-face" />}
                    <span className="mrv-label">You</span>
                    <button
                      type="button"
                      className="mrv-review"
                      onClick={() => {
                        if (recDirty) return;
                        setStageReview({ kind: m.photo || isPicture(m.url) ? "photo" : "video", url: m.url });
                      }}
                      aria-label={m.photo || isPicture(m.url) ? "Show the photo you sent back" : "Play your review on the stage"}
                    >
                      <span className="mrv-review-thumb">
                        {m.photo || isPicture(m.url) ? (
                          // eslint-disable-next-line @next/next/no-img-element -- the coach's own upload
                          <img src={m.url.startsWith("blob:") ? m.url : pic(m.url, 480)} alt="" />
                        ) : (
                          <>
                            <video src={m.url} muted playsInline preload="metadata" aria-hidden="true" />
                            <i aria-hidden="true">
                              <svg viewBox="0 0 24 24" width="10" height="10"><path d="M8 5v14l11-7z" fill="currentColor" /></svg>
                            </i>
                          </>
                        )}
                      </span>
                      <span className="mrv-review-text">
                        {m.message ? <span className="mrv-review-msg">{m.message}</span> : <span className="mrv-review-msg faint">{m.durationMs != null ? clock(m.durationMs / 1000) : "Review"}</span>}
                        {!(m.photo || isPicture(m.url)) && m.message && m.durationMs != null && <small>{clock(m.durationMs / 1000)}</small>}
                      </span>
                    </button>
                  </div>
                )
              )}
            </section>
          )}
        </div>

        {/* ---- The reply, always at the foot (16 Nov, Alex): one panel, no modes. */}
        <footer className="mrv-foot">
          {recorder.micDenied && micOn && (
            <p className="mrv-problem">
              Microphone blocked{" "}
              <button type="button" onClick={() => recorder.retake()}>
                Try again
              </button>
            </p>
          )}
          {camDenied && camOn && <p className="mrv-problem">Camera blocked</p>}
          {problem && <p className="mrv-problem">{problem}</p>}
          {drawingLeftBehind && !!text.trim() && recorder.state === "ready" && !takingFoot && <p className="mrv-problem">A drawing on a video goes in a recording</p>}

          {recorder.state === "done" && recorder.preview && (
            <div className="mrv-take">
              <video className="mrv-take-thumb" src={recorder.preview} playsInline preload="metadata" onClick={(e) => (e.currentTarget.paused ? void e.currentTarget.play() : e.currentTarget.pause())} aria-label="Play the recording" />
              <span className="mrv-take-len">{clock(recorder.secs)}</span>
            </div>
          )}

          {!takingFoot && (
            <label className={`mrv-line${text ? " has" : ""}`}>
              <textarea
                ref={lineRef}
                rows={1}
                value={text}
                aria-label={recorder.state === "done" ? `A note with the recording for ${first}` : `Reply to ${first}`}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    if (recorder.state === "done") void sendReview();
                    else void sendText();
                  }
                }}
              />
            </label>
          )}

          <div className="mrv-acts">
            {recorder.state === "done" ? (
              <>
                <span className="mrv-sp" />
                <button type="button" className="mrv-pill" onClick={recorder.retake} disabled={progress != null}>
                  Retake
                </button>
                <button type="button" className="mrv-pill ink" onClick={() => void sendReview()} disabled={progress != null}>
                  {progress != null ? (
                    <>
                      <span className="mrv-ring" style={{ "--p": `${Math.round(progress * 100)}%` } as React.CSSProperties} aria-hidden="true" />
                      {progress >= 1 ? "Saving" : `${Math.round(progress * 100)}%`}
                    </>
                  ) : (
                    <>
                      Send <Ico d={SEND} size={15} w={1.8} />
                    </>
                  )}
                </button>
              </>
            ) : (
              <>
                {canRecord && (
                  <>
                    <button type="button" className={`mrv-tg${micOn ? " on" : ""}`} aria-pressed={micOn} aria-label="Microphone" title={micOn ? "Microphone on" : "Microphone off"} onClick={() => setMicOn(!micOn)}>
                      <Ico d={MIC} size={16} w={1.6} />
                    </button>
                    <button type="button" className={`mrv-tg${camOn ? " on" : ""}`} aria-pressed={camOn} aria-label="Camera" title={camOn ? "Camera on" : "Camera off"} onClick={toggleCam}>
                      <Ico d={CAM} size={16} w={1.6} />
                    </button>
                  </>
                )}
                <span className="mrv-sp" />
                {takingFoot ? (
                  <>
                    <span className={`mrv-clock${recorder.state === "paused" ? " paused" : ""}`} aria-live="off">
                      <i aria-hidden="true" />
                      {clock(recorder.secs)}
                    </span>
                    {recorder.state !== "ready" && (
                      <button type="button" className="mrv-tg" aria-label={recorder.state === "paused" ? "Resume" : "Pause"} title={recorder.state === "paused" ? "Resume" : "Pause"} onClick={recorder.state === "paused" ? recorder.resume : recorder.pause}>
                        {recorder.state === "paused" ? (
                          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor" /></svg>
                        ) : (
                          <Ico d="M9 6v12M15 6v12" size={14} w={2} />
                        )}
                      </button>
                    )}
                    <button type="button" className="mrv-stop" onClick={stopRecording} aria-label="Stop" title="Stop">
                      <b aria-hidden="true" />
                    </button>
                  </>
                ) : (
                  <>
                    {canRecord && (
                      <button type="button" className="mrv-pill" onClick={startRecording} disabled={busy}>
                        <i className="mrv-dot" aria-hidden="true" />
                        Record
                      </button>
                    )}
                    <button type="button" className="mrv-pill ink" disabled={!text.trim() || busy || drawingLeftBehind} onClick={() => void sendText()}>
                      {busy ? "Sending" : "Send"} <Ico d={SEND} size={15} w={1.8} />
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        </footer>
      </div>

      {/* Asked before a recording is thrown away. */}
      {confirm && (
        <div className="mrv-confirm" role="alertdialog" aria-label="Delete the recording?">
          <div className="mrv-confirm-card">
            <b>Delete the recording?</b>
            <span>
              <button type="button" className="mrv-text-btn" onClick={() => setConfirm(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="mrv-discard"
                onClick={() => {
                  discardTake();
                  onClose();
                }}
              >
                Delete
              </button>
            </span>
          </div>
        </div>
      )}
    </DialogContent>
  );
}

/** Whether a Training-tab video is one this modal shows: in, or answered, with a file. */
export const reviewable = (v: { state: string; src: string | null } | null | undefined) => !!v && (v.state === "in" || v.state === "replied") && !!v.src;
