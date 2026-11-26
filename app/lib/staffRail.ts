import "server-only";
import { supportUnreadForOwner } from "./support";
import { pendingCoachSignupsCount } from "./staffSignups";
import { staffCan, type StaffMember } from "./staffTypes";

// The staff rail's counts (26 Nov, Alex; app/staff/layout.tsx): Sign-ups waiting and Support's unread, each only for
// someone who may see that screen. One function, read by the layout on every request; a screen that changes a count
// (an answer, an Accept) calls router.refresh() or revalidatePath("/staff", "layout") and the rail reads it again.

export type StaffRailCounts = { signups: number; support: number };

export function staffRailCounts(m: StaffMember): StaffRailCounts {
  return {
    signups: staffCan(m, "signups") ? pendingCoachSignupsCount() : 0,
    // The coaches' lines nobody on staff has read yet (support.ts keeps one read state, `seen_by_owner`).
    support: staffCan(m, "support") ? supportUnreadForOwner() : 0,
  };
}
