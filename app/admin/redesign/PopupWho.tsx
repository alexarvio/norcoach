"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { DialogTitle } from "../../components/ui/dialog";
import { pic } from "../../lib/pic";
import { popupClientAction } from "./popupWhoActions";
import { clientScreenOf } from "./paths";

// A pop-up's title in C (22 Nov, Alex: docs/boards/admin-popups-c-mockup.html, "build them"): on a client's screens the
// client's face and `{Name} | {tab}` in small caps over the title, in the coach's dark; anywhere else the title alone.
// The client is the one the address names (/clients/<id>/<tab>), the tab the one it is on, so every pop-up says it the
// same way.

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

/** The client tab a pop-up was opened on: the shell keeps every tab mounted and switches them in place, the address
 *  path staying the one it loaded on, so each tab says its own name to the pop-ups inside it (22 Nov). */
const PopupTabContext = createContext<string | null>(null);
export function PopupTabZone({ tab, hidden, children }: { tab: string; hidden: boolean; children: ReactNode }) {
  return (
    <PopupTabContext.Provider value={tab}>
      <div hidden={hidden}>{children}</div>
    </PopupTabContext.Provider>
  );
}

type Who = { name: string; photo: string | null };
/** The client the screens are about, handed down by the page that already has them (the client shell), so a pop-up
 *  opens with its face and name drawn at once, never fetched as it opens (22 Nov, Alex: "a bit slow to open"). */
const PopupWhoContext = createContext<(Who & { id: number }) | null>(null);
export function PopupWhoProvider({ id, name, photo, children }: { id: number; name: string; photo: string | null; children: ReactNode }) {
  const value = useMemo(() => ({ id, name, photo }), [id, name, photo]);
  return <PopupWhoContext.Provider value={value}>{children}</PopupWhoContext.Provider>;
}
const known = new Map<number, Who | null>();

function useWho(): { who: Who; tab: string | null } | null {
  const path = usePathname();
  const zone = useContext(PopupTabContext);
  const given = useContext(PopupWhoContext);
  const screen = clientScreenOf(path);
  const id = screen?.clientId ?? 0;
  const [, bump] = useState(0);
  const has = Number.isInteger(id) && id > 0;
  const handed = given && (!has || given.id === id) ? given : null;
  useEffect(() => {
    // Fetched only where no page handed the client down (a screen outside the client shell).
    if (handed || !has || known.has(id)) return;
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
  }, [handed, has, id]);
  const who = handed ?? (has ? known.get(id) : null);
  if (!who) return null;
  const tab = zone ?? screen?.tab ?? null;
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
