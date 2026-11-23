"use client";

import { useCallback, useEffect, useRef, useState, useTransition, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import type { PhaseTrack } from "../../../lib/db";
import type { TrackPictures } from "../../../lib/phaseCovers";
import { addCoachCardPictureAction, removeCoachBannerAction, removeCoachCardPictureAction, removeCoachLogoAction, uploadCoachBannerAction, uploadCoachLogoAction } from "../../../lib/actions";
import { setCardsDefaultAction } from "../../../lib/brandingActions";
import { BRAND_SWATCHES, brandColour } from "../../../lib/brandColour";
import { fitJpeg } from "../../../lib/coverJpeg";
import { pic } from "../../../lib/pic";
import { NorCoachLogo } from "../../../components/NorCoachLogo";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "../../../components/ui/dialog";
import { TRACK_ACCENT, TRACK_LABEL } from "../../phaseChrome";
import { TrackIcon } from "../plan/PlanDraft";
import { ConfirmDialog } from "../training/TrainingDraft";
import HelpTip from "../HelpTip";
import { Sep } from "../Sep";
import { BrandColourSettings } from "./SettingsForms";
import "./branding.css";

// Settings, Branding (22 Nov, Alex: "i really like c. have the branding like in c and the card pictures like in a";
// docs/boards/_branding-opt-C.html and _branding-opt-A.html). One identity card drawn the way the brand shows: the band
// in the coach's colour (--brand, which BrandColourSettings sets on the body the moment a colour is picked, so the band
// follows live), their logo faint in it, the banner and the logo changed right where they show (their face and name went
// to Profile, 23 Nov, Alex); the paper rising over the band's foot holds the brand colour. Under the card the card pictures, a row a track, Default
// (Norcoach's stock pictures, read only) or Your own (up to five a track). Every change saved at once; only a failure
// speaks. Scoped under .rbr (branding.css).

const MAX = 5;
const TRACKS: PhaseTrack[] = ["lifestyle", "training", "nutrition"];
const INK = BRAND_SWATCHES[0].hex;

type Props = {
  mark: string | null;
  banner: string | null;
  bannerRatio: number | null;
  colour: string | null;
  cards: TrackPictures;
  cardsDefault: boolean;
  stock: TrackPictures;
};

export default function BrandingSection({ mark, banner, bannerRatio, colour, cards, cardsDefault, stock }: Props) {
  const logo = useBrandFile(uploadCoachLogoAction, removeCoachLogoAction);
  const ban = useBrandFile(uploadCoachBannerAction, removeCoachBannerAction);
  const shape = banner ? ({ "--banner-ratio": bannerRatio && bannerRatio > 0 ? bannerRatio : 4, WebkitMaskImage: `url("${banner}")`, maskImage: `url("${banner}")` } as CSSProperties) : undefined;
  const error = logo.error || ban.error;

  return (
    <div className="rbr">
      <div className="rbr-id">
        <div className="rbr-band">
          {/* Their logo faint in their colour, as the rest of the admin draws it; the star without one. */}
          <i className="rbr-band-mark" aria-hidden="true" />
          <div className="rbr-band-grid">
            <div className="rbr-cap">
              <span className="rbr-titled">
                Banner
                <HelpTip title="Banner">
                  <p>For the best result, upload your banner with a transparent background (a PNG or SVG).</p>
                </HelpTip>
              </span>
              <Sep />
              <span className="rbr-fact">{banner ? "In the top bar" : "NORCOACH"}</span>
            </div>
            <div className="rbr-cap r">
              <span className="rbr-titled">
                Logo
                <HelpTip title="Logo">
                  <p>For the best result, upload your logo with a transparent background (a PNG or SVG).</p>
                </HelpTip>
              </span>
              <Sep />
              <span className="rbr-fact">{mark ? "Behind every screen" : "Norcoach's star"}</span>
            </div>

            <div className="rbr-slot">
              <span className="rbr-bannerdraw">
                {banner ? <span className="brand-banner" role="img" aria-label="Your banner" style={shape} /> : <NorCoachLogo word />}
              </span>
              <FilePill file={ban} has={!!banner} />
              {banner && (
                <button type="button" className="rbr-gword" onClick={() => ban.setAsking(true)} disabled={ban.busy}>
                  Remove
                </button>
              )}
            </div>
            <div className="rbr-slot r">
              {mark && (
                <button type="button" className="rbr-gword" onClick={() => logo.setAsking(true)} disabled={logo.busy}>
                  Remove
                </button>
              )}
              <FilePill file={logo} has={!!mark} />
            </div>
          </div>
        </div>

        <div className="rbr-paper">
          {error && <small className="rbr-err">{error}</small>}
          <div className="rbr-paper-row">
            <ColourName picked={colour} />
            <div className="rbr-colour">
              <BrandColourSettings picked={colour} />
            </div>
          </div>
        </div>
      </div>

      <CardPictures cards={cards} cardsDefault={cardsDefault} stock={stock} />

      <Dialog open={logo.asking} onOpenChange={logo.setAsking}>
        {logo.asking && (
          <ConfirmDialog
            title="Remove your logo?"
            description="The Norcoach star comes back behind your screens and your clients’."
            confirm="Remove"
            danger
            onConfirm={() => logo.remove()}
          />
        )}
      </Dialog>
      <Dialog open={ban.asking} onOpenChange={ban.setAsking}>
        {ban.asking && (
          <ConfirmDialog
            title="Remove your banner?"
            description="NORCOACH comes back in the top bar."
            confirm="Remove"
            danger
            onConfirm={() => ban.remove()}
          />
        )}
      </Dialog>
    </div>
  );
}

type Result = { ok: true } | { ok: false; error: string };

/** A logo or a banner: the computer's own picker in one tap, saved at once, Remove asking first. */
function useBrandFile(upload: (f: FormData) => Promise<Result>, drop: () => Promise<Result | void>) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState("");
  const [asking, setAsking] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const pick = (file: File | undefined) => {
    if (!file) return;
    const f = new FormData();
    f.set("file", file);
    start(async () => {
      const r = await upload(f).catch(() => ({ ok: false as const, error: "Not saved. Try again." }));
      if (!r.ok) return setError(r.error);
      setError("");
      router.refresh();
    });
  };
  const remove = () => {
    setAsking(false);
    setError("");
    start(async () => {
      const r = await drop().catch(() => ({ ok: false as const, error: "Not removed. Try again." }));
      if (r && !r.ok) setError(r.error);
      router.refresh();
    });
  };
  return { busy, error, asking, setAsking, input, pick, remove };
}

function FilePill({ file, has }: { file: ReturnType<typeof useBrandFile>; has: boolean }) {
  return (
    <>
      <button type="button" className={`rbr-gpill${file.busy ? " busy" : ""}`} onClick={() => file.input.current?.click()} disabled={file.busy}>
        {!file.busy && !has && (
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M8 11V3M4.5 6.5 8 3l3.5 3.5M3 13h10" />
          </svg>
        )}
        {file.busy ? "Saving…" : has ? "Replace" : "Upload"}
      </button>
      <input ref={file.input} type="file" accept="image/*" hidden onChange={(e) => (file.pick(e.target.files?.[0]), (e.target.value = ""))} />
    </>
  );
}

/** `Brand colour` over the colour's name and hex, read live from --brand on the body (BrandColourSettings sets it the
 *  moment a colour is picked, the save following). */
function ColourName({ picked }: { picked: string | null }) {
  const fromProp = (picked && brandColour(picked)?.hex) || INK;
  const [hex, setHex] = useState(fromProp.toLowerCase());
  // The colour as picked when it shows darkened (BrandColourSettings puts it on the body), so the line says both on its
  // own room (23 Nov, Alex: the line under the picker "rearranges the whole screen").
  const [picked2, setPicked] = useState<string | null>(null);
  useEffect(() => {
    const read = () => {
      setHex((document.body.style.getPropertyValue("--brand").trim() || INK).toLowerCase());
      setPicked(document.body.dataset.brandPicked ?? null);
    };
    read();
    const watch = new MutationObserver(read);
    watch.observe(document.body, { attributes: true, attributeFilter: ["style", "data-brand-picked"] });
    return () => watch.disconnect();
  }, []);
  const name = BRAND_SWATCHES.find((s) => s.hex.toLowerCase() === hex)?.name ?? "Custom";
  return (
    <div className="rbr-colourname">
      <b>Brand colour</b>
      <span>
        {name}
        <Sep />
        {picked2 && picked2.toLowerCase() !== hex ? (
          <span className="rbr-colourshift" title={`${picked2.toUpperCase()} is darkened to ${hex.toUpperCase()} so words on it read`}>
            {picked2.toUpperCase()}
            <i aria-hidden="true">→</i>
            {hex.toUpperCase()}
          </span>
        ) : (
          hex.toUpperCase()
        )}
      </span>
    </div>
  );
}

// ---- Card pictures (option A's part): Default | Your own as the capsule, then a row a track in the tracks' order, its
// icon and name in its colour, its pictures as 3:4 tiles, `0 of 5` on the right in Your own. Default shows Norcoach's
// stock pictures read only; switching never deletes anything (setCardsDefaultAction).
function CardPictures({ cards, cardsDefault, stock }: { cards: TrackPictures; cardsDefault: boolean; stock: TrackPictures }) {
  const router = useRouter();
  const [def, setDef] = useState(cardsDefault);
  const [seen, setSeen] = useState(cardsDefault);
  if (cardsDefault !== seen) {
    setSeen(cardsDefault);
    setDef(cardsDefault);
  }
  const [error, setError] = useState("");
  const [view, setView] = useState<{ track: PhaseTrack; pictures: string[]; at: number } | null>(null);
  const choose = (on: boolean) => {
    if (on === def) return;
    setDef(on);
    setError("");
    void setCardsDefaultAction(on)
      .then(() => router.refresh())
      .catch(() => {
        setDef(!on);
        setError("Not saved. Try again.");
      });
  };
  return (
    <section className="rbr-pics">
      <div className="rbr-label">
        <span className="rbr-label-words">
          <b>Card pictures</b>
          <Sep />
          <span>{def ? "Default pictures" : "Your own"}</span>
        </span>
        <div className="rd-btn-group" role="group" aria-label="Card pictures">
          <button type="button" className={def ? "on" : undefined} aria-pressed={def} onClick={() => choose(true)}>
            Default
          </button>
          <button type="button" className={def ? undefined : "on"} aria-pressed={!def} onClick={() => choose(false)}>
            Your own
          </button>
        </div>
      </div>
      {error && <small className="rbr-err">{error}</small>}
      {/* Both lists are drawn from the start, the other one hidden, so their tiles are in before a switch (22 Nov, Alex:
          "when I toggle to default pictures, they also took maybe a second to load"). */}
      <div className="rbr-pics-card" hidden={!def}>
        {TRACKS.map((t) => (
          <StockTrack key={t} track={t} pictures={stock[t] ?? []} onOpen={(at) => setView({ track: t, pictures: stock[t] ?? [], at })} />
        ))}
      </div>
      <div className="rbr-pics-card" hidden={def}>
        {TRACKS.map((t) => (
          <OwnTrack key={t} track={t} saved={cards[t] ?? []} onOpen={(pictures, at) => setView({ track: t, pictures, at })} />
        ))}
      </div>
      <Dialog open={!!view} onOpenChange={(o) => !o && setView(null)}>
        {view && <PictureViewer key={view.track} track={view.track} pictures={view.pictures} start={view.at} />}
      </Dialog>
    </section>
  );
}

/** A tile's picture: an upload's 480 copy (lib/pic; a 60px tile is 120 px on a 2× screen, and the browser has it
 *  cached already), a stock file as it is (30–360 KB). Eager, and both lists are
 *  mounted from the start, so the hidden one is fetched with the page. Not next/image for the stock files: the
 *  optimizer fetches /img/… with no cookie and proxy.ts sends that to sign-in, so /_next/image answers 400. */
/** A stock picture's small copy for a tile (scripts/stock-thumbs.mjs: public/img/thumb/<name>.webp, 240×320, a few KB),
 *  so Default shows at once (22 Nov, Alex: "they also took maybe a second to load"); the original only in the viewer. */
const stockThumb = (src: string) => {
  const m = /^\/img\/((?:lifestyle|training|nutrition)-[\w-]+)\.jpg$/.exec(src);
  return m ? `/img/thumb/${m[1]}.webp` : src;
};

function Thumb({ src }: { src: string }) {
  // eslint-disable-next-line @next/next/no-img-element -- see above
  return <img src={src.startsWith("/uploads/") ? pic(src, 480) : stockThumb(src)} alt="" loading="eager" decoding="async" draggable={false} />;
}

/** The picture at full size: an upload's 1080 copy, a stock file as it is. */
const big = (src: string) => (src.startsWith("/uploads/") ? pic(src, 1080) : src);

// ---- The viewer (22 Nov, Alex: "since they're quite small… clicking on them and being able to like see them expanded…
// an arrow or something that I can go to the next one"; then "the picture in the middle… no black background… only the
// picture… the arrows on the sides of the picture, but outside… the background… blurred"): the picture alone in the
// middle of the window, its own shape with rounded corners, no head, stage or title (the track was the row clicked);
// ‹ › round white buttons outside its sides, the ✕ outside its top right; the page behind darkened and blurred, as the
// client's notification pop-up. ← → and a sideways swipe step, Esc or a click beside it closes. Nothing to change in it:
// a tile's × removes.
function PictureViewer({ track, pictures, start }: { track: PhaseTrack; pictures: string[]; start: number }) {
  const n = pictures.length;
  const [at, setAt] = useState(Math.min(Math.max(0, start), Math.max(0, n - 1)));
  const [dir, setDir] = useState<"l" | "r" | "">("");
  // Each picture's width over its height once known, so the frame is the picture's own shape (3:4 until then: the
  // tiles' crop, the small copy shown in it meanwhile).
  const [ratio, setRatio] = useState<Record<string, number>>({});
  const press = useRef<{ x: number; y: number } | null>(null);
  const step = (by: number) => {
    if (n < 2) return;
    setDir(by > 0 ? "r" : "l");
    setAt((i) => (i + by + n) % n);
  };
  const known = useCallback((p: string, w: number, h: number) => {
    if (w && h) setRatio((r) => (r[p] ? r : { ...r, [p]: w / h }));
  }, []);

  // Every picture of the track fetched as the viewer opens (five at most), so a step never waits.
  useEffect(() => {
    for (const p of pictures) {
      const img = new window.Image();
      img.decoding = "async";
      img.onload = () => known(p, img.naturalWidth, img.naturalHeight);
      img.src = big(p);
      if (img.complete) known(p, img.naturalWidth, img.naturalHeight);
    }
  }, [pictures, known]);

  // The full picture shows once in; a stable ref, so it runs only as each picture's img mounts.
  const bigIn = useCallback((el: HTMLImageElement | null) => {
    if (el?.complete && el.naturalWidth) el.dataset.in = "1";
  }, []);

  const src = pictures[at];
  const r = (src && ratio[src]) || 3 / 4;
  return (
    <DialogContent
      className="rbv"
      aria-describedby={undefined}
      onKeyDown={(e) => {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        e.preventDefault();
        step(e.key === "ArrowRight" ? 1 : -1);
      }}
    >
      <DialogTitle className="sr-only">
        {TRACK_LABEL[track]} picture {at + 1} of {n}
      </DialogTitle>
      {n > 1 && (
        <button type="button" className="rbv-nav l" onClick={() => step(-1)} aria-label="Previous picture" title="Previous">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M10 3.5 5.5 8l4.5 4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
      <div
        className="rbv-stage"
        style={{ "--r": r } as CSSProperties}
        onPointerDown={(e) => {
          if ((e.target as Element).closest("button")) return;
          press.current = { x: e.clientX, y: e.clientY };
          // A mouse swipe let go outside the picture still steps (a touch is captured already).
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerUp={(e) => {
          const from = press.current;
          press.current = null;
          if (!from) return;
          const dx = e.clientX - from.x;
          if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(e.clientY - from.y)) step(dx < 0 ? 1 : -1);
        }}
        onPointerCancel={() => (press.current = null)}
      >
        {src && (
          <div key={`${at}-${src}`} className={`rbv-frame${dir ? ` in-${dir}` : ""}`}>
            {/* the tile's small copy, already in, under the full one while it comes */}
            <Thumb src={src} />
            {/* eslint-disable-next-line @next/next/no-img-element -- the picture at full size */}
            <img
              className="rbv-big"
              src={big(src)}
              alt={`${TRACK_LABEL[track]} picture ${at + 1}`}
              draggable={false}
              ref={bigIn}
              onLoad={(e) => {
                e.currentTarget.dataset.in = "1";
                known(src, e.currentTarget.naturalWidth, e.currentTarget.naturalHeight);
              }}
            />
          </div>
        )}
        <DialogClose className="rbv-x" aria-label="Close">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </DialogClose>
      </div>
      {n > 1 && (
        <button type="button" className="rbv-nav r" onClick={() => step(1)} aria-label="Next picture" title="Next">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M6 3.5 10.5 8 6 12.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
    </DialogContent>
  );
}

function TrackName({ track }: { track: PhaseTrack }) {
  return (
    <span className="rbr-trk" style={{ color: TRACK_ACCENT[track] }}>
      <TrackIcon track={track} size={14} />
      {TRACK_LABEL[track]}
    </span>
  );
}

function StockTrack({ track, pictures, onOpen }: { track: PhaseTrack; pictures: string[]; onOpen: (at: number) => void }) {
  return (
    <div className="rbr-track">
      <div className="rbr-track-row">
        <TrackName track={track} />
        <div className="rbr-tiles">
          {pictures.map((p, i) => (
            <button key={p} type="button" className="rbr-pic open" onClick={() => onOpen(i)} aria-label={`Open ${TRACK_LABEL[track].toLowerCase()} picture ${i + 1}`}>
              <Thumb src={p} />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** A picture on its way up: shown at once from the computer, breathing until it lands. */
type Pending = { key: string; preview: string };

// The tile logic of CardPicturesSettings' TrackCards (the computer's picker, uploads one after another, Remove asking
// in place), drawn as option A's row.
function OwnTrack({ track, saved, onOpen }: { track: PhaseTrack; saved: string[]; onOpen: (pictures: string[], at: number) => void }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
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
  const flying = useRef(0);
  const [asking, setAsking] = useState<string | null>(null);
  const [error, setError] = useState("");
  const chain = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    if (!asking) return;
    const off = (e: PointerEvent) => {
      if ((e.target as Element | null)?.closest(".rbr-pic.asking")) return;
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
    <div className="rbr-track">
      <div className="rbr-track-row">
        <TrackName track={track} />
        <div className="rbr-tiles">
          {list.map((p, i) => (
            <span key={p} className={`rbr-pic${asking === p ? " asking" : ""}`}>
              <button
                type="button"
                className="rbr-pic-open"
                onClick={() => onOpen(list, i)}
                disabled={asking === p}
                aria-label={`Open ${TRACK_LABEL[track].toLowerCase()} picture ${i + 1}`}
              >
                <Thumb src={p} />
              </button>
              {asking === p ? (
                <span className="rbr-pic-ask">
                  <b>Remove?</b>
                  <button type="button" className="rbr-pic-word" onClick={() => setAsking(null)}>
                    Cancel
                  </button>
                  <button type="button" className="rbr-pic-word danger" onClick={() => remove(p)}>
                    Remove
                  </button>
                </span>
              ) : (
                <button type="button" className="rbr-pic-x" onClick={() => setAsking(p)} aria-label="Remove this picture" title="Remove">
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                    <path d="M2.5 2.5l5 5M7.5 2.5l-5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                </button>
              )}
            </span>
          ))}
          {pending.map((x) => (
            <span key={x.key} className="rbr-pic up">
              {/* eslint-disable-next-line @next/next/no-img-element -- the picture itself while it goes up */}
              <img src={x.preview} alt="" />
            </span>
          ))}
          {room > 0 && (
            <button type="button" className="rbr-pic add" onClick={() => fileRef.current?.click()} aria-label={`Add ${TRACK_LABEL[track].toLowerCase()} pictures`} title="Add">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </div>
        <span className="rbr-count">
          {list.length + pending.length} of {MAX}
        </span>
      </div>
      {error && <small className="rbr-err">{error}</small>}
      <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => pick(e.target.files)} />
    </div>
  );
}
