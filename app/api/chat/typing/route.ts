import { NextResponse } from "next/server";
import { chatClientOf, chatUser, coachChatOf } from "../../../lib/chatAccess";
import { chatTyping } from "../../../lib/chatBus";

// Typing… (27 Oct, Alex), from every chat (17 Nov): chatTypingAction as a plain POST, so the signal sent as the words
// are typed never sits in front of the send that follows them. Nothing is saved. A coach previewing the app is the
// coach; the chat stays open while read-only.
//   POST ?c=ID
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const user = await chatUser(request);
  if (!user) return new Response(null, { status: 204 });
  const asked = Number(new URL(request.url).searchParams.get("c"));
  const id = user.role === "coach" ? coachChatOf(user, asked, true) : chatClientOf(user, asked);
  if (id != null) chatTyping(id, user.role === "coach" ? "coach" : "client");
  return NextResponse.json({ ok: true });
}
