import { NextResponse } from "next/server";
import { chatUser, coachChatOf } from "../../../lib/chatAccess";
import { chatChanged } from "../../../lib/chatBus";
import { markClientEventsSeen } from "../../../lib/queries";

// The coach has read a client's chat (17 Nov): markSeenAction's chat read as a plain POST, for the coach's phone, so it
// never sits in front of a send and never draws the whole /coach page again (an action that revalidates sends the
// page back with it). Open while read-only, as the action is. Its unread mark goes on every open screen of it.
//   POST ?c=ID
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const user = await chatUser(request);
  const id = user ? coachChatOf(user, Number(new URL(request.url).searchParams.get("c")), true) : null;
  if (id == null) return NextResponse.json({ ok: false }, { status: 403 });
  markClientEventsSeen(id, { tab: "messages" });
  chatChanged(id);
  return NextResponse.json({ ok: true });
}
