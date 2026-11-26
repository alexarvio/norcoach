import "server-only";
import { clerkClient } from "@clerk/nextjs/server";
import { clerkOn, clerkUserIdFromRequest } from "./clerk";
import { staffByEmail, staffCan, type StaffPerm } from "./staff";

// A guide's clip sent ahead to /api/upload by someone on Norcoach's staff with no coach account (26 Nov, Alex; the staff
// admin's Guides). An upload is filed under who sent it (lib/streamUpload.ts, a number); staff without a users row are
// filed under a negative number of their own, from their email, which no users row ever has. /api/upload runs outside
// the proxy, so Clerk's auth() can't: who it is comes from the request itself, as getRequestUser reads it.

/** The number a staff member's uploads are filed under: negative, the same for the same email, never a users row's id. */
export function staffUploadId(email: string): number {
  let h = 2166136261;
  for (const ch of email.trim().toLowerCase()) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return -((h % 1_000_000_000) + 1);
}

/** Who on staff sent a request, with this permission, by Clerk's session on the request; null for anyone else. */
export async function staffUploaderFromRequest(request: Request, perm: StaffPerm): Promise<number | null> {
  if (!clerkOn()) return null;
  try {
    const clerkId = await clerkUserIdFromRequest(request);
    if (!clerkId) return null;
    const u = await (await clerkClient()).users.getUser(clerkId);
    const emails = u.emailAddresses.filter((e) => e.verification?.status === "verified").map((e) => e.emailAddress.trim().toLowerCase());
    const m = emails.map((e) => staffByEmail(e)).find((x) => staffCan(x, perm));
    return m ? staffUploadId(m.email) : null;
  } catch {
    return null;
  }
}
