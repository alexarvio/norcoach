"use client";

import { useSyncExternalStore } from "react";
import { toast } from "sonner";
import { norcode } from "../../../lib/norcode";
import { Sep } from "../Sep";

// Settings, Profile, Your Norcode (18 Nov, Alex: "an actual proper code… We generate one for each coach, always"): the
// code a client types when they sign up to ask to join this coach, `NC-` and eight letters and digits, made for the
// coach and never changed by them, and the link that fills it in for the client (for an Instagram bio). Copy for each.
// A request comes to the Feed's Needs you.

const SITE = "https://app.norcoachapp.com";
const noSubscribe = () => () => {};
const linkOf = (origin: string, code: string) => `${origin}/join/${code.toLowerCase()}`;
const shown = (url: string) => url.replace(/^https?:\/\//, "");

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
    <section className="rls-section rst-sub rjc-part">
      <div className="trn-weekhead">
        <div>
          <h3>Your Norcode</h3>
        </div>
      </div>
      <div className="rls-card rst-card">
        <div className="rst-rows">
          <div className="rst-row">
            <div className="rst-row-main">
              <b className="rjc-code">{norcode(code)}</b>
            </div>
            <button type="button" className="rst-act" onClick={() => copy(norcode(code))}>
              Copy
            </button>
          </div>
          <div className="rst-row">
            <div className="rst-row-main">
              <b>Link</b>
              <Sep />
              <small>{shown(link)}</small>
            </div>
            <button type="button" className="rst-act" onClick={() => copy(link)}>
              Copy
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
