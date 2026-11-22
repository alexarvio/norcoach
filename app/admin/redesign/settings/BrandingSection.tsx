"use client";

import { useEffect, useRef, useState, useTransition, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import type { PhaseTrack } from "../../../lib/db";
import type { TrackPictures } from "../../../lib/phaseCovers";
import { addCoachCardPictureAction, removeCoachBannerAction, removeCoachCardPictureAction, removeCoachLogoAction, uploadCoachBannerAction, uploadCoachLogoAction } from "../../../lib/actions";
import { setCardsDefaultAction } from "../../../lib/brandingActions";
import { BRAND_SWATCHES, brandColour } from "../../../lib/brandColour";
import { fitJpeg } from "../../../lib/coverJpeg";
import { pic } from "../../../lib/pic";
import { NorCoachLogo } from "../../../components/NorCoachLogo";
import { Dialog } from "../../../components/ui/dialog";
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
// follows live), their logo faint in it, the banner and the logo changed right where they show, their face and name;
// the paper rising over the band's foot holds the brand colour. Under the card the card pictures, a row a track, Default
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
  business: string;
  coach: { name: string; photo: string | null };
};

export default function BrandingSection({ mark, banner, bannerRatio, colour, cards, cardsDefault, stock, business, coach }: Props) {
  const logo = useBrandFile(uploadCoachLogoAction, removeCoachLogoAction);
  const ban = useBrandFile(uploadCoachBannerAction, removeCoachBannerAction);
  const shape = banner ? ({ "--banner-ratio": bannerRatio && bannerRatio > 0 ? bannerRatio : 4, WebkitMaskImage: `url("${banner}")`, maskImage: `url("${banner}")` } as CSSProperties) : undefined;
  const error = logo.error || ban.error;
  const initial = coach.name.trim().charAt(0).toUpperCase() || "?";

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

          <div className="rbr-who">
            {coach.photo ? (
              // eslint-disable-next-line @next/next/no-img-element -- the coach's own face
              <img className="rbr-face" src={pic(coach.photo, 96)} alt="" />
            ) : (
              <span className="rbr-face none" aria-hidden="true">
                {initial}
              </span>
            )}
            <div className="rbr-who-words">
              <b>{coach.name}</b>
              {business && <span>{business}</span>}
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
  useEffect(() => {
    const read = () => setHex((document.body.style.getPropertyValue("--brand").trim() || INK).toLowerCase());
    read();
    const watch = new MutationObserver(read);
    watch.observe(document.body, { attributes: true, attributeFilter: ["style"] });
    return () => watch.disconnect();
  }, []);
  const name = BRAND_SWATCHES.find((s) => s.hex.toLowerCase() === hex)?.name ?? "Custom";
  return (
    <div className="rbr-colourname">
      <b>Brand colour</b>
      <span>
        {name}
        <Sep />
        {hex.toUpperCase()}
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
      <div className="rbr-pics-card">
        {TRACKS.map((t) => (def ? <StockTrack key={t} track={t} pictures={stock[t] ?? []} /> : <OwnTrack key={t} track={t} saved={cards[t] ?? []} />))}
      </div>
    </section>
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

function StockTrack({ track, pictures }: { track: PhaseTrack; pictures: string[] }) {
  return (
    <div className="rbr-track">
      <div className="rbr-track-row">
        <TrackName track={track} />
        <div className="rbr-tiles">
          {pictures.map((p) => (
            <span key={p} className="rbr-pic">
              {/* eslint-disable-next-line @next/next/no-img-element -- Norcoach's stock picture */}
              <img src={pic(p, 480)} alt="" loading="lazy" decoding="async" />
            </span>
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
function OwnTrack({ track, saved }: { track: PhaseTrack; saved: string[] }) {
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
          {list.map((p) => (
            <span key={p} className={`rbr-pic${asking === p ? " asking" : ""}`}>
              {/* eslint-disable-next-line @next/next/no-img-element -- the coach's own upload */}
              <img src={pic(p, 480)} alt="" loading="lazy" decoding="async" />
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
