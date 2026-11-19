// The coach's brand colour (19 Nov, Alex: docs/boards/coach-brand-mockup.html, option C). Any colour the coach likes;
// it only ever fills things with white words on them (the main pill, the tab on screen, the client's own bubbles), so
// the one change made is for those words: a colour too light for them is darkened, its hue and saturation kept, its
// lightness lowered 1% at a time until white on it reads at 4.5:1 (WCAG AA). No hue is refused. Unset, today's ink.
// Pure, so the Settings form can show what will be used as the coach picks.

/** The quick picks beside the colour field; Ink is today's look. */
export const BRAND_SWATCHES: { name: string; hex: string }[] = [
  { name: "Ink", hex: "#141a24" },
  { name: "Slate", hex: "#3d4a5c" },
  { name: "Cobalt", hex: "#2346a8" },
  { name: "Ocean", hex: "#0d6680" },
  { name: "Plum", hex: "#6a2c70" },
  { name: "Burgundy", hex: "#8a2442" },
  { name: "Magenta", hex: "#a3195b" },
  { name: "Olive", hex: "#5d6b1f" },
];

/** White words on the colour need this much contrast. */
const MIN_CONTRAST = 4.5;

type Rgb = [number, number, number];

/** '#rgb', '#rrggbb', with or without the #, as 0–255 channels; null when it isn't one. */
function parse(input: string): Rgb | null {
  const s = input.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{3}$/.test(s)) return [0, 1, 2].map((i) => parseInt(s[i] + s[i], 16)) as Rgb;
  if (/^[0-9a-f]{6}$/.test(s)) return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16)) as Rgb;
  return null;
}

const toHex = (rgb: Rgb) => "#" + rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("");

/** The colour as typed, written the one way: lowercase '#rrggbb'; null when it isn't one. Not darkened. */
export function normalHex(input: string): string | null {
  const rgb = parse(input ?? "");
  return rgb ? toHex(rgb) : null;
}

function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** White on the colour. */
const contrastWithWhite = (rgb: Rgb) => 1.05 / (luminance(rgb) + 0.05);

function toHsl([r, g, b]: Rgb): [number, number, number] {
  const [rr, gg, bb] = [r / 255, g / 255, b / 255];
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === rr ? (gg - bb) / d + (gg < bb ? 6 : 0) : max === gg ? (bb - rr) / d + 2 : (rr - gg) / d + 4;
  return [h / 6, s, l];
}

function fromHsl(h: number, s: number, l: number): Rgb {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t: number) => {
    const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (u < 1 / 6) return p + (q - p) * 6 * u;
    if (u < 1 / 2) return q;
    if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
    return p;
  };
  return [hue(h + 1 / 3) * 255, hue(h) * 255, hue(h - 1 / 3) * 255];
}

/** The colour as it is used, lowercase '#rrggbb', and whether it had to be darkened; null when it isn't a colour. */
export function brandColour(input: string): { hex: string; changed: boolean } | null {
  const rgb = parse(input ?? "");
  if (!rgb) return null;
  if (contrastWithWhite(rgb) >= MIN_CONTRAST) return { hex: toHex(rgb), changed: false };
  const [h, s, l0] = toHsl(rgb);
  for (let step = 1; step <= 100; step++) {
    const l = Math.max(0, l0 - step / 100);
    const next = fromHsl(h, s, l).map((c) => Math.round(c)) as Rgb;
    if (contrastWithWhite(next) >= MIN_CONTRAST || l === 0) return { hex: toHex(next), changed: true };
  }
  return { hex: "#000000", changed: true };
}
