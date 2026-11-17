import { NextResponse } from "next/server";
import { chatClientOf, chatUser } from "../../../lib/chatAccess";
import { sendChatAs } from "../../../lib/chatSend";

// A message sent to a chat (17 Nov, Alex: a message on the coach's phone "locked into Sending for a long while"): the
// body of sendChatMessageAction (lib/chatSend.ts) as a plain POST, so a send never queues behind the page's other
// server actions (a thread read, a read mark, Typing…) or waits on a page drawn again. The form is the action's own
// (clientId, text, upload, poster, link, replyTo, nonce); its one-time key still makes a retry post it once. Every open
// screen of the chat hears of it through the chat's line (chatBus.ts), as before; no page is read again here.
// { ok: true } once the server has it, whether posted now or already (a repeat); anything else is Not sent.
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
  const user = await chatUser(request);
  if (!user) return NextResponse.json({ ok: false }, { status: 401, headers: NO_STORE });
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ ok: false }, { status: 400, headers: NO_STORE });
  }
  const clientId = chatClientOf(user, Number(form.get("clientId")));
  if (clientId == null) return NextResponse.json({ ok: false }, { status: 403, headers: NO_STORE });
  try {
    await sendChatAs(user, clientId, form);
  } catch (error) {
    console.error("[chat] send failed:", error);
    return NextResponse.json({ ok: false }, { status: 500, headers: NO_STORE });
  }
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
