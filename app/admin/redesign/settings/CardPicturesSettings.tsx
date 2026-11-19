"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { PhaseTrack } from "../../../lib/db";
import type { TrackPictures } from "../../../lib/phaseCovers";
import { addCoachCardPictureAction, removeCoachCardPictureAction } from "../../../lib/actions";
import { fitJpeg } from "../../../lib/coverJpeg";
import { pic } from "../../../lib/pic";
import { TRACK_ACCENT, TRACK_LABEL } from "../../phaseChrome";
import { TrackIcon } from "../plan/PlanDraft";
import { Section } from "./SettingsForms";

// ---- Card pictures (19 Nov, Alex: "do up to 5 per track"; lib/coachCards.ts): the coach's own pictures behind their
// clients' Home cards and banners, in place of Norcoach's stock ones, set once for all their clients. A row a track in
// the tracks' order, its icon and name in its colour, then its pictures as small 3:4 tiles, up to five, the dashed Add
// tile while there is room (the computer's own picker in one tap); a round × on a tile's hover asks in place, the
// tile dimmed, Remove? with Cancel and Remove in words. Each change saved at once, as Logo; only a failure speaks.

const MAX = 5;
const TRACKS: PhaseTrack[] = ["lifestyle", "training", "nutrition"];

export default function CardPicturesSettings({ cards }: { cards: TrackPictures }) {
  const total = TRACKS.reduce((n, t) => n + (cards[t]?.length ?? 0), 0);
  return (
    <Section title="Card pictures" fact={total ? "On your clients' cards" : "Norcoach's for now"}>
      <div className="rls-card rst-card rst-cards">
        {TRACKS.map((t) => (
          <TrackCards key={t} track={t} saved={cards[t] ?? []} />
        ))}
      </div>
    </Section>
  );
}

/** A picture on its way up: shown at once from the computer, breathing until it lands. */
type Pending = { key: string; preview: string };

function TrackCards({ track, saved }: { track: PhaseTrack; saved: string[] }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  // What was just saved, until the page comes back with it.
  const [list, setList] = useState(saved);
  // Taken again only when what the page saved changed, read by its content (a refresh hands a new array each time).
  const savedKey = saved.join("|");
  const [seenKey, setSeenKey] = useState(savedKey);
  const [pending, setPending] = useState<Pending[]>([]);
  // Never while pictures are still going up: a page read in between would drop the ones that landed after it.
  if (savedKey !== seenKey && !pending.length) {
    setSeenKey(savedKey);
    setList(saved);
  }
  /** Uploads not finished yet; the page is read again once the last is in. */
  const flying = useRef(0);
  const [asking, setAsking] = useState<string | null>(null);
  const [error, setError] = useState("");
  /** Uploads go one after another, so they land in the order picked. */
  const chain = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    if (!asking) return;
    const off = (e: PointerEvent) => {
      if ((e.target as Element | null)?.closest(".rst-cardpic.asking")) return;
      setAsking(null);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setAsking(null);
    document.addEventListener("pointerdown", off);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", off);
      document.removeEventListener("keydown", esc);
    };
  }, [asking]);

  const room = Math.max(0, MAX - list.length - pending.length);
  const pick = (files: FileList | null) => {
    const picked = files ? Array.from(files).slice(0, room) : [];
    if (fileRef.current) fileRef.current.value = "";
    if (!picked.length) return;
    setError("");
    for (const file of picked) {
      const item: Pending = { key: `${Date.now()}-${Math.random()}`, preview: URL.createObjectURL(file) };
      setPending((p) => [...p, item]);
      flying.current += 1;
      chain.current = chain.current.then(async () => {
        // Made smaller here first (the longest side 1600), so it goes up quickly; the server makes it the card's JPEG.
        const small = await fitJpeg(file, 1600).catch(() => null);
        const f = new FormData();
        f.set("file", small ? new File([small], "card.jpg", { type: "image/jpeg" }) : file);
        const r = await addCoachCardPictureAction(track, f).catch(() => ({ ok: false as const, error: "Not saved. Try again." }));
        flying.current -= 1;
        if (r.ok) setList((l) => [...l, r.path]);
        else setError(r.error);
        setPending((p) => p.filter((x) => x.key !== item.key));
        URL.revokeObjectURL(item.preview);
        if (!flying.current) router.refresh();
      });
    }
  };
  const remove = (p: string) => {
    setAsking(null);
    setError("");
    const before = list;
    setList((l) => l.filter((x) => x !== p));
    void removeCoachCardPictureAction(track, p)
      .then((r) => {
        if (!r.ok) {
          setList(before);
          setError(r.error);
        } else if (!flying.current) router.refresh();
      })
      .catch(() => {
        setList(before);
        setError("Not removed. Try again.");
      });
  };

  return (
    <div className="rst-cards-track">
      <span className="rst-cards-head" style={{ color: TRACK_ACCENT[track] }}>
        <TrackIcon track={track} size={14} />
        {TRACK_LABEL[track]}
      </span>
      <div className="rst-cards-row">
        {list.map((p) => (
          <span key={p} className={`rst-cardpic${asking === p ? " asking" : ""}`}>
            {/* eslint-disable-next-line @next/next/no-img-element -- the coach's own upload */}
            <img src={pic(p, 480)} alt="" loading="lazy" decoding="async" />
            {asking === p ? (
              <span className="rst-cardpic-ask">
                <b>Remove?</b>
                <button type="button" className="rst-cardpic-word" onClick={() => setAsking(null)}>
                  Cancel
                </button>
                <button type="button" className="rst-cardpic-word danger" onClick={() => remove(p)}>
                  Remove
                </button>
              </span>
            ) : (
              <button type="button" className="rst-cardpic-x" onClick={() => setAsking(p)} aria-label="Remove this picture" title="Remove">
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                  <path d="M2.5 2.5l5 5M7.5 2.5l-5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </button>
            )}
          </span>
        ))}
        {pending.map((x) => (
          <span key={x.key} className="rst-cardpic up">
            {/* eslint-disable-next-line @next/next/no-img-element -- the picture itself while it goes up */}
            <img src={x.preview} alt="" />
          </span>
        ))}
        {room > 0 && (
          <button type="button" className="rst-cardpic add" onClick={() => fileRef.current?.click()} aria-label={`Add ${TRACK_LABEL[track].toLowerCase()} pictures`}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            <span>Add</span>
          </button>
        )}
      </div>
      {error && <small className="rst-err">{error}</small>}
      <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => pick(e.target.files)} />
    </div>
  );
}
