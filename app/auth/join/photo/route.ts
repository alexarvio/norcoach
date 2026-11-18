import { auth } from "@clerk/nextjs/server";
import { clerkOn } from "../../../lib/clerk";
import { keyOf, smallCopy } from "../../../lib/storage";
import { coachPhotoByCode, tooManyTries } from "../../../lib/joinRequests";

// The coach's picture for someone joining with their code (18 Nov, Alex: "it should load up the coach, and then we see
// the profile picture"): /uploads serves a coach's files only to the coach and their clients, and the person joining is
// neither yet. Only for someone signed in (they have made their account by the time they type a code), counted with the
// code lookups so codes can't be guessed through it; read by the code, so only a code that is a coach's shows a picture,
// and only its small copy (480 wide), never the original. Under /auth, which the proxy lets through.
//   /auth/join/photo?code=FINLAY
const notFound = () => new Response("Not found", { status: 404 });

export async function GET(request: Request) {
  if (!clerkOn()) return notFound();
  const { userId } = await auth();
  if (!userId || tooManyTries(userId)) return notFound();
  const url = new URL(request.url);
  const code = url.searchParams.get("code") ?? "";
  const photo = coachPhotoByCode(code);
  const key = photo ? keyOf(photo) : null;
  if (!key || !key.startsWith("coaches/")) return notFound();

  // The version only as the picture's own stamp (digits), so no other value makes another copy.
  const v = url.searchParams.get("v");
  const small = await smallCopy(key, 480, v && /^\d{1,16}$/.test(v) ? v : null);
  // No small copy (not a picture sharp reads): nothing, and the initial shows instead.
  return small ?? notFound();
}
