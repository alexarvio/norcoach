"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { SiteShell } from "./SignInScreens";
import { Bars } from "../client/Bars";
import { leaveWithDarkClock } from "../client/NativeStatusBar";
import { deleteJoinAccountAction, joinStatusAction, lookupCoachCodeAction, sendJoinRequestAction, withdrawJoinRequestAction } from "../lib/joinActions";
import type { CoachCard } from "../lib/joinRequests";

// Joining a coach (18 Nov, Alex: docs/boards/client-signup-mockup.html, its Motion section): About you (first and last
// name, date of birth), then the coach's code, which shows the coach's picture, name and business once it is theirs
// ("Not a valid code" when it is no one's), then Send request and the wait, until the coach says yes. Never a jump from
// screen to screen (18 Nov, Alex: "have a smooth transition"): the dark head and the paper stay put while a step's form
// slides out and the next slides in; on Send the paper drops away, the coach's picture lifts out of its row into its
// place on the dark, and Request sent, Waiting for {First}, the facts and the buttons come in one after another; on the
// yes the ring goes green, the line becomes You're in, and the paper rises again into the app. Styles: .jn- at the end
// of globals.css; reduced motion, the screens simply change.

type Step = "about" | "coach";
const ORDER: Record<Step, number> = { about: 0, coach: 1 };
const TITLE: Record<Step, string> = { about: "About you", coach: "Your coach" };
const POLL_MS = 8000;

/** Typed as DD / MM / YYYY: digits only, the slashes coming in as they go. */
function dobShown(raw: string): string {
  const d = raw.replace(/\D/g, "").slice(0, 8);
  return [d.slice(0, 2), d.slice(2, 4), d.slice(4)].filter(Boolean).join(" / ");
}

/** DD / MM / YYYY to YYYY-MM-DD, when it is a real day someone alive was born on. */
function dobValue(shown: string): string | null {
  const d = shown.replace(/\D/g, "");
  if (d.length !== 8) return null;
  const [dd, mm, yyyy] = [Number(d.slice(0, 2)), Number(d.slice(2, 4)), Number(d.slice(4))];
  const date = new Date(Date.UTC(yyyy, mm - 1, dd));
  if (date.getUTCFullYear() !== yyyy || date.getUTCMonth() !== mm - 1 || date.getUTCDate() !== dd) return null;
  const year = new Date().getFullYear();
  if (yyyy < year - 110 || yyyy > year - 5) return null;
  return `${d.slice(4)}-${d.slice(2, 4)}-${d.slice(0, 2)}`;
}

const fromValue = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v.slice(8)} / ${v.slice(5, 7)} / ${v.slice(0, 4)}` : "");
const reduced = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const cleanCode = (raw: string) => raw.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 20);
const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

/** The coach's face: their picture, else their initial on a pale disc. */
function Face({ coach, faceRef, className = "" }: { coach: CoachCard; faceRef?: React.Ref<HTMLSpanElement>; className?: string }) {
  return (
    <span ref={faceRef} className={`jn-face ${className}`} aria-hidden="true">
      {coach.photo ? (
        // eslint-disable-next-line @next/next/no-img-element -- the coach's own picture, served by /auth/join/photo
        <img src={coach.photo} alt="" decoding="async" />
      ) : (
        coach.first.charAt(0).toUpperCase()
      )}
    </span>
  );
}

export default function JoinFlow({
  email,
  first: firstGiven,
  last: lastGiven,
  birthdate,
  code: codeGiven,
  waitingFor,
  declined,
}: {
  email: string;
  first: string;
  last: string;
  /** YYYY-MM-DD, from a request sent before. */
  birthdate: string;
  code: string;
  /** The coach of the request they are waiting on: the wait, straight away. */
  waitingFor: CoachCard | null;
  /** The coach said no to the last request: the code step, saying so. */
  declined: boolean;
}) {
  // The step's form, and the one sliding out while the next slides in (dir: 1 forward, -1 back).
  const [pages, setPages] = useState<{ cur: Step; prev: Step | null; dir: 1 | -1 }>({ cur: declined ? "coach" : "about", prev: null, dir: 1 });
  const go = (next: Step) => {
    setPages((p) => (p.cur === next ? p : { cur: next, prev: p.cur, dir: ORDER[next] > ORDER[p.cur] ? 1 : -1 }));
    window.setTimeout(() => setPages((p) => ({ ...p, prev: null })), reduced() ? 0 : 380);
  };

  const [first, setFirst] = useState(firstGiven);
  const [last, setLast] = useState(lastGiven);
  const [dob, setDob] = useState(fromValue(birthdate));
  const [aboutError, setAboutError] = useState<string | null>(null);

  // Declined: a new code to type, the old one gone.
  const [code, setCode] = useState(declined ? "" : codeGiven);
  const [found, setFound] = useState<CoachCard | null>(null);
  const [noCoach, setNoCoach] = useState(false);
  const [coachError, setCoachError] = useState<string | null>(declined ? "Not accepted" : null);
  const [sending, setSending] = useState(false);
  const onceKey = useRef(newKey());

  // The wait: who for, whether it is drawn in yet (its lines come in one after another), and the yes.
  const [waiting, setWaiting] = useState<CoachCard | null>(waitingFor);
  const [shown, setShown] = useState(!!waitingFor);
  const [yes, setYes] = useState(false);
  const [rising, setRising] = useState(false);
  // A wait already on when the page opens is drawn still, its first paint alone; anything after it moves as ever.
  const [fresh, setFresh] = useState(!!waitingFor);
  useEffect(() => {
    if (!fresh) return;
    const id = window.requestAnimationFrame(() => window.requestAnimationFrame(() => setFresh(false)));
    return () => window.cancelAnimationFrame(id);
  }, [fresh]);
  // Delete account, asked in place (App Store: an account made here can be deleted here).
  const [deleting, setDeleting] = useState<"ask" | "going" | null>(null);
  const foundFace = useRef<HTMLSpanElement>(null);
  const bigFace = useRef<HTMLSpanElement>(null);
  const [fly, setFly] = useState<{ coach: CoachCard; from: DOMRect } | null>(null);
  const [flyTo, setFlyTo] = useState<DOMRect | null>(null);

  // The code looked up as it is typed, a moment after the last key: the coach once it is theirs, else Not a valid code.
  const lookup = useRef(0);
  useEffect(() => {
    const want = code.trim();
    setFound(null);
    setNoCoach(false);
    const ask = ++lookup.current;
    if (want.length < 3) return;
    const t = window.setTimeout(async () => {
      const r = await lookupCoachCodeAction(want).catch(() => ({ ok: false as const }));
      if (ask !== lookup.current) return;
      if (r.ok) setFound(r.coach);
      else setNoCoach(true);
    }, 350);
    return () => window.clearTimeout(t);
  }, [code]);

  const about = () => {
    if (!first.trim() || !last.trim()) return setAboutError("Add your first and last name.");
    if (!dobValue(dob)) return setAboutError("Check your date of birth.");
    setAboutError(null);
    go("coach");
  };

  // Into the app once the coach says yes: the ring green and You're in, then the paper rising over the dark.
  const welcome = useCallback(() => {
    setYes(true);
    const r = reduced();
    window.setTimeout(() => setRising(true), r ? 0 : 1300);
    window.setTimeout(() => {
      leaveWithDarkClock();
      window.location.assign("/auth/continue");
    }, r ? 0 : 2000);
  }, []);

  // Back to the code: the wait goes, the paper comes back up.
  const backToCode = useCallback((note: string | null) => {
    setShown(false);
    setFly(null);
    setFlyTo(null);
    window.setTimeout(() => setWaiting(null), reduced() ? 0 : 320);
    setCode("");
    setCoachError(note);
    setPages({ cur: "coach", prev: null, dir: -1 });
  }, []);

  const send = async () => {
    if (!found || sending || waiting) return;
    const birth = dobValue(dob);
    if (!birth) return go("about");
    setSending(true);
    setCoachError(null);
    const r = await sendJoinRequestAction({ firstName: first, lastName: last, birthdate: birth, code: found.code }, onceKey.current).catch(() => ({ ok: false as const, error: "Not sent. Try again." }));
    onceKey.current = newKey();
    setSending(false);
    if (!r.ok) return setCoachError(r.error);
    // The keyboard goes with the form.
    (document.activeElement as HTMLElement | null)?.blur?.();
    // The picture lifts out of its row (FLIP): from where it is now to its place on the wait, measured once drawn.
    const from = foundFace.current?.getBoundingClientRect();
    if (from && !reduced()) setFly({ coach: r.coach, from });
    setWaiting(r.coach);
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => setShown(true)));
  };

  useLayoutEffect(() => {
    if (!fly || !bigFace.current) return;
    const to = bigFace.current.getBoundingClientRect();
    const id = window.requestAnimationFrame(() => setFlyTo(to));
    return () => window.cancelAnimationFrame(id);
  }, [fly, waiting]);

  // While waiting: asked again every few seconds and whenever the app comes back to the front.
  useEffect(() => {
    if (!waiting || yes) return;
    let alive = true;
    const check = async () => {
      if (document.visibilityState === "hidden") return;
      const s = await joinStatusAction().catch(() => null);
      if (!alive || !s) return;
      if (s.status === "in") welcome();
      else if (s.status === "declined") backToCode("Not accepted");
      else if (s.status === "none") backToCode(null);
    };
    const t = window.setInterval(check, POLL_MS);
    document.addEventListener("visibilitychange", check);
    return () => {
      alive = false;
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", check);
    };
  }, [waiting, yes, welcome, backToCode]);

  const another = async () => {
    await withdrawJoinRequestAction().catch(() => {});
    backToCode(null);
  };

  const deleteAccount = async () => {
    setDeleting("going");
    const r = await deleteJoinAccountAction().catch(() => ({ ok: false }));
    if (!r.ok) return setDeleting("ask");
    leaveWithDarkClock();
    window.location.assign("/auth/signout");
  };

  // Sign out and Delete account, the second asking in place: Cancel in words and Delete in red words.
  const accountLine = (look: "paper" | "dark"): ReactNode =>
    deleting ? (
      <span className={`jn-ask ${look}`}>
        Delete your account?
        <Bars
          parts={[
            <button key="c" type="button" className="jn-word" onClick={() => setDeleting(null)} disabled={deleting === "going"}>
              Cancel
            </button>,
            <button key="d" type="button" className="jn-word danger" onClick={deleteAccount} disabled={deleting === "going"}>
              Delete
            </button>,
          ]}
        />
      </span>
    ) : (
      <Bars
        parts={[
          look === "paper" ? <span key="e">{email}</span> : null,
          <a key="o" href="/auth/signout">
            Sign out
          </a>,
          <button key="d" type="button" className="jn-word" onClick={() => setDeleting("ask")}>
            Delete account
          </button>,
        ]}
      />
    );

  const page = (step: Step): ReactNode =>
    step === "about" ? (
      <form
        className="auth-form"
        method="post"
        onSubmit={(e) => {
          e.preventDefault();
          about();
        }}
      >
        {aboutError && <p className="auth-error au-error">{aboutError}</p>}
        <div className="au-two">
          <label className="auth-field">
            <span>First name</span>
            <input name="first" autoComplete="given-name" value={first} onChange={(e) => (setFirst(e.target.value), setAboutError(null))} maxLength={40} />
          </label>
          <label className="auth-field">
            <span>Last name</span>
            <input name="last" autoComplete="family-name" value={last} onChange={(e) => (setLast(e.target.value), setAboutError(null))} maxLength={40} />
          </label>
        </div>
        <label className="auth-field">
          <span>Date of birth</span>
          <input name="birthdate" inputMode="numeric" autoComplete="bday" placeholder="DD / MM / YYYY" value={dob} onChange={(e) => (setDob(dobShown(e.target.value)), setAboutError(null))} />
        </label>
        <button className="btn auth-submit" type="submit">
          Continue
        </button>
      </form>
    ) : (
      <form
        className="auth-form"
        method="post"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <label className="auth-field">
          <span>Coach code</span>
          <input
            className="jn-code"
            name="code"
            autoComplete="off"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            value={code}
            onChange={(e) => (setCode(cleanCode(e.target.value)), setCoachError(null))}
          />
        </label>
        <div className="jn-slot">
        {found && !coachError ? (
          <div className="jn-found" key={found.code}>
            <Face coach={found} faceRef={foundFace} className={fly ? "flown" : ""} />
            <span>
              <b>{found.name}</b>
              {found.business && <small>{found.business}</small>}
            </span>
          </div>
        ) : coachError || noCoach ? (
          // One line at a time: what the last answer said, else that the code is no coach's.
          <p className="auth-error au-error jn-none">{coachError ?? "Not a valid code"}</p>
        ) : null}
        </div>
        <button className={`btn auth-submit jn-send${sending ? " sending" : ""}`} type="submit" disabled={!found || sending}>
          {sending ? (
            <span className="jn-dots" aria-label="Sending">
              <i />
              <i />
              <i />
            </span>
          ) : (
            "Send request"
          )}
        </button>
        <p className="auth-note jn-back">
          <button type="button" className="au-link" onClick={() => go("about")}>
            Back
          </button>
        </p>
      </form>
    );

  const title = TITLE[pages.cur];
  return (
    <>
      <SiteShell
        className={`jn${waiting ? " jn-sent" : ""}${fresh ? " jn-now" : ""}`}
        pitch={false}
        title={
          <span key={title} className="jn-title">
            {title}
          </span>
        }
        aside={accountLine("paper")}
      >
        <div className="jn-pages" inert={!!waiting}>
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

      {waiting && (
        <div className={`jn-wait${shown ? " in" : ""}${yes ? " yes" : ""}${fresh ? " now" : ""}`} data-clock="dark" role="status">
          <div className="jn-wait-in">
            <span className="jn-face-wrap">
              <Face coach={waiting} faceRef={bigFace} className={`big${fly ? " hold" : ""}`} />
              <i className="jn-ring" aria-hidden="true" />
              <i className="jn-tick" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12.5l4.2 4.2L19 7" />
                </svg>
              </i>
            </span>
            <h1 className="jn-sent-title">
              Request sent
              <span key={yes ? "y" : "w"} className={!yes && waiting === waitingFor ? "still" : undefined}>
                {yes ? "You’re in" : `Waiting for ${waiting.first}`}
              </span>
            </h1>
            <p className="jn-facts">
              <Bars parts={[<b key="n">{waiting.name}</b>, ...(waiting.business ? [<span key="b">{waiting.business}</span>] : [])]} />
            </p>
            <div className="jn-bottom">
              {!yes && (
                <button type="button" className="jn-ghost" onClick={another}>
                  Use another code
                </button>
              )}
              <span className="jn-out">{accountLine("dark")}</span>
            </div>
          </div>
        </div>
      )}

      {/* The picture on its way from its row to its place on the wait. */}
      {fly && (
        <span
          className="jn-fly"
          style={{
            left: (flyTo ?? fly.from).left,
            top: (flyTo ?? fly.from).top,
            width: (flyTo ?? fly.from).width,
            height: (flyTo ?? fly.from).height,
            fontSize: (flyTo ?? fly.from).width * 0.4,
          }}
          onTransitionEnd={(e) => {
            if (e.propertyName === "width" && flyTo) {
              setFly(null);
              setFlyTo(null);
            }
          }}
          aria-hidden="true"
        >
          <Face coach={fly.coach} />
        </span>
      )}

      {/* Into the app: the paper rising over the dark, as Home will be drawn on it. */}
      <div className={`jn-home${rising ? " in" : ""}`} aria-hidden="true" />
    </>
  );
}
