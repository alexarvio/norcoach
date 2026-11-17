// The social media kit (17 Nov, Alex: "the background color and the logos… a template for posts… with that faded
// background logo and also the actual logo"): the logos as SVG and PNG, and blank Instagram templates on the website's
// dark with the star huge and faint off the top right and the logo at the top left. Writes brand/social/.
// The dark is read from website/site-bg.css, so a new background colour there is one rerun here.
// Run from the repo root: node brand/build-social.mjs
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";

const OUT = "brand/social";
mkdirSync(`${OUT}/logos`, { recursive: true });
mkdirSync(`${OUT}/templates`, { recursive: true });

// The website's dark, from the one file that holds it (fallback: today's).
const siteBg = readFileSync("website/site-bg.css", "utf8").match(/\.site-bg\s*\{[^}]*background:\s*(#[0-9a-f]{3,8})/i)?.[1] ?? "#1c1c1e";
const WHITE = "#ffffff";
const INK = "#141a24";

// The drawings: the star (its own viewBox) and the NORCOACH word (0 0 2000 352).
const markSvg = readFileSync("brand/norcoach-mark.svg", "utf8");
const markBox = markSvg.match(/viewBox="([^"]+)"/)[1].split(/\s+/).map(Number); // x y w h
const markPaths = [...markSvg.matchAll(/<path [^>]*\/>/g)].map((m) => m[0]).join("");
const wordSvg = readFileSync("brand/norcoach-wordmark.svg", "utf8");
const wordPaths = [...wordSvg.matchAll(/<path [^>]*\/>/g)].map((m) => m[0]).join("");

/** The star scaled to `h` tall with its top left at (x, y). */
const star = (x, y, h, extra = "") => {
  const s = h / markBox[3];
  return `<g transform="translate(${x} ${y}) scale(${s}) translate(${-markBox[0]} ${-markBox[1]})"${extra}>${markPaths}</g>`;
};
// The logo as the app draws it: the star and the word both 1em tall, centred on one another, half an em between.
const STAR_W = markBox[2] / markBox[3]; // in em
const LOGO_W = STAR_W + 0.5 + 2000 / 352; // in em
/** The whole logo `h` tall (the letters' height) with its top left at (x, y). */
const logo = (x, y, h) => `${star(x, y, h)}<g transform="translate(${x + (STAR_W + 0.5) * h} ${y}) scale(${h / 352})">${wordPaths}</g>`;

const svgDoc = (w, h, body, fill) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill="${fill}">${body}</svg>`;
const png = (svg, file) => sharp(Buffer.from(svg)).png().toFile(file);

// ---- Logos: the whole logo and the star alone, white (for the dark) and ink (for light), SVG and a big PNG.
for (const [name, colour] of [["white", WHITE], ["ink", INK]]) {
  const H = 352;
  const logoSvg = svgDoc(Math.ceil(LOGO_W * H), H, logo(0, 0, H), colour);
  writeFileSync(`${OUT}/logos/norcoach-logo-${name}.svg`, logoSvg);
  await png(svgDoc(3000, Math.round(3000 / LOGO_W), logo(0, 0, 3000 / LOGO_W), colour), `${OUT}/logos/norcoach-logo-${name}.png`);
  const starSvg = svgDoc(Math.ceil(STAR_W * H), H, star(0, 0, H), colour);
  writeFileSync(`${OUT}/logos/norcoach-star-${name}.svg`, starSvg);
  await png(svgDoc(Math.round(STAR_W * 1600), 1600, star(0, 0, 1600), colour), `${OUT}/logos/norcoach-star-${name}.png`);
}

// The profile picture: the white star in the middle of the dark, inside Instagram's round crop.
{
  const S = 1080;
  const h = S * 0.44;
  const w = h * STAR_W;
  await png(svgDoc(S, S, `<rect width="${S}" height="${S}" fill="${siteBg}"/>${star((S - w) / 2, (S - h) / 2, h)}`, WHITE), `${OUT}/logos/norcoach-profile-picture.png`);
}

// ---- Templates: the dark, the star huge and faint (white at 5%, as the website's hero) cropped off the top right, the
// logo small and white at the top left, inside Instagram's safe margins. Blank otherwise, for the post's own words.
const templates = [
  { file: "instagram-post-4x5", w: 1080, h: 1350, margin: 80, top: 80 },
  { file: "instagram-post-square", w: 1080, h: 1080, margin: 80, top: 80 },
  // A story's top 250px or so is under Instagram's own bar: the logo sits below it.
  { file: "instagram-story", w: 1080, h: 1920, margin: 80, top: 270 },
];
for (const t of templates) {
  const starH = t.w * 0.96; // as big as the website's hero star is to its band
  const starX = t.w - starH * STAR_W * 0.6;
  const starY = -starH * 0.34 + (t.file === "instagram-story" ? 120 : 0);
  const logoH = 30; // the letters' height: about 220px of logo on a 1080px post
  const body = `<rect width="${t.w}" height="${t.h}" fill="${siteBg}"/>${star(starX, starY, starH, ` opacity="0.05"`)}${logo(t.margin, t.top, logoH)}`;
  const svg = svgDoc(t.w, t.h, body, WHITE);
  writeFileSync(`${OUT}/templates/${t.file}.svg`, svg);
  await png(svg, `${OUT}/templates/${t.file}.png`);
  // The same without the logo, for a post that places it itself.
  await png(svgDoc(t.w, t.h, `<rect width="${t.w}" height="${t.h}" fill="${siteBg}"/>${star(starX, starY, starH, ` opacity="0.05"`)}`, WHITE), `${OUT}/templates/${t.file}-no-logo.png`);
}

console.log(`brand/social written on ${siteBg}`);
