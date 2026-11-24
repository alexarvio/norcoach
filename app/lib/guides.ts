import { allocId, getData, persist } from "./db";
import { GUIDE_SCREENS, GUIDE_TOPICS } from "./guideScreens";

export { GUIDE_SCREENS, GUIDE_TOPICS };

// Help for coaches (24 Nov, Alex: "tutorials… how to create a client or how to onboard a client or how to create a
// workout"; B of docs/boards/coach-help-mockup.html). Guides are short videos with steps, made by the owner (the Norcoach
// team) on Coaches and read by every coach in the help panel the ? opens on every admin screen (HelpButton.tsx). A guide
// is tagged with the screens it belongs to, so the panel puts the ones for the screen the coach is on first. The rows
// live in `help_guides` (db.ts, kept in kv on Postgres, as support_messages); an uploaded clip under uploads/guides/,
// served to any signed-in coach (app/uploads/[...path]/route.ts). Which guides a coach has watched is on their own row
// (users.coach_settings.guides_watched), so it goes with them.

export type HelpGuide = {
  id: number;
  title: string;
  /** Getting started, Clients, Plan… or one the owner typed. */
  topic: string;
  /** The screens it belongs to, as the address names them (GUIDE_SCREENS). */
  screens: string[];
  /** "/uploads/guides/team/<file>", or a YouTube or Vimeo (or any) link; null for none. */
  video: string | null;
  /** How long it runs, in seconds; null when not known. */
  seconds: number | null;
  /** Short lines, in order. */
  steps: string[];
  published: boolean;
  /** Its place in its topic, lowest first. */
  order: number;
  created_at: string;
  updated_at: string;
};

const MAX_TITLE = 120;
const MAX_TOPIC = 40;
const MAX_STEP = 300;
const MAX_STEPS = 30;
const MAX_VIDEO = 1000;

const rows = (): HelpGuide[] => {
  const data = getData();
  if (!data.help_guides) data.help_guides = [];
  return data.help_guides;
};

/** A guide as the panel and the owner's list read it. */
export type GuideView = Pick<HelpGuide, "id" | "title" | "topic" | "screens" | "video" | "seconds" | "steps" | "published" | "order">;
const view = (g: HelpGuide): GuideView => ({ id: g.id, title: g.title, topic: g.topic, screens: g.screens, video: g.video, seconds: g.seconds, steps: g.steps, published: g.published, order: g.order });

/** Topic first (the offered ones in their order, then typed ones A to Z), then order, then oldest. */
function byPlace(a: HelpGuide, b: HelpGuide): number {
  const ta = GUIDE_TOPICS.indexOf(a.topic as (typeof GUIDE_TOPICS)[number]);
  const tb = GUIDE_TOPICS.indexOf(b.topic as (typeof GUIDE_TOPICS)[number]);
  if (a.topic !== b.topic) {
    if (ta >= 0 && tb >= 0) return ta - tb;
    if (ta >= 0) return -1;
    if (tb >= 0) return 1;
    return a.topic.localeCompare(b.topic);
  }
  return a.order - b.order || a.id - b.id;
}

/** Every guide, drafts too (the owner's list on Coaches). */
export function listGuidesForOwner(): GuideView[] {
  return [...rows()].sort(byPlace).map(view);
}

/** The guides a coach sees: the published ones. */
export function listPublishedGuides(): GuideView[] {
  return rows().filter((g) => g.published).sort(byPlace).map(view);
}

/** What the editor sends. */
export type GuideFields = { title: string; topic: string; screens: string[]; video: string | null; seconds: number | null; steps: string[]; published: boolean; order: number };

// In a folder of their own, so a clip gets its poster as a chat video does (storage.ts posterKey wants three parts).
const isUploaded = (v: string) => /^\/uploads\/guides\/team\/[^/?#]+$/.test(v);
/** A video the guide may name: one of its own uploads, or an http(s) link. */
export function cleanGuideVideo(v: unknown): string | null {
  const s = String(v ?? "").trim().slice(0, MAX_VIDEO);
  if (!s) return null;
  if (isUploaded(s)) return s;
  return /^https?:\/\/\S+\.\S+/i.test(s) ? s : null;
}

/** The fields as they may be kept, or null when there is no title. */
export function cleanGuideFields(v: Partial<GuideFields>): GuideFields | null {
  const title = String(v.title ?? "").trim().replace(/\s+/g, " ").slice(0, MAX_TITLE);
  if (!title) return null;
  const topic = String(v.topic ?? "").trim().replace(/\s+/g, " ").slice(0, MAX_TOPIC) || GUIDE_TOPICS[0];
  // In the screens' own order (the rail's, then the client tabs'), whatever order they were picked in.
  const picked = new Set((Array.isArray(v.screens) ? v.screens : []).map(String));
  const screens = GUIDE_SCREENS.map((s) => s.key).filter((k) => picked.has(k));
  const seconds = v.seconds == null || !Number.isFinite(Number(v.seconds)) || Number(v.seconds) <= 0 ? null : Math.min(6 * 3600, Math.round(Number(v.seconds)));
  const steps = (Array.isArray(v.steps) ? v.steps : [])
    .map((s) => String(s ?? "").trim().replace(/\s+/g, " ").slice(0, MAX_STEP))
    .filter(Boolean)
    .slice(0, MAX_STEPS);
  const order = Number.isFinite(Number(v.order)) ? Math.max(0, Math.min(9999, Math.round(Number(v.order)))) : 0;
  return { title, topic, screens, video: cleanGuideVideo(v.video), seconds, steps, published: !!v.published, order };
}

export function getGuide(id: number): HelpGuide | null {
  return rows().find((g) => g.id === id) ?? null;
}

/** A new guide, or an existing one changed. Back with it and the upload it no longer names (to be deleted). */
export function saveGuide(id: number | null, fields: GuideFields): { guide: HelpGuide; dropped: string | null } | null {
  const now = new Date().toISOString();
  if (id == null) {
    const g: HelpGuide = { id: allocId("help_guides"), ...fields, created_at: now, updated_at: now };
    rows().push(g);
    persist();
    return { guide: g, dropped: null };
  }
  const g = getGuide(id);
  if (!g) return null;
  const dropped = g.video && g.video !== fields.video && isUploaded(g.video) ? g.video : null;
  Object.assign(g, fields, { updated_at: now });
  persist();
  return { guide: g, dropped };
}

/** A guide gone; back with its upload, if any, to be deleted. Null when there was no such guide. */
export function deleteGuide(id: number): { dropped: string | null } | null {
  const data = getData();
  const g = getGuide(id);
  if (!g) return null;
  data.help_guides = rows().filter((x) => x.id !== id);
  // Off every coach's watched list too.
  for (const u of data.users) {
    const w = u.coach_settings?.guides_watched;
    if (w?.includes(id)) u.coach_settings = { ...u.coach_settings, guides_watched: w.filter((x) => x !== id) };
  }
  persist();
  return { dropped: g.video && isUploaded(g.video) ? g.video : null };
}

/** Whether an upload is named by any guide still (so a dropped one is only deleted once nothing shows it). */
export function guideVideoInUse(path: string): boolean {
  return rows().some((g) => g.video === path);
}

/** The guides a coach has watched, by id. */
export function watchedGuides(coachId: number): number[] {
  const u = getData().users.find((x) => x.id === coachId && x.role === "coach");
  return u?.coach_settings?.guides_watched ?? [];
}

/** A guide watched by a coach (opened and played). Back with their watched list. */
export function markGuideWatched(coachId: number, guideId: number): number[] {
  const u = getData().users.find((x) => x.id === coachId && x.role === "coach");
  if (!u || !getGuide(guideId)) return watchedGuides(coachId);
  const had = u.coach_settings?.guides_watched ?? [];
  if (had.includes(guideId)) return had;
  const next = [...had, guideId];
  u.coach_settings = { ...(u.coach_settings ?? {}), guides_watched: next };
  persist();
  return next;
}
