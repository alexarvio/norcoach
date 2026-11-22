import fs from "fs";
import path from "path";
import { DATA_DIR, getData, persist, type PhaseTrack } from "./db";
import { loadSharp } from "./sharpSetup";
import { trashUploadFile } from "./storage";
import type { TrackPictures } from "./phaseCovers";

// The coach's own card pictures (19 Nov, Alex: "do up to 5 per track"): set once in Settings, Business details, for
// all their clients, in place of Norcoach's stock pictures. A track's are behind its Home card and its banner, taking
// turns as the stock ones did, wherever the client has none of their own and the phase has no cover the coach chose
// (lib/phaseCovers.ts trackPictures). Kept on the coach's brand (`cards`), the files in uploads/coaches/<id>/, which the
// coach, the owner and their clients may read.

export const MAX_COACH_CARDS = 5;
export const CARD_TRACK_ORDER: PhaseTrack[] = ["lifestyle", "training", "nutrition"];

const coachRow = (coachId: number) => getData().users.find((u) => u.id === coachId && u.role === "coach");

/** The coach's card pictures, by track; none set, nothing in it. */
export function coachCardPictures(coachId: number | null | undefined): TrackPictures {
  if (coachId == null) return {};
  const cards = coachRow(coachId)?.coach_settings?.brand?.cards ?? {};
  const out: TrackPictures = {};
  for (const t of CARD_TRACK_ORDER) if (cards[t]?.length) out[t] = [...cards[t]!];
  return out;
}

/** Default chosen over their own (22 Nov, Alex: "a toggle for card pics if we want default or not"): their clients see
 *  Norcoach's pictures, the coach's own kept for when they switch back. */
export function coachCardsDefault(coachId: number | null | undefined): boolean {
  return coachId != null && !!coachRow(coachId)?.coach_settings?.brand?.cardsDefault;
}

/** Default or their own: kept on the brand; never deletes a picture. */
export function setCoachCardsDefault(coachId: number, on: boolean) {
  const user = coachRow(coachId);
  if (!user) return;
  const brand = { ...(user.coach_settings?.brand ?? {}) };
  if (on) brand.cardsDefault = true;
  else delete brand.cardsDefault;
  const { brand: _gone, ...rest } = user.coach_settings ?? {};
  void _gone;
  user.coach_settings = Object.keys(brand).length ? { ...rest, brand } : rest;
  persist();
}

/** The client's coach's card pictures: none while the coach has Default on, so the stock ones show. */
export function coachCardsForClient(clientId: number): TrackPictures {
  const coachId = getData().clients.find((c) => c.id === clientId)?.coach_id ?? null;
  return coachCardsDefault(coachId) ? {} : coachCardPictures(coachId);
}

/** One of a coach's card pictures (any coach's): the client's own list may hold it, added with its +, and it is never
 *  theirs to delete. */
export function isCoachCardPicture(p: string): boolean {
  return /^\/uploads\/coaches\/\d+\/cards-(lifestyle|training|nutrition)-/.test(p);
}

/** The coach's picture for this client's track: theirs to put among their own (their coach's, that track's). */
export function coachCardOfClient(clientId: number, track: PhaseTrack, p: string): boolean {
  return (coachCardsForClient(clientId)[track] ?? []).includes(p);
}

/** Still behind some card: the coach's own set, or a client's own list. */
function coachCardInUse(p: string): boolean {
  const d = getData();
  if (d.users.some((u) => Object.values(u.coach_settings?.brand?.cards ?? {}).some((list) => list?.includes(p)))) return true;
  return d.clients.some((c) => Object.values(c.card_pictures ?? {}).some((list) => list?.includes(p)));
}

// The file on the disk to trash, as a client's cover (19 Nov: it missed the uploads folder and was never removed).
const unlinkQuietly = (publicPath: string) => trashUploadFile(publicPath);

function setCards(coachId: number, track: PhaseTrack, list: string[]) {
  const user = coachRow(coachId);
  if (!user) return;
  const brand = { ...(user.coach_settings?.brand ?? {}) };
  const cards = { ...(brand.cards ?? {}) };
  if (list.length) cards[track] = list;
  else delete cards[track];
  if (Object.keys(cards).length) brand.cards = cards;
  else delete brand.cards;
  const { brand: _gone, ...rest } = user.coach_settings ?? {};
  void _gone;
  user.coach_settings = Object.keys(brand).length ? { ...rest, brand } : rest;
  persist();
}

/** The upload as the card's picture: upright, a JPEG, its longest side 1600 at most (as a cover). Null, not a picture. */
export async function cardJpeg(upload: Buffer): Promise<Buffer | null> {
  try {
    const sharp = await loadSharp();
    return await sharp(upload, { failOn: "none" }).rotate().resize(1600, 1600, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  } catch {
    return null;
  }
}

/** One more of the coach's pictures on a track, after the others. Back with its path, or why not. */
export function addCoachCardPicture(coachId: number, track: PhaseTrack, jpeg: Buffer): { ok: true; saved: string } | { ok: false; error: string } {
  const user = coachRow(coachId);
  if (!user) return { ok: false, error: "Not saved. Try again." };
  const have = coachCardPictures(coachId)[track] ?? [];
  if (have.length >= MAX_COACH_CARDS) return { ok: false, error: `${MAX_COACH_CARDS} pictures is the most.` };
  const dir = path.join(DATA_DIR, "uploads", "coaches", String(coachId));
  fs.mkdirSync(dir, { recursive: true });
  // A new name each time, so no screen keeps an old one from its cache.
  const file = `cards-${track}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.jpg`;
  fs.writeFileSync(path.join(dir, file), jpeg);
  const saved = `/uploads/coaches/${coachId}/${file}`;
  setCards(coachId, track, [...have, saved]);
  return { ok: true, saved };
}

/** One taken off the coach's set. Back with the path to drop from the bucket: null when it wasn't theirs, or a client
 *  still has it among their own (it stays on their card). */
export function removeCoachCardPicture(coachId: number, track: PhaseTrack, publicPath: string): { removed: boolean; drop: string | null } {
  const have = coachCardPictures(coachId)[track] ?? [];
  if (!have.includes(publicPath)) return { removed: false, drop: null };
  setCards(coachId, track, have.filter((p) => p !== publicPath));
  if (coachCardInUse(publicPath)) return { removed: true, drop: null };
  unlinkQuietly(publicPath);
  return { removed: true, drop: publicPath };
}

/** A coach's picture a client took off their own list: its file goes once nothing shows it. Back with the paths gone,
 *  for the bucket. */
export function dropUnusedCoachCards(paths: string[]): string[] {
  const gone = paths.filter((p) => isCoachCardPicture(p) && !coachCardInUse(p));
  gone.forEach(unlinkQuietly);
  return gone;
}
