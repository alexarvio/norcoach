import crypto from "crypto";
import { NextResponse } from "next/server";
import { requireCoach, createUser } from "../../../lib/auth";
import { getData, persist } from "../../../lib/db";

// The website's demo (ironline-demo only): a login for Emma Clarke, so her own app can be photographed.
export const dynamic = "force-dynamic";

export async function GET() {
  const coach = await requireCoach();
  const data = getData();
  const emma = data.clients.find((c) => c.coach_id === coach.id && c.name === "Emma Clarke");
  if (!emma) return NextResponse.json({ error: "no Emma" }, { status: 404 });
  let user = data.users.find((u) => u.client_id === emma.id);
  if (!user) {
    createUser("emma@demo.test", crypto.randomBytes(12).toString("base64url"), "client", emma.id, false);
    user = data.users.find((u) => u.client_id === emma.id);
  }
  emma.app_opened_at = emma.app_opened_at ?? new Date().toISOString();
  persist();
  return NextResponse.json({ ok: true, userId: user?.id });
}
