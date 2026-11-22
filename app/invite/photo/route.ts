import { readInviteToken } from "../../lib/inviteToken";
import { getClient, getCoachProfileView } from "../../lib/queries";
import { keyOf, smallCopy } from "../../lib/storage";

// The coach's picture on their client's invite (22 Nov): /uploads serves a coach's files only to the coach and their
// clients, and the person invited is signed in as neither yet. Read by the link's own signed token (lib/inviteToken.ts),
// so only an invite link shows a picture, and only the coach of that client's, its small copy (480 wide), never the
// original. Under /invite, which the proxy lets through.
//   /invite/photo?c=12.ab34…&v=1700000000000
const notFound = () => new Response("Not found", { status: 404 });

export async function GET(request: Request) {
  const url = new URL(request.url);
  const clientId = readInviteToken(url.searchParams.get("c"));
  const client = clientId != null ? getClient(clientId) : null;
  const view = client?.coach_id != null ? getCoachProfileView(client.coach_id) : null;
  const key = view?.avatarPath ? keyOf(view.avatarPath) : null;
  if (!key || !key.startsWith("coaches/")) return notFound();
  // The version only as the picture's own stamp (digits), so no other value makes another copy.
  const v = url.searchParams.get("v");
  const small = await smallCopy(key, 480, v && /^\d{1,16}$/.test(v) ? v : null);
  return small ?? notFound();
}
