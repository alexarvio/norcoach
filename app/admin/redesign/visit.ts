// What only a real visit to a client's screens does (22 Nov): the rail fetches a client's page ahead while the pointer
// rests on their row (ViewLink), and Next's full prefetch is a server render no visit can be told from. So the page
// writes nothing for being drawn; RedesignShell calls visitClient once it is on screen, again for another client or
// route, and at most once a minute more while the page is re-read (a save's refresh). Sent as a plain POST to
// /api/admin/visit, never a server action: Next runs actions and refreshes one at a time, so a visit there would hold
// the coach's next save behind its round trip. Client-safe: no server imports.

/** Each client route's name on the presence board (/admin/presence), as its page.tsx said it. */
export const ROUTE_WHERE = {
  home: "Home",
  plan: "Plan",
  training: "Training",
  nutrition: "Nutrition",
  measurements: "Lifestyle",
  pictures: "Shape update",
  meetings: "Meetings",
  messages: "Messages",
  invoices: "Invoices",
} as const;
export type VisitRoute = keyof typeof ROUTE_WHERE;

/** A route key as sent: one of ROUTE_WHERE's own, never an inherited name ("constructor", "__proto__"). */
export const isVisitRoute = (route: unknown): route is VisitRoute => typeof route === "string" && Object.hasOwn(ROUTE_WHERE, route);

/** The coach has this client's page on screen, on this route. Fire and forget: nothing comes back, a failure is dropped,
 *  and keepalive lets it finish when the coach clicks on at once. */
export function visitClient(clientId: number, route: VisitRoute): void {
  try {
    void fetch("/api/admin/visit", {
      method: "POST",
      keepalive: true,
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId, route }),
    }).catch(() => {});
  } catch {}
}
