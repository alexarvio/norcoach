import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { requireCoach } from "../../../lib/auth";
import { buildDemoClient } from "../../../lib/demoClient";
import { getData, persist, DATA_DIR } from "../../../lib/db";
import { createClient, saveWeightGoal, removeClient, sendChatMessage } from "../../../lib/queries";
import { setFocus } from "../../../lib/focus";
import { fetchClientCheckIns } from "../../../lib/checkins/rows";

// The website's demo (ironline-demo only, never the real repo): Finlay, Full Potential Coaching, with Emma Clarke lived
// in and a list of made-up clients, so the website's laptop pictures are taken from today's admin.
export const dynamic = "force-dynamic";

const SITE_AVATARS = "C:/Users/alexa/Downloads/ironline_new/ironline/website/img/avatars";
const OTHERS: [string, string, string][] = [
  ["Adam Hughes", "adam", "male"], ["Ben Carter", "ben", "male"], ["Chloe Martin", "chloe", "female"], ["Daniel Reid", "daniel", "male"],
  ["Grace Wilson", "grace", "female"], ["Hannah Lee", "hannah", "female"], ["Jack Turner", "jack", "male"], ["James Moore", "james", "male"],
  ["Lucy Evans", "lucy", "female"], ["Mia Scott", "mia", "female"], ["Oliver King", "oliver", "male"], ["Sara Novak", "sara", "female"],
  ["Tom Baker", "tom", "male"], ["Zoe Hall", "zoe", "female"],
];
// A recent word from a few of them, so the rail and the Feed hold what a real Tuesday does.
const WORDS: Record<string, string> = {
  "Ben Carter": "Can we move Thursday's call to Friday?",
  "Daniel Reid": "Knee felt a bit off on the lunges today.",
  "Hannah Lee": "Hit 8k steps every day this week!",
  "James Moore": "Is it ok to swap the leg press for hack squats?",
  "Oliver King": "Sent you a video of my deadlift.",
  "Sara Novak": "Feeling great on the new plan.",
};

async function face(file: string, folder: string, id: number): Promise<string> {
  const sharp = (await import("sharp")).default;
  const dir = path.join(DATA_DIR, "uploads", folder, String(id));
  fs.mkdirSync(dir, { recursive: true });
  const src = fs.existsSync(path.join(SITE_AVATARS, `${file}.jpg`)) ? path.join(SITE_AVATARS, `${file}.jpg`) : path.join(SITE_AVATARS, `${file}.svg`);
  await sharp(src, { density: 300 }).resize(256, 256).flatten({ background: "#e8eaee" }).jpeg({ quality: 85 }).toFile(path.join(dir, "face.jpg"));
  return `/uploads/${folder}/${id}/face.jpg?v=${Date.now()}`;
}

export async function GET() {
  const coach = await requireCoach();
  const data = getData();
  const user = data.users.find((u) => u.id === coach.id)!;
  user.coach_settings = { ...(user.coach_settings ?? {}), business: { ...(user.coach_settings?.business ?? {}), business_name: "Full Potential Coaching" } };
  let profile = data.coach_profiles.find((p) => p.coach_id === coach.id);
  if (!profile) {
    profile = { coach_id: coach.id } as (typeof data.coach_profiles)[number];
    data.coach_profiles.push(profile);
  }
  profile.display_name = "Finlay Chedd";
  profile.avatar_path = await face("finlay", "coaches", coach.id);
  persist();

  for (const c of data.clients.filter((c) => c.coach_id === coach.id && c.name !== "Emma Clarke")) await removeClient(c.id);
  const emma = await buildDemoClient(coach.id, "Emma Clarke");
  const row = data.clients.find((c) => c.id === emma)!;
  row.gender = "female";
  row.avatar_path = await face("emma", "avatars", emma);
  row.app_opened_at = new Date().toISOString();
  persist();
  const ck = await fetchClientCheckIns(emma, "dev.seed");
  const goal = saveWeightGoal(ck, emma, { targetKg: 74, unit: "kg", byDate: "2026-12-20" }, { who: "coach", userId: coach.id });
  if (typeof goal === "object") {
    goal.start_kg = 79.8;
    const start = new Date();
    start.setDate(start.getDate() - 35);
    goal.start_date = start.toISOString().slice(0, 10);
  }
  setFocus(emma, ["Film your top set of squats", "8,000 steps every day", "Protein at every meal"]);
  persist();

  for (const [name, file, gender] of OTHERS) {
    const c = createClient(name, coach.id);
    const r = data.clients.find((x) => x.id === c.id)!;
    r.gender = gender;
    r.avatar_path = await face(file, "avatars", c.id);
    r.app_opened_at = new Date().toISOString();
    persist();
    if (WORDS[name]) {
      const at = new Date(Date.now() - (1 + Object.keys(WORDS).indexOf(name)) * 3600_000);
      await sendChatMessage(c.id, "client", WORDS[name], undefined, null, null, { createdAt: at.toISOString(), path: "w.insert.demo" });
    }
  }
  persist();
  return NextResponse.json({ ok: true, emma, open: `/clients/${emma}/home` });
}
