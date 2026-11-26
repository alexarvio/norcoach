"use server";

import { revalidatePath } from "next/cache";
import { staffForAction, staffFirst } from "../../lib/staff";
import { once, onceKeyOf } from "../../lib/once";
import {
  addSupportMessage,
  isSupportCoach,
  listSupportCoachIds,
  listSupportThreads,
  markSupportProblemDone,
  markSupportSeen,
  supportThreadView,
  type SupportInboxRow,
  type SupportLine,
} from "../../lib/support";

// The staff admin's Support (26 Nov, Alex; the staff spec, screens 2 and 3): the coaches' threads as the owner reads
// them on the coach admin's Coaches (lib/support.ts, the one `seen_by_owner`), answered by anyone on staff who may
// answer support. Every one checks who is asking itself (staffForAction("support")) and answers `{ error }` rather than
// throwing. A line staff write carries who wrote it (`by`, their name), shown on the staff side only; the coach reads it
// as Norcoach and gets the same unread dot as an owner's reply.

type Fail = { error: string };
export type StaffThreadResult = { lines: SupportLine[]; error?: undefined } | Fail;

const coachIdOf = (v: unknown) => {
  const id = Number(v);
  return Number.isInteger(id) && id > 0 ? id : null;
};

/** What a staff line says who wrote it: the name staff go by, else the email before the @. */
const writer = (m: { name: string | null; email: string }) => (m.name?.trim() || staffFirst(m)).slice(0, 80);

/** Every coach's thread, newest first. */
export async function loadStaffInboxAction(): Promise<{ rows: SupportInboxRow[]; error?: undefined } | Fail> {
  const who = await staffForAction("support");
  if (!who.staff) return { error: who.error };
  return { rows: listSupportThreads() };
}

/** One coach's thread as Norcoach reads it. */
export async function loadStaffThreadAction(coachId: number): Promise<StaffThreadResult> {
  const who = await staffForAction("support");
  if (!who.staff) return { error: who.error };
  const id = coachIdOf(coachId);
  if (!id || !isSupportCoach(id)) return { error: "No such coach" };
  return { lines: supportThreadView(id, "owner") };
}

/** A thread opened on staff: the coach's lines are read (for every owner and staff member: one read mark). */
export async function markStaffThreadSeenAction(coachId: number): Promise<{ error?: string }> {
  const who = await staffForAction("support");
  if (!who.staff) return { error: who.error };
  const id = coachIdOf(coachId);
  if (!id) return { error: "No such coach" };
  if (markSupportSeen(id, "owner")) revalidatePath("/staff", "layout");
  return {};
}

/** Staff write to a coach: an answer, or the first word in an empty thread. Back with the thread as it now stands. */
export async function replyStaffSupportAction(coachId: number, text: string, onceKey?: string): Promise<StaffThreadResult> {
  const who = await staffForAction("support");
  if (!who.staff) return { error: who.error };
  const id = coachIdOf(coachId);
  const words = String(text ?? "").trim();
  if (!id || !isSupportCoach(id)) return { error: "No such coach" };
  if (!words) return { error: "Nothing to send" };
  // Taken once (lib/once.ts): sent again after a dropped signal, it posts no second line.
  await once(`replyStaffSupportAction:${id}`, onceKeyOf(onceKey), () => {
    // Answering is reading what came before.
    markSupportSeen(id, "owner");
    addSupportMessage({ coachId: id, from: "owner", kind: "message", text: words, by: writer(who.staff) });
  });
  revalidatePath("/staff", "layout");
  return { lines: supportThreadView(id, "owner") };
}

/** A problem closed. Back with its thread. */
export async function markStaffProblemDoneAction(messageId: number): Promise<StaffThreadResult> {
  const who = await staffForAction("support");
  if (!who.staff) return { error: who.error };
  const m = markSupportProblemDone(Number(messageId));
  if (!m) return { error: "No such problem" };
  revalidatePath("/staff", "layout");
  return { lines: supportThreadView(m.coach_id, "owner") };
}

/** Message all coaches: the same words into every coach's thread (listSupportCoachIds). Back with how many it went to. */
export async function messageAllCoachesAction(text: string, onceKey?: string): Promise<{ sent: number; error?: undefined } | Fail> {
  const who = await staffForAction("support");
  if (!who.staff) return { error: who.error };
  const words = String(text ?? "").trim();
  if (!words) return { error: "Nothing to send" };
  const ids = listSupportCoachIds();
  if (!ids.length) return { error: "No coaches yet" };
  const by = writer(who.staff);
  const sent = await once(`messageAllCoachesAction`, onceKeyOf(onceKey), () => {
    for (const id of ids) addSupportMessage({ coachId: id, from: "owner", kind: "message", text: words, by });
    return ids.length;
  });
  revalidatePath("/staff", "layout");
  return { sent };
}
