import { getData } from "./db";
import { getCoachAvatarPath, getCoachDisplayName, listChatMessages } from "./queries";
import type { MediaReview, ThreadItem } from "../admin/redesign/media-review/MediaReviewModal";

// The coach's phone (21 Oct, Alex: answer messages and reply to videos, the
// rest stays on the laptop). The chats come from the admin's own loader
// (loadChatDock); this file reads the videos: every photo or video a client
// sent from an exercise, waiting for the coach or already answered, and one
// of them as the review screen draws it, the same MediaReview the laptop's
// review modal takes.

export type PhoneVideo = {
  id: number;
  clientId: number;
  client: string;
  avatarPath: string | null;
  exercise: string;
  /** "Upper — push", or "Session 2" when it has no name. */
  session: string;
  /** "Week 3" inside its programme. */
  week: string | null;
  media: "video" | "photo";
  /** The file, for its thumbnail on the list (25 Oct, Alex). */
  path: string;
  /** The coach asked for it (else the client sent it on their own). */
  asked: boolean;
  sentAt: number;
  repliedAt: number | null;
  /** How the coach answered: a recorded form review, words, or marked done without a reply (25 Oct). */
  reply: "review" | "text" | "done" | null;
};
export type PhoneVideos = { waiting: PhoneVideo[]; replied: PhoneVideo[] };
/** The review screen: the laptop's MediaReview, with what the coach asked for and when they answered. */
export type PhoneReview = MediaReview & {
  askNote: string | null;
  repliedAt: number | null;
  clientId: number;
  /** The coach's own face, beside their ask and their earlier words (17 Nov, Alex: docs/boards/review-align-mockup.html). */
  coach?: { name: string; photoPath: string | null };
};

type Data = ReturnType<typeof getData>;
type Request = Data["video_requests"][number];

const ms = (s: string | null | undefined) => {
  if (!s) return 0;
  const t = new Date(s.includes("T") ? s : s.replace(" ", "T")).getTime();
  return Number.isFinite(t) ? t : 0;
};

/** The exercise, its session and its week, as the Feed names them. */
function placeOf(data: Data, v: Request) {
  const a = data.workout_assignments.find((w) => w.id === v.assignment_id);
  const d = a ? data.program_days.find((x) => x.id === a.program_day_id) : undefined;
  const name = a ? data.exercises.find((e) => e.id === a.exercise_id)?.name ?? a.custom_name ?? "Exercise" : "Exercise";
  const session = d ? (d.free && d.copy_of == null ? "Rogue session" : d.label?.trim() || `Session ${d.day_of_week}`) : "Session";
  const program = d ? data.training_programs.find((p) => p.client_id === d.client_id && d.week_number >= p.start_week && d.week_number < p.start_week + p.total_weeks) : undefined;
  const weekNo = d ? (program ? d.week_number - program.start_week + 1 : d.week_number) : null;
  return { a, d, exercise: v.about === "swap" ? `Swap for ${name}` : name, session, weekNo };
}

/** Every photo or video in from this coach's clients: the ones waiting, longest wait first, then the last 20 answered. */
export function listPhoneVideos(coachId: number): PhoneVideos {
  const data = getData();
  const clients = new Map(data.clients.filter((c) => c.coach_id === coachId).map((c) => [c.id, c] as const));
  const rows: PhoneVideo[] = [];
  for (const v of data.video_requests ?? []) {
    const c = clients.get(v.client_id);
    if (!c || !v.file_path || !v.submitted_at) continue;
    const p = placeOf(data, v);
    rows.push({
      id: v.id,
      clientId: c.id,
      client: c.name ?? "Client",
      avatarPath: c.avatar_path ?? null,
      exercise: p.exercise,
      session: p.session,
      week: p.weekNo != null ? `Week ${p.weekNo}` : null,
      media: v.media === "photo" ? "photo" : "video",
      path: v.file_path,
      asked: !v.from_client,
      sentAt: ms(v.submitted_at),
      repliedAt: v.replied_at ? ms(v.replied_at) : v.closed_at ? ms(v.closed_at) : null,
      // A written reply on a photo (16 Nov) carries the photo back as its file: it is the words, not a recording.
      reply: v.reply_file_path && v.reply_media !== "photo" ? "review" : v.reply_note?.trim() ? "text" : v.closed_at ? "done" : null,
    });
  }
  return {
    waiting: rows.filter((r) => r.repliedAt == null).sort((x, y) => x.sentAt - y.sentAt),
    replied: rows
      .filter((r) => r.repliedAt != null)
      .sort((x, y) => (y.repliedAt ?? 0) - (x.repliedAt ?? 0))
      .slice(0, 20),
  };
}

/** One photo or video as the review screen draws it; null when it is gone or has no file. */
export function phoneReview(requestId: number): PhoneReview | null {
  const data = getData();
  const v = (data.video_requests ?? []).find((x) => x.id === requestId);
  if (!v || !v.file_path) return null;
  const c = data.clients.find((x) => x.id === v.client_id);
  const p = placeOf(data, v);
  // The whole conversation about the clip (17 Nov, Alex: docs/boards/review-align-mockup.html), as the laptop's review
  // reads it: what both sides said in the chat about the exercise, oldest first, then the reply on the clip itself. A
  // coach's video in it is an earlier review, to play on the stage; a coach's picture a photo sent back.
  const thread: ThreadItem[] = [];
  const replyNote = v.reply_note?.trim() || "";
  const clientNote = v.client_note?.trim() || "";
  const askNote = !v.from_client ? v.note?.trim() || "" : "";
  for (const m of listChatMessages(v.client_id)) {
    if (m.link?.kind !== "exercise" || m.link.assignmentId !== v.assignment_id) continue;
    const mine = m.sender === "coach";
    const at = ms(m.created_at);
    const text = m.text?.trim() || "";
    // The clip itself and the reply on it are drawn from the request; the ask and the client's note have their own place.
    if (m.media_path && (m.media_path === v.file_path || m.media_path === v.reply_file_path)) continue;
    if (!m.media_path && mine && (text === replyNote || text === askNote)) continue;
    if (!m.media_path && !mine && text === clientNote) continue;
    if (mine && m.media_path && (m.media_type === "video" || m.media_type === "image")) {
      thread.push({ id: `c${m.id}`, kind: "review", url: m.media_path, durationMs: null, annotations: null, message: text || null, at, photo: m.media_type === "image" });
      continue;
    }
    const words = text || (m.media_path ? (m.media_type === "image" ? "A photo" : m.media_type === "video" ? "A video" : m.media_type === "audio" ? "A voice message" : "A file") : "");
    if (words) thread.push({ id: `c${m.id}`, kind: "text", mine, text: words, at });
  }
  // The reply on the clip: a recording, or the photo sent back with the words (16 Nov; it was read as words alone).
  if (v.reply_file_path) thread.push({ id: `r${v.id}`, kind: "review", url: v.reply_file_path, durationMs: v.reply_duration_ms ?? null, annotations: v.reply_annotations ?? null, message: replyNote || null, at: ms(v.replied_at), photo: v.reply_media === "photo" });
  else if (replyNote) thread.push({ id: `n${v.id}`, kind: "text", mine: true, text: replyNote, at: ms(v.replied_at) });
  thread.sort((x, y) => x.at - y.at);
  const name = c?.name ?? "Client";
  return {
    requestId: v.id,
    clientId: v.client_id,
    unseen: !v.seen_at,
    client: { firstName: name.split(/\s+/)[0] || name, name, avatarPath: c?.avatar_path ?? null },
    exercise: { name: p.exercise, session: p.session, week: p.weekNo ?? 0, day: p.d?.day_of_week ?? 1 },
    requested: !v.from_client,
    media: [{ kind: v.media === "photo" ? "photo" : "video", url: v.file_path }],
    sentAt: v.submitted_at ?? null,
    // No session, week, day or sets on the review (17 Nov, Alex): the exercise's name alone.
    sets: [],
    clientMessage: clientNote ? { text: clientNote, at: v.submitted_at ?? null } : null,
    thread,
    askNote: askNote || null,
    repliedAt: v.replied_at ? ms(v.replied_at) : null,
    // The coach's face and name as the laptop's review reads them (mediaReviewClientAction).
    coach: { name: getCoachDisplayName(v.client_id), photoPath: getCoachAvatarPath(v.client_id) },
  };
}
