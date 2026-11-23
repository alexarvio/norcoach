"use server";

import { requireClient } from "../lib/auth";
import { healthWasOn, setHealthOn, type HealthStore } from "../lib/healthOn";

// The phone's health switch, kept on the server too (23 Nov, lib/healthOn.ts), so a wiped web storage doesn't switch
// it off. Only the signed-in client's own row.

const storeOf = (s: unknown): HealthStore | null => (s === "apple" || s === "google" ? s : null);

export async function setHealthOnAction(store: HealthStore, on: boolean): Promise<void> {
  const kind = storeOf(store);
  if (!kind) return;
  const { clientId } = await requireClient();
  setHealthOn(clientId, kind, !!on);
}

export async function healthWasOnAction(store: HealthStore): Promise<boolean> {
  const kind = storeOf(store);
  if (!kind) return false;
  const { clientId } = await requireClient();
  return healthWasOn(clientId, kind);
}
