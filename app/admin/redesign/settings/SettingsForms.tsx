"use client";

import { Fragment, useEffect, useRef, useState, useTransition, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { connectStripeAction, disconnectStripeAction, removeCoachBannerAction, removeCoachLogoAction, saveCoachBusinessAction, saveCoachInvoicingAction, setBrandColourAction, uploadCoachBannerAction, uploadCoachLogoAction } from "../../../lib/actions";
import { BRAND_SWATCHES, brandColour, brandVars, normalHex } from "../../../lib/brandColour";
import type { PaymentsState } from "../../../lib/payments";
import { changeOwnEmailAction, changeOwnPasswordAction, logoutAction } from "../../../lib/auth-actions";
import type { CoachBusiness, CoachInvoicing } from "../../../lib/db";
import { ArrowRightIcon } from "../../../components/icons";
import { businessCountries, businessNumbers, CURRENCIES, countryCodeFromName, countryOf, currencyName, hasBankDetails, invoicingFor, REGIONS, taxFact, type BusinessNumber } from "../../../lib/countries";
import { setInvoiceAutoAction } from "../../../lib/invoiceAutoActions";
import { dialOfCountry } from "../../../lib/phone";
import { Capsule, Card, Cells, Fields, InlineLine, Line, OpenRow, Part, Pill, Row, State, Switch, Two, Word } from "./Rows";
import Picker from "../Picker";
import { Sep, SepJoin } from "../Sep";
import { useSaveSlot, useUnsaved } from "./SaveHost";
import { goToSetting } from "./settingsScroll";
import { Dialog } from "../../../components/ui/dialog";
import { ConfirmDialog } from "../training/TrainingDraft";
import type { AccountSecurity } from "../../../lib/accountSecurity";
import ClerkAccount from "./ClerkAccount";
import HelpTip from "../HelpTip";

// Settings' sections on the admin rules (22 Oct; docs/DESIGN-RULES-ADMIN.md), each a section of the one Settings page
// (SettingsBoard.tsx). Since 23 Nov (Alex: docs/boards/settings-harmony-mockup.html) Account, Business details,
// Invoicing & payments and Privacy are drawn in the one row system (Rows.tsx): parts as small caps labels over one
// white hairline card each, settings as rows, real forms as small caps labels over clean lines, every field empty until
// typed with no sample in it. Field and Section are the older parts' (Logo, Banner, Brand colour and other files). A form that saves on Save puts its changes on the page's one bar (useSaveSlot, SaveHost.tsx), and
// keeps them while its section is folded. Each form is keyed on what was saved (the page does it), so a save that
// comes back unchanged never throws away what is being typed.

/** A label over its field. `group` for a field that is not one input (a capsule, a list), so a click on the label
 *  never presses the first of its buttons. */
export function Field({ label, fact, wide = false, group = false, error, children }: { label: string; fact?: ReactNode; wide?: boolean; group?: boolean; error?: string; children: ReactNode }) {
  const inner = (
    <>
      <span className="dlh-label">{fact ? <SepJoin parts={[label, <small key="fact">{fact}</small>]} /> : label}</span>
      {children}
      {error && <small className="rst-err">{error}</small>}
    </>
  );
  const cls = `rst-field${wide ? " wide" : ""}`;
  return group ? <div className={cls}>{inner}</div> : <label className={cls}>{inner}</label>;
}

/** A part of a section: its small caps label (and one quiet fact) over its card, its controls on the right. */
export function Section({ title, fact, actions, children }: { title: ReactNode; fact?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <section className="rls-section rst-sub">
      <div className="trn-weekhead">
        <div>
          <h3>{title}</h3>
          {fact && (
            <>
              <Sep />
              <span>{fact}</span>
            </>
          )}
        </div>
        {actions && <div className="trn-weekhead-actions">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/** A form's working copy, what it started from, and Save / Cancel for the page's bar (which says saved or not, and
 *  draws the page again once everything changed is in). */
export function useDraft<T extends Record<string, unknown>>(initial: T, save: (v: T) => Promise<unknown>) {
  const [v, setV] = useState<T>(initial);
  const dirty = JSON.stringify(v) !== JSON.stringify(initial);
  const set = <K extends keyof T>(k: K, val: T[K]) => setV((o) => ({ ...o, [k]: val }));
  // How many fields differ from what is saved, for the bar's count.
  const count = Object.keys(v).filter((k) => JSON.stringify(v[k]) !== JSON.stringify(initial[k])).length;
  return { v, set, dirty, count, commit: async () => void (await save(v)), discard: () => setV(initial) };
}

// ---- Account (23 Nov, Alex: docs/boards/settings-harmony-mockup.html; Account & security and Billing, one section):
// how the coach signs in, as rows (Rows.tsx). The email and the password each a row with its word, opening its fields
// under itself; with Clerk, the linked logins beside them and the devices under (ClerkAccount.tsx). What the coach pays
// Norcoach comes after, from the page (BillingSettings).
export function AccountSettings({ email, passwordless = false, security = null, passwordsHint = null }: { email: string; /** Sign-in through Clerk (26 Oct): no password here, and the email can be changed. */ passwordless?: boolean; /** The linked logins and devices, from Clerk (27 Oct). */ security?: AccountSecurity | null; /** Whether Clerk takes passwords, read with the page (lib/clerkPasswords.ts). */ passwordsHint?: boolean | null }) {
  if (passwordless) return <ClerkAccount email={email} security={security} passwordsHint={passwordsHint} />;
  return <AccountPassword email={email} />;
}

/** Presses the Save of the opened row a form sits in (Enter in its fields), as a click on it would. */
export function pressSave(from: HTMLElement) {
  from.closest(".rsr-unfold")?.querySelector<HTMLButtonElement>(".rsr-pill.go:not(:disabled)")?.click();
}

/** The account's email with the sign-in through Clerk: where clients' replies to invites go. A row, `Change` opening a
 *  New email line under it; saved at once (not on the page's bar). Signing in is Clerk's (Google, a password, or a code
 *  to the email). */
export function AccountEmail({ email }: { email: string }) {
  const router = useRouter();
  const [shown, setShown] = useState(email);
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const ready = !!value.trim() && value.trim().toLowerCase() !== shown.toLowerCase();
  const clear = () => (setValue(""), setError(""));
  const save = async () => {
    const r = await changeOwnEmailAction(value).catch(() => ({ ok: false, error: "Not saved. Try again." }));
    if (!r.ok) {
      setError(r.error ?? "Couldn't change it.");
      return false;
    }
    setShown(value.trim().toLowerCase());
    clear();
    toast.success("Email changed");
    router.refresh();
  };
  return (
    <OpenRow name="Email" fact={shown} word="Change" onSave={save} onCancel={clear} canSave={ready} error={error}>
      <form onSubmit={(e) => (e.preventDefault(), ready && pressSave(e.currentTarget))}>
        <Fields cols={1}>
          <Line label="New email">
            <input className="dlh-line" type="email" value={value} onChange={(e) => (setValue(e.target.value), setError(""))} autoComplete="email" />
          </Line>
        </Fields>
      </form>
    </OpenRow>
  );
}

/** With nothing read of the devices: this one alone, Sign out on its row. */
export function ThisDevice() {
  return (
    <Part label="Devices">
      <Row name="This device">
        <Word onClick={() => logoutAction()}>Sign out</Word>
      </Row>
    </Part>
  );
}

/** The old sign-in (an email and a password of ours): the email as it is, the password changed under its row. */
function AccountPassword({ email }: { email: string }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState("");
  const problem = next && next.length < 8 ? "At least 8 characters." : again && next !== again ? "The two new passwords differ." : "";
  const ok = !!current && next.length >= 8 && next === again;
  const clear = () => (setCurrent(""), setNext(""), setAgain(""), setError(""));
  const change = async () => {
    const r = await changeOwnPasswordAction(current, next).catch(() => ({ ok: false, error: "Not saved. Try again." }));
    if (!r.ok) {
      setError(r.error ?? "Couldn't change it.");
      return false;
    }
    clear();
    toast.success("Password changed");
  };
  return (
    <>
      <Part label="Email and password">
        <Row name="Email" fact={email} />
        <OpenRow name="Password" fact="Set" word="Change" onSave={change} onCancel={clear} canSave={ok} error={problem || error}>
          <form onSubmit={(e) => (e.preventDefault(), ok && pressSave(e.currentTarget))}>
            <input className="sr-only" type="email" name="email" autoComplete="username" value={email} readOnly tabIndex={-1} aria-hidden="true" />
            <Fields cols={2}>
              <Line label="Current password" wide>
                <input className="dlh-line" type="password" value={current} onChange={(e) => (setCurrent(e.target.value), setError(""))} autoComplete="current-password" />
              </Line>
              <Line label="New password">
                <input className="dlh-line" type="password" value={next} onChange={(e) => (setNext(e.target.value), setError(""))} autoComplete="new-password" aria-invalid={!!problem && next.length < 8} />
              </Line>
              <Line label="New password again">
                <input className="dlh-line" type="password" value={again} onChange={(e) => (setAgain(e.target.value), setError(""))} autoComplete="new-password" aria-invalid={!!again && next !== again} />
              </Line>
            </Fields>
            <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
          </form>
        </OpenRow>
      </Part>
      <ThisDevice />
    </>
  );
}

// ---- The coach's logo (28 Oct, Alex; lib/brandMark.ts): made into the faint mark behind every screen, theirs and
// their clients', in place of the Norcoach star. Saved at once, not on the page's bar (a file, as Account's actions):
// the card shows the mark as it will sit, Upload (Replace) as a white pill, Remove in words, asking first.
export function LogoSettings({ mark }: { mark: string | null }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState("");
  const [asking, setAsking] = useState(false);
  const pick = (file: File | undefined) => {
    if (!file) return;
    const f = new FormData();
    f.set("file", file);
    start(async () => {
      const r = await uploadCoachLogoAction(f).catch(() => ({ ok: false as const, error: "Not saved. Try again." }));
      if (!r.ok) return setError(r.error);
      setError("");
      // No Saved toast (admin §9): the mark on the card says it; only a failure speaks.
      router.refresh();
    });
  };
  return (
    <Section
      title={
        <span className="rst-titled">
          Logo
          {/* The tip behind a ? (28 Oct, Alex asked for it): the rules keep explanations off the page. */}
          <HelpTip title="Logo">
            <p>For the best result, upload your logo with a transparent background (a PNG or SVG).</p>
          </HelpTip>
        </span>
      }
      fact={mark ? "Behind every screen" : "Norcoach's star for now"}
      actions={
        <>
          <label className={`trn-pill rst-pill${busy ? " busy" : ""}`}>
            {busy ? "Saving…" : mark ? "Replace" : "Upload"}
            <input type="file" accept="image/*" hidden disabled={busy} onChange={(e) => (pick(e.target.files?.[0]), (e.target.value = ""))} />
          </label>
          {mark && (
            <button type="button" className="rst-danger" onClick={() => setAsking(true)} disabled={busy}>
              Remove
            </button>
          )}
        </>
      }
    >
      <div className="rls-card rst-card rst-logo">
        {/* The mark on the page's grey, a little stronger than on the screens so it reads here. */}
        {/* eslint-disable-next-line @next/next/no-img-element -- the coach's own upload */}
        <img className={`rst-logo-mark${mark ? "" : " star"}`} src={mark ?? "/brand/mark.svg"} alt={mark ? "Your logo as the mark behind your screens" : "The Norcoach star"} />
        {error && <small className="rst-err">{error}</small>}
      </div>
      <Dialog open={asking} onOpenChange={setAsking}>
        {asking && (
          <ConfirmDialog
            title="Remove your logo?"
            description="The Norcoach star comes back behind your screens and your clients’."
            confirm="Remove"
            danger
            onConfirm={() => {
              setAsking(false);
              start(async () => {
                await removeCoachLogoAction();
                router.refresh();
              });
            }}
          />
        )}
      </Dialog>
    </Section>
  );
}

// ---- The banner (19 Nov, Alex: docs/boards/coach-brand-mockup.html): a wide wordmark drawn where NORCOACH is, on
// their screens and their clients'. Made one colour as the logo is, so the card shows it as it will sit: ink on the
// page and white over a photo. Upload (Replace) the white pill, Remove in red words asking first; saved at once.
export function BannerSettings({ banner, ratio }: { banner: string | null; ratio: number | null }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState("");
  const [asking, setAsking] = useState(false);
  const pick = (file: File | undefined) => {
    if (!file) return;
    const f = new FormData();
    f.set("file", file);
    start(async () => {
      const r = await uploadCoachBannerAction(f).catch(() => ({ ok: false as const, error: "Not saved. Try again." }));
      if (!r.ok) return setError(r.error);
      setError("");
      // No Saved toast (admin §9): the previews say it; only a failure speaks.
      router.refresh();
    });
  };
  const shape = banner ? ({ "--banner-ratio": ratio && ratio > 0 ? ratio : 4, WebkitMaskImage: `url("${banner}")`, maskImage: `url("${banner}")` } as CSSProperties) : undefined;
  return (
    <Section
      title="Banner"
      fact={banner ? "In the top bar" : "None yet"}
      actions={
        <>
          <label className={`trn-pill rst-pill${busy ? " busy" : ""}`}>
            {busy ? "Saving…" : banner ? "Replace" : "Upload"}
            <input type="file" accept="image/*" hidden disabled={busy} onChange={(e) => (pick(e.target.files?.[0]), (e.target.value = ""))} />
          </label>
          {banner && (
            <button type="button" className="rst-danger" onClick={() => setAsking(true)} disabled={busy}>
              Remove
            </button>
          )}
        </>
      }
    >
      {(banner || error) && (
        <div className="rls-card rst-card rst-bannercard">
          {banner && (
            <div className="rst-banner-row">
              {/* On the page, in ink; over a photo, in white. */}
              <span className="rst-banner-prev">
                <span className="brand-banner" role="img" aria-label="Your banner on the page" style={shape} />
              </span>
              <span className="rst-banner-prev dark">
                <span className="brand-banner" role="img" aria-label="Your banner over a photo" style={shape} />
              </span>
            </div>
          )}
          {error && <small className="rst-err">{error}</small>}
        </div>
      )}
      <Dialog open={asking} onOpenChange={setAsking}>
        {asking && (
          <ConfirmDialog
            title="Remove your banner?"
            description="Norcoach’s name comes back in the top bar, with your business name where you have set one."
            confirm="Remove"
            danger
            onConfirm={() => {
              setAsking(false);
              start(async () => {
                await removeCoachBannerAction();
                router.refresh();
              });
            }}
          />
        )}
      </Dialog>
    </Section>
  );
}

// ---- The brand colour (19 Nov, Alex: option C): any colour, on the main pill of a screen, the tab on screen and the
// client's own bubbles. Eight quick picks and Custom for any other (a colour square, a hue strip and a hex code); one too light for white words is darkened, and one grey
// fact says so. Ink is today's look, kept as none. Saved at once, as Logo.
export function BrandColourSettings({ picked }: { picked: string | null }) {
  const router = useRouter();
  const [now, setNow] = useState<string | null>(picked ? normalHex(picked) : null);
  const [error, setError] = useState("");
  const custom = !!now && !BRAND_SWATCHES.some((s) => s.hex === now);
  const [open, setOpen] = useState(custom);
  const [typed, setTyped] = useState((now ?? BRAND_SWATCHES[0].hex).toUpperCase());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ink = BRAND_SWATCHES[0].hex;
  const shown = now ?? ink;
  const used = brandColour(shown) ?? { hex: ink, changed: false, ink: "#ffffff" as const, text: ink };
  // The admin takes the colour the moment it is picked (19 Nov, Alex: "just have the ui change the color when i click on
  // a color so they see immediately how it is"; no Start pill): --brand on the page at once, the save following, and
  // the faint mark behind the page redrawn in it here (the server's own tinted copy comes with the save).
  useEffect(() => {
    const body = document.body.style;
    // The colour with its words: on a bright one they turn dark at once (brandVars; 22 Nov, Alex: D).
    const VARS = ["--brand", "--brand-ink", "--brand-pill", "--brand-pill-ink", "--brand-count"];
    for (const v of [...VARS, "--brand-text"]) body.removeProperty(v);
    if (used.hex === ink) {
      body.removeProperty("--brand-mark");
      return;
    }
    for (const [k, v] of Object.entries(brandVars(used.hex))) body.setProperty(k, v);
    let gone = false;
    const mark = /url\(["']?([^"')]+)["']?\)/.exec(getComputedStyle(document.body).getPropertyValue("--bg-mark"))?.[1] ?? "/brand/mark.svg";
    const img = new Image();
    img.onload = () => {
      if (gone) return;
      // The star's SVG has no size of its own: drawn in the mark's box (448:430, doubled).
      const svg = mark.endsWith(".svg") || mark.startsWith("data:image/svg");
      const c = document.createElement("canvas");
      c.width = svg || !img.naturalWidth ? 896 : img.naturalWidth;
      c.height = svg || !img.naturalHeight ? 860 : img.naturalHeight;
      const g = c.getContext("2d");
      if (!g) return;
      g.drawImage(img, 0, 0, c.width, c.height);
      g.globalCompositeOperation = "source-in";
      g.fillStyle = used.text;
      g.fillRect(0, 0, c.width, c.height);
      body.setProperty("--brand-mark", `url("${c.toDataURL("image/png")}")`);
    };
    img.src = mark;
    return () => {
      gone = true;
    };
  }, [used.hex, ink]);
  // The colour as picked, while it shows darkened (the narrow middle where neither white nor ink words read): on the body
  // for the row's name line to say both, live as the picker moves.
  useEffect(() => {
    const d = document.body.dataset;
    if (used.changed) d.brandPicked = shown;
    else delete d.brandPicked;
  }, [shown, used.changed]);
  const save = (hex: string | null) => {
    if (timer.current) clearTimeout(timer.current);
    // Ink is today's look: none kept.
    const value = hex && hex !== ink ? hex : null;
    setNow(value);
    setTyped((value ?? ink).toUpperCase());
    setError("");
    void setBrandColourAction(value)
      .then((r) => (r.ok ? router.refresh() : setError(r.error)))
      .catch(() => setError("Not saved. Try again."));
  };
  // A drag in the picker sends every step: the last one is kept.
  const saveSoon = (hex: string) => {
    setNow(hex);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => save(hex), 450);
  };
  const takeTyped = () => {
    const hex = normalHex(typed);
    if (!hex) return setError(typed.trim() ? "That isn't a colour." : "");
    setTyped(hex.toUpperCase());
    if (hex !== now) save(hex);
  };
  const name = BRAND_SWATCHES.find((s) => s.hex === shown)?.name ?? shown.toUpperCase();
  return (
    <Section title="Brand colour" fact={name}>
      <div className="rls-card rst-card rst-brand">
        <div className="rst-swatches" role="radiogroup" aria-label="Brand colour">
          {BRAND_SWATCHES.map((s) => (
            <button
              key={s.hex}
              type="button"
              role="radio"
              aria-checked={shown === s.hex}
              aria-label={s.name}
              title={s.name}
              className={`rst-swatch${shown === s.hex ? " on" : ""}`}
              style={{ background: s.hex }}
              onClick={() => (setOpen(false), save(s.hex))}
            />
          ))}
          <button type="button" className={`rst-custom${custom ? " on" : ""}${open ? " open" : ""}`} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            <i className="rst-custom-dot" style={custom ? { background: shown } : undefined} aria-hidden="true" />
            Custom
          </button>
        </div>
        {open && (
          <ColourPicker
            value={shown}
            typed={typed}
            onTyped={setTyped}
            onTake={takeTyped}
            onDrag={(hex) => {
              setTyped(hex.toUpperCase());
              saveSoon(hex);
            }}
          />
        )}
        {/* A colour darkened to be read is said on the row's own name line (ColourName, BrandingSection.tsx), never a
            line of its own here (23 Nov, Alex: "it creates a new line below the color picker… it rearranges the whole
            screen"). */}
        {error && <small className="rst-err">{error}</small>}
      </div>
    </Section>
  );
}

// The Custom picker (19 Nov, Alex: "the thing where i can choose a color from a whole pallet or even type a hex code.
// the + sign is a bit vague"): a square of the hue's shades to drag in, the hue strip under it, and the hex code typed.
// Every step shows on the page at once (the colour is live), the save following the last.
function hexToHsv(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [((h * 60) + 360) % 360, max ? d / max : 0, max];
}
function hsvToHex(h: number, s: number, v: number): string {
  const f = (k: number) => {
    const x = (k + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(x, 4 - x, 1));
  };
  return "#" + [f(5), f(3), f(1)].map((c) => Math.round(c * 255).toString(16).padStart(2, "0")).join("");
}
function ColourPicker({ value, typed, onTyped, onTake, onDrag }: { value: string; typed: string; onTyped: (t: string) => void; onTake: () => void; onDrag: (hex: string) => void }) {
  const [hsv, setHsv] = useState<[number, number, number]>(() => hexToHsv(value));
  // A colour picked elsewhere (a swatch, the hex typed) moves the marks, keeping the hue where grey has none.
  const last = useRef(value);
  useEffect(() => {
    if (value === last.current) return;
    last.current = value;
    const next = hexToHsv(value);
    setHsv((was) => (next[1] === 0 || next[2] === 0 ? [was[0], next[1], next[2]] : next));
  }, [value]);
  const pick = (h: number, s: number, v: number) => {
    setHsv([h, s, v]);
    const hex = hsvToHex(h, s, v);
    last.current = hex;
    onDrag(hex);
  };
  const drag = (el: HTMLElement, e: ReactPointerEvent, move: (x: number, y: number) => void) => {
    el.setPointerCapture(e.pointerId);
    const at = (ev: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect();
      move(Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)));
    };
    at(e);
    const onMove = (ev: PointerEvent) => at(ev);
    const onUp = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  };
  const [h, s, v] = hsv;
  return (
    <div className="rst-picker">
      <div
        className="rst-picker-sv"
        style={{ backgroundColor: hsvToHex(h, 1, 1) }}
        onPointerDown={(e) => drag(e.currentTarget, e, (x, y) => pick(h, x, 1 - y))}
        role="slider"
        aria-label="Shade"
        aria-valuetext={value.toUpperCase()}
        tabIndex={0}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 0.1 : 0.02;
          const keys: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
          const k = keys[e.key];
          if (!k) return;
          e.preventDefault();
          pick(h, Math.min(1, Math.max(0, s + k[0])), Math.min(1, Math.max(0, v + k[1])));
        }}
      >
        <span className="rst-picker-mark" style={{ left: `${s * 100}%`, top: `${(1 - v) * 100}%`, background: value }} />
      </div>
      <div
        className="rst-picker-hue"
        onPointerDown={(e) => drag(e.currentTarget, e, (x) => pick(x * 359.9, s || 1, v || 1))}
        role="slider"
        aria-label="Hue"
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuenow={Math.round(h)}
        tabIndex={0}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 20 : 4;
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          e.preventDefault();
          pick((h + (e.key === "ArrowRight" ? step : -step) + 360) % 360, s || 1, v || 1);
        }}
      >
        <span className="rst-picker-mark" style={{ left: `${(h / 360) * 100}%`, background: hsvToHex(h, 1, 1) }} />
      </div>
      <div className="rst-hexrow">
        <i className="rst-picker-now" style={{ background: value }} aria-hidden="true" />
        <input
          className="dlh-line rst-hex"
          value={typed}
          onChange={(e) => onTyped(e.target.value)}
          onBlur={onTake}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onTake();
            }
          }}
          aria-label="Colour as a hex code"
          spellCheck={false}
          autoComplete="off"
          maxLength={7}
        />
      </div>
    </div>
  );
}

// ---- Business details (23 Nov, Alex: docs/boards/settings-harmony-mockup.html): who the invoices are from. The country
// leads, a row saying what it sets, and decides each field's name and which fields show (lib/countries.ts): the
// registration across one card, the address and the invoice contact side by side. Every field empty until typed, no
// sample in any. On the page's one bar, as before.
const OTHER = "other";
const BUSINESS_FIELDS = ["business_name", "legal_name", "company_number", "vat_number", "address", "postcode", "city", "region", "billing_email", "phone", "website"] as const;

/** A VAT number as typed after its country's fixed prefix: the prefix (and a space after it) taken off. */
const afterPrefix = (v: string, prefix?: string) => (prefix && v.toUpperCase().startsWith(prefix) ? v.slice(prefix.length).trimStart() : v);

export function BusinessSettings({ initial }: { initial: CoachBusiness }) {
  const startCode = initial.country_code ?? countryCodeFromName(initial.country);
  const d = useDraft<CoachBusiness>({ ...initial, country_code: startCode }, saveCoachBusinessAction);
  useSaveSlot("business", { dirty: d.dirty, count: d.count, save: d.commit, cancel: d.discard });
  const country = countryOf(d.v.country_code);
  // A country typed before the list, kept shown as it was saved (23 Nov, Alex: a coach whose country leaves the list
  // keeps it); one on the list but no longer offered (New Zealand) stays offered to them (businessCountries).
  const typedName = country.code ? "" : (d.v.country ?? "").trim();
  const picked = !!country.code || !!typedName;
  // The rest comes in once a country is picked; anything saved without one stays in sight.
  const held = BUSINESS_FIELDS.some((k) => !!String(d.v[k] ?? "").trim());
  const options = [...businessCountries(startCode).map((c) => ({ value: c.code, label: c.name })), ...(typedName ? [{ value: OTHER, label: typedName }] : [])];
  const pick = (v: string) => {
    if (v === OTHER) return;
    const next = countryOf(v);
    // A VAT number carries its country's prefix: a new country swaps it.
    const vat = d.v.vat_number ?? "";
    if (vat && country.vatPrefix && country.vatPrefix !== next.vatPrefix && vat.toUpperCase().startsWith(country.vatPrefix)) {
      const bare = afterPrefix(vat, country.vatPrefix);
      d.set("vat_number", bare ? `${next.vatPrefix ?? ""}${bare}` : "");
    }
    d.set("country_code", v);
    d.set("country", next.name);
  };
  const text = (k: (typeof BUSINESS_FIELDS)[number], label: string, opts: { wide?: boolean; type?: string; auto?: string } = {}) => (
    <Line label={label} wide={opts.wide}>
      <input className="dlh-line" type={opts.type ?? "text"} value={d.v[k] ?? ""} onChange={(e) => d.set(k, e.target.value)} autoComplete={opts.auto} />
    </Line>
  );
  // The phone on invoices (23 Nov, review; the board's +31): the country's dial code fixed before the line and kept with
  // the number (`+31 6 12345678`, one string, as the invoice prints it). A number typed with a code of its own (+ or 00)
  // is kept as typed and shown whole, the fixed code gone; so is one saved under another country's code.
  const dial = dialOfCountry(country.code);
  const phoneNow = (d.v.phone ?? "").trim();
  const ownCode = !dial || (phoneNow.startsWith("+") && !phoneNow.startsWith(`${dial} `) && phoneNow !== dial);
  const phone = (
    <Line label="Phone">
      {/* One input in one place either way, so typing a + of their own never takes the keyboard away. */}
      <span className="rsr-lined">
        {!ownCode && dial && <em className="rsr-pre">{dial}</em>}
        <input
          className="dlh-line"
          type="tel"
          value={ownCode || !dial ? (d.v.phone ?? "") : phoneNow.startsWith(`${dial} `) ? phoneNow.slice(dial.length + 1) : phoneNow === dial ? "" : (d.v.phone ?? "")}
          onChange={(e) => {
            const typed = e.target.value;
            const t = typed.trim();
            d.set("phone", ownCode || !dial || !t || t.startsWith("+") || t.startsWith("00") ? (t ? typed : "") : `${dial} ${typed.trimStart()}`);
          }}
          autoComplete="tel"
        />
      </span>
    </Line>
  );
  const numbers = businessNumbers(country);
  const number = (n: BusinessNumber) => {
    const value = d.v[n.key] ?? "";
    if (!n.prefix) return <Fragment key={n.key}>{text(n.key, n.label)}</Fragment>;
    const prefix = n.prefix;
    return (
      <Line key={n.key} label={n.label}>
        <span className="rsr-lined">
          <em className="rsr-pre">{prefix}</em>
          <input
            className="dlh-line"
            value={afterPrefix(value, prefix)}
            onChange={(e) => {
              // Pasted with its prefix, the prefix is taken once.
              const typed = afterPrefix(e.target.value, prefix);
              d.set(n.key, typed.trim() ? `${prefix}${typed}` : "");
            }}
            autoComplete="off"
          />
        </span>
      </Line>
    );
  };
  const regions = REGIONS[country.code];
  const region = country.region
    ? regions
      ? (
          <Line label={country.region} wide group>
            <Picker
              value={d.v.region ?? ""}
              onChange={(v) => d.set("region", v)}
              label={country.region}
              className="rsr-sel"
              menuClassName="nc-countrymenu"
              empty=""
              // A region saved before the list (or typed another way) stays offered.
              options={[...(d.v.region && !regions.includes(d.v.region) ? [d.v.region] : []), ...regions].map((r) => ({ value: r, label: r }))}
            />
          </Line>
        )
      : text("region", country.region, { wide: true })
    : null;
  return (
    <>
      <Part label="Where you do business">
        <Row name="Country" fact={country.code ? <SepJoin parts={[`Prices in ${country.currency}`, taxFact(country)]} /> : undefined}>
          <Picker value={country.code || (typedName ? OTHER : "")} onChange={pick} label="Country" className={`rsr-pick${picked ? "" : " empty"}`} menuClassName="nc-countrymenu" empty="" options={options} />
        </Row>
      </Part>

      {(picked || held) && (
        <>
          <Part label="Registration">
            <Fields pad fit={200}>
              {text("business_name", "Business name", { auto: "organization" })}
              {text("legal_name", "Legal name")}
              {numbers.map(number)}
            </Fields>
          </Part>

          <Two top>
            <Part label="Address">
              {/* One order and one name for an address everywhere (16 Nov, Alex: the audit; AddressFields): Address
                  across, then the postcode and the city, the region after them; the country leads above. */}
              <Fields pad>
                {text("address", "Address", { wide: true })}
                {text("postcode", country.postcode)}
                {text("city", "City")}
                {region}
              </Fields>
            </Part>
            <Part label="Contact on invoices">
              <Fields pad>
                {text("billing_email", "Billing email", { wide: true, type: "email" })}
                {phone}
                {text("website", "Website")}
              </Fields>
            </Part>
          </Two>
        </>
      )}
    </>
  );
}

// ---- Invoicing & payments (23 Nov, Alex: docs/boards/settings-harmony-mockup.html): the prices and the tax beside what
// goes on each invoice, the two ways to pay side by side, then what invoices do by themselves. A figure is typed on its
// row; a text (the tax note, the footer, the bank details) is a row with Add or Edit, opened in place, whose Save saves
// the section at once. Only the currency, the tax rate and whether prices include it come from the country (Business
// details); every other field is empty until typed, no sample in any. The figures go on the page's one bar.

/** A whole or decimal figure typed on a row's right (InlineLine), kept as typed while it is being typed (`21.`). */
function NumLine({ value, onChange, unit, width, label, decimal = false }: { value: number | undefined; onChange: (n: number | undefined) => void; unit?: string; width: number; label: string; decimal?: boolean }) {
  const [text, setText] = useState(value == null ? "" : String(value));
  // Put back from elsewhere (the bar's Cancel): shown.
  const [was, setWas] = useState(value);
  if (value !== was) {
    setWas(value);
    const typed = text === "" ? undefined : Number(text.replace(",", "."));
    if (typed !== value) setText(value == null ? "" : String(value));
  }
  return (
    <InlineLine
      value={text}
      width={width}
      unit={unit}
      label={label}
      inputMode={decimal ? "decimal" : "numeric"}
      maxLength={decimal ? 5 : 6}
      onChange={(t) => {
        const clean = decimal ? t.replace(/[^\d.,]/g, "") : t.replace(/\D/g, "");
        setText(clean);
        const n = clean === "" ? undefined : Number(clean.replace(",", "."));
        if (n === undefined || Number.isFinite(n)) onChange(n);
      }}
    />
  );
}

// Card payments: the coach's own Stripe account (lib/stripe.ts), on which a client pays an invoice (23 Nov, Alex: "ok do
// the stripe also"). Off until the server has Stripe's keys (Soon); then Connect Stripe, finish on Stripe, Connected.
// Where it stands is the state pill; Disconnect in red words on the row's hover, asking first.
function CardPayment({ state, ready }: { state: PaymentsState; ready: boolean }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState("");
  const [disconnecting, setDisconnecting] = useState(false);
  // Stripe takes the page away, and makes the account from what is saved (the country): unsaved changes go first,
  // said until they are saved or put back.
  const unsaved = useUnsaved().length > 0;
  const [saveFirst, setSaveFirst] = useState(false);
  if (saveFirst && !unsaved) setSaveFirst(false);
  const go = () => {
    if (unsaved) return setSaveFirst(true);
    start(async () => {
      const r = await connectStripeAction();
      if (r.url) window.location.href = r.url;
      else setError(r.error ?? "Stripe did not answer. Try again.");
    });
  };
  const said = saveFirst ? "Save your changes first." : error;
  const off = !ready || state.status === "off";
  const linked = !off && (state.status === "active" || state.status === "pending");
  return (
    <>
      <Row name="Card payment" fact={<SepJoin parts={["Stripe", !off && state.testMode ? "Test mode" : null]} />} hover={linked}>
        {off ? (
          <State>Soon</State>
        ) : state.status === "none" ? (
          <Pill onClick={go} disabled={busy}>
            {busy ? "Opening Stripe…" : "Connect Stripe"}
          </Pill>
        ) : (
          <>
            <Word tone="red" hoverOnly disabled={busy} onClick={() => setDisconnecting(true)}>
              Disconnect
            </Word>
            {state.status === "active" ? <State tone="good">Connected</State> : <State tone="rust">Not finished</State>}
            {state.status === "pending" && (
              <Word onClick={go} disabled={busy}>
                {busy ? "Opening Stripe…" : "Finish on Stripe"}
              </Word>
            )}
          </>
        )}
      </Row>
      {said && <p className="rst-err rst-err-row">{said}</p>}
      {/* Nothing destructive on one click (rule 4): Disconnect asks first. */}
      <Dialog open={disconnecting} onOpenChange={setDisconnecting}>
        {disconnecting && (
          <ConfirmDialog
            title="Disconnect Stripe?"
            description="Your clients can’t pay invoices by card until you connect it again."
            confirm="Disconnect"
            danger
            onConfirm={() => {
              setDisconnecting(false);
              start(async () => {
                await disconnectStripeAction();
                router.refresh();
              });
            }}
          />
        )}
      </Dialog>
    </>
  );
}

type InvoiceAutoNow = { emailInvoices: boolean; billOnPlan: boolean };

export function InvoicingSettings({
  initial,
  business,
  payments,
  auto,
  stripeReady,
  coachEmail,
}: {
  initial: CoachInvoicing;
  business: CoachBusiness;
  payments: PaymentsState;
  /** The coach's sign-in email: where a reply to an invoice email goes when no billing email is set. */
  coachEmail?: string;
  /** Invoices by email (on by default) and When a plan is assigned (off by default), lib/invoiceAuto.ts (23 Nov, Alex). */
  auto?: InvoiceAutoNow;
  /** Stripe set up on the server (lib/stripe.ts stripeConfigured): card payments offered, else "Soon". */
  stripeReady?: boolean;
}) {
  const router = useRouter();
  const eff = invoicingFor(business, initial);
  const country = eff.country;
  const d = useDraft<CoachInvoicing>({ currency: eff.currency, vat_rate: eff.rate, prices_include_vat: eff.pricesIncludeVat, ...initial }, saveCoachInvoicingAction);
  const tax = country.tax;
  // Mid-sentence, the tax of no country yet is a plain word ("Include tax").
  const taxWord = country.code ? tax : "tax";
  // The United States has no tax part (sales tax isn't handled): the currency alone.
  const taxed = country.code !== "US";
  const ibanBad = !!d.v.iban && !/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(d.v.iban.replace(/\s+/g, "").toUpperCase());
  const ibanError = ibanBad ? "Not an IBAN" : undefined;
  const currency = d.v.currency ?? eff.currency;
  const currencies = CURRENCIES.includes(currency) ? CURRENCIES : [currency, ...CURRENCIES];
  // A bad IBAN holds Save back, and the bar says why (its row may be shut).
  useSaveSlot("invoicing", { dirty: d.dirty, count: d.count, blocked: ibanBad, problem: ibanBad ? "IBAN in Invoicing & payments isn't valid" : null, save: d.commit, cancel: d.discard });

  // The next invoice's number, once its prefix or number is set.
  const year = new Date().getFullYear();
  const example = d.v.number_prefix || d.v.next_number != null ? `Next ${(d.v.number_prefix ?? "").replaceAll("{year}", String(year))}${String(d.v.next_number ?? 1).padStart(4, "0")}` : undefined;
  const standard = country.code && country.rate > 0 ? (d.v.vat_rate === country.rate ? `${country.name} standard` : `${country.name} standard ${country.rate}%`) : undefined;

  // A row opened in place edits the form itself; Cancel puts back what it held when opened, Save saves the section now
  // (what else is changed in it with it), then draws the page again.
  const [kept, setKept] = useState<Partial<CoachInvoicing>>({});
  const [rowError, setRowError] = useState("");
  const keep = (keys: (keyof CoachInvoicing)[]) => (open: boolean) => {
    if (!open) return;
    setRowError("");
    setKept((o) => ({ ...o, ...Object.fromEntries(keys.map((k) => [k, d.v[k]])) }));
  };
  const putBack = (keys: (keyof CoachInvoicing)[]) => () => {
    for (const k of keys) d.set(k, kept[k] as never);
    setRowError("");
  };
  const saveNow = async () => {
    if (ibanBad) return false;
    try {
      await saveCoachInvoicingAction(d.v);
    } catch {
      setRowError("Not saved. Try again.");
      return false;
    }
    router.refresh();
  };
  const textRow = (k: "tax_note" | "footer", name: string, tall = false) => {
    const value = d.v[k] ?? "";
    return (
      <OpenRow name={name} fact={value || undefined} word={value ? "Edit" : "Add"} onOpenChange={keep([k])} onCancel={putBack([k])} onSave={saveNow} canSave={!ibanBad} error={rowError}>
        <Fields cols={1}>
          <Line wide tall={tall} label={undefined}>
            {tall ? (
              <textarea className="dlh-line" value={value} onChange={(e) => d.set(k, e.target.value)} rows={3} aria-label={name} />
            ) : (
              <input className="dlh-line" value={value} onChange={(e) => d.set(k, e.target.value)} aria-label={name} />
            )}
          </Line>
        </Fields>
      </OpenRow>
    );
  };
  const field = (k: keyof CoachInvoicing, label: string, opts: { wide?: boolean; upper?: boolean; error?: string } = {}) => (
    <Line label={label} wide={opts.wide} error={opts.error}>
      <input className="dlh-line" value={String(d.v[k] ?? "")} onChange={(e) => d.set(k, (opts.upper ? e.target.value.toUpperCase() : e.target.value) as never)} aria-invalid={!!opts.error} autoComplete="off" />
    </Line>
  );

  // Bank transfer: how the country pays by bank (lib/countries.ts), opened under its row.
  const BANK_KEYS: (keyof CoachInvoicing)[] = ["account_holder", "iban", "bic", "sort_code", "account_number", "routing_number", "bsb", "bank_details"];
  const v = d.v;
  const account =
    country.bank === "uk" ? (v.sort_code && v.account_number ? `${v.sort_code} ${v.account_number}` : v.iban)
    : country.bank === "us" ? (v.routing_number && v.account_number ? `${v.routing_number} ${v.account_number}` : null)
    : country.bank === "au" ? (v.bsb && v.account_number ? `${v.bsb} ${v.account_number}` : null)
    : country.bank === "iban" ? v.iban
    : (v.bank_details?.split("\n")[0] ?? v.iban);
  const banked = hasBankDetails(v, country);

  // Invoices by email and When a plan is assigned: each switch saved at once, put back if it didn't go.
  const [autoNow, setAutoNow] = useState<InvoiceAutoNow>(auto ?? { emailInvoices: true, billOnPlan: false });
  const [autoError, setAutoError] = useState<{ key: keyof InvoiceAutoNow; text: string } | null>(null);
  const flip = (key: keyof InvoiceAutoNow, on: boolean) => {
    const was = autoNow;
    setAutoNow({ ...was, [key]: on });
    setAutoError(null);
    const fail = (text: string) => (setAutoNow(was), setAutoError({ key, text }));
    setInvoiceAutoAction({ [key]: on })
      .then((r: unknown) => {
        // What the switches are now (or, from an answer that says so, why it didn't go).
        const said = r as { ok?: boolean; error?: string; emailInvoices?: unknown; billOnPlan?: unknown } | null;
        if (said?.ok === false) return fail(said.error ?? "Not saved. Try again.");
        if (typeof said?.emailInvoices === "boolean" && typeof said?.billOnPlan === "boolean") setAutoNow({ emailInvoices: said.emailInvoices, billOnPlan: said.billOnPlan });
      })
      .catch(() => fail("Not saved. Try again."));
  };
  const autoSaid = (key: keyof InvoiceAutoNow) => autoError?.key === key && <p className="rst-err rst-err-row">{autoError.text}</p>;
  const payLink = payments.status === "active" && (stripeReady ?? true);
  const mailWith = payLink && banked ? "With a Pay link and your bank details" : payLink ? "With a Pay link" : banked ? "With your bank details" : undefined;
  const sender = business.business_name?.trim() || business.legal_name?.trim() || "";
  const replyTo = business.billing_email?.trim() || coachEmail?.trim() || "";

  return (
    <>
      <Two top>
        <Part label={taxed ? `Prices and ${taxWord}` : "Prices"} fact={country.code ? country.name : undefined}>
          <Row name="Currency" fact={currencyName(currency)}>
            <Picker value={currency} onChange={(c) => d.set("currency", c)} label="Currency" className="rsr-pick" menuClassName="nc-countrymenu" options={currencies.map((c) => ({ value: c, label: c, hint: currencyName(c) }))} />
          </Row>
          {taxed && (
            <>
              <Row name={`${tax} rate`} fact={standard}>
                <NumLine value={d.v.vat_rate} onChange={(n) => d.set("vat_rate", n)} unit="%" width={64} label={`${tax} rate`} decimal />
              </Row>
              <Row name="Prices you type">
                <Capsule
                  value={d.v.prices_include_vat === false ? "exclude" : "include"}
                  onChange={(x) => d.set("prices_include_vat", x === "include")}
                  label="Prices you type"
                  options={[
                    { value: "include", label: `Include ${taxWord}` },
                    { value: "exclude", label: `Exclude ${taxWord}` },
                  ]}
                />
              </Row>
              {textRow("tax_note", `${tax} note`)}
            </>
          )}
        </Part>
        <Part label="On each invoice" fact={example}>
          <Row name="Prefix">
            <InlineLine value={d.v.number_prefix ?? ""} onChange={(p) => d.set("number_prefix", p)} width={130} label="Prefix" maxLength={12} />
          </Row>
          <Row name="Next number">
            <NumLine value={d.v.next_number} onChange={(n) => d.set("next_number", n)} width={64} label="Next number" />
          </Row>
          <Row name="Payment terms">
            <NumLine value={d.v.payment_terms_days} onChange={(n) => d.set("payment_terms_days", n)} unit="days" width={90} label="Payment terms" />
          </Row>
          {textRow("footer", "Footer", true)}
        </Part>
      </Two>

      <Part label="How clients pay" bare>
        <Two top>
          <Card>
            <OpenRow
              name="Bank transfer"
              fact={banked ? <SepJoin parts={[account, v.account_holder]} /> : country.code ? "Not set" : "No country set"}
              word={banked ? "Edit" : "Add"}
              extra={
                !country.code && (
                  // Business details is a section of the same page: Set your country opens it (what is typed kept).
                  <Word
                    onClick={() => {
                      if (!goToSetting("business")) window.location.hash = "business";
                    }}
                  >
                    Set your country
                  </Word>
                )
              }
              onOpenChange={keep(BANK_KEYS)}
              onCancel={putBack(BANK_KEYS)}
              onSave={saveNow}
              canSave={!ibanBad}
              error={rowError}
            >
              <Fields>
                {field("account_holder", "Account holder", { wide: true })}
                {country.bank === "iban" && (
                  <>
                    {field("iban", "IBAN", { upper: true, error: ibanError })}
                    {field("bic", "BIC / SWIFT", { upper: true })}
                  </>
                )}
                {country.bank === "uk" && (
                  <>
                    {field("sort_code", "Sort code")}
                    {field("account_number", "Account number")}
                    {field("iban", "IBAN", { upper: true, error: ibanError })}
                    {field("bic", "BIC / SWIFT", { upper: true })}
                  </>
                )}
                {country.bank === "us" && (
                  <>
                    {field("routing_number", "Routing number (ABA)")}
                    {field("account_number", "Account number")}
                  </>
                )}
                {country.bank === "au" && (
                  <>
                    {field("bsb", "BSB")}
                    {field("account_number", "Account number")}
                  </>
                )}
                {country.bank === "other" && (
                  <Line label="How to pay you" wide tall>
                    <textarea className="dlh-line" value={d.v.bank_details ?? ""} onChange={(e) => d.set("bank_details", e.target.value)} rows={3} />
                  </Line>
                )}
              </Fields>
            </OpenRow>
          </Card>
          <Card>
            <CardPayment state={payments} ready={stripeReady ?? payments.status !== "off"} />
          </Card>
        </Two>
      </Part>

      <Two top>
        <Part label="Invoices by email">
          {/* What the email carries, as it will (lib/invoiceEmails.ts): Pay only while Stripe takes cards, the bank only once set. */}
          <Row name="Email each invoice as it is sent" fact={mailWith}>
            <Switch on={autoNow.emailInvoices} label="Email each invoice as it is sent" onChange={(on) => flip("emailInvoices", on)} />
          </Row>
          {autoSaid("emailInvoices")}
          {/* Who it is from and where a reply goes, as the email sends it: the billing email, else the sign-in's. */}
          {sender ? <Row name={`From ${sender}`} fact={replyTo ? `Replies to ${replyTo}` : undefined} /> : replyTo ? <Row name={`Replies to ${replyTo}`} /> : null}
        </Part>
        <Part label="When a plan is assigned">
          <Row name="Start billing when a client gets a plan" fact="The first invoice that day, then one each period">
            <Switch on={autoNow.billOnPlan} label="Start billing when a client gets a plan" onChange={(on) => flip("billOnPlan", on)} />
          </Row>
          {autoSaid("billOnPlan")}
        </Part>
      </Two>
    </>
  );
}

// ---- Privacy (Data & privacy's second part, 23 Nov, Alex: docs/boards/settings-harmony-mockup.html): the documents
// clients see beside what happens to their data, then who is behind the app, its two facts across one card.
export function PrivacySettings({ company, country, contactEmail, updated }: { company: string; country: string; contactEmail: string; updated: string }) {
  // A document: the whole row opens it in a new tab (Open shows on hover); one still to come wears a grey Soon.
  const doc = (label: string, href: string | null, fact?: ReactNode) =>
    href ? (
      <Link href={href} target="_blank" className="rsr-row hl rst-row opens">
        <span className="rsr-rm">
          <b>{label}</b>
          {fact && <span>{fact}</span>}
        </span>
        <span className="rst-open">
          Open <ArrowRightIcon />
        </span>
      </Link>
    ) : (
      <Row name={label} fact={fact}>
        <State>Soon</State>
      </Row>
    );
  return (
    <>
      <Two top>
        <Part label="Documents">
          {doc("Privacy policy", "/privacy", `Updated ${updated}`)}
          {doc("Support page", "/support")}
          {doc("Terms of service", null)}
          {doc("Data processing agreement", null)}
        </Part>
        <Part label={<>Your clients&rsquo; data</>}>
          <Row name="Clients delete their own account" fact="Their data goes straight away" />
          <Row name="Invoices stay" fact={<>Up to 7 years, the client&rsquo;s name alone</>} />
          <Row name="Backups" fact={<SepJoin parts={["Nightly", "a deleted account gone within 30 days"]} />} />
        </Part>
      </Two>
      <Part label="Who is behind the app">
        <Cells>
          <Row name={company} fact={`Registered in ${country}`} />
          <Row name="Privacy contact" fact={contactEmail || undefined}>
            {!contactEmail && <State>Missing</State>}
          </Row>
        </Cells>
      </Part>
    </>
  );
}
