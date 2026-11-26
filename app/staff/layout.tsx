import type { Metadata } from "next";
import { getStaff } from "../lib/staff";
import { staffRailCounts } from "../lib/staffRail";
import { StaffRail } from "./StaffRail";
import { viewsFor } from "./views";
// The coach admin's shared parts the staff screens reuse as they are (never changed for them): the `.dlh` pop-up and
// its confirm anatomy, the drawn bar (`.rd-sep`), the shared fold (`.rd-rowfold`) and the search pill (`.rd-search`).
import "../components/ui/ui.css";
import "../admin/redesign/training/trn.css";
import "../admin/redesign/training/draft.css";
import "./staff.css";

// The staff admin's frame (26 Nov, Alex; app/lib/staff.ts): the rail and the page. Only reached on the staff host
// (proxy.ts rewrites admin.norcoachapp.com's pages here; /staff answers 404 anywhere else). Every page under it checks
// who is asking itself (requireStaff); this frame draws the rail only for someone on staff, and the bare page (the
// not-staff page, a redirect on its way) for anyone else.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "NORCOACH STAFF", robots: { index: false, follow: false } };

export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  const m = await getStaff();
  if (!m) return <div className="stf stf-bare">{children}</div>;
  return (
    <div className="stf">
      <StaffRail name={m.name} email={m.email} role={m.role} views={viewsFor(m)} counts={staffRailCounts(m)} />
      <main className="stf-main">{children}</main>
    </div>
  );
}
