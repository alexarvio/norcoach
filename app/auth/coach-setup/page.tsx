import { redirect } from "next/navigation";
import { currentUser } from "@clerk/nextjs/server";
import { clerkIdentity, clerkOn } from "../../lib/clerk";
import { getSessionUser } from "../../lib/auth";
import { getData } from "../../lib/db";
import { billingAccess } from "../../lib/billing";
import { isOwner } from "../../lib/auth";
import { latestRequestFor } from "../../lib/joinRequests";
import { COUNTRIES } from "../../lib/countries";
import { getCoachProfile, getCoachSettings } from "../../lib/queries";
import CoachSetupFlow from "../../login/CoachSetupFlow";
import "../../components/ui/ui.css";

// The coach's sign-up after the email (18 Nov, Alex: docs/boards/coach-flow-mockup.html): About you, Your business,
// You're set (CoachSetupFlow). For someone signed in to Clerk with no account here (About you makes it), or a coach who
// hasn't finished (users.onboarding: on from Your business); anyone else on to their own screens.
export const dynamic = "force-dynamic";

export default async function CoachSetupPage() {
  const countries = COUNTRIES.map((c) => ({ code: c.code, name: c.name, currency: c.currency, tax: c.tax, rate: c.rate }));
  const me = await getSessionUser();
  if (me) {
    if (me.role !== "coach") redirect("/auth/continue");
    const row = getData().users.find((u) => u.id === me.id);
    if (!row?.onboarding) redirect("/clients");
    if (billingAccess(me.id, isOwner(me)).state === "subscribe") redirect("/auth/subscribe");
    const profile = getCoachProfile(me.id);
    const settings = getCoachSettings(me.id);
    const [first = "", ...rest] = (profile?.display_name ?? "").trim().split(/\s+/);
    return (
      <CoachSetupFlow
        data={{
          start: "business",
          email: me.email,
          first,
          last: rest.join(" "),
          birthdate: settings.birthdate ?? "",
          title: profile?.title ?? "",
          photo: profile?.avatar_path ?? null,
          business: settings.business?.business_name ?? "",
          countryCode: settings.business?.country_code ?? "",
          countries,
        }}
      />
    );
  }
  if (!clerkOn()) redirect("/login");
  const who = await clerkIdentity();
  const email = who?.emails[0];
  if (!who || !email) redirect("/login");
  const asked = latestRequestFor(who.userId);
  if (asked?.status === "open" || asked?.status === "declined") redirect("/auth/join");
  const clerk = await currentUser().catch(() => null);
  return (
    <CoachSetupFlow
      data={{ start: "about", email, first: clerk?.firstName ?? "", last: clerk?.lastName ?? "", birthdate: "", title: "", photo: null, business: "", countryCode: "", countries }}
    />
  );
}
