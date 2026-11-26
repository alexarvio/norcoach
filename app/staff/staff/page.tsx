import { listStaff, requireStaffOwner } from "../../lib/staff";
import { StaffScreen } from "./StaffScreen";

// Staff (26 Nov, Alex: docs/boards/staff-admin-mockup.html, "3 · Staff"): who can get into admin.norcoachapp.com and
// what each may do. Owners only; admin.norcoachapp.com/staff.
export const dynamic = "force-dynamic";

export default async function StaffStaffPage() {
  const me = await requireStaffOwner();
  return <StaffScreen rows={listStaff(me)} />;
}
