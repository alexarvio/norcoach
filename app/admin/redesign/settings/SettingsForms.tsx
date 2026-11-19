"use client";

import { useEffect, useRef, useState, useTransition, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { connectStripeAction, disconnectStripeAction, removeCoachBannerAction, removeCoachLogoAction, saveCoachBusinessAction, saveCoachInvoicingAction, setBrandColourAction, uploadCoachBannerAction, uploadCoachLogoAction } from "../../../lib/actions";
import { BRAND_SWATCHES, brandColour, normalHex } from "../../../lib/brandColour";
import type { PaymentsState } from "../../../lib/payments";
import { changeOwnEmailAction, changeOwnPasswordAction, logoutAction } from "../../../lib/auth-actions";
import type { CoachBusiness, CoachInvoicing } from "../../../lib/db";
import { ArrowRightIcon } from "../../../components/icons";
import { COUNTRIES, CURRENCIES, countryCodeFromName, countryOf, currencyName, invoicingFor } from "../../../lib/countries";
import Picker from "../Picker";
import { Sep, SepJoin } from "../Sep";
import { useSaveSlot, useUnsaved } from "./SaveHost";
import { goToSetting } from "./settingsScroll";
import { Dialog } from "../../../components/ui/dialog";
import { ConfirmDialog } from "../training/TrainingDraft";
import type { AccountSecurity } from "../../../lib/accountSecurity";
import ClerkAccount from "./ClerkAccount";
import HelpTip from "../HelpTip";

// Settings' sections on the admin rules (22 Oct; docs/DESIGN-RULES-ADMIN.md), each a folding section of the one
// Settings page (23 Oct, Alex; SettingsBoard.tsx): its parts as small caps labels over one white hairline card each,
// fields as small caps labels over clean lines (.dlh-label, .dlh-line), a choice of two as the capsule, lists as the
// floating Picker. A form that saves on Save puts its changes on the page's one bar (useSaveSlot, SaveHost.tsx), and
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

// ---- Account & security
export function AccountSettings({ email, passwordless = false, security = null, passwordsHint = null }: { email: string; /** Sign-in through Clerk (26 Oct): no password here, and the email can be changed. */ passwordless?: boolean; /** The linked logins and devices, from Clerk (27 Oct). */ security?: AccountSecurity | null; /** Whether Clerk takes passwords, read with the page (lib/clerkPasswords.ts). */ passwordsHint?: boolean | null }) {
  if (passwordless) return <ClerkAccount email={email} security={security} passwordsHint={passwordsHint} />;
  return <AccountPassword email={email} />;
}

/** The account's email with the sign-in through Clerk: where clients' replies to invites go, changed in place. Signing
 *  in is Clerk's (Google, or a code to the email), so no password. */
export function AccountEmail({ email, bare = false }: { email: string; /** Inside a card of the caller's (27 Oct: Account & security's Sign-in card). */ bare?: boolean }) {
  const [value, setValue] = useState(email);
  const [busy, start] = useTransition();
  const [error, setError] = useState("");
  const changed = value.trim().toLowerCase() !== email;
  const save = () =>
    start(async () => {
      const r = await changeOwnEmailAction(value);
      if (!r.ok) return setError(r.error ?? "Couldn't change it.");
      setError("");
      toast.success("Email changed");
    });
  // The email line alone, for the caller's card.
  if (bare)
    return (
      <div className="rst-grid">
        <Field label="Email" wide>
          <input className="dlh-line" type="email" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="email" />
        </Field>
        {changed && (
          <div className="rst-foot wide">
            <span className="rst-err">{error}</span>
            <button type="button" className="dlh-go" onClick={save} disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        )}
      </div>
    );
  return (
    <>
      <Section title="Sign-in">
      <div className="rls-card rst-card">
        <div className="rst-grid">
          <Field label="Email" wide>
            <input className="dlh-line" type="email" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="email" />
          </Field>
          {changed && (
            <div className="rst-foot wide">
              <span className="rst-err">{error}</span>
              <button type="button" className="dlh-go" onClick={save} disabled={busy}>
                {busy ? "Saving…" : "Save"}
              </button>
            </div>
          )}
        </div>
      </div>
      </Section>
      <Section
        title="This device"
        actions={
          <button type="button" className="trn-pill rst-pill" onClick={() => logoutAction()}>
            Sign out
          </button>
        }
      />
    </>
  );
}

function AccountPassword({ email }: { email: string }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, start] = useTransition();
  const [error, setError] = useState("");
  const problem = next && next.length < 8 ? "At least 8 characters." : again && next !== again ? "The two new passwords differ." : "";
  const ok = !!current && next.length >= 8 && next === again;
  const change = () =>
    start(async () => {
      const r = await changeOwnPasswordAction(current, next);
      if (!r.ok) {
        setError(r.error ?? "Couldn't change it.");
        return;
      }
      setError("");
      setCurrent("");
      setNext("");
      setAgain("");
      toast.success("Password changed");
    });
  return (
    <>
      <Section title="Sign-in">
        <div className="rls-card rst-card">
          <div className="rst-grid">
            <div className="rst-field wide">
              <span className="dlh-label">Email</span>
              <span className="rst-static">{email}</span>
            </div>
          </div>
        </div>
      </Section>

      <Section title="Password">
        <div className="rls-card rst-card">
          <div className="rst-grid">
            <Field label="Current password" wide>
              <input className="dlh-line" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
            </Field>
            <Field label="New password">
              <input className="dlh-line" type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" aria-invalid={!!problem && next.length < 8} />
            </Field>
            <Field label="New password again">
              <input className="dlh-line" type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" aria-invalid={!!again && next !== again} />
            </Field>
            <div className="rst-foot wide">
              <span className="rst-err">{problem || error}</span>
              <button type="button" className="dlh-go" onClick={change} disabled={!ok || busy}>
                {busy ? "Changing…" : "Change"}
              </button>
            </div>
          </div>
        </div>
      </Section>

      <Section
        title="This device"
        actions={
          <button type="button" className="trn-pill rst-pill" onClick={() => logoutAction()}>
            Sign out
          </button>
        }
      />
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
  const used = brandColour(shown) ?? { hex: ink, changed: false };
  // The admin takes the colour the moment it is picked (19 Nov, Alex: "just have the ui change the color when i click on
  // a color so they see immediately how it is"; no Start pill): --brand on the page at once, the save following, and
  // the faint mark behind the page redrawn in it here (the server's own tinted copy comes with the save).
  useEffect(() => {
    const body = document.body.style;
    if (used.hex === ink) {
      body.removeProperty("--brand");
      body.removeProperty("--brand-mark");
      return;
    }
    body.setProperty("--brand", used.hex);
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
      g.fillStyle = used.hex;
      g.fillRect(0, 0, c.width, c.height);
      body.setProperty("--brand-mark", `url("${c.toDataURL("image/png")}")`);
    };
    img.src = mark;
    return () => {
      gone = true;
    };
  }, [used.hex, ink]);
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
        {used.changed && (
          <span className="rst-brand-fact">
            {shown.toUpperCase()} shows as {used.hex.toUpperCase()}
          </span>
        )}
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
          placeholder="#"
          aria-label="Colour as a hex code"
          spellCheck={false}
          autoComplete="off"
          maxLength={7}
        />
      </div>
    </div>
  );
}

// ---- Business details: who the invoices are from. The country comes first:
// it names the numbers and the address lines (lib/countries.ts).
const OTHER = "other";

export function BusinessSettings({ initial }: { initial: CoachBusiness }) {
  const d = useDraft<CoachBusiness>({ ...initial, country_code: initial.country_code ?? countryCodeFromName(initial.country) }, saveCoachBusinessAction);
  useSaveSlot("business", { dirty: d.dirty, count: d.count, save: d.commit, cancel: d.discard });
  const country = countryOf(d.v.country_code);
  const text = (k: keyof CoachBusiness, label: string, opts: { wide?: boolean; placeholder?: string; type?: string } = {}) => (
    <Field label={label} wide={opts.wide}>
      <input className="dlh-line" type={opts.type ?? "text"} value={d.v[k] ?? ""} onChange={(e) => d.set(k, e.target.value)} placeholder={opts.placeholder} />
    </Field>
  );
  return (
    <>
      <Section title="Where you do business">
        <div className="rls-card rst-card">
          <div className="rst-grid">
            <Field label="Country" group>
              <Picker
                value={country.code || OTHER}
                onChange={(v) => d.set("country_code", v === OTHER ? "" : v)}
                label="Country"
                className="rst-pick"
                options={[...COUNTRIES.map((c) => ({ value: c.code, label: c.name })), { value: OTHER, label: "Somewhere else" }]}
              />
            </Field>
            {!country.code && text("country", "Country name", { placeholder: "Where you are registered" })}
          </div>
        </div>
      </Section>

      <Section title="Business">
        <div className="rls-card rst-card">
          <div className="rst-grid">
            {text("business_name", "Business name", { placeholder: "Full Potential Coaching" })}
            {text("legal_name", "Legal name", { placeholder: "As registered" })}
            {text("company_number", country.registration ?? "Business registration")}
            {text("vat_number", country.taxId)}
          </div>
        </div>
      </Section>

      <Section title="Address">
        <div className="rls-card rst-card">
          <div className="rst-grid">
            {/* One order and one name for an address everywhere (16 Nov, Alex: the audit; AddressFields): Address
                across, then the postcode and the city, the region after them; the country leads the section above. */}
            {text("address", "Address", { wide: true, placeholder: "Street and number" })}
            {text("postcode", country.postcode)}
            {text("city", "City")}
            {country.region && text("region", country.region)}
          </div>
        </div>
      </Section>

      <Section title="Contact on invoices">
        <div className="rls-card rst-card">
          <div className="rst-grid">
            {text("billing_email", "Billing email", { type: "email", placeholder: "billing@…" })}
            {text("phone", "Phone")}
            {text("website", "Website", { wide: true, placeholder: "https://" })}
          </div>
        </div>
      </Section>
    </>
  );
}

// ---- Invoicing & payments: how invoices are numbered, priced and paid. The
// country from Business details fills in what is left open.
// Online payments: the coach's own Stripe account (lib/stripe.ts). Off until
// the server has Stripe's keys; then Connect, finish on Stripe, Connected.
// Where it stands is a state pill; the fix is its pill beside it.
function OnlinePayments({ state }: { state: PaymentsState }) {
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
  const pill =
    state.status === "active" ? (
      <span className="trn-state good rst-state">Connected</span>
    ) : state.status === "pending" ? (
      <span className="trn-state warn rst-state">Not finished</span>
    ) : state.status === "off" ? (
      <span className="trn-state rst-state">Soon</span>
    ) : (
      <span className="trn-state rst-state">Not connected</span>
    );
  return (
    <Section title="Online payments" fact={state.testMode ? "Test mode" : undefined}>
      <div className="rls-card rst-card">
        <div className="rst-row">
          <span className="rst-row-main">
            <b>Stripe</b>
          </span>
          {state.status !== "none" && state.status !== "off" && (
            <button type="button" className="rst-danger rst-hover" disabled={busy} onClick={() => setDisconnecting(true)}>
              Disconnect
            </button>
          )}
          {pill}
          {state.status !== "off" && state.status !== "active" && (
            <button type="button" className="rst-act" onClick={go} disabled={busy}>
              {busy ? "Opening Stripe…" : state.status === "pending" ? "Finish on Stripe" : "Connect Stripe"}
            </button>
          )}
        </div>
        {said && <p className="rst-err rst-err-row">{said}</p>}
      </div>
      {/* Nothing destructive on one click (rule 4): Disconnect asks first. */}
      <Dialog open={disconnecting} onOpenChange={setDisconnecting}>
        {disconnecting && (
          <ConfirmDialog
            title="Disconnect Stripe?"
            description="Your clients can’t pay invoices online until you connect it again."
            confirm="Disconnect"
            danger
            onConfirm={() => {
              setDisconnecting(false);
              start(async () => {
                await disconnectStripeAction();
                router.refresh();
                toast.success("Stripe disconnected here");
              });
            }}
          />
        )}
      </Dialog>
    </Section>
  );
}

export function InvoicingSettings({ initial, business, payments }: { initial: CoachInvoicing; business: CoachBusiness; payments: PaymentsState }) {
  const eff = invoicingFor(business, initial);
  const country = eff.country;
  const d = useDraft<CoachInvoicing>({ currency: eff.currency, vat_rate: eff.rate, prices_include_vat: eff.pricesIncludeVat, payment_terms_days: eff.termsDays, number_prefix: "", next_number: 1, ...initial }, saveCoachInvoicingAction);
  const num = (k: "vat_rate" | "payment_terms_days" | "next_number", s: string) => d.set(k, s === "" ? undefined : Number(s));
  const text = (k: keyof CoachInvoicing, label: string, opts: { wide?: boolean; placeholder?: string; upper?: boolean; error?: string } = {}) => (
    <Field label={label} wide={opts.wide} error={opts.error}>
      <input className="dlh-line" value={String(d.v[k] ?? "")} onChange={(e) => d.set(k, (opts.upper ? e.target.value.toUpperCase() : e.target.value) as never)} placeholder={opts.placeholder} aria-invalid={!!opts.error} />
    </Field>
  );
  const year = new Date().getFullYear();
  const example = `${(d.v.number_prefix ?? "").replaceAll("{year}", String(year))}${String(d.v.next_number ?? 1).padStart(4, "0")}`;
  const ibanBad = !!d.v.iban && !/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(d.v.iban.replace(/\s+/g, "").toUpperCase());
  const ibanError = ibanBad ? "Not an IBAN" : undefined;
  const tax = country.tax;
  const currencies = CURRENCIES.includes(d.v.currency ?? "") ? CURRENCIES : [d.v.currency ?? "EUR", ...CURRENCIES];
  // The country's standard rate, as a quiet fact by the field (not in the US, where coaching is usually untaxed).
  const standard = country.code && country.code !== "US" ? `standard ${country.rate}%` : undefined;
  // A bad IBAN holds Save back, and the bar says why (its field may be folded away).
  useSaveSlot("invoicing", { dirty: d.dirty, count: d.count, blocked: ibanBad, problem: ibanBad ? "IBAN in Invoicing & payments isn't valid" : null, save: d.commit, cancel: d.discard });
  return (
    <>
      <Section title={`Prices and ${tax}`} fact={country.code ? country.name : undefined}>
        <div className="rls-card rst-card">
          <div className="rst-grid">
            <Field label="Currency" group>
              <Picker value={d.v.currency ?? eff.currency} onChange={(v) => d.set("currency", v)} label="Currency" className="rst-pick" options={currencies.map((c) => ({ value: c, label: c, hint: currencyName(c) }))} />
            </Field>
            <Field label={`${tax} rate`} fact={standard}>
              <span className="rst-suffixed">
                <input className="dlh-line" type="number" inputMode="decimal" min={0} max={50} step={0.1} value={d.v.vat_rate ?? ""} onChange={(e) => num("vat_rate", e.target.value)} />
                <em>%</em>
              </span>
            </Field>
            <Field label="Prices you type" group>
              <div className="rd-btn-group rst-cap" role="radiogroup" aria-label="Prices you type">
                {[true, false].map((inc) => (
                  <button key={String(inc)} type="button" role="radio" aria-checked={!!d.v.prices_include_vat === inc} className={!!d.v.prices_include_vat === inc ? "on" : ""} onClick={() => d.set("prices_include_vat", inc)}>
                    {inc ? `Include ${tax}` : `Exclude ${tax}`}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="Payment terms">
              <span className="rst-suffixed">
                <input className="dlh-line" type="number" inputMode="numeric" min={0} max={120} value={d.v.payment_terms_days ?? ""} onChange={(e) => num("payment_terms_days", e.target.value)} />
                <em>days</em>
              </span>
            </Field>
            {text("tax_note", `${tax} note on invoices`, { wide: true, placeholder: country.code === "NL" ? "Vrijgesteld van btw (KOR)" : "VAT exempt, reverse charge…" })}
          </div>
        </div>
      </Section>

      <Section title="Numbering" fact={`Next ${example}`}>
        <div className="rls-card rst-card">
          <div className="rst-grid">
            <Field label="Prefix">
              <input className="dlh-line" value={d.v.number_prefix ?? ""} onChange={(e) => d.set("number_prefix", e.target.value)} placeholder="FP-{year}-" />
            </Field>
            <Field label="Next number">
              <input className="dlh-line" type="number" inputMode="numeric" min={1} value={d.v.next_number ?? ""} onChange={(e) => num("next_number", e.target.value)} />
            </Field>
          </div>
        </div>
      </Section>

      <Section
        title="Bank transfer"
        fact={country.code ? undefined : "No country set"}
        actions={
          !country.code && (
            // Business details is a section of the same page: the pill opens it (this one folds, what is typed kept).
            <a
              href="#business"
              className="trn-pill rst-pill"
              onClick={(e) => {
                if (goToSetting("business")) e.preventDefault();
              }}
            >
              Set your country
            </a>
          )
        }
      >
        <div className="rls-card rst-card">
          <div className="rst-grid">
            {text("account_holder", "Account holder", { placeholder: business.legal_name || business.business_name || "", wide: country.bank === "other" })}
            {country.bank === "iban" && (
              <>
                {text("iban", "IBAN", { upper: true, placeholder: `${country.code || "NL"}00 BANK 0123 4567 89`, error: ibanError })}
                {text("bic", "BIC / SWIFT", { upper: true })}
              </>
            )}
            {country.bank === "uk" && (
              <>
                {text("sort_code", "Sort code", { placeholder: "12-34-56" })}
                {text("account_number", "Account number", { placeholder: "12345678" })}
                {text("iban", "IBAN", { upper: true, error: ibanError })}
                {text("bic", "BIC / SWIFT", { upper: true })}
              </>
            )}
            {country.bank === "us" && (
              <>
                {text("routing_number", "Routing number (ABA)", { placeholder: "021000021" })}
                {text("account_number", "Account number")}
              </>
            )}
            {country.bank === "au" && (
              <>
                {text("bsb", "BSB", { placeholder: "062-000" })}
                {text("account_number", "Account number")}
              </>
            )}
            {country.bank === "other" && (
              <Field label="How to pay you" wide>
                <textarea className="dlh-line rst-text" value={d.v.bank_details ?? ""} onChange={(e) => d.set("bank_details", e.target.value)} rows={3} placeholder="Bank, account number, and any code the bank needs" />
              </Field>
            )}
          </div>
        </div>
      </Section>

      <OnlinePayments state={payments} />

      <Section title="Invoice footer">
        <div className="rls-card rst-card">
          <div className="rst-grid">
            <Field label="Footer" wide>
              <textarea className="dlh-line rst-text" value={d.v.footer ?? ""} onChange={(e) => d.set("footer", e.target.value)} placeholder="Thank you for training with us. Questions about this invoice: billing@…" rows={3} />
            </Field>
          </div>
        </div>
      </Section>
    </>
  );
}

// ---- Privacy & legal: the documents clients see, and what happens to their data.
export function PrivacySettings({ company, country, contactEmail, updated }: { company: string; country: string; contactEmail: string; updated: string }) {
  // A document: the whole row opens it in a new tab (Open shows on hover); one still to come wears a grey Soon.
  const doc = (label: string, href: string | null, note?: ReactNode) =>
    href ? (
      <Link href={href} target="_blank" className="rst-row opens">
        <span className="rst-row-main">
          <b>{label}</b>
          {note && <small>{note}</small>}
        </span>
        <span className="rst-open">
          Open <ArrowRightIcon />
        </span>
      </Link>
    ) : (
      <div className="rst-row">
        <span className="rst-row-main">
          <b>{label}</b>
          {note && <small>{note}</small>}
        </span>
        <span className="trn-state rst-state">Soon</span>
      </div>
    );
  const fact = (label: string, text: ReactNode) => (
    <div className="rst-row">
      <span className="rst-row-main stack">
        <b>{label}</b>
        <small>{text}</small>
      </span>
    </div>
  );
  return (
    <>
      <Section title="Documents">
        <div className="rls-card rst-card rst-rows">
          {doc("Privacy policy", "/privacy", `Updated ${updated}`)}
          {doc("Support page", "/support")}
          {doc("Terms of service", null)}
          {doc("Data processing agreement", null)}
        </div>
      </Section>

      <Section title="Who is behind the app">
        <div className="rls-card rst-card rst-rows">
          <div className="rst-row">
            <span className="rst-row-main">
              <b>{company}</b>
              <small>Registered in {country}</small>
            </span>
          </div>
          <div className="rst-row">
            <span className="rst-row-main">
              <b>Privacy contact</b>
              {contactEmail && <small>{contactEmail}</small>}
            </span>
            {!contactEmail && <span className="trn-state rst-state">Missing</span>}
          </div>
        </div>
      </Section>

      <Section title={<>Your clients&rsquo; data</>}>
        <div className="rls-card rst-card rst-rows">
          {fact("Clients delete their own account", "In the app, under Account; their data goes straight away.")}
          {fact("Invoices stay", <>Up to 7 years, the business record the law asks you to keep, with only the client&rsquo;s name.</>)}
          {fact("Backups", "Nightly; a deleted account is gone from them within 30 days.")}
        </div>
      </Section>
    </>
  );
}
