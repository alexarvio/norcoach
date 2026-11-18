"use client";

import { useLayoutEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { COACH_STEPS, SiteShell } from "./SignInScreens";
import { Bars } from "../client/Bars";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/form";
import { finishWelcomeAction, saveCoachAboutAction, saveWelcomeBusinessAction } from "../lib/onboarding-actions";

// The coach's sign-up after the email (18 Nov, Alex: docs/boards/coach-flow-mockup.html, "Build it"): one flow in the
// sign-up's dark-and-paper frame, each thing asked once. About you (the photo clients see, first and last name, date of
// birth, what they coach) makes the account; Your business (business name, country, which sets the currency and tax);
// then You're set, who they are, and Open Norcoach. No plan step (the first coaches are free), no code (Settings, Profile),
// the time zone set from the computer, never asked. On a laptop the dark lists the steps, done ticked green, the one on
// screen white. Never a jump: the head and the paper stay put while a step's form slides out and the next slides in, as
// the client's join screens (the .jn- classes they share); You're set comes in line by line.

type Step = "about" | "business" | "ready";
const ORDER: Record<Step, number> = { about: 0, business: 1, ready: 2 };
const TITLE: Record<Step, string> = { about: "About you", business: "Your business", ready: "You’re set" };

export type CoachSetupData = {
  start: Step;
  email: string;
  first: string;
  last: string;
  /** YYYY-MM-DD. */
  birthdate: string;
  title: string;
  photo: string | null;
  business: string;
  countryCode: string;
  countries: { code: string; name: string; currency: string; tax: string; rate: number }[];
};

const dobShown = (raw: string) => {
  const d = raw.replace(/\D/g, "").slice(0, 8);
  return [d.slice(0, 2), d.slice(2, 4), d.slice(4)].filter(Boolean).join(" / ");
};
function dobValue(shown: string): string | null {
  const d = shown.replace(/\D/g, "");
  if (d.length !== 8) return null;
  const [dd, mm, yyyy] = [Number(d.slice(0, 2)), Number(d.slice(2, 4)), Number(d.slice(4))];
  const date = new Date(Date.UTC(yyyy, mm - 1, dd));
  if (date.getUTCFullYear() !== yyyy || date.getUTCMonth() !== mm - 1 || date.getUTCDate() !== dd) return null;
  const now = new Date();
  const youngest = Date.UTC(now.getFullYear() - 14, now.getMonth(), now.getDate());
  if (yyyy < now.getFullYear() - 100 || date.getTime() > youngest) return null;
  return `${d.slice(4)}-${d.slice(2, 4)}-${d.slice(0, 2)}`;
}
const fromValue = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v.slice(8)} / ${v.slice(5, 7)} / ${v.slice(0, 4)}` : "");
const reduced = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
async function faceOf(file: File): Promise<File> {
  try {
    const bmp = await createImageBitmap(file);
    const side = Math.min(bmp.width, bmp.height);
    const out = Math.min(800, side);
    const canvas = document.createElement("canvas");
    canvas.width = out;
    canvas.height = out;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, out, out);
    bmp.close();
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", 0.88));
    return blob ? new File([blob], "avatar.jpg", { type: "image/jpeg" }) : file;
  } catch {
    return file;
  }
}

const CameraIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1.5-2h6l1.5 2h2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z" />
    <circle cx="12" cy="13" r="3.4" />
  </svg>
);

export default function CoachSetupFlow({ data }: { data: CoachSetupData }) {
  const [pages, setPages] = useState<{ cur: Step; prev: Step | null; dir: 1 | -1 }>({ cur: data.start, prev: null, dir: 1 });
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const pagesBox = useRef<HTMLDivElement>(null);
  const [hold, setHold] = useState<number | null>(null);
  const go = (next: Step) => {
    setError(null);
    setHold(pagesBox.current?.offsetHeight ?? null);
    setPages((p) => (p.cur === next ? p : { cur: next, prev: p.cur, dir: ORDER[next] > ORDER[p.cur] ? 1 : -1 }));
    window.setTimeout(() => {
      setPages((p) => ({ ...p, prev: null }));
      setHold(null);
    }, reduced() ? 0 : 380);
  };
  useLayoutEffect(() => {
    if (!pages.prev) setHold(null);
  }, [pages.prev]);

  // About you.
  const [first, setFirst] = useState(data.first);
  const [last, setLast] = useState(data.last);
  const [dob, setDob] = useState(fromValue(data.birthdate));
  const [title, setTitle] = useState(data.title);
  const [photo, setPhoto] = useState<string | null>(data.photo);
  const [file, setFile] = useState<File | null>(null);
  const [photoNote, setPhotoNote] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Your business. The time zone is the computer's own, sent with it.
  const [business, setBusiness] = useState(data.business);
  const [country, setCountry] = useState(data.countryCode);
  const picked = data.countries.find((c) => c.code === country) ?? null;

  const saveAbout = () =>
    start(async () => {
      setError(null);
      const birthdate = dobValue(dob);
      if (!first.trim() || !last.trim()) return setError("Add your first and last name.");
      if (!birthdate) return setError("Check your date of birth.");
      const fd = new FormData();
      fd.set("first", first);
      fd.set("last", last);
      fd.set("birthdate", birthdate);
      fd.set("title", title);
      // The photo goes with the step, shrunk first, and saved with it.
      if (file) fd.set("photo", await faceOf(file));
      const r = await saveCoachAboutAction(fd).catch(() => ({ ok: false as const, error: "Not saved. Try again.", next: undefined, photo: undefined }));
      if (!r.ok) return setError(r.error ?? "Not saved. Try again.");
      setFile(null);
      if (r.photo === "failed") {
        setPhoto(data.photo);
        setPhotoNote("Photo not added. Add it in Settings, Profile.");
      } else setPhotoNote(null);
      // While coaches pay: the plan first, the rest of setup after it.
      if (r.next) return window.location.assign(r.next);
      (document.activeElement as HTMLElement | null)?.blur?.();
      go("business");
    });

  const saveBusiness = () =>
    start(async () => {
      setError(null);
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
      const r = await saveWelcomeBusinessAction({ business, countryCode: country, timezone }).catch(() => ({ ok: false }));
      if (!r.ok) return setError("Not saved. Try again.");
      (document.activeElement as HTMLElement | null)?.blur?.();
      go("ready");
    });

  // Into the admin; if it can't, a line saying so here, never an error page.
  const open = () =>
    start(async () => {
      setError(null);
      await finishWelcomeAction("look").catch(() => setError("Not saved. Try again."));
    });

  const name = `${first.trim()} ${last.trim()}`.trim();
  const face = (
    <span className="cs-face" aria-hidden="true">
      {photo ? (
        // eslint-disable-next-line @next/next/no-img-element -- the coach's own picture, just picked or already saved
        <img src={photo} alt="" />
      ) : (
        (first.trim().charAt(0) || "N").toUpperCase()
      )}
    </span>
  );

  const page = (step: Step): ReactNode =>
    step === "about" ? (
      <form
        className="auth-form"
        method="post"
        onSubmit={(e) => {
          e.preventDefault();
          if (!pending) saveAbout();
        }}
      >
        {error && <p className="auth-error au-error">{error}</p>}
        {/* The photo clients see: the phone's or computer's own picker in one tap. */}
        <button type="button" className="cs-photo" onClick={() => fileInput.current?.click()}>
          <span className={`cs-avatar${photo ? " has" : ""}`}>
            {photo ? (
              // eslint-disable-next-line @next/next/no-img-element -- the picture just picked
              <img src={photo} alt="" />
            ) : (
              <CameraIcon />
            )}
          </span>
          <span className="cs-photo-word">{photo ? "Change photo" : "Add a photo"}</span>
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f || !f.type.startsWith("image/")) return;
            if (photo?.startsWith("blob:")) URL.revokeObjectURL(photo);
            setFile(f);
            setPhotoNote(null);
            setPhoto(URL.createObjectURL(f));
          }}
        />
        <div className="au-two">
          <label className="auth-field">
            <span>First name</span>
            <input name="first" autoComplete="given-name" value={first} onChange={(e) => (setFirst(e.target.value), setError(null))} maxLength={40} />
          </label>
          <label className="auth-field">
            <span>Last name</span>
            <input name="last" autoComplete="family-name" value={last} onChange={(e) => (setLast(e.target.value), setError(null))} maxLength={40} />
          </label>
        </div>
        <label className="auth-field">
          <span>Date of birth</span>
          <input name="birthdate" inputMode="numeric" autoComplete="bday" placeholder="DD / MM / YYYY" value={dob} onChange={(e) => (setDob(dobShown(e.target.value)), setError(null))} />
        </label>
        <label className="auth-field">
          <span>What you coach</span>
          <input name="title" autoComplete="off" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} />
        </label>
        <button className="btn auth-submit" type="submit" disabled={pending}>
          {pending ? "One moment…" : "Continue"}
        </button>
      </form>
    ) : step === "business" ? (
      <form
        className="auth-form"
        method="post"
        onSubmit={(e) => {
          e.preventDefault();
          if (!pending) saveBusiness();
        }}
      >
        {(error || photoNote) && <p className="auth-error au-error">{error ?? photoNote}</p>}
        <label className="auth-field">
          <span>Business name</span>
          <input name="business" autoComplete="organization" value={business} onChange={(e) => setBusiness(e.target.value)} maxLength={120} />
        </label>
        <div className="auth-field cs-country">
          <span>Country</span>
          <Select value={country || undefined} onValueChange={setCountry}>
            <SelectTrigger className="cs-select" aria-label="Country">
              <SelectValue placeholder="Choose" />
            </SelectTrigger>
            <SelectContent className="cs-select-menu">
              {data.countries.map((c) => (
                <SelectItem key={c.code} value={c.code}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {/* What the country sets on invoices: facts, parted by the drawn bar. */}
          <small className="cs-fact">{picked ? <Bars parts={[`Prices in ${picked.currency}`, picked.rate ? `${picked.rate}% ${picked.tax}` : null]} /> : " "}</small>
        </div>
        <button className="btn auth-submit" type="submit" disabled={pending}>
          {pending ? "One moment…" : "Continue"}
        </button>
        <p className="auth-note jn-back">
          <button type="button" className="au-link" onClick={() => go("about")} disabled={pending}>
            Back
          </button>
        </p>
      </form>
    ) : (
      <div className="cs-ready">
        {error && <p className="auth-error au-error">{error}</p>}
        <div className="cs-who">
          {face}
          <span>
            <b>{name}</b>
            <small>
              <Bars parts={[business.trim() || null, title.trim() || null]} />
            </small>
          </span>
        </div>
        <button className="btn auth-submit" type="button" onClick={open} disabled={pending}>
          Open Norcoach
        </button>
      </div>
    );

  const t = TITLE[pages.cur];
  return (
    <SiteShell
      className="jn cs"
      pitch={false}
      steps={{ labels: COACH_STEPS, now: ORDER[pages.cur] + 1 }}
      title={
        <span key={t} className="jn-title">
          {pages.cur === "ready" && first.trim() ? `You’re set, ${first.trim()}` : t}
        </span>
      }
      aside={
        <Bars
          parts={[
            <span key="e">{data.email}</span>,
            <a key="o" href="/auth/signout">
              Sign out
            </a>,
          ]}
        />
      }
    >
      <div className="jn-pages" ref={pagesBox} style={hold ? { minHeight: hold } : undefined}>
        {pages.prev && (
          <div className={`jn-page out d${pages.dir}`} aria-hidden="true" inert>
            {page(pages.prev)}
          </div>
        )}
        <div key={pages.cur} className={`jn-page${pages.prev ? ` in d${pages.dir}` : ""}`}>
          {page(pages.cur)}
        </div>
      </div>
    </SiteShell>
  );
}
