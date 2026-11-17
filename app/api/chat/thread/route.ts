import { NextResponse } from "next/server";
import { chatClientOf, coachChatOf, chatUser } from "../../../lib/chatAccess";
import { chatCurrent, chatRev, timedChatRead } from "../../../lib/chatBus";
import { chatThreadViews } from "../../../lib/queries";
import { loadMessages } from "../../../admin/redesign/loaders";
import { noteCoachReading } from "../../../lib/coachPush";

// One chat's thread (17 Nov, Alex: the coach's phone chat "didn't load for a few seconds, maybe 10"): what every chat
// asks for while it shows, as a plain GET, so it never waits behind the page's server actions (Next runs those one at
// a time) and they never wait behind it. The same reads and checks as the actions it stands in for:
//   ?c=ID&for=coach   the coach's side (loadMessages; coachThreadAction, chatDraftThreadAction), the phone and the laptop
//   ?c=ID&for=app     the client app's (chatThreadViews; chatThreadAction), a client's own or a coach previewing it
//   &rev=R            the revision the screen holds (chatBus.ts): unchanged, 204 and nothing sent
//   &from=S           which screen asked (phone, laptop, prefetch), for /api/timing
//   &reading=1        the coach's phone has this chat on screen, so its pushes stay quiet (coachPush.ts)
export const dynamic = "force-dynamic";

const SCREENS = new Set(["phone", "laptop", "prefetch"]);
const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const user = await chatUser(request);
  if (!user) return NextResponse.json(null, { status: 401, headers: NO_STORE });
  const q = new URL(request.url).searchParams;
  const asked = Number(q.get("c"));
  const known = q.get("rev");
  if (q.get("for") === "coach") {
    const id = coachChatOf(user, asked);
    if (id == null) return NextResponse.json(null, { status: 403, headers: NO_STORE });
    if (q.get("reading") === "1") noteCoachReading(user.id, id);
    // Nothing changed since the screen's copy (27 Oct): nothing to send.
    if (chatCurrent(id, known)) return new Response(null, { status: 204, headers: NO_STORE });
    const from = q.get("from") ?? "";
    // The phone never links a message, so its reads skip the link targets (every session and exercise of the plan).
    const phone = from === "phone" || from === "prefetch";
    return NextResponse.json(timedChatRead(`chat · ${SCREENS.has(from) ? from : "coach"}`, () => loadMessages(id, { targets: !phone })), { headers: NO_STORE });
  }
  const id = chatClientOf(user, asked);
  if (id == null) return NextResponse.json({ rev: "", messages: [] }, { headers: NO_STORE });
  if (chatCurrent(id, known)) return new Response(null, { status: 204, headers: NO_STORE });
  return NextResponse.json({ rev: chatRev(id), messages: timedChatRead("chat · client", () => chatThreadViews(id)) }, { headers: NO_STORE });
}
