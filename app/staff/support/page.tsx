import { requireStaff } from "../../lib/staff";
import { listSupportCoachIds, listSupportThreads } from "../../lib/support";
import { SupportInbox } from "./SupportInbox";

// Support on the staff admin (26 Nov, Alex; the staff spec, screen 3): every coach's thread, newest word first, each
// opening in place, and Message all coaches. Staff who may answer support only.
//   admin.norcoachapp.com/support
export const dynamic = "force-dynamic";

export default async function StaffSupportPage() {
  await requireStaff("support");
  return <SupportInbox initial={listSupportThreads()} coaches={listSupportCoachIds().length} />;
}
