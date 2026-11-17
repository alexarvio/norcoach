import { redirect } from "next/navigation";

// Where a signed-up coach waited for the owner's approval, until 17 Nov (Alex: "I don't see why I have to accept
// them"). Nobody waits now: an old link or a screen that still sends a pending coach here goes on, and /auth/continue
// lets them in (letCoachIn).
export const dynamic = "force-dynamic";

export default function WaitingPage() {
  redirect("/auth/continue");
}
