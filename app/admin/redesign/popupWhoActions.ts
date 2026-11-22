"use server";

import { coachForClient } from "../../lib/auth";
import { getData } from "../../lib/db";

/** The client a pop-up is about, for its dark head (PopupWho.tsx): their name and picture. Null for one not this coach's. */
export async function popupClientAction(clientId: number): Promise<{ name: string; photo: string | null } | null> {
  const id = Number(clientId);
  if (!Number.isInteger(id) || !(await coachForClient(id))) return null;
  const c = getData().clients.find((x) => x.id === id);
  return c ? { name: c.name, photo: c.avatar_path ?? null } : null;
}
