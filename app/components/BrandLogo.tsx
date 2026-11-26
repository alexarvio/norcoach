"use client";

import type { CSSProperties } from "react";
import { NorCoachLogo } from "./NorCoachLogo";

// Where NORCOACH shows, the coach's own (19 Nov, Alex: docs/boards/coach-brand-mockup.html): their banner if they
// uploaded one, drawn in the colour of the text round it as the word is (ink on the page, white over a photo), as tall
// as the word and as wide as its shape; else NORCOACH (26 Nov, Alex: "only if there is a banner uploaded, then it
// shows, but if there's nothing… we just show Norcoach": the business name typed in our letters stood in before).

export type BrandLogoProps = {
  /** The banner as a picture (a data URI from lib/brandMark.ts, its upload address until read). */
  banner?: string;
  /** Its width over its height (8 at most). */
  bannerRatio?: number;
  /** The coach's business name: the banner's label for a screen reader. */
  name?: string;
  /** NORCOACH's word alone, without the star (the client's top bar). */
  word?: boolean;
  className?: string;
};

export function BrandLogo({ banner, bannerRatio, name, word = false, className }: BrandLogoProps) {
  const cls = className ? " " + className : "";
  if (banner) {
    const mask = `url("${banner}")`;
    const style = { "--banner-ratio": bannerRatio && bannerRatio > 0 ? bannerRatio : 4, WebkitMaskImage: mask, maskImage: mask } as CSSProperties;
    return <span className={`brand-banner${cls}`} role="img" aria-label={name || "Logo"} style={style} />;
  }
  return <NorCoachLogo className={className} word={word} />;
}
