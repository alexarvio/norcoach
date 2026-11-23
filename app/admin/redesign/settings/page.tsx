import { isOwner, requireCoach } from "../../../lib/auth";
import { clerkOn } from "../../../lib/clerk";
import { getCoachProfile, getCoachProfileView, getCoachSettings, listCoachEmails } from "../../../lib/queries";
import { fetchChatDock } from "../../../lib/chat/rows";
import { getData } from "../../../lib/db";
import { COUNTRIES, countryOf, invoicingFor } from "../../../lib/countries";
import { nameParts } from "../../../lib/coachNames";
import { LEGAL } from "../../../lib/legal";
import { paymentsState, refreshCoachStripe, type PaymentsState } from "../../../lib/payments";
import { dayMonth } from "../../../lib/dayMonth";
import { loadSupportSection } from "../../../lib/support";
import { startTiming } from "../../../lib/timing";
import { loadChatDock } from "../loaders";
import ChatDock from "../ChatDock";
import "../messages/messages.css";
import { AccountSettings, BusinessSettings, InvoicingSettings, PrivacySettings } from "./SettingsForms";
import { coachBrandInline } from "../../../lib/brandMark";
import { coachCardPictures, coachCardsDefault } from "../../../lib/coachCards";
import BrandingSection from "./BrandingSection";
import { PHASE_COVERS } from "../../../lib/phaseCovers";
import { BRAND_SWATCHES } from "../../../lib/brandColour";
import SupportSection from "./SupportSection";
import BillingSettings from "./BillingSettings";
import { billingView } from "../../../lib/billing";
import PlansSettings from "./PlansSettings";
import { listCoachPlans, planClientCounts } from "../../../lib/coachPlans";
import { DataSettings, NotificationsSettings, PreferencesSettings } from "./MoreSettings";
import { loadAccountSecurity } from "../../../lib/accountSecurity";
import { passwordsOnHint } from "../../../lib/clerkPasswords";
import { ensureJoinCode } from "../../../lib/joinRequests";
import ProfileEditor from "../profile/ProfileEditor";
import SettingsBoard, { type SettingsSection } from "./SettingsBoard";
import { SepJoin } from "../Sep";
import "../../../components/ui/ui.css";
import "../training/draft.css";
import "../training/trn.css";
import "../measurements/measurements.css";
import "../rail.css";
import "./settings.css";
import "../profile/profile.css";

// Settings in the redesign, opened from the coach at the foot of the rail: the sections listed on the left, each with
// one fact, and the one picked on the right (27 Oct, Alex: mockup B; SettingsBoard). The rail keeps its own look here. Profile (the form and the client's view beside it; the
// owner opens any coach's with ?coachId=), Account & security, Business details, Invoicing & payments, Privacy &
// legal, and for a coach (not the owner) Support. One bar at the foot saves every section changed (SaveHost). #<key>
// opens a section, and the rail's Settings rows open theirs. The old addresses redirect here (settings/[section],
// /admin/redesign/profile).
//   /admin/redesign/settings#profile | account | business | plans | invoicing | privacy | support
export const dynamic = "force-dynamic";

/** When Stripe was last asked about a coach's unfinished account (the page's own memory, per server). */
const stripeAsked = new Map<number, number>();
const STRIPE_ASK_MS = 60_000;

/** Where a coach's Stripe account stands: asked of Stripe when just back from it, and while unfinished once a minute
    at most (every save draws this page again); else what is known. */
async function stripeState(coachId: number, back: boolean): Promise<PaymentsState> {
  const known = paymentsState(coachId);
  const now = Date.now();
  if (!back && (known.status !== "pending" || now - (stripeAsked.get(coachId) ?? 0) < STRIPE_ASK_MS)) return known;
  stripeAsked.set(coachId, now);
  return refreshCoachStripe(coachId);
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
/** "25 September 2026" (lib/legal.ts) as the admin writes a date, 25/9 (dayMonth); as it is when it won't read. */
function legalDate(words: string): string {
  const m = /^(\d{1,2}) ([A-Za-z]+) (\d{4})$/.exec(words.trim());
  const month = m ? MONTHS.indexOf(m[2].toLowerCase()) : -1;
  return m && month >= 0 ? dayMonth(new Date(Number(m[3]), month, Number(m[1]))) : words;
}

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ coachId?: string; stripe?: string }> }) {
  // Each loader timed (app/lib/timing.ts, /api/timing): measuring only, the props are what they were.
  const t = startTiming("settings");
  const coach = await t.time("auth", () => requireCoach());
  // The chat first (Step 5, app/lib/chat/rows.ts): the chat list's alone (the rail reads its own, in the layout).
  const chat = { dock: await t.time("chat", () => fetchChatDock(coach.id, "page.settings")) };
  const params = await searchParams;

  // Profile: the coach's own, or for the owner any coach's (?coachId=).
  const owner = isOwner(coach);
  const asked = Number(params.coachId);
  const coachId = owner && Number.isInteger(asked) && asked > 0 && t.time("profileView", () => getCoachProfileView(asked)) ? asked : coach.id;
  const profile = t.time("profileView", () => getCoachProfileView(coachId));
  // Their ids and emails alone (Step 5: no coach's feed built for them).
  const coaches = owner ? t.time("coachAccounts", () => listCoachEmails()) : [];
  // Your details (23 Nov, Alex: A of docs/boards/settings-profile-mockup.html): who they are, the account basics and the
  // address; the name split back into first and last (as the sign-up's About you asked them), only a name they gave.
  const whose = t.time("coachSettings", () => getCoachSettings(coachId));
  const contact = whose.contact ?? {};
  // As typed (a first name of two words stays one), else the display name cut at its first space (coachNames.ts).
  const given = nameParts(whose, getCoachProfile(coachId)?.display_name);
  const details = {
    first: given.first,
    last: given.last,
    birthdate: whose.birthdate ?? "",
    title: profile?.title ?? "",
    business: whose.business?.business_name?.trim() ?? "",
    email: getData().users.find((u) => u.id === coachId)?.email ?? "",
    phoneCode: contact.phone_code ?? "",
    phone: contact.phone ?? "",
    address: contact.address ?? "",
    postcode: contact.postcode ?? "",
    city: contact.city ?? "",
    countryCode: contact.country_code ?? "",
  };
  const countries = COUNTRIES.map((c) => ({ code: c.code, name: c.name }));

  // Back from Stripe (?stripe=back, which the page then drops from its address), or still unfinished.
  const payments = await t.time("stripe", () => stripeState(coach.id, !!params.stripe));
  const settings = t.time("coachSettings", () => getCoachSettings(coach.id));
  const business = settings.business ?? {};
  // The banner inside the page, for its preview (19 Nov).
  const brandNow = await coachBrandInline(coach.id);
  const invoicing = settings.invoicing ?? {};
  const support = t.time("support", () => loadSupportSection(coach));
  // Account & security's logins and devices, from Clerk (27 Oct); null with Clerk off or not answering.
  const [security, passwordsHint] = await Promise.all([t.time("security", () => loadAccountSecurity()), clerkOn() ? passwordsOnHint() : null]);
  const notify = settings.notify ?? {};
  const units = settings.units === "lbs" ? "lbs" : "kg";
  const timezone = settings.timezone || process.env.TZ || "Europe/Amsterdam";
  const clientCount = getData().clients.filter((cl) => cl.coach_id === coach.id).length;
  // Plans (28 Oct, Alex): each with how many clients are on it, priced in the coach's currency, VAT as Invoicing says.
  const planCounts = planClientCounts(coach.id);
  const plans = listCoachPlans(coach.id, true).map((p) => ({ id: p.id, name: p.name, price: p.price ?? null, every: p.every ?? null, archived: !!p.archived, clients: planCounts.get(p.id) ?? 0 }));
  const eff = invoicingFor(business, invoicing);
  const livePlans = plans.filter((p) => !p.archived).length;

  // The list's quiet fact under each name (27 Oct, Alex: mockup B), parts parted by the drawn bar (3 Nov, Alex: was a typed "|").
  const billing = t.time("billing", () => billingView(coach.id, owner));
  const join = (parts: (string | null | undefined | false)[]) => (parts.some(Boolean) ? <SepJoin parts={parts} /> : null);
  const land = business.country_code ? countryOf(business.country_code) : null;
  const facts = {
    profile: profile ? (profile.published ? "Published" : "Not published") : null,
    business: join([business.business_name, land?.name ?? business.country]) ?? "Not set",
    // Branding's fact: the colour by its name (or its hex), then what is uploaded.
    branding: join([settings.brand?.color ? BRAND_SWATCHES.find((s) => s.hex === settings.brand?.color)?.name ?? settings.brand.color.toUpperCase() : null, settings.brand?.mark ? "Logo" : null, brandNow.banner ? "Banner" : null]) ?? "Not set",
    plans: livePlans === 0 ? "None yet" : `${livePlans} plan${livePlans === 1 ? "" : "s"}`,
    invoicing: join([invoicing.currency ?? land?.currency ?? "EUR", invoicing.vat_rate != null ? `${invoicing.vat_rate}% ${land?.tax ?? "tax"}` : null, payments.status === "active" ? "Stripe" : null]),
    privacy: `Policy updated ${legalDate(LEGAL.updated)}`,
    account: join([coach.email, security?.logins.some((l) => l.provider === "google") ? "Google" : null]),
    notifications: join([notify.chat === false && notify.video === false ? "Phone off" : "Phone on", notify.quiet ? `quiet ${notify.quietFrom ?? "22:00"}–${notify.quietTo ?? "07:00"}` : null]),
    preferences: join([units, timezone]),
    data: "Export",
    // What they pay Norcoach (28 Oct): the plan and its state in a word.
    billing: billing.status === "free" ? "Free" : join([billing.interval === "year" ? "Yearly" : billing.interval ? "Monthly" : null, billing.access.state === "readonly" ? "Read-only" : billing.status === "trialing" ? "Trial" : billing.status === "active" ? "Active" : billing.access.state === "grace" ? "Payment failed" : "Not started"]),
  };

  // In the rail's order, a section a line (its label from settingsNav's SETTINGS unless given; no body, left out).
  const sections: SettingsSection[] = [
    {
      key: "profile",
      // The owner on another coach's: whose it is.
      label: profile && coachId !== coach.id ? `${profile.displayName}'s profile` : undefined,
      fact: facts.profile,
      tag: profile && <span className={`trn-state${profile.published ? " good" : ""}`}>{profile.published ? "Published" : "Not published"}</span>,
      body: profile ? <ProfileEditor key={coachId} profile={profile} coaches={coaches} details={details} countries={countries} joinCode={ensureJoinCode(coachId)} /> : <p className="rpf-empty">No coach profile</p>,
    },
    { key: "account", fact: facts.account, body: <AccountSettings email={coach.email} passwordless={clerkOn()} security={security} passwordsHint={passwordsHint} /> },
    {
      key: "business",
      fact: facts.business,
      body: <BusinessSettings key={JSON.stringify(business)} initial={business} />,
    },
    {
      // Branding, a section of its own (22 Nov, Alex: "right now it lives inside of business but i want its own section"):
      // the logo, the banner and the brand colour (19 Nov, Alex: docs/boards/coach-brand-mockup.html), and the card pictures.
      key: "branding",
      fact: facts.branding,
      // C's identity card and A's card pictures (22 Nov, Alex: "have the branding like in c and the card pictures like in a";
      // docs/boards/settings-branding-mockup.html): the coach's brand drawn as it shows, edited in place.
      body: (
        <BrandingSection
          mark={settings.brand?.mark ?? null}
          banner={brandNow.banner ?? null}
          bannerRatio={brandNow.bannerRatio ?? null}
          colour={settings.brand?.color ?? null}
          cards={coachCardPictures(coach.id)}
          cardsDefault={coachCardsDefault(coach.id)}
          stock={PHASE_COVERS}
        />
      ),
    },
    { key: "plans", fact: facts.plans, body: <PlansSettings plans={plans} currency={eff.currency} vatFact={eff.rate > 0 ? `Prices ${eff.pricesIncludeVat ? "include" : "exclude"} ${eff.rate}% ${eff.taxLabel}` : null} /> },
    // Keyed on the business's country too: a new one there brings its own defaults here.
    { key: "invoicing", fact: facts.invoicing, body: <InvoicingSettings key={JSON.stringify([invoicing, business.country_code ?? null, business.country ?? null])} initial={invoicing} business={business} payments={payments} /> },
    // Off until subscriptions are set up on the server; the owner has none (settingsFor).
    { key: "billing", fact: facts.billing, body: billing.on && !owner ? <BillingSettings view={billing} /> : null },
    { key: "notifications", fact: facts.notifications, body: <NotificationsSettings key={JSON.stringify(notify)} initial={notify} /> },
    { key: "preferences", fact: facts.preferences, body: <PreferencesSettings key={`${units}|${timezone}`} units={units} timezone={timezone} /> },
    { key: "data", fact: facts.data, body: <DataSettings clients={clientCount} /> },
    { key: "privacy", fact: facts.privacy, body: <PrivacySettings company={LEGAL.company} country={LEGAL.country} contactEmail={LEGAL.contactEmail} updated={legalDate(LEGAL.updated)} /> },
    // A coach's thread with the company; the owner answers from Coaches and has none (null leaves it out).
    { key: "support", label: "Support", body: support && <SupportSection {...support} /> },
  ];

  return t.end(
    <>
      {/* The chat tab and its 60px on the right, as every coach-level page (16 Nov, Alex: the audit). */}
      <ChatDock chats={t.time("chatDock", () => loadChatDock(coach, chat.dock))} />
      <div className="rd-page">
        <SettingsBoard className="rd trn rls rst rpf" sections={sections} />
      </div>
    </>
  );
}
