"use client";

import { useState } from "react";

// A guide's video (24 Nov, Alex; lib/guides.ts): an uploaded clip, or a YouTube or Vimeo link, played as the Library's
// demos are (DemoVideoDialog): YouTube's own thumbnail, a clip's first frame (?poster=1), else a plain tile; a click on
// the round play mark plays it in place. Shared by the help panel (HelpButton) and the owner's Guides on Coaches.

export const ytId = (url: string) => /(?:youtu\.be\/|[?&]v=|shorts\/|embed\/)([\w-]{11})/.exec(url)?.[1] ?? null;
export const vimeoId = (url: string) => /vimeo\.com\/(?:video\/)?(\d+)/.exec(url)?.[1] ?? null;
export const isUploadedVideo = (url: string) => url.startsWith("/uploads/");

/** The name of where a video lives, for a fact line. */
export function videoSource(url: string): string {
  if (isUploadedVideo(url)) return "Uploaded file";
  if (ytId(url) || /youtube\.com|youtu\.be/i.test(url)) return "YouTube";
  if (/vimeo\.com/i.test(url)) return "Vimeo";
  return "Link";
}

/** A length as the panel says it: `2 min` (a minute at least). */
export const minutes = (seconds: number | null) => (seconds == null ? null : `${Math.max(1, Math.round(seconds / 60))} min`);

/** The poster picture for a video, or null when there is none (Vimeo without its API, a plain link). */
export function posterOf(url: string | null): string | null {
  if (!url) return null;
  const id = ytId(url);
  if (id) return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
  if (isUploadedVideo(url)) return `${url}?poster=1`;
  return null;
}

const PLAY = "M8 5v14l11-7z";

/** A small poster: the picture, else the plain tile; the play mark over it. */
export function GuideThumb({ video, className = "hlp-thumb" }: { video: string | null; className?: string }) {
  const [broken, setBroken] = useState(false);
  const src = posterOf(video);
  return (
    <span className={className} aria-hidden="true">
      {/* eslint-disable-next-line @next/next/no-img-element -- YouTube's thumbnail or the clip's first frame */}
      {src && !broken && <img src={src} alt="" loading="lazy" draggable={false} onError={() => setBroken(true)} />}
      {video && (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d={PLAY} fill="currentColor" />
        </svg>
      )}
    </span>
  );
}

/** The video, 16:9, played in place; `onPlay` once it starts (the guide watched). */
export function GuidePlayer({ video, title, onPlay }: { video: string; title: string; onPlay?: () => void }) {
  const [playing, setPlaying] = useState(false);
  const [broken, setBroken] = useState(false);
  if (isUploadedVideo(video))
    return (
      <div className="hlp-player">
        <video src={video} poster={`${video}?poster=1`} controls playsInline preload="metadata" onPlay={onPlay} />
      </div>
    );
  const yt = ytId(video);
  const vm = vimeoId(video);
  if (playing && (yt || vm))
    return (
      <div className="hlp-player">
        <iframe src={yt ? `https://www.youtube.com/embed/${yt}?autoplay=1&rel=0` : `https://player.vimeo.com/video/${vm}?autoplay=1`} title={title} allow="autoplay; fullscreen; picture-in-picture" allowFullScreen />
      </div>
    );
  const poster = posterOf(video);
  const start = () => {
    onPlay?.();
    if (yt || vm) setPlaying(true);
    else window.open(video, "_blank", "noopener,noreferrer");
  };
  return (
    <button type="button" className="hlp-player hlp-poster" onClick={start} aria-label={yt || vm ? `Play ${title}` : `Open ${title}`}>
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
