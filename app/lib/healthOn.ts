import "server-only";
import { getData, persist } from "./db";

// Whether a client turned their phone's health store on (23 Nov, Alex: "my apple health got disconnected from the app").
// The switch lived in the app's web storage alone (app/client/HealthSync.tsx), which iOS may wipe for a site loaded in
// an app (storage pressure, a week without a visit, a reinstall); the phone's own permission stays, so only our mark
// was lost. Kept here as well, a row a client and phone kind, so the app turns it back on by itself. Not a Postgres
// table of its own: a top-level value of the store, kept in `kv` as every such value is.

export type HealthStore = "apple" | "google";
type HealthOnRow = { client_id: number; store: HealthStore; on: boolean; at: string };
type WithHealthOn = { health_on?: HealthOnRow[] };

const rows = (): HealthOnRow[] => {
  const data = getData() as unknown as WithHealthOn;
  if (!Array.isArray(data.health_on)) data.health_on = [];
  return data.health_on;
};

/** Note the switch for this client's phone kind; a write only when it changes. */
export function setHealthOn(clientId: number, store: HealthStore, on: boolean): void {
  const list = rows();
  const was = list.find((r) => r.client_id === clientId && r.store === store);
  if (was?.on === on) return;
  if (was) Object.assign(was, { on, at: new Date().toISOString() });
  else list.push({ client_id: clientId, store, on, at: new Date().toISOString() });
  persist();
}

/** Whether this client last had their phone kind's health store on. */
export function healthWasOn(clientId: number, store: HealthStore): boolean {
  return rows().some((r) => r.client_id === clientId && r.store === store && r.on);
}

/** A client erased: their rows go too. */
export function dropHealthOn(clientId: number): void {
  const data = getData() as unknown as WithHealthOn;
  if (!data.health_on?.some((r) => r.client_id === clientId)) return;
  data.health_on = data.health_on.filter((r) => r.client_id !== clientId);
  persist();
}
