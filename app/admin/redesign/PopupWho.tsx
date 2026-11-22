"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { DialogTitle } from "../../components/ui/dialog";
import { pic } from "../../lib/pic";
import { popupClientAction } from "./popupWhoActions";

// A pop-up's title in C (22 Nov, Alex: docs/boards/admin-popups-c-mockup.html, "build them"): on a client's screens the
// client's face and `{Name} | {tab}` in small caps over the title, in the coach's dark; anywhere else the title alone.
// The client is the one the address names (?client=), the tab the one it is on, so every pop-up says it the same way.

const TAB_WORD: Record<string, string> = {
  home: "Home",
  plan: "Plan",
  measurements: "Lifestyle",
  training: "Training",
  nutrition: "Nutrition",
  pictures: "Shape update",
  meetings: "Meetings",
  invoices: "Invoices",
};
/** The tab's colour, lightened for the dark (the tracks' own; the rest a soft white). */
const TAB_COLOUR: Record<string, string> = {
  measurements: "#dcc89e",
  training: "#b3adf5",
  nutrition: "#7fd1c4",
  meetings: "#8fb4ff",
  pictures: "#f2a888",
};

type Who = { name: string; photo: string | null };
const known = new Map<number, Who | null>();

function useWho(): { who: Who; tab: string | null } | null {
  const params = useSearchParams();
  const path = usePathname();
  const id = Number(params?.get("client"));
  const [, bump] = useState(0);
  const has = Number.isInteger(id) && id > 0;
  useEffect(() => {
    if (!has || known.has(id)) return;
    let alive = true;
    popupClientAction(id)
      .then((w) => {
        known.set(id, w);
        if (alive) bump((n) => n + 1);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [has, id]);
  const who = has ? known.get(id) : null;
  if (!who) return null;
  const seg = path?.match(/\/admin\/redesign\/([a-z]+)/)?.[1] ?? null;
  const tab = seg === "home" ? params?.get("tab") ?? "home" : seg;
  return { who, tab };
}

/** The title of a `.dlh` or `.npd` pop-up: with the client's face and name over it on their screens. */
export function PopupTitle({ children, className = "dlh-title", what }: { children: ReactNode; className?: string; /** In place of the tab's name, when the pop-up is about something narrower ("Week 7", "Upper"). */ what?: string }) {
  const w = useWho();
  if (!w) return <DialogTitle className={className}>{children}</DialogTitle>;
  const word = what ?? (w.tab ? TAB_WORD[w.tab] : null);
  const first = w.who.name.trim().charAt(0).toUpperCase() || "?";
  return (
    <div className="dlh-whohead" style={w.tab && TAB_COLOUR[w.tab] ? ({ "--who-c": TAB_COLOUR[w.tab] } as React.CSSProperties) : undefined}>
      <span className="dlh-whoface" aria-hidden="true">
        {w.who.photo ? <img src={pic(w.who.photo, 96)} alt="" decoding="async" /> : first}
      </span>
      <div>
        <span className="dlh-whoeye">{word ? `${w.who.name} | ${word}` : w.who.name}</span>
        <DialogTitle className={className}>{children}</DialogTitle>
      </div>
    </div>
  );
}
