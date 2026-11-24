"use server";

import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { revalidatePath } from "next/cache";
import { isOwner, requireCoach, requireCoachAccount } from "./auth";
import { DATA_DIR } from "./db";
import { deleteUpload, putUploadFromDisk } from "./storage";
import { claimUpload, discardUpload, placeUpload, UPLOAD_CAPS } from "./streamUpload";
import { supportUnreadForCoach } from "./support";
import {
  cleanGuideFields,
  deleteGuide,
  guideVideoInUse,
  listGuidesForOwner,
  listPublishedGuides,
  markGuideWatched,
  saveGuide,
  watchedGuides,
  type GuideFields,
  type GuideView,
} from "./guides";

// The help guides' actions (24 Nov, Alex; lib/guides.ts). A coach reads the published guides and marks one watched;
// the owner (isOwner) makes, changes and deletes them on Coaches. Reading is open while read-only (requireCoachAccount),
// as Support is: help is where a stuck coach goes.

/** What the help panel needs when it opens: the published guides, the ones this coach watched, whether they have a
 *  thread with the team (the owner has none) and the team's lines they haven't read. */
export type HelpState = { guides: GuideView[]; watched: number[]; owner: boolean; unread: number };

export async function loadHelpAction(): Promise<HelpState> {
  const coach = await requireCoachAccount();
  const owner = isOwner(coach);
  return { guides: listPublishedGuides(), watched: watchedGuides(coach.id), owner, unread: owner ? 0 : supportUnreadForCoach(coach.id) };
}

/** The team's lines the coach hasn't read (the ? button's dot, read every so often). */
export async function helpUnreadAction(): Promise<number> {
  const coach = await requireCoachAccount();
  return isOwner(coach) ? 0 : supportUnreadForCoach(coach.id);
}

/** A guide opened and played. Back with the coach's watched list. */
export async function markGuideWatchedAction(guideId: number): Promise<number[]> {
  const coach = await requireCoachAccount();
  const id = Number(guideId);
  if (!Number.isInteger(id)) return watchedGuides(coach.id);
  return markGuideWatched(coach.id, id);
}

// ---- The owner ------------------------------------------------------------------------------------------------------

async function owner() {
  const coach = await requireCoach();
  return isOwner(coach) ? coach : null;
}

/** Drops an upload no guide names any more: off the disk and to the bucket's trash. */
async function dropUnused(publicPath: string | null) {
  if (!publicPath || guideVideoInUse(publicPath)) return;
  try {
    fs.rmSync(path.join(DATA_DIR, publicPath.replace(/^\/+/, "")), { force: true });
  } catch {
    /* gone already */
  }
  await deleteUpload(publicPath);
}

export type GuideSaved = { ok: true; guides: GuideView[]; id: number } | { ok: false; error: string };

/** A new guide (id null) or an existing one changed. Back with every guide as it now stands. */
export async function saveGuideAction(id: number | null, fields: GuideFields): Promise<GuideSaved> {
  if (!(await owner())) return { ok: false, error: "Not from this account." };
  const clean = cleanGuideFields(fields);
  if (!clean) return { ok: false, error: "A guide needs a title." };
  const saved = saveGuide(id == null ? null : Number(id), clean);
  if (!saved) return { ok: false, error: "That guide is gone." };
  await dropUnused(saved.dropped);
  revalidatePath("/coaches");
  return { ok: true, guides: listGuidesForOwner(), id: saved.guide.id };
}

/** A guide deleted. Back with every guide left, or null when it didn't go. */
export async function deleteGuideAction(id: number): Promise<GuideView[] | null> {
  if (!(await owner())) return null;
  const gone = deleteGuide(Number(id));
  if (!gone) return null;
  await dropUnused(gone.dropped);
  revalidatePath("/coaches");
  return listGuidesForOwner();
}

// The names uploadGuideVideoAction gives, and only those.
const GUIDE_UPLOAD = /^\/uploads\/guides\/team\/[a-z0-9]+-[0-9a-f]{8}\.[a-z0-9]{2,5}$/;

/** The clips uploaded in an edit pop-up as it closes, saved or not: each one no guide names (a Cancel, a Remove, a
 *  second upload over the first) goes off the disk and to the bucket's trash; the one a guide was saved with stays. */
export async function discardGuideUploadsAction(paths: string[]): Promise<void> {
  if (!(await owner())) return;
  const list = [...new Set((Array.isArray(paths) ? paths : []).map(String))].filter((p) => GUIDE_UPLOAD.test(p)).slice(0, 20);
  for (const p of list) await dropUnused(p);
}

const VIDEO_EXT: Record<string, string> = { "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm", "video/x-m4v": "m4v" };

/** A clip for a guide. The clip was sent ahead to /api/upload (uploadFirst, as the Library's): the form carries its
 *  handle. Back with its path, which the guide names once saved; one never saved goes as its pop-up closes
 *  (discardGuideUploadsAction). */
export async function uploadGuideVideoAction(formData: FormData): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const coach = await owner();
  if (!coach) return { ok: false, error: "Not from this account." };
  const up = claimUpload(formData.get("upload"), { userId: coach.id, kinds: ["video"] });
  if (!up) return { ok: false, error: "Empty file." };
  const refuse = (error: string) => (discardUpload(up), { ok: false as const, error });
  if (up.size > UPLOAD_CAPS.video) return refuse(`${up.name} is ${(up.size / 1024 / 1024).toFixed(0)}MB; the limit is 128MB.`);
  if (!up.type.startsWith("video/")) return refuse(`${up.name} isn't a video.`);
  const ext = VIDEO_EXT[up.type] ?? /\.([a-z0-9]{2,5})$/i.exec(up.name)?.[1]?.toLowerCase() ?? "mp4";
  const publicPath = `/uploads/guides/team/${Date.now().toString(36)}-${randomBytes(4).toString("hex")}.${ext}`;
  const onDisk = placeUpload(up, publicPath);
  await putUploadFromDisk(publicPath, onDisk, up.type);
  return { ok: true, path: publicPath };
}
