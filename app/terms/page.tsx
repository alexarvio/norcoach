import type { Metadata } from "next";
import Link from "next/link";
import { NorCoachLogo } from "../components/NorCoachLogo";
import { LEGAL } from "../lib/legal";
import "../../website/site-bg.css";
import "../privacy/legal.css";

// The terms of service (20 Nov, Alex: "Yes, draft it"): public, on the website's address beside the privacy policy and
// support (proxy.ts, LEGAL_PAGES). Plain words, written for what Norcoach actually does (checked against the code, 20 Nov);
// a draft until a lawyer has read it. When billing, data or what a coach can do changes, this changes with it.

// These pages live on the website's address (norcoachapp.com), where /login is the website's: Sign in goes to the app's.
const SIGN_IN = process.env.CANONICAL_HOST ? `https://${process.env.CANONICAL_HOST.trim()}/login` : "/login";

export const metadata: Metadata = { title: `Terms of service · ${LEGAL.app.toUpperCase()}` };

export default function TermsPage() {
  const contact = LEGAL.contactEmail ? <a href={`mailto:${LEGAL.contactEmail}`}>{LEGAL.contactEmail}</a> : <em>[contact email to be added]</em>;
  const law = LEGAL.jurisdiction || <em>[state to be confirmed]</em>;
  return (
    <main className="lg">
      {/* The website's dark head over the paper, as the privacy policy and support. */}
      <header className="lg-band site-bg site-bg-mark">
        <div className="lg-band-in">
          <a href="/" className="lg-brand" aria-label={LEGAL.app}>
            <NorCoachLogo />
          </a>
          <h1>Terms of service</h1>
          <p className="lg-updated">Last updated {LEGAL.termsUpdated}</p>
        </div>
      </header>
      <div className="lg-paper">
        <div className="lg-wrap">
          <p>
            {LEGAL.app} is an app for one-to-one coaching. Coaches use it to plan and run their coaching, and their clients use it to follow their plan and stay in touch with their coach. {LEGAL.app} is run by {LEGAL.company}, a company registered in {LEGAL.country} (&ldquo;we&rdquo;). These terms are the agreement
            between you and us when you use {LEGAL.app}. By using {LEGAL.app}, you agree to them.
          </p>

          <div className="lg-box">
            <strong>The short version.</strong> Coaches are responsible for their coaching; we provide the app. You own what you put in it. Coaches can cancel their plan whenever they like, and we never delete anything because a payment failed. No AI writes to your clients or learns from your data.
          </div>

          <h2>Your account</h2>
          <ul>
            <li>You need to be at least 18 to coach on {LEGAL.app}. To be coached you need to be at least 16, and if you&rsquo;re under 18 you need a parent&rsquo;s or guardian&rsquo;s permission. Coaches must not invite anyone younger.</li>
            <li>An account is for one person. Keep your sign-in details to yourself, and tell us if you think someone else has used your account.</li>
            <li>Give us information that is true and up to date, so your coach, your clients and we can reach you.</li>
          </ul>

          <h2>Health and safety</h2>
          <p>
            {LEGAL.app} is not a medical device and is not for emergencies. Figures the app works out, such as a raised target weight, a personal best or a trend, are calculations from what you and your coach entered, not advice. Training and changing what you eat carry a risk of injury or
            illness, and you take part at your own risk.
          </p>

          <h2>If you coach</h2>
          <p>
            <strong>Your coaching is yours.</strong> You are an independent professional. You decide the training, nutrition and lifestyle advice you give, and you are responsible for it, including holding any qualifications and insurance your work needs. {LEGAL.app} does not give
            fitness, nutrition or medical advice, and we don&rsquo;t check the advice coaches give.
          </p>
          <p>
            <strong>Your clients and their data.</strong> You invite your clients, or accept their requests to join you. Use what they share with you only to coach them, and treat it with care: it often includes health information. For your clients&rsquo; coaching data, you decide what is
            collected and why, and we handle it for you, only to run {LEGAL.app}: we keep it confidential and secure, use only the service providers in the <Link href="/privacy">privacy policy</Link>, help you answer your clients&rsquo; requests about their data, and tell you without
            undue delay if it is ever exposed. If your clients are in the European Union or the United Kingdom, you are responsible for having a lawful reason to coach them with their data.
          </p>
          <p>
            <strong>Billing your clients.</strong> If you send invoices or take payments through {LEGAL.app}, the payments go to your own Stripe account or bank, and {LEGAL.app} takes no part of them. Stripe&rsquo;s own terms apply to your Stripe account. Your prices, refunds and
            cancellations are between you and your client, and you&rsquo;re responsible for the tax, invoicing and consumer-law duties of your own business.
          </p>
          <p>
            <strong>Claims about your coaching.</strong> If a client or anyone else makes a claim against us because of your coaching, your content or how you handle your clients&rsquo; data, you&rsquo;ll cover our reasonable costs and losses from that claim.
          </p>

          <h2>Paying for {LEGAL.app}</h2>
          <ul>
            <li>The first coaches use {LEGAL.app} free while we&rsquo;re in early access. We&rsquo;ll tell you the price before you pay anything.</li>
            <li>A paid plan is a subscription, monthly or yearly, paid through Stripe. It renews by itself until you cancel.</li>
            <li>A new plan can start with a free 14-day trial, one trial for each coach. We ask for your payment details when the trial starts, and the first payment is taken when it ends unless you cancel before then.</li>
            <li>You can cancel any time from Settings, Billing. Your plan keeps working until the end of the period you&rsquo;ve paid for, and we don&rsquo;t refund part of a period.</li>
            <li>
              If a payment fails or your plan ends, everything keeps working for a week. After that your account is read-only: you can see everything, chat with your clients and sort out billing, but you can&rsquo;t make changes until you subscribe again. We never delete anything because a
              payment failed, and your clients&rsquo; app keeps working.
            </li>
            <li>If we change a price, we&rsquo;ll tell you before it applies to you.</li>
          </ul>

          <h2>If you&rsquo;re coached</h2>
          <ul>
            <li>Your coach is responsible for the coaching you get, not {LEGAL.app}. Questions about your plan go to your coach.</li>
            <li>Talk to a doctor before you start a new training or nutrition plan if you have a medical condition, are pregnant or are unsure. Stop and get advice if something hurts.</li>
            <li>What you log is shared with your coach, because that is what it is for. You can delete your account and your data in the app, under Settings, Data.</li>
          </ul>

          <h2>What&rsquo;s yours</h2>
          <p>
            What you put into {LEGAL.app} (plans, notes, messages, photos, videos, logs) stays yours. You give us permission to store, process and show it only to run, secure, back up and support {LEGAL.app} for you and the people you coach or are coached by. Coaches can export their
            clients&rsquo; records at any time from Settings, Your data.
          </p>
          <p>No AI writes anything your clients read in {LEGAL.app}, and we don&rsquo;t use your data to train AI models. {LEGAL.app} itself, its design and its code, stays ours.</p>

          <h2>Using {LEGAL.app} fairly</h2>
          <p>Don&rsquo;t use {LEGAL.app} to:</p>
          <ul>
            <li>break the law, or share anything you don&rsquo;t have the right to share;</li>
            <li>harass, threaten or mislead anyone;</li>
            <li>get into accounts or data that aren&rsquo;t yours, or test, overload or work around our security;</li>
            <li>copy, resell or build a competing product from {LEGAL.app}.</li>
          </ul>
          <p>
            If an account breaks these terms, we may pause or close it. Unless the law, someone&rsquo;s safety or the security of {LEGAL.app} and its users stops us, we&rsquo;ll tell you why first and give you a chance to put it right.
          </p>

          <h2>Keeping {LEGAL.app} running</h2>
          <p>
            We work to keep {LEGAL.app} running and your data safe, and to fix things quickly when they go wrong. We can&rsquo;t promise it will never be unavailable. We keep improving {LEGAL.app}, so features change; if we take away something coaches rely on, we&rsquo;ll tell them in
            advance.
          </p>

          <h2>Leaving</h2>
          <p>
            You can stop using {LEGAL.app} whenever you like. Clients can delete their account in the app. Coaches can cancel their plan, export their clients&rsquo; records, and ask us to close their account by writing to us from Support. Deleting an account deletes its data as the{" "}
            <Link href="/privacy">privacy policy</Link> describes. Payment, liability and the parts of these terms about your data still apply after you leave.
          </p>

          <h2>If you use the iPhone app</h2>
          <p>
            These terms are between you and us, not Apple. Apple isn&rsquo;t responsible for {LEGAL.app}, its support or any claims about it, but Apple can enforce these terms as a third party. Apple&rsquo;s own licence terms for apps from the App Store also apply.
          </p>

          <h2>Liability</h2>
          <p>
            {LEGAL.app} is provided as it is. As far as the law allows, we are not responsible for indirect losses, such as lost profits, lost clients or lost data, or for the coaching advice given through {LEGAL.app}. As far as the law allows, our total responsibility to you is limited to
            the greater of what you paid us in the 12 months before the claim or US$100. This doesn&rsquo;t limit our responsibility for death or personal injury caused by our negligence, for fraud, or for anything else the law doesn&rsquo;t let us limit, and nothing in these terms takes
            away rights you have as a consumer.
          </p>

          <h2>Changes to these terms</h2>
          <p>If we change these terms, we&rsquo;ll update the date at the top. If a change matters to you, we&rsquo;ll tell you before it applies, and you can stop using {LEGAL.app}, or cancel your plan, before then.</p>

          <h2>Disputes and law</h2>
          <p>
            If something goes wrong, write to us first and we&rsquo;ll try to sort it out within 30 days. These terms follow the law of {law}, in {LEGAL.country}, and claims go to the courts there. If you live elsewhere, you keep the protections your own country&rsquo;s law gives you, and
            consumers in the European Union or the United Kingdom can also go to their own courts.
          </p>

          <h2>Small print</h2>
          <p>
            We&rsquo;re not responsible for delays caused by events outside our control, such as outages at our providers. We may transfer this agreement to whoever takes over {LEGAL.app}, and we&rsquo;ll tell you if we do. If one part of these terms can&rsquo;t be enforced, the rest
            still applies. These terms and the privacy policy are the whole agreement between us. We send notices to your account&rsquo;s email.
          </p>

          <h2>Contact</h2>
          <p>
            {LEGAL.company}. Questions about these terms: {contact}.
          </p>

          <div className="lg-foot">
            <Link href="/privacy">Privacy policy</Link>
            <Link href="/support">Support</Link>
            <a href={SIGN_IN}>Sign in</a>
          </div>
        </div>
      </div>
    </main>
  );
}
