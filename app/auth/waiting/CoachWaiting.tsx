"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { SiteShell } from "../../login/SignInScreens";
import { Bars } from "../../client/Bars";
import "./waiting.css";

// The coach's wait for a yes (26 Nov, Alex; /auth/waiting), in the coach sign-up's frame (SiteShell): `Request sent` as
// the title, their face and name, `Waiting for Norcoach` grey, and their email and Sign out at the foot. The page is
// read again every 20 seconds while it is in sight; once someone on staff accepts, the server sends them on.

const POLL_MS = 20_000;

export function CoachWaiting({ name, email, photo }: { name: string; email: string; photo: string | null }) {
  const router = useRouter();
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const t = window.setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [router]);

  return (
    <SiteShell
      title="Request sent"
      aside={
        <Bars
          parts={[
            <span key="e">{email}</span>,
            <a key="o" href="/auth/signout">
              Sign out
            </a>,
          ]}
        />
      }
    >
      <div className="cw-who" role="status">
        <span className="cw-face" aria-hidden="true">
          {photo ? (
            // eslint-disable-next-line @next/next/no-img-element -- the coach's own picture, served by the app
            <img src={`${photo}${photo.includes("?") ? "&" : "?"}w=192`} alt="" decoding="async" />
          ) : (
            name.trim().charAt(0).toUpperCase()
          )}
          <i className="cw-ring" />
        </span>
        <div>
          <b>{name}</b>
          <small>Waiting for Norcoach</small>
        </div>
      </div>
    </SiteShell>
  );
}
