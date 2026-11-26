import { requireStaff } from "../../lib/staff";
import { listGuidesForOwner } from "../../lib/guides";
import GuidesSection from "../../admin/redesign/coaches/GuidesSection";
import "../../components/ui/ui.css";
import "../../admin/redesign/measurements/measurements.css";
import "../../admin/redesign/coaches/coaches.css";
import "./guides.css";

// Guides on the staff admin (26 Nov, Alex; the staff spec, screen 4): the help guides every coach sees from the ? on
// their admin, made and changed here with the coach admin's own editor (GuidesSection; lib/guidesActions.ts lets staff
// who make guides in as well as the owner). Drafts too. Staff who may make guides only.
//   admin.norcoachapp.com/guides
export const dynamic = "force-dynamic";

export default async function StaffGuidesPage() {
  await requireStaff("guides");
  return (
    <div className="rd trn rls rco stf-screen stf-guides">
      <GuidesSection initial={listGuidesForOwner()} />
    </div>
  );
}
