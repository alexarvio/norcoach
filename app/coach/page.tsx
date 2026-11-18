import type { Metadata, Viewport } from "next";
import { requireCoach } from "../lib/auth";
import { getCoachProfile, getCoachSettings, localDateStr } from "../lib/queries";
import { isSupportCoach, listSupportThread } from "../lib/support";
import { loadPhoneCalendar } from "./calendar";
import { listPhoneVideos } from "../lib/coachPhone";
import { nativePushReady, pushPublicKey } from "../lib/push";
import { loadChatDock } from "../admin/redesign/loaders";
import { fetchChatDock } from "../lib/chat/rows";
import CoachApp from "./CoachApp";
import "./coach.css";

// The coach's phone (21 Oct, Alex: built from the mockup): answer every
// client's chat, reply to the videos they send from an exercise, and since
// 22 Oct the coach's Calendar. Phases, programmes and everything else stay
// on the laptop (/admin/redesign). The native app opens here when a coach
// signs in (NativeCoachRedirect); in a phone's browser it is just this address.
//   /coach              the chats
//   /coach?tab=videos   the videos
//   /coach?tab=calendar the calendar
//   /coach?c=ID         one client's chat
//   /coach?v=ID         one video, to review
export const dynamic = "force-dynamic";

// Its own manifest (public/coach.webmanifest): added to an iPhone's Home Screen it opens here, not on the client app,
// and an iPhone gets web push only from a Home Screen app.
export const metadata: Metadata = { title: "NORCOACH", manifest: "/coach.webmanifest" };
export const viewport: Viewport = { themeColor: "#F5F6F8" };

export default async function CoachPage() {
  const coach = await requireCoach();
  // The chat list first (Step 5, app/lib/chat/rows.ts).
  const dock = await fetchChatDock(coach.id, "page.coachPhone");
  const profile = getCoachProfile(coach.id);
  const local = coach.email.split("@")[0] ?? "";
  const name = profile?.display_name?.trim() || local.split(/[._-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ") || "Coach";
  // This week of the Calendar comes with the page, so its tab opens at once.
  const today = localDateStr();
  const monday = new Date(`${today}T12:00:00`);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  // Settings (17 Nov, Alex): the laptop's own record. The business as the rail names it; notifications as Settings,
  // Notifications keeps them; a deletion already asked of Norcoach support reads as asked.
  const settings = getCoachSettings(coach.id);
  const canAskSupport = isSupportCoach(coach.id);
  const deletionAsked = canAskSupport && listSupportThread(coach.id).some((m) => m.from === "coach" && m.text.trim() === "Please delete my account.");
  return (
    <CoachApp
      inbox={{ chats: loadChatDock(coach, dock), videos: listPhoneVideos(coach.id) }}
      calendar={loadPhoneCalendar(coach.id, localDateStr(monday), today)}
      today={today}
      coach={{
        id: coach.id,
        name,
        photoPath: profile?.avatar_path ?? null,
        business: settings.business?.business_name?.trim() ?? "",
        email: coach.email,
        notify: settings.notify ?? {},
        canAskSupport,
        deletionAsked,
      }}
      push={{ publicKey: pushPublicKey(), nativeReady: nativePushReady() }}
    />
  );
}
