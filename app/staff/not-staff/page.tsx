import { redirect } from "next/navigation";
import { getStaff, staffIdentity } from "../../lib/staff";
import { logoutAction } from "../../lib/auth-actions";

// Signed in, but not on Norcoach staff (26 Nov, Alex; the staff spec): nothing secret, the email they are signed in
// with and Sign out in words. Someone on staff who comes here goes home; nobody signed in goes to sign in.
export const dynamic = "force-dynamic";

export default async function NotStaffPage() {
  const who = await staffIdentity();
  if (!who) redirect("/login");
  const email = who.emails[0] ?? null;
  if (await getStaff()) redirect("/");
  return (
    <div className="stf-out">
      <div className="stf-out-card">
        <h1>Not on Norcoach staff</h1>
        {email && <p>{email}</p>}
        <form action={logoutAction}>
          <button type="submit" className="stf-act">
            Sign out
          </button>
        </form>
      </div>
    </div>
  );
}
