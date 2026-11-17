import { redirect } from "next/navigation";
import { getData } from "../../lib/db";
import { clerkOn } from "../../lib/clerk";
import { getSessionUser } from "../../lib/auth";
import { WaitingScreen } from "../../login/SignInScreens";

// A coach who signed up, until the owner lets them in.
export const dynamic = "force-dynamic";

export default async function WaitingPage() {
  if (!clerkOn()) redirect("/login");
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (!user.pending) redirect("/auth/continue");
  const me = getData().users.find((u) => u.id === user.id);
  const name = me?.pending?.name?.split(" ")[0] || "";
  return <WaitingScreen name={name} email={me?.email ?? null} signOut={<a href="/auth/signout">Sign out</a>} />;
}
