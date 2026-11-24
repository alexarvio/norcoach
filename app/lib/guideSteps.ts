// A help guide's steps (24 Nov, Alex: docs/boards/help-docked-mockup.html, "the step the video is on is in ink"). Pure,
// with no imports: the server (lib/guides.ts), the owner's editor on Coaches and the help panel all read it.
//
// A step is its words, and may carry the moment in the video it starts at. Kept as it always was for a step without
// one (a plain string, so every guide saved before reads as before), and as { text, at } (seconds) for one with one.
// The owner types a timed step as a line starting with its time: `0:45 Open the Training tab`, `1:02:30 …`.

export type GuideStep = string | { text: string; at: number };

export const stepText = (s: GuideStep): string => (typeof s === "string" ? s : String(s?.text ?? ""));
export const stepAt = (s: GuideStep): number | null => (typeof s === "string" || !Number.isFinite(Number(s?.at)) || Number(s.at) < 0 ? null : Number(s.at));

/** Seconds as a clock: `0:45`, `4:30`, `1:02:30`. */
export function clockOf(seconds: number): string {
  const t = Math.max(0, Math.floor(seconds));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

// `0:45 words`, `1:52 – words`, `1:02:30 | words`: the time, then a space or a dash, bar or dot, then the words.
const TIMED = /^(?:(\d{1,2}):)?(\d{1,3}):([0-5]\d)(?:\s*[-–—|·.]\s*|\s+)(\S.*)$/;

/** A line as the editor holds it, as a step: timed when it starts with its time and has words after it. Null for an
 *  empty line. */
export function parseStepLine(line: string, maxText = 300): GuideStep | null {
  const s = String(line ?? "").trim().replace(/\s+/g, " ");
  if (!s) return null;
  const m = TIMED.exec(s);
  if (!m) return s.slice(0, maxText);
  const at = Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  const text = m[4].trim().slice(0, maxText);
  return text ? { text, at } : null;
}

/** A step kept, cleaned (a plain line parsed for its time, a timed one checked). Null when it has no words. */
export function cleanStep(v: unknown, maxText = 300): GuideStep | null {
  if (v && typeof v === "object") {
    const text = String((v as { text?: unknown }).text ?? "").trim().replace(/\s+/g, " ").slice(0, maxText);
    if (!text) return null;
    const at = Number((v as { at?: unknown }).at);
    return Number.isFinite(at) && at >= 0 ? { text, at: Math.min(6 * 3600, Math.round(at)) } : text;
  }
  return parseStepLine(String(v ?? ""), maxText);
}

/** A step as the editor shows it: its time first when it has one. */
export const stepLine = (s: GuideStep): string => {
  const at = stepAt(s);
  return at == null ? stepText(s) : `${clockOf(at)} ${stepText(s)}`;
};

/** Whether any step carries a time. */
export const hasTimedSteps = (steps: readonly GuideStep[]): boolean => steps.some((s) => stepAt(s) != null);

/** The step the video is on at `t` seconds: the timed step with the latest time that has come (the later one in the
 *  list on a tie, so steps typed out of order still follow the video), else -1 (none yet, or none timed). */
export function stepIndexAt(steps: readonly GuideStep[], t: number): number {
  let at = -1;
  let best = -Infinity;
  steps.forEach((s, i) => {
    const a = stepAt(s);
    if (a != null && a <= t + 0.25 && a >= best) {
      best = a;
      at = i;
    }
  });
  return at;
}
