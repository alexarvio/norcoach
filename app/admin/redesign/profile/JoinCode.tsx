"use client";

import { useSyncExternalStore } from "react";
import { toast } from "sonner";
import { norcode } from "../../../lib/norcode";
import { Sep } from "../Sep";

// Settings, Profile, Your Norcode (18 Nov, Alex: "an actual proper code… We generate one for each coach, always"): the
// code a client types when they sign up to ask to join this coach, `NC-` and eight letters and digits, made for the
// coach and never changed by them, and the link that fills it in for the client (for an Instagram bio). Since 23 Nov
// (Alex: A of docs/boards/settings-profile-mockup.html) it sits in the identity card's band, on its right, as how clients
// find you: `Your Norcode` small caps, the code, then Copy and Copy link in words; no card of its own. A request comes to
// the Feed's Needs you.

const SITE = "https://app.norcoachapp.com";
const noSubscribe = () => () => {};
const linkOf = (origin: string, code: string) => `${origin}/join/${code.toLowerCase()}`;

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success("Copied");
  } catch {
    toast.error("Couldn't copy");
  }
}

export default function JoinCode({ code }: { code: string }) {
  const origin = useSyncExternalStore(noSubscribe, () => window.location.origin, () => SITE);
  if (!code) return null;
  const link = linkOf(origin, code);

  return (
    <div className="rpf-code">
      <small>Your Norcode</small>
      <b>{norcode(code)}</b>
      <span className="rpf-code-acts">
        <button type="button" className="rpf-bword" onClick={() => copy(norcode(code))}>
          Copy
        </button>
        <Sep />
        <button type="button" className="rpf-bword" onClick={() => copy(link)} title={link.replace(/^https?:\/\//, "")}>
          Copy link
        </button>
      </span>
    </div>
  );
}
