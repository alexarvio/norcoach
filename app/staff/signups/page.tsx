import { requireStaff, staffSettings } from "../../lib/staff";
import { listCoachApplications, listWaitingCoaches } from "../../lib/staffSignups";
import { SignupsScreen } from "./SignupsScreen";

// Sign-ups on the staff admin (26 Nov, Alex; the staff spec, screen 5): Accept new coaches by hand (an owner's switch),
// the coach accounts waiting for a yes, and the website's applications. Staff who may let new coaches in only.
//   admin.norcoachapp.com/signups
export const dynamic = "force-dynamic";

export default async function StaffSignupsPage() {
  const m = await requireStaff("signups");
  return <SignupsScreen approve={staffSettings().approveCoaches} canSwitch={m.role === "owner"} waiting={listWaitingCoaches()} applications={listCoachApplications()} />;
}
