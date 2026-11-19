"use client";

import { useLayoutEffect, useRef, type CSSProperties } from "react";
import { NorCoachLogo } from "./NorCoachLogo";

// Where NORCOACH shows, the coach's own (19 Nov, Alex: docs/boards/coach-brand-mockup.html): their banner if they
// uploaded one, drawn in the colour of the text round it as the word is (ink on the page, white over a photo), as tall
// as the word and as wide as its shape; else their business name in the bar's small caps, shrinking to fit one line,
// never cut; else NORCOACH as before. The rail passes `nameInPlace={false}`: there the name stays the line under it.

export type BrandLogoProps = {
  /** The banner as a picture (a data URI from lib/brandMark.ts, its upload address until read). */
  banner?: string;
  /** Its width over its height (8 at most). */
  bannerRatio?: number;
  /** The coach's business name: the banner's label, and the bar's words when there is no banner. */
  name?: string;
  /** NORCOACH's word alone, without the star (the client's top bar). */
  word?: boolean;
  className?: string;
  /** The business name in NORCOACH's place when there is no banner (default); false keeps NORCOACH. */
  nameInPlace?: boolean;
};

export function BrandLogo({ banner, bannerRatio, name, word = false, className, nameInPlace = true }: BrandLogoProps) {
  const cls = className ? " " + className : "";
  if (banner) {
    const mask = `url("${banner}")`;
    const style = { "--banner-ratio": bannerRatio && bannerRatio > 0 ? bannerRatio : 4, WebkitMaskImage: mask, maskImage: mask } as CSSProperties;
    return <span className={`brand-banner${cls}`} role="img" aria-label={name || "Logo"} style={style} />;
  }
  if (name && nameInPlace) return <BrandName name={name} className={cls} />;
  return <NorCoachLogo className={className} word={word} />;
}

/** The business name on one line: a size down until it fits the room it has, never cut and never wrapped. */
function BrandName({ name, className }: { name: string; className: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      el.style.fontSize = "";
      const full = el.scrollWidth;
      const room = el.clientWidth;
      if (room > 0 && full > room + 0.5) {
        const size = parseFloat(getComputedStyle(el).fontSize);
        el.style.fontSize = `${Math.max(9, Math.floor(((size * room) / full) * 10) / 10)}px`;
      }
    };
    fit();
    void document.fonts?.ready.then(fit);
    const ro = new ResizeObserver(fit);
    ro.observe(el.parentElement ?? el);
    return () => ro.disconnect();
  }, [name]);
  return (
    <span ref={ref} className={`brand-name${className}`}>
      {name}
    </span>
  );
}
