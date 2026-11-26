import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaff, staffCan } from "../../../lib/staff";
import { loadStaffCoach } from "../../../lib/staffCoaches";
import { dayMonth } from "../../../lib/dayMonth";
import { daysAgo, lastInWords, lengthSince } from "../../../lib/staffWords";
import { SepJoin, StaffFace } from "../../parts";
import { PlanAction, RemoveCoach } from "./CoachActs";
import { CoachSupport } from "../../support/CoachSupport";

// A coach (26 Nov, Alex; the staff spec, screen 2; docs/boards/staff-admin-mockup.html "2 · A coach"):
// `/coaches/<Norcode>`, or `/coaches/id-<id>` with no code. What we know of them as a customer and nothing about their
// clients but counts: the figures, Billing (See what coaches pay only) beside Account, then their Support thread
// (Support only). Make them pay / Make it free with Change a coach's billing, Remove with Remove a coach, each asking
// first.
export const dynamic = "force-dynamic";

export default async function StaffCoachPage({ params }: { params: Promise<{ key: string }> }) {
  const m = await requireStaff("coaches");
  const { key } = await params;
  const c = await loadStaffCoach(m, key);
  if (!c) notFound();
  const money = staffCan(m, "billing_view") ? c.billing : undefined;
  const last = lastInWords(c.account.lastInAt);
  const late = !!c.account.lastInAt && daysAgo(c.account.lastInAt) > 10;
  const dash = <span className="stf-dash">—</span>;

  return (
    <div className="stf-screen">
      <Link href="/" className="stf-back">
        ‹ Coaches
      </Link>
      <div className="stf-chead">
        <StaffFace name={c.name} photo={c.photo} big />
        <div>
          <h1>{c.name}</h1>
          <div className="stf-facts">
            <SepJoin parts={[c.business, c.country, c.norcode]} />
          </div>
        </div>
      </div>

      <div className="stf-card stf-figs" style={{ ["--stf-figs" as string]: money ? 4 : 3 }}>
        <div className="stf-fig">
          <small>Plan</small>
          <b>{c.plan.word}</b>
          <span>{c.planWhen ?? " "}</span>
        </div>
        {money && (
          <div className="stf-fig">
            <small>Pays</small>
            {money.pays?.amount ? (
              <>
                <b>{money.pays.amount}</b>
                <span>a month</span>
              </>
            ) : (
              <>
                <b>{dash}</b>
                <span>{money.pays?.trialEnds ? `Trial ends ${money.pays.trialEnds}` : " "}</span>
              </>
            )}
          </div>
        )}
        <div className="stf-fig">
          <small>With us</small>
          <b>{lengthSince(c.joinedAt)}</b>
          <span>Since {dayMonth(c.joinedAt)}</span>
        </div>
        <div className="stf-fig">
          <small>Clients</small>
          <b>{c.clients}</b>
          <span>{c.inApp} in the app</span>
        </div>
      </div>

      <div className="stf-two" style={money ? undefined : { gridTemplateColumns: "minmax(0, 1fr)" }}>
        {money && (
          <div>
            <div className="stf-lab">Billing</div>
            <div className="stf-card stf-rows">
              <div className="stf-kv">
                <span className="stf-kv-k">Plan</span>
                <span className="stf-kv-v">
                  <b>{money.planLine}</b>
                </span>
                {staffCan(m, "billing_change") && !c.ownerAccount && <PlanAction coachId={c.id} name={c.name} first={c.first} pays={money.required} />}
              </div>
              <div className="stf-kv">
                <span className="stf-kv-k">Trial</span>
                <span className="stf-kv-v">{money.trial.used ? <SepJoin parts={["Used", money.trial.from && money.trial.to ? `${money.trial.from} – ${money.trial.to}` : null]} /> : "Not used"}</span>
              </div>
              <div className="stf-kv">
                <span className="stf-kv-k">Stripe</span>
                <span className="stf-kv-v">{money.stripe.status ?? dash}</span>
                {money.stripe.link && (
                  <a className="stf-act" href={money.stripe.link} target="_blank" rel="noopener noreferrer">
                    Open in Stripe
                  </a>
                )}
              </div>
            </div>
          </div>
        )}
        <div>
          <div className="stf-lab">Account</div>
          <div className="stf-card stf-rows">
            <div className="stf-kv">
              <span className="stf-kv-k">Email</span>
              <span className="stf-kv-v">{c.account.email}</span>
            </div>
            <div className="stf-kv">
              <span className="stf-kv-k">Signs in with</span>
              <span className="stf-kv-v">{c.account.signIn.length ? <SepJoin parts={c.account.signIn} /> : dash}</span>
            </div>
            <div className="stf-kv">
              <span className="stf-kv-k">Last in</span>
              <span className={`stf-kv-v${late ? " stf-rust" : ""}`}>{last ?? dash}</span>
            </div>
            <div className="stf-kv">
              <span className="stf-kv-k">Last region</span>
              <span className="stf-kv-v">{c.account.region ?? dash}</span>
              {staffCan(m, "remove_coach") && c.removable && <RemoveCoach coachId={c.id} name={c.name} facts={[c.business, c.account.email]} />}
            </div>
          </div>
        </div>
      </div>

      {staffCan(m, "support") && <CoachSupport coachId={c.id} />}
    </div>
  );
}
