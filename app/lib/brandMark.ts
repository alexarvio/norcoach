import fs from "fs";
import path from "path";
import { DATA_DIR, getData, persist, type CoachSettings } from "./db";
import { loadSharp } from "./sharpSetup";
import { brandColour } from "./brandColour";
import { trashUploadFile } from "./storage";

// The coach's logo behind the screens (28 Oct, Alex: "their logo would be the one in the background"). Where the
// Norcoach star sits very faint today (the client's Home, every chat, every admin screen, the coach's phone), a coach
// who uploaded a logo has it there instead: the coach on their own screens, their clients on theirs. None, the star.
//
// The upload is made into what the star is: one dark shape on nothing, in the star's box (448 × 430), so every screen
// draws it exactly as it drew the star, only another picture (`--bg-mark`, set on the page's body by the root layout).
// The shape is the logo's own transparency when it has one, else whatever differs from the colour round its edge (a
// logo on white, or white on black). Too little left, or a solid block, says so and keeps the star.
//
// Beside it since 19 Nov (Alex: docs/boards/coach-brand-mockup.html, option C): a banner, a wide wordmark made the same
// way and drawn where NORCOACH is (`BrandLogo`), and one brand colour on the main pills (`--brand`,
// lib/brandColour.ts). `coachBrand` and `brandFor` read all of it.

/** The star's box, twice over for a sharp edge on a large screen. */
const BOX = { width: 896, height: 860 };
/** The ink every shape is drawn in (#141a24); the screens fade it to 4.5%. */
const INK = { r: 20, g: 26, b: 36 };

export type MarkResult = { ok: true; png: Buffer } | { ok: false; error: string };

/** The logo as a one-colour silhouette in the star's box, or why it can't be one. */
export async function makeLogoMark(upload: Buffer): Promise<MarkResult> {
  const shape = await silhouette(upload, 800);
  if (!shape.ok) return shape;
  const sharp = await loadSharp();
  const png = await sharp(shape.png).resize(BOX.width, BOX.height, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  return { ok: true, png };
}

/** The banner's height, 120px (a top bar draws it at about 24, so sharp on a 3× screen with room to spare), and how
 *  wide it may be: eight times that. */
const BANNER_H = 120;
const BANNER_MAX_RATIO = 8;

/** The coach's banner (19 Nov, Alex: a wide wordmark drawn where NORCOACH is): made as the logo's mark is, one colour
 *  on nothing and cut to its shape, but kept at its own width (eight times its height at most, a longer one centred in
 *  that), 120px tall and small enough to sit inside the page. Its width over its height with it. Throws why not. */
export async function makeBannerMark(buf: Buffer): Promise<{ png: Buffer; ratio: number }> {
  const shape = await silhouette(buf, 2000);
  if (!shape.ok) throw new Error(shape.error);
  const sharp = await loadSharp();
  const meta = await sharp(shape.png).metadata();
  const own = (meta.width ?? 1) / Math.max(1, meta.height ?? 1);
  const width = Math.max(1, Math.round(BANNER_H * Math.min(own, BANNER_MAX_RATIO)));
  const png = await sharp(shape.png)
    .resize(width, BANNER_H, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ palette: true, quality: 90, compressionLevel: 9 })
    .toBuffer();
  return { png, ratio: Math.round((width / BANNER_H) * 1000) / 1000 };
}

/** What differs from the upload's background, in ink on nothing, cut to its shape (the logo's mark and the banner
 *  alike), read at most `side` px a side; or why it can't be one. */
async function silhouette(upload: Buffer, side: number): Promise<MarkResult> {
  const sharp = await loadSharp();
  let raw: { data: Buffer; info: { width: number; height: number } };
  try {
    raw = await sharp(upload, { failOn: "none", density: 300 }).rotate().resize(side, side, { fit: "inside", withoutEnlargement: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  } catch {
    return { ok: false, error: "That file isn't a picture we can read." };
  }
  const { data, info } = raw;
  const { width: w, height: h } = info;
  const px = (i: number) => [data[i * 4], data[i * 4 + 1], data[i * 4 + 2], data[i * 4 + 3]] as const;

  // The edge: every pixel round the border.
  const edge: number[] = [];
  for (let x = 0; x < w; x++) edge.push(x, (h - 1) * w + x);
  for (let y = 1; y < h - 1; y++) edge.push(y * w, y * w + w - 1);
  const seeThrough = edge.filter((i) => px(i)[3] < 32).length > edge.length * 0.5;
  // The colour round it: the median of the opaque edge, channel by channel.
  const median = (vals: number[]) => vals.sort((a, b) => a - b)[Math.floor(vals.length / 2)] ?? 255;
  const solid = edge.filter((i) => px(i)[3] >= 32);
  const bg = seeThrough ? null : ([0, 1, 2].map((c) => median(solid.map((i) => px(i)[c]))) as [number, number, number]);
  // A photo or a pattern has no one colour round it to drop: what would show is noise.
  const off = (i: number) => (bg ? Math.max(...[0, 1, 2].map((c) => Math.abs(px(i)[c] - bg[c]))) : 0);
  if (bg && solid.filter((i) => off(i) > 40).length > solid.length * 0.2) return { ok: false, error: "It needs a plain or see-through background, as a logo file has." };

  const out = Buffer.alloc(w * h * 4);
  let covered = 0;
  for (let i = 0; i < w * h; i++) {
    const [r, g, b, a] = px(i);
    let alpha: number;
    if (!bg) alpha = a;
    else {
      // How far from the background, eased in over a band so an anti-aliased edge stays smooth.
      const d = Math.max(Math.abs(r - bg[0]), Math.abs(g - bg[1]), Math.abs(b - bg[2]));
      alpha = Math.round(Math.min(1, Math.max(0, (d - 28) / 60)) * a);
    }
    out[i * 4] = INK.r;
    out[i * 4 + 1] = INK.g;
    out[i * 4 + 2] = INK.b;
    out[i * 4 + 3] = alpha;
    covered += alpha / 255;
  }
  const share = covered / (w * h);
  if (share < 0.005) return { ok: false, error: "Nothing of it would show. Try a version with a plain background." };
  if (share > 0.85) return { ok: false, error: "It would show as a solid block. Try a version with a plain or see-through background." };

  // Cut to the shape, nothing round it.
  const png = await sharp(out, { raw: { width: w, height: h, channels: 4 } }).trim({ threshold: 1 }).png().toBuffer();
  return { ok: true, png };
}

const coachRow = (coachId: number) => getData().users.find((u) => u.id === coachId && u.role === "coach");

/** The coach's mark, as the screens draw it; null, the star. */
export function coachMark(coachId: number | null | undefined): string | null {
  return coachId == null ? null : (coachRow(coachId)?.coach_settings?.brand?.mark ?? null);
}

/** Whose mark a signed-in person sees: a coach their own, a client their coach's. */
export function markFor(user: { role: string; id: number; client_id: number | null } | null): string | null {
  if (!user) return null;
  if (user.role === "coach") return coachMark(user.id);
  const coachId = getData().clients.find((c) => c.id === user.client_id)?.coach_id ?? null;
  return coachMark(coachId);
}

/** The upload as a PNG of at most 1600px, kept beside the mark (for its own colours later, an invoice's head): never
 *  the file as sent, so an SVG is never served as one. */
export async function logoAsPng(upload: Buffer): Promise<Buffer> {
  const sharp = await loadSharp();
  return sharp(upload, { failOn: "none", density: 300 }).rotate().resize(1600, 1600, { fit: "inside", withoutEnlargement: true }).png().toBuffer();
}

/** Keeps the coach's logo (a PNG, logoAsPng) and its mark (uploads/coaches/<id>/, which the coach, the owner and
 *  their clients may read). Back with the paths now and the ones they replaced, for the storage bucket. */
export function saveCoachLogo(coachId: number, original: Buffer, mark: Buffer): { logo: string; mark: string; previous: (string | null)[] } | null {
  const user = coachRow(coachId);
  if (!user) return null;
  const dir = path.join(DATA_DIR, "uploads", "coaches", String(coachId));
  fs.mkdirSync(dir, { recursive: true });
  const was = user.coach_settings?.brand ?? {};
  const stamp = Date.now();
  // A new name each time, so no screen keeps the old one from its cache.
  const logoFile = `logo-${stamp}.png`;
  const markFile = `mark-${stamp}.png`;
  fs.writeFileSync(path.join(dir, logoFile), original);
  fs.writeFileSync(path.join(dir, markFile), mark);
  for (const old of [was.logo, was.mark]) unlinkUpload(old);
  const logo = { logo: `/uploads/coaches/${coachId}/${logoFile}`, mark: `/uploads/coaches/${coachId}/${markFile}` };
  // The banner and the colour stay as they were (19 Nov).
  setBrand(user, { ...was, ...logo });
  return { ...logo, previous: [was.logo ?? null, was.mark ?? null] };
}

/** Back to the star. The paths removed, for the storage bucket. */
export function removeCoachLogo(coachId: number): (string | null)[] {
  const user = coachRow(coachId);
  const was = user?.coach_settings?.brand;
  if (!user || !was) return [];
  for (const old of [was.logo, was.mark]) unlinkUpload(old);
  const { logo: _logo, mark: _mark, ...rest } = was;
  void _logo;
  void _mark;
  setBrand(user, rest);
  return [was.logo ?? null, was.mark ?? null];
}

type User = ReturnType<typeof getData>["users"][number];
type Brand = NonNullable<CoachSettings["brand"]>;

/** The brand kept, or taken off the settings when nothing is left in it; persisted. */
function setBrand(user: User, brand: Brand) {
  const kept = Object.fromEntries(Object.entries(brand).filter(([, v]) => v != null && v !== "")) as Brand;
  const { brand: _gone, ...rest } = user.coach_settings ?? {};
  void _gone;
  user.coach_settings = Object.keys(kept).length ? { ...rest, brand: kept } : rest;
  persist();
}

/** Keeps the coach's banner (makeBannerMark) beside the logo, a new name each time. Back with its path and the one it
 *  replaced, for the storage bucket. */
export function saveCoachBanner(coachId: number, png: Buffer, ratio: number): { banner: string; previous: string | null } | null {
  const user = coachRow(coachId);
  if (!user) return null;
  const dir = path.join(DATA_DIR, "uploads", "coaches", String(coachId));
  fs.mkdirSync(dir, { recursive: true });
  const was = user.coach_settings?.brand ?? {};
  const file = `banner-${Date.now()}.png`;
  fs.writeFileSync(path.join(dir, file), png);
  unlinkUpload(was.banner);
  if (was.banner) bannerReady.delete(was.banner);
  const banner = `/uploads/coaches/${coachId}/${file}`;
  // Already small: it goes inside the page as it is.
  bannerReady.set(banner, dataUri(png));
  setBrand(user, { ...was, banner, bannerRatio: ratio });
  return { banner, previous: was.banner ?? null };
}

/** Back to the business name, else NORCOACH. The path removed, for the storage bucket. */
export function removeCoachBanner(coachId: number): string | null {
  const user = coachRow(coachId);
  const was = user?.coach_settings?.brand;
  if (!user || !was?.banner) return null;
  unlinkUpload(was.banner);
  bannerReady.delete(was.banner);
  const { banner: _banner, bannerRatio: _ratio, ...rest } = was;
  void _banner;
  void _ratio;
  setBrand(user, rest);
  return was.banner;
}

/** The brand colour as the coach picked it ('#rrggbb'), or none for today's ink. False when there is no such coach. */
export function saveBrandColour(coachId: number, hex: string | null): boolean {
  const user = coachRow(coachId);
  if (!user) return false;
  setBrand(user, { ...(user.coach_settings?.brand ?? {}), color: hex ?? undefined });
  return true;
}

export type CoachBrand = { /** The colour as it is used (brandColour). */ color?: string; banner?: string; bannerRatio?: number; businessName?: string };

/** What a coach's screens and their clients' wear (19 Nov, Alex): the colour as it is used (made fit for white words,
 *  brandColour), the banner inside the page when it has been read (its address until then, while it is fetched), its
 *  width over its height, and the business name for where there is no banner. Nothing set, nothing in it. */
export function coachBrand(coachId: number): CoachBrand {
  const user = coachRow(coachId);
  if (!user) return {};
  const brand = user.coach_settings?.brand;
  const out: CoachBrand = {};
  const color = brand?.color ? brandColour(brand.color)?.hex : undefined;
  if (color) out.color = color;
  // A banner whose file is gone is left out, so the business name (or NORCOACH) shows, never an empty shape.
  if (brand?.banner && !bannerMissing(brand.banner)) {
    out.banner = bannerReady.get(brand.banner) ?? (void bannerInline(brand.banner), brand.banner);
    if (brand.bannerRatio) out.bannerRatio = brand.bannerRatio;
  }
  const name = user.coach_settings?.business?.business_name?.trim();
  if (name) out.businessName = name;
  return out;
}

/** Whose coach id a signed-in person wears: a coach their own, a client their coach's. */
function brandCoachId(user: { role: string; id: number; client_id: number | null } | null): number | null {
  if (!user) return null;
  if (user.role === "coach") return user.id;
  return getData().clients.find((c) => c.id === user.client_id)?.coach_id ?? null;
}

/** The brand a signed-in person sees: a coach their own, a client their coach's; no one, nothing. */
export function brandFor(user: { role: string; id: number; client_id: number | null } | null): CoachBrand {
  const coachId = brandCoachId(user);
  return coachId == null ? {} : coachBrand(coachId);
}

/** A coach's brand with the banner read into the page first, so it is never its address on a screen drawn beside the
 *  layout (the client's app, its phone preview of another coach's client). No coach, nothing. */
export async function coachBrandInline(coachId: number | null | undefined): Promise<CoachBrand> {
  if (coachId == null) return {};
  const banner = coachRow(coachId)?.coach_settings?.brand?.banner;
  if (banner) await bannerInline(banner);
  return coachBrand(coachId);
}

/** A coach's faint mark as their clients see it, for the coach's phone preview of a client (the viewer's own is on
 *  the page's body): in their colour when they have one, else their mark, else the star. Always an address to draw. */
export async function coachMarkInline(coachId: number | null | undefined): Promise<string> {
  const mark = coachMark(coachId);
  const color = coachId == null ? undefined : coachBrand(coachId).color;
  if (color && color !== "#141a24") {
    const tint = await brandMarkInline(mark, color);
    if (tint) return tint;
  }
  if (mark) return (await markInline(mark)) ?? mark;
  return "/brand/mark.svg";
}

/** The star as one shape in a colour, as public/brand/mark.svg draws it in ink. */
const starSvg = (fill: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="197.07 200.13 640.9 614.88" fill="${fill}"><path d="M829.97,514.19L593.43,553.12L561.88,484.19Z"/><path d="M447.37,447.42L407.36,208.13L523.47,456.35Z"/><path d="M205.07,514.47L475.5,554.53A11.63,11.63 0 0 1 484.17,560.78L609.01,807.01L533.83,482.9Z"/></svg>`;

/** The faint mark in the brand colour (19 Nov, Alex: "the faint logo behind Home takes the colour too, still faint"):
 *  the coach's mark (else the star) drawn in their colour instead of ink, inside the page as markInline makes it, so
 *  every screen draws it exactly as before, only tinted (`--brand-mark`). Made once per mark and colour. Null while it
 *  can't be read; the ink mark then. */
const tinted = new Map<string, Promise<string | null>>();
export function brandMarkInline(mark: string | null, color: string): Promise<string | null> {
  const key = `${mark ?? "star"}|${color}`;
  let hit = tinted.get(key);
  if (!hit) {
    hit = (async () => {
      try {
        if (!mark) return `data:image/svg+xml,${encodeURIComponent(starSvg(color))}`;
        const uri = await markInline(mark);
        if (!uri?.startsWith("data:image/png;base64,")) return null;
        const sharp = await loadSharp();
        const { data, info } = await sharp(Buffer.from(uri.slice(uri.indexOf(",") + 1), "base64")).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
        for (let i = 0; i < data.length; i += 4) {
          data[i] = r;
          data[i + 1] = g;
          data[i + 2] = b;
        }
        const png = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png({ palette: true, quality: 80, compressionLevel: 9 }).toBuffer();
        return dataUri(png);
      } catch {
        return null;
      }
    })();
    tinted.set(key, hit);
    void hit.then((v) => {
      if (v == null) tinted.delete(key);
    });
  }
  return hit;
}

/** The banner's path a signed-in person sees, as brandFor finds it; null when none. */
export function bannerPathFor(user: { role: string; id: number; client_id: number | null } | null): string | null {
  const coachId = brandCoachId(user);
  return coachId == null ? null : (coachRow(coachId)?.coach_settings?.brand?.banner ?? null);
}

const dataUri = (png: Buffer) => `data:image/png;base64,${png.toString("base64")}`;

/** The banner inside the page, as the mark is (markInline): read once and kept in memory, so it is there at once on
 *  every open. The file is already small, so as it is. Null while it can't be read. */
const bannerReady = new Map<string, string>();
const bannerReading = new Map<string, Promise<string | null>>();
/** A banner whose file couldn't be read, and when: not asked for again for a minute, so a file gone from the disk
 *  and the bucket never holds up every page of that coach and their clients. */
const bannerMissed = new Map<string, number>();
const BANNER_RETRY_MS = 60_000;
export function bannerMissing(banner: string): boolean {
  const at = bannerMissed.get(banner);
  return at != null && Date.now() - at < BANNER_RETRY_MS;
}
export function bannerInline(banner: string): Promise<string | null> {
  const ready = bannerReady.get(banner);
  if (ready) return Promise.resolve(ready);
  if (bannerMissing(banner)) return Promise.resolve(null);
  let hit = bannerReading.get(banner);
  if (!hit) {
    hit = (async () => {
      try {
        const { keyOf, readUpload } = await import("./storage");
        const key = keyOf(banner);
        const bytes = key ? await readUpload(key) : null;
        if (!bytes) {
          bannerMissed.set(banner, Date.now());
          return null;
        }
        bannerMissed.delete(banner);
        const uri = dataUri(bytes);
        bannerReady.set(banner, uri);
        return uri;
      } catch {
        bannerMissed.set(banner, Date.now());
        return null;
      } finally {
        bannerReading.delete(banner);
      }
    })();
    bannerReading.set(banner, hit);
  }
  return hit;
}

// The old file on the disk to trash (19 Nov: the path missed the uploads folder, so old logos stayed on the volume).
function unlinkUpload(publicPath: string | null | undefined) {
  if (!publicPath?.startsWith("/uploads/")) return;
  trashUploadFile(publicPath);
}

/** The mark as a small picture inside the page itself (13 Nov, Alex: "the background image takes quite a little bit to
 *  load when I open the app"): the upload's address went through a new signed bucket link each time, so the phone
 *  fetched it again on every open. Drawn at 4.5% it needs no detail: half the box, a palette PNG, made once per mark
 *  and kept in memory, its file name changing with every new logo. Null while it can't be read; the address then. */
const inlined = new Map<string, Promise<string | null>>();
export function markInline(mark: string): Promise<string | null> {
  let hit = inlined.get(mark);
  if (!hit) {
    hit = (async () => {
      try {
        const { keyOf, readUpload } = await import("./storage");
        const key = keyOf(mark);
        const bytes = key ? await readUpload(key) : null;
        if (!bytes) return null;
        const sharp = await loadSharp();
        const small = await sharp(bytes).resize(Math.round(BOX.width / 2), Math.round(BOX.height / 2), { fit: "inside" }).png({ palette: true, quality: 80, compressionLevel: 9 }).toBuffer();
        return `data:image/png;base64,${small.toString("base64")}`;
      } catch {
        return null;
      }
    })();
    inlined.set(mark, hit);
    // A failed read is tried again next time, not kept.
    void hit.then((v) => {
      if (v == null) inlined.delete(mark);
    });
  }
  return hit;
}
