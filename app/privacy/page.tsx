import type { Metadata } from "next";
import Link from "next/link";
import { NorCoachLogo } from "../components/NorCoachLogo";
import { LEGAL } from "../lib/legal";
import "../../website/site-bg.css";
import "./legal.css";

// The privacy policy: public (no login), linked from the App Store listing
// and the login page. Written for what the app actually does; when a new
// kind of data or a new service comes in, it goes in here too.

// These pages live on the website’s address (norcoachapp.com, 20 Nov), where /login is the website’s: Sign in goes to the app’s.
const SIGN_IN = process.env.CANONICAL_HOST ? `https://${process.env.CANONICAL_HOST.trim()}/login` : "/login";

export const metadata: Metadata = { title: `Privacy policy · ${LEGAL.app.toUpperCase()}` };

export default function PrivacyPage() {
  const contact = LEGAL.contactEmail ? <a href={`mailto:${LEGAL.contactEmail}`}>{LEGAL.contactEmail}</a> : <em>[contact email to be added]</em>;
  return (
    <main className="lg">
      {/* The website's dark head over the paper, as the sign-in on a phone (20 Nov, Alex: "redone with the new style"). */}
      <header className="lg-band site-bg site-bg-mark">
        <div className="lg-band-in">
          <a href="/" className="lg-brand" aria-label={LEGAL.app}>
            <NorCoachLogo />
          </a>
          <h1>Privacy policy</h1>
          <p className="lg-updated">Last updated {LEGAL.updated}</p>
        </div>
      </header>
      <div className="lg-paper">
      <div className="lg-wrap">

        <p>
          {LEGAL.app} is an app for coaching: your coach plans your training, nutrition and check-ins in it, and you log what you do. {LEGAL.app} is run by {LEGAL.company}, a company registered in {LEGAL.country} (&ldquo;we&rdquo;). This policy explains what we store, why, who
          else handles it, and what you can do about it.
        </p>

        <div className="lg-box">
          <strong>The short version.</strong> We store what you and your coach put into the app so that coaching works. Your coach sees what you log. We don&rsquo;t sell your data, we don&rsquo;t show ads, and we don&rsquo;t track you across other apps or websites. You can delete your account and your data from inside the app at any time.
        </div>

        <h2>Who sees your data</h2>
        <p>
          Your coach is an independent professional who uses {LEGAL.app} to coach you. Everything you enter in the app is shared with your coach, because that is what it is for. Your coach decides what is collected and how it is used for your coaching; we handle it on your coach&rsquo;s
          behalf, only to run the app, and keep it safe. For your account, sign-in and technical data, and for what coaches pay us, we decide how it is used. Nobody else can see your data, apart from the service providers listed below, who handle it only to run the app.
        </p>

        <h2>What we store</h2>
        <ul>
          <li>
            <strong>Your account:</strong> your name, email address, date of birth and sign-in details, a profile picture if you add one, and the details you or your coach fill in, such as gender, height, phone number and address. Your password is stored only in a form no one can read.
          </li>
          <li>
            <strong>Health and fitness data:</strong> the check-ins you fill in (for example body weight, sleep, steps, how you&rsquo;re feeling, body measurements), the training you log (sets, weights, reps, notes), your food diary and calories, progress pictures, and the gyms you train at.
          </li>
          <li>
            <strong>From your phone&rsquo;s health app:</strong> only if you connect Apple Health or Health Connect, the steps, body weight, sleep, resting heart rate, heart-rate variability and calories eaten your phone records, and your workouts (their type, time, length,
            distance, calories burned and the app that recorded them). You can turn this off in the app, under Settings, Connected apps: that stops new readings, and what was already read stays with your other check-ins.
          </li>
          <li>
            <strong>Messages:</strong> your chat with your coach, including photos, videos, voice messages and files you send, and videos of exercises your coach asks for.
          </li>
          <li>
            <strong>What your coach writes about you:</strong> your programme and plan, notes, goals, meeting recaps, and invoices if your coach bills you through {LEGAL.app}.
          </li>
          <li>
            <strong>Activity:</strong> when you were last in the app, and whether you&rsquo;ve seen a message. Your coach sees these, so they know whether you&rsquo;re using the app.
          </li>
          <li>
            <strong>Devices:</strong> if you turn on notifications, an address for your device that lets us send them. We also keep a sign-in cookie so you stay logged in.
          </li>
          <li>
            <strong>Technical data:</strong> when something goes wrong, an error report (what failed, the browser or device type, and roughly when) so we can fix it.
          </li>
        </ul>
        <p>We don&rsquo;t collect your location, your contacts, or advertising identifiers. No AI reads your data, and we don&rsquo;t use it to train AI models.</p>

        <h2>If you coach</h2>
        <p>
          For coaches we also store your date of birth, photo, what you coach and your public profile; your logo, banner and card pictures; your business details (business name, address, country and tax details, and the bank details you put on your invoices); your plans and prices,
          the invoices you send, your {LEGAL.app} code, your subscription with us and the id of your Stripe account; and what you write to us in Support, with any screenshots. Payments go through Stripe: card details are entered with Stripe and never reach us. We use this to run your
          account and your billing (performance of a contract).
        </p>
        <p>
          <strong>Before you&rsquo;re a client.</strong> If you ask to join a coach with their code, we keep your name, date of birth and email with the request: up to 60 days while it waits for an answer, and 90 days after the coach answers. If you apply as a coach on our website, your
          application (your name, email, business and how many clients you coach) is emailed to us.
        </p>

        <h2>Why we use it, and on what basis</h2>
        <ul>
          <li>To provide the app and the coaching you signed up for (performance of a contract).</li>
          <li>
            Health and fitness data is a special kind of personal data. It is processed only because you choose to enter it, or connect your phone&rsquo;s health app, for your coaching, with your explicit consent, which you can withdraw at any time by deleting it, disconnecting the
            health app or deleting your account.
          </li>
          <li>To keep the app working and secure, and to fix errors (our legitimate interest).</li>
          <li>To send you notifications you turned on, such as a message from your coach or a reminder before a call. You can turn them off in the app or on your phone.</li>
        </ul>

        <h2>Service providers</h2>
        <p>These companies handle data to run the app, under their own terms and, where they work for us, contracts that require them to protect it:</p>
        <ul>
          <li>
            <strong>Railway</strong>: hosting, database, file storage and backups (servers in the United States and the European Union).
          </li>
          <li>
            <strong>Clerk</strong>: signing in, including passwords, signing in with Apple or Google, and the emails with invitations, sign-in codes and password resets.
          </li>
          <li>
            <strong>Stripe</strong>: coaches&rsquo; subscriptions to {LEGAL.app}, and payments coaches take from their clients (into the coach&rsquo;s own Stripe account).
          </li>
          <li>
            <strong>Resend</strong>: emailing us the applications coaches send from our website.
          </li>
          <li>
            <strong>Sentry</strong>: error reports, without what you typed, your cookies or your IP address.
          </li>
          <li>
            <strong>Apple, Google and your browser&rsquo;s push service</strong>: delivering notifications to your device.
          </li>
          <li>
            <strong>YouTube and Vimeo</strong>: when you play an exercise demo your coach added from them, the video loads from them, and they see your IP address.
          </li>
          <li>
            <strong>Google Fonts</strong>: some of the typefaces in the app and on our website load from Google, which sees your IP address.
          </li>
          <li>
            <strong>Open Food Facts</strong>: when you search for a food or scan a barcode, the search term or barcode is looked up in this public food database. No personal data is sent.
          </li>
        </ul>

        <h2>International transfers</h2>
        <p>
          {LEGAL.company} and some of our providers are in the United States. If you are in the European Union or the United Kingdom, your data is transferred there under safeguards recognised by EU law, such as the European Commission&rsquo;s Standard Contractual Clauses.
        </p>

        <h2>How long we keep it</h2>
        <ul>
          <li>For as long as you have an account.</li>
          <li>When you delete your account in the app, your data is deleted straight away. Copies in our nightly backups are gone within 30 days.</li>
          <li>Invoices your coach issued you are business records your coach must keep by law, so they stay after your account is deleted, with only your name on them.</li>
          <li>Your coach also keeps a short record that you were their client: your name and the dates you started and left.</li>
        </ul>

        <h2>Your rights</h2>
        <p>
          You can ask to see the data we hold about you, correct it, get a copy of it, have it deleted, or object to or restrict how it is used. You can delete your account and all your data yourself in the app, under Settings, Data. Coaches can ask us to close their account by writing to us from Support. For anything else, write to {contact}. If you are in the EU or UK and
          aren&rsquo;t happy with how we handle your data, you can also complain to your data protection authority (in the Netherlands, the Autoriteit Persoonsgegevens).
        </p>

        <h2>Security</h2>
        <p>Data is sent over encrypted connections, passwords are stored only in hashed form, and access to your data is limited to you and your coach. No system is perfectly secure, but we work to keep yours safe and will tell you if something goes wrong.</p>

        <h2>Children</h2>
        <p>{LEGAL.app} is not meant for anyone under 16, and we don&rsquo;t knowingly store data about children.</p>

        <h2>Changes</h2>
        <p>If we change this policy, we&rsquo;ll update the date at the top, and tell you in the app if the change matters.</p>

        <h2>Contact</h2>
        <p>
          {LEGAL.company}. Questions about your data: {contact}.
        </p>

        <div className="lg-foot">
          <Link href="/support">Support</Link>
          <a href={SIGN_IN}>Sign in</a>
        </div>
      </div>
      </div>
    </main>
  );
}
