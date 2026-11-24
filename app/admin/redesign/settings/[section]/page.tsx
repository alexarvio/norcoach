import { notFound, redirect } from "next/navigation";
import { isSettingsAddress, settingsHref } from "../../settingsNav";

// Settings was a page per section; it is one page now (23 Oct, Alex), and the old addresses go to their section on
// it, ?stripe= (back from Stripe) and ?coachId= kept. A key merged into another section on 23 Nov (billing,
// notifications, data) keeps its #key, which the page lands inside the section that holds it (SETTINGS_ALIASES).
//   /settings/account | business | invoicing | privacy → /settings#<section>
export const dynamic = "force-dynamic";

export default async function SettingsSectionPage({ params, searchParams }: { params: Promise<{ section: string }>; searchParams: Promise<{ stripe?: string; coachId?: string }> }) {
  const { section } = await params;
  const { stripe, coachId } = await searchParams;
  if (!isSettingsAddress(section)) notFound();
  redirect(settingsHref(section, { coachId, stripe }));
}
