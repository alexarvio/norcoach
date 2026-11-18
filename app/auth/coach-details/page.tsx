import { redirect } from "next/navigation";

// "About you" is the first step of the coach's setup now (18 Nov, Alex: /auth/coach-setup).
export const dynamic = "force-dynamic";

export default function CoachDetailsPage() {
  redirect("/auth/coach-setup");
}
