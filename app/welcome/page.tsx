import { redirect } from "next/navigation";

// The welcome steps are the coach's setup now (18 Nov, Alex: /auth/coach-setup, one flow from About you to You're set).
export const dynamic = "force-dynamic";

export default function WelcomePage() {
  redirect("/auth/coach-setup");
}
