import { NextResponse } from "next/server";
import { requireCoach } from "../../../lib/auth";
import { buildDemoClient } from "../../../lib/demoClient";
import { EXAMPLE_NAME } from "../../../lib/exampleClient";

// Local development only: builds "Demo Client", a lived-in client for looking
// at the coach screens with something on them (lib/demoClient.ts). Calling it
// again removes the previous Demo Client and builds a fresh one. Refuses
// anywhere but a dev machine, so it can never run on live.
//   GET http://localhost:3000/api/dev/seed-demo   (signed in as the coach)
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (process.env.NODE_ENV === "production" || process.env.RAILWAY_ENVIRONMENT) return new NextResponse("Not here.", { status: 403 });
  const coach = await requireCoach();
  // ?example=1: the coach's example client as a new coach gets it (lib/exampleClient.ts), to look at the onboarding.
  if (new URL(request.url).searchParams.get("example") === "1") {
    const id = await buildDemoClient(coach.id, EXAMPLE_NAME, { example: true });
    return NextResponse.json({ ok: true, clientId: id, open: `/clients/${id}/home` });
  }
  const id = await buildDemoClient(coach.id, "Demo Client");
  return NextResponse.json({ ok: true, clientId: id, open: `/admin?client=${id}&tab=training` });
}
