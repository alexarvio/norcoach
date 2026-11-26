import { getStaff, staffCan } from "../../lib/staff";
import { getData } from "../../lib/db";
import { getCoachProfileView } from "../../lib/queries";
import { isSupportCoach, supportThreadView } from "../../lib/support";
import { Sep } from "../parts";
import { StaffThread } from "./StaffThread";
import "./support.css";

// A coach's Support part on their staff page (26 Nov, Alex: docs/boards/staff-admin-mockup.html, "2 · A coach"):
// `SUPPORT` in small caps, the open problems grey after the bar, then their thread in one hairline card with the reply
// line, Done and Send (StaffThread). An empty thread is the line alone: writing there is how staff send a coach a
// message. Only for staff who may answer support, and only for a coach a thread can be with (never the owner's own
// account or one still waiting for a yes): nothing at all otherwise.

export async function CoachSupport({ coachId }: { coachId: number }) {
  const staff = await getStaff();
  if (!staffCan(staff, "support") || !isSupportCoach(coachId)) return null;
  const lines = supportThreadView(coachId, "owner");
  const name = getCoachProfileView(coachId)?.displayName?.trim() || getData().users.find((u) => u.id === coachId)?.email || "Coach";
  const problems = lines.filter((l) => l.kind === "problem" && !l.done).length;
  return (
    <section>
      <div className="stf-lab">
        Support
        {problems > 0 && (
          <small>
            <Sep />
            {`${problems} problem${problems === 1 ? "" : "s"} open`}
          </small>
        )}
      </div>
      <div className="stf-card stf-sup-card">
        <StaffThread coachId={coachId} coachName={name} initial={lines} />
      </div>
    </section>
  );
}
