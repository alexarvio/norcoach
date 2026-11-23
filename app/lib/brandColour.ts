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

/** The ink words go dark in on a bright colour. */
const INK: Rgb = [20, 26, 36];
const contrastWithInk = (rgb: Rgb) => (luminance(rgb) + 0.05) / (luminance(INK) + 0.05);

/** The colour as it is used, lowercase '#rrggbb', whether it had to be darkened, and the words on it: white, or ink on a
 *  colour too bright for white (22 Nov, Alex: D of docs/boards/light-brand-mockup.html: a neon yellow stays itself, its
 *  words dark, never darkened to mustard). Only a colour in the narrow middle where neither reads at 4.5:1 is darkened
 *  a touch, its hue kept, until white does. Null when it isn't a colour. */
export function brandColour(input: string): { hex: string; changed: boolean; ink: "#ffffff" | "#141a24"; text: string } | null {
  const rgb = parse(input ?? "");
  if (!rgb) return null;
  if (contrastWithWhite(rgb) >= MIN_CONTRAST) return { hex: toHex(rgb), changed: false, ink: "#ffffff", text: toHex(rgb) };
  if (contrastWithInk(rgb) >= MIN_CONTRAST) return { hex: toHex(rgb), changed: false, ink: "#141a24", text: readableOnWhite(rgb) };
  const [h, s, l0] = toHsl(rgb);
  for (let step = 1; step <= 100; step++) {
    const l = Math.max(0, l0 - step / 100);
    const next = fromHsl(h, s, l).map((c) => Math.round(c)) as Rgb;
    if (contrastWithWhite(next) >= MIN_CONTRAST || l === 0) return { hex: toHex(next), changed: true, ink: "#ffffff", text: toHex(next) };
  }
  return { hex: "#000000", changed: true, ink: "#ffffff", text: "#000000" };
}

/** A bright colour as words or a faint mark on white (the client's picked tab, the mark behind the page): darkened, its
 *  hue kept, until it reads at 4.5:1; a neon yellow alone on white can't be read. */
function readableOnWhite(rgb: Rgb): string {
  const [h, s, l0] = toHsl(rgb);
  for (let step = 1; step <= 100; step++) {
    const l = Math.max(0, l0 - step / 100);
    const next = fromHsl(h, s, l).map((c) => Math.round(c)) as Rgb;
    if (contrastWithWhite(next) >= MIN_CONTRAST || l === 0) return toHex(next);
  }
  return "#000000";
}

/** The colour's CSS variables for the body (the layout, Settings as it is picked, a phone preview): `--brand` the
 *  colour; on a bright one, what sits on it turns dark: `--brand-ink` the words and marks on the colour (white by
 *  default), `--brand-pill` and `--brand-pill-ink` the picked pill on a surface of the colour (white with ink words by
 *  default; ink with white words on a bright one), `--brand-count` a count on it (soft rust by default; dark rust). */
export function brandVars(input: string | null | undefined): Record<string, string> {
  const c = input ? brandColour(input) : null;
  if (!c) return {};
  const vars: Record<string, string> = { "--brand": c.hex };
  // How strong the big faint logo behind the admin's page is, drawn in the colour itself (23 Nov, Alex: "match the color
  // selected in branding a bit better, its too little intensity"): a light colour needs more of it than a dark one to show
  // as much against the paper, so its strength rises as the colour lightens (ink and navy about 10%, a lime 30%).
  const rgb = parse(c.hex);
  if (rgb) vars["--brand-mark-o"] = String(Math.round(Math.min(0.3, Math.max(0.1, 0.1 / Math.max(0.05, 0.93 - luminance(rgb)))) * 1000) / 1000);
  if (c.ink === "#141a24") {
    vars["--brand-ink"] = "#141a24";
    vars["--brand-pill"] = "#141a24";
    vars["--brand-pill-ink"] = "#ffffff";
    vars["--brand-count"] = "#8a3a12";
    // The colour as words on white, darkened until it reads there.
    vars["--brand-text"] = c.text;
  }
  return vars;
}
