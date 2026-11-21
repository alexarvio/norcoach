// The lock-screen pill's tap, handed inside the app (21 Nov, Alex: "pressing on the pill… makes the whole app refresh"):
// NativeLinks (and a tapped "still going" push, NativePush) send a link to /client?workout= here when the app's shell is
// open and listening, and the shell opens the workout in place (AppShell) instead of the page loading again. Before the
// shell listens (a cold start), they load the page as they always did.

const WORKOUT_ARRIVE = "norcoach:workout-arrive";
let listening = 0;

export type WorkoutArrive = { workout: number; finish: boolean };

/** The workout a link names, when it is the app's own /client?workout=, else null. */
export function workoutArriveOf(url: URL): WorkoutArrive | null {
  if (url.pathname !== "/client") return null;
  const workout = Number(url.searchParams.get("workout"));
  if (!url.searchParams.has("workout") || !Number.isInteger(workout)) return null;
  return { workout, finish: url.searchParams.get("finish") === "1" };
}

/** Hands the link to the open shell; false when it isn't one, or nothing is listening on /client (load it instead). */
export function arriveInPlace(url: URL): boolean {
  const arrive = workoutArriveOf(url);
  if (!arrive || !listening || window.location.pathname !== "/client") return false;
  window.dispatchEvent(new CustomEvent<WorkoutArrive>(WORKOUT_ARRIVE, { detail: arrive }));
  return true;
}

/** The shell's ear for it; the returned function stops listening. */
export function listenWorkoutArrive(handler: (arrive: WorkoutArrive) => void): () => void {
  const on = (e: Event) => {
    const d = (e as CustomEvent<WorkoutArrive>).detail;
    if (d && Number.isInteger(d.workout)) handler(d);
  };
  window.addEventListener(WORKOUT_ARRIVE, on);
  listening++;
  return () => {
    window.removeEventListener(WORKOUT_ARRIVE, on);
    listening--;
  };
}
