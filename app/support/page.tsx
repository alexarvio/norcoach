import type { Metadata } from "next";
import Link from "next/link";
import { NorCoachLogo } from "../components/NorCoachLogo";
import { LEGAL } from "../lib/legal";
import "../../website/site-bg.css";
import "../privacy/legal.css";

// The support page: public, the App Store listing's support link. The
// questions people actually have, and where to write.

export const metadata: Metadata = { title: `Support · ${LEGAL.app.toUpperCase()}` };

export default function SupportPage() {
  const contact = LEGAL.contactEmail ? <a href={`mailto:${LEGAL.contactEmail}`}>{LEGAL.contactEmail}</a> : <em>[contact email to be added]</em>;
  return (
    <main className="lg">
      {/* The website's dark head over the paper, as the privacy policy (20 Nov, Alex). */}
      <header className="lg-band site-bg site-bg-mark">
        <div className="lg-band-in">
          <Link href="/login" className="lg-brand" aria-label={`${LEGAL.app} sign in`}>
            <NorCoachLogo />
          </Link>
          <h1>Support</h1>
          <p className="lg-updated">Help with the {LEGAL.app} app</p>
        </div>
      </header>
      <div className="lg-paper">
      <div className="lg-wrap">

        <div className="lg-box">
          <strong>Questions about your training, food or plan?</strong> Ask your coach: open the menu in the app and choose Messages. Your coach answers there.
        </div>

        <h2>Getting in</h2>
        <ul>
          <li>Your coach sets up your account and sends you an invitation with your email address.</li>
          <li>Forgot your password? Ask your coach to reset it for you.</li>
        </ul>

        <h2>Notifications</h2>
        <ul>
          <li>Turn them on in the app under Account. On an iPhone, add {LEGAL.app} to your Home Screen first (Share, then Add to Home Screen).</li>
          <li>Not getting any? Check that notifications for {LEGAL.app} are allowed in your phone&rsquo;s settings.</li>
        </ul>

        <h2>Your account and data</h2>
        <ul>
          <li>
            You can delete your account and all your data yourself, in the app under Account. See the <Link href="/privacy">privacy policy</Link> for what we store and why.
          </li>
        </ul>

        <h2>Something not working?</h2>
        <p>
          Write to {contact} with what you were doing, what you expected and what happened instead. A screenshot helps. We usually answer within two working days.
        </p>

        <div className="lg-foot">
          <Link href="/privacy">Privacy policy</Link>
          <Link href="/login">Sign in</Link>
          <span>
            {LEGAL.app} is run by {LEGAL.company}.
          </span>
        </div>
      </div>
      </div>
    </main>
  );
}
