import { notFound, redirect } from "next/navigation";
import { requireStaff, staffCan } from "../lib/staff";
import { loadStaffCoaches } from "../lib/staffCoaches";
import { viewsFor } from "./views";
import { CoachesList } from "./CoachesList";

// Coaches (26 Nov, Alex; the staff spec, screen 1; docs/boards/staff-admin-mockup.html "1 · Coaches"):
// admin.norcoachapp.com opens here. The figures across Norcoach, then every coach as a row, the newest joined first,
// one search over them. Someone on staff without See coaches lands on the first view they have. What coaches pay is
// only loaded for someone with See what coaches pay (lib/staffCoaches.ts).
export const dynamic = "force-dynamic";

export default async function StaffCoachesPage() {
  const m = await requireStaff();
  if (!staffCan(m, "coaches")) {
    const first = viewsFor(m).find((v) => v.key !== "coaches");
    if (first) redirect(first.href);
    notFound();
  }
  const board = await loadStaffCoaches(m);
  return <CoachesList figures={board.figures} rows={board.rows} money={staffCan(m, "billing_view")} />;
}
