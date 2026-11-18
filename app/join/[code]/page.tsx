import { joinStart } from "../start";

// A coach's own link (Settings, Profile, Your code: app.norcoachapp.com/join/finlay): the client sign-up with the code
// filled in on the coach step (18 Nov, Alex).
export const dynamic = "force-dynamic";

export default async function JoinWithCodePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  let raw = code ?? "";
  try {
    raw = decodeURIComponent(raw);
  } catch {}
  return joinStart(raw);
}
