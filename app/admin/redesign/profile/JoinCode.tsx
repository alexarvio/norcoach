"use client";

import { useState, useSyncExternalStore, useTransition } from "react";
import { toast } from "sonner";
import { setJoinCodeAction } from "../../../lib/joinActions";
import { Sep } from "../Sep";

// Settings, Profile, Your code (18 Nov, Alex: docs/boards/client-signup-mockup.html): the code a client types when they
// sign up to ask to join this coach, and the link that fills it in for them (for an Instagram bio). Copy for each;
// Change types a new code in place, Cancel in words and the ink Save, saved at once as the plans are, never on the
// page's bar. A request comes to the Feed's Needs you.

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

export default function JoinCode({ coachId, code: initial }: { coachId: number; code: string }) {
  const [code, setCode] = useState(initial);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const origin = useSyncExternalStore(noSubscribe, () => window.location.origin, () => SITE);
  if (!code) return null;
  const link = linkOf(origin, code);

  const save = () =>
    start(async () => {
      const r = await setJoinCodeAction(draft ?? "", coachId).catch(() => ({ ok: false as const, error: "Not saved. Try again." }));
      if (!r.ok) return setError(r.error);
      setCode(r.code);
      setDraft(null);
      setError(null);
    });

  return (
    <section className="rls-section rst-sub rjc-part">
      <div className="trn-weekhead">
        <div>
          <h3>Your code</h3>
        </div>
      </div>
      <div className="rls-card rst-card">
        <div className="rst-rows">
          {draft == null ? (
            <div className="rst-row">
              <div className="rst-row-main">
                <b className="rjc-code">{code}</b>
              </div>
              <button type="button" className="rst-act" onClick={() => copy(code)}>
                Copy
              </button>
              <button type="button" className="rst-act" onClick={() => (setDraft(code), setError(null))}>
                Change
              </button>
            </div>
          ) : (
            <form
              className="rst-row rjc-edit"
              onSubmit={(e) => {
                e.preventDefault();
                if (!busy) save();
              }}
              onKeyDown={(e) => e.key === "Escape" && setDraft(null)}
            >
              <input
                className="dlh-line rjc-input"
                autoFocus
                value={draft}
                onChange={(e) => (setDraft(e.target.value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 20)), setError(null))}
                aria-label="Your code"
                autoComplete="off"
                spellCheck={false}
              />
              {error && <span className="rst-err rjc-err">{error}</span>}
              <span className="rst-plan-foot">
                <button type="button" className="dlh-cancel" onClick={() => (setDraft(null), setError(null))}>
                  Cancel
                </button>
                <button type="submit" className="dlh-go" disabled={busy || (draft ?? "").length < 3 || draft === code}>
                  Save
                </button>
              </span>
            </form>
          )}
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
