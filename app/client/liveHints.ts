// What the lock-screen pill (19 Nov, Alex; useLiveActivitySync) can't read from the workout's outbox: a rogue session
// started and Reopen (both straight to the server, never through the outbox), a rogue session dropped, and the name and
// gym of a session started here (the outbox's start carries neither). A hint stands until the server's answer from after
// it is in; one older than a session can last is let go.

export type LiveHint =
  | { at: number; dayId: number; live: true; startedMs: number; name: string; gymId: number | null }
  | { at: number; dayId: number; live: false };

const KEEP_MS = 12 * 3600_000;
let hints: LiveHint[] = [];
const names = new Map<number, { name: string; gymId: number | null }>();
const gymNames = new Map<number, string>();
let version = 0;
const listeners = new Set<() => void>();

function changed() {
  const cut = Date.now() - KEEP_MS;
  hints = hints.filter((h) => h.at >= cut).slice(-20);
  version++;
  listeners.forEach((l) => l());
}

/** A session going that the outbox never saw: a rogue session started, a session reopened (from its own start). */
export function hintLive(dayId: number, startedAt: string, name: string, gym: { id: number; name: string } | null) {
  const startedMs = Date.parse(startedAt);
  if (!Number.isFinite(startedMs)) return;
  if (gym) gymNames.set(gym.id, gym.name);
  names.set(dayId, { name, gymId: gym?.id ?? null });
  hints = [...hints, { at: Date.now(), dayId, live: true, startedMs, name, gymId: gym?.id ?? null }];
  changed();
}

/** A rogue session dropped or thrown away. */
export function hintGone(dayId: number) {
  hints = [...hints, { at: Date.now(), dayId, live: false }];
  changed();
}

/** A session started here: its name and gym, for the start the outbox carries. */
export function hintName(dayId: number, name: string, gym: { id: number; name: string } | null) {
  if (gym) gymNames.set(gym.id, gym.name);
  names.set(dayId, { name, gymId: gym?.id ?? null });
  changed();
}

/** A gym picked mid-session (a new one is not in the page's list yet). */
export function hintGym(gym: { id: number; name: string }) {
  if (gymNames.get(gym.id) === gym.name) return;
  gymNames.set(gym.id, gym.name);
  changed();
}

export const subscribeHints = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export const hintsVersion = () => version;
export const readHints = () => ({ hints, names, gymNames });
