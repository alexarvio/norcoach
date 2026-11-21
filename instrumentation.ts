import * as Sentry from "@sentry/nextjs";
import { sentryOptions } from "./app/lib/sentryOptions";

// Errors thrown while rendering, in server actions and in route handlers go
// to Sentry (settings in app/lib/sentryOptions.ts).
export const onRequestError = Sentry.captureRequestError;

// Runs once when the server starts. Starts Sentry, then schedules the nightly
// backup and, if the bucket has no snapshot for today yet, takes one shortly
// after boot, so a deploy never leaves a day uncovered.
export async function register() {
  Sentry.init(sentryOptions);
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Postgres mode (STORE=postgres) loads the data before the server takes
  // any request; in JSON mode this does nothing.
  const { initStore } = await import("./app/lib/pg/runtime");
  await initStore();
  // On SIGTERM / SIGINT: save at once, end the chat streams, and hold the exit until the last save is in (17 Nov).
  // Not in `next build`'s prerender workers (which run register too): Ctrl+C there must not wait 12 s.
  if (process.env.NEXT_PHASE !== "phase-production-build") {
    const { registerShutdown } = await import("./app/lib/shutdown");
    registerShutdown();
  }
  // The clients' check-in reminders (17 Nov, mission 2): they ran inside the root layout's render, so every request paid
  // for them; now once ~20 s after start and every minute, so one still comes in within the minute its day, week or
  // photo period opens, and goes once it is no longer due. Not in `next build`'s prerender workers.
  if (process.env.NEXT_PHASE !== "phase-production-build") {
    // Fetches the notes it reads first since quest 7 (app/lib/notes/rows.ts), so it answers a promise; one tick at a time.
    const { runClientReminders } = await import("./app/lib/queries");
    const remindCheckIns = () => {
      void runClientReminders().catch((e) => console.error("[reminders] check-in reminders failed:", e instanceof Error ? e.message : e));
    };
    setInterval(remindCheckIns, 60_000).unref?.();
    setTimeout(remindCheckIns, 20_000).unref?.();
    // The read reminders over 30 days old deleted (19 Nov, Alex; app/lib/notes/prune.ts): once a night at 04:30, after
    // the 03:15 backup, in the background; one at a time (the door's own guard), and a failure waits for the next night.
    // Only where the nightly backup is (BACKUP_*), and only once tonight's snapshot is in the bucket, so what goes is in
    // the night's copy: never on a local copy with none. NOTES_PRUNE=off stops it; =on runs it with no backup too.
    const { backupConfigured, backupTakenToday } = await import("./app/lib/backup");
    const pruneAsked = process.env.NOTES_PRUNE;
    if (pruneAsked === "on" || (pruneAsked !== "off" && backupConfigured())) {
      const { runReminderPrune } = await import("./app/lib/queries");
      const { msUntilPrune } = await import("./app/lib/notes/prune");
      const { pruneBooked } = await import("./app/lib/notes/rows");
      const pruneTonight = async () => {
        if (backupConfigured() && !(await backupTakenToday())) return console.log("[reminders] clean-up skipped tonight (no backup in the bucket for today)");
        const n = await runReminderPrune();
        console.log(n == null ? "[reminders] clean-up skipped tonight (a check-in tick or a clean-up still running)" : `[reminders] clean-up: ${n} read reminder${n === 1 ? "" : "s"} over 30 days old deleted`);
      };
      const pruneNightly = () => {
        // Worked out from a minute on, so a timer fired a hair early never runs it twice the same night.
        const wait = 60_000 + msUntilPrune(new Date(Date.now() + 60_000));
        pruneBooked(Date.now() + wait);
        setTimeout(() => {
          pruneBooked(null);
          void pruneTonight()
            .catch((e) => console.error("[reminders] clean-up failed:", e instanceof Error ? e.message : e))
            .finally(pruneNightly);
        }, wait).unref?.();
      };
      pruneNightly();
    }
  }
  // Storage bucket on (UPLOADS_STORE=bucket): copy any files the bucket does
  // not have yet, in the background so the server starts straight away.
  const { copyDiskUploadsToBucket } = await import("./app/lib/storage");
  void copyDiskUploadsToBucket().catch((e) => console.error("[uploads] copy to bucket failed:", e instanceof Error ? e.message : e));
  // Every chat and exercise picture's and video's poster, copies and look made ahead (25 Oct), a while after start.
  const { prepareAllChatMedia } = await import("./app/lib/storage");
  setTimeout(() => {
    void prepareAllChatMedia()
      .then((n) => console.log(`[uploads] media prepared ahead: ${n} made`))
      .catch((e) => console.error("[uploads] preparing media failed:", e instanceof Error ? e.message : e));
  }, 30_000).unref?.();
  // Reminder pushes for booked calls (a day and an hour before), checked
  // every five minutes on the live server.
  const { meetingRemindersOn, runMeetingReminders } = await import("./app/lib/meetingReminders");
  if (meetingRemindersOn()) {
    const remind = () =>
      void runMeetingReminders()
        .then((n) => n && console.log(`[reminders] sent ${n}`))
        .catch((e) => console.error("[reminders] failed:", e instanceof Error ? e.message : e));
    setInterval(remind, 5 * 60_000).unref?.();
    setTimeout(remind, 90_000).unref?.();
  }
  // A session left running (19 Nov, Alex: "I forget to complete the workout"): "Upper is still going" 60 min and 3 h
  // after its last set, every five minutes on the live server, as the call reminders (app/lib/workoutReminders.ts).
  const { workoutRemindersOn, runWorkoutReminders } = await import("./app/lib/workoutReminders");
  if (workoutRemindersOn() && process.env.NEXT_PHASE !== "phase-production-build") {
    let busy = false;
    const remindWorkouts = () => {
      if (busy) return;
      busy = true;
      void runWorkoutReminders()
        .then((n) => n && console.log(`[reminders] workouts: sent ${n}`))
        .catch((e) => console.error("[reminders] workouts failed:", e instanceof Error ? e.message : e))
        .finally(() => {
          busy = false;
        });
    };
    setInterval(remindWorkouts, 5 * 60_000).unref?.();
    setTimeout(remindWorkouts, 120_000).unref?.();
  }
  // A client's quiet hours (19 Nov, Alex: Settings · Notifications; app/lib/push.ts): what was held is sent once they
  // end, the newest of each, checked every minute on the live server (NOTIF_HOLD, as the reminders).
  const { notifHoldOn, releaseHeldPushes } = await import("./app/lib/push");
  if (notifHoldOn() && process.env.NEXT_PHASE !== "phase-production-build") {
    let busy = false;
    const release = () => {
      if (busy) return;
      busy = true;
      void releaseHeldPushes()
        .then((n) => n && console.log(`[push] quiet hours over: sent ${n} held`))
        .catch((e) => console.error("[push] releasing held pushes failed:", e instanceof Error ? e.message : e))
        .finally(() => {
          busy = false;
        });
    };
    setInterval(release, 60_000).unref?.();
    setTimeout(release, 45_000).unref?.();
  }
  // The locked app (19 Nov, Alex: "first phase"; app/lib/appLock.ts): a client let in whose first phase has begun (one
  // scheduled for today) opens, with `Your app is ready` pushed once, every five minutes on the live server.
  const { appLockPushOn, checkAppLocks } = await import("./app/lib/appLock");
  if (appLockPushOn() && process.env.NEXT_PHASE !== "phase-production-build") {
    let busy = false;
    const openLocks = () => {
      if (busy) return;
      busy = true;
      void checkAppLocks()
        .then((n) => n && console.log(`[app-lock] opened ${n}`))
        .catch((e) => console.error("[app-lock] failed:", e instanceof Error ? e.message : e))
        .finally(() => {
          busy = false;
        });
    };
    setInterval(openLocks, 5 * 60_000).unref?.();
    setTimeout(openLocks, 150_000).unref?.();
  }
  // Recurring invoices (21 Oct): each series makes its next invoice on its day, checked every ten minutes. Locally
  // too, so a series can be seen working; the client's buzz for a sent one only from the live server (as reminders).
  if (process.env.RECURRING_INVOICES !== "off") {
    const { runRecurringInvoices } = await import("./app/lib/queries");
    const buzz = meetingRemindersOn();
    const make = () => {
      try {
        const n = runRecurringInvoices(undefined, buzz);
        if (n) console.log(`[invoices] made ${n} recurring`);
      } catch (e) {
        console.error("[invoices] recurring failed:", e instanceof Error ? e.message : e);
      }
    };
    setInterval(make, 10 * 60_000).unref?.();
    setTimeout(make, 60_000).unref?.();
  }
  const { runBackup, msUntilNextRun, backupConfigured } = await import("./app/lib/backup");
  // Deleted uploads wait in trash for 30 days (18 Nov, step 4D, lib/storage.ts): every night at the backup's hour the
  // days past that go, with or without a backup; a few minutes after boot, what the disk's trash holds goes up to the
  // bucket's. Not in `next build`'s prerender workers.
  if (process.env.NEXT_PHASE !== "phase-production-build") {
    const { pruneTrash, trashToBucket } = await import("./app/lib/storage");
    const prune = () =>
      void pruneTrash()
        .then((n) => n && console.log(`[uploads] trash: ${n} file${n === 1 ? "" : "s"} older than 30 days deleted`))
        .catch((e) => console.error("[uploads] trash prune failed:", e instanceof Error ? e.message : e));
    const nightly = () => {
      setTimeout(() => {
        prune();
        nightly();
      }, msUntilNextRun()).unref?.();
    };
    nightly();
    setTimeout(() => void trashToBucket().catch(() => {}), 5 * 60_000).unref?.();
  }
  if (!backupConfigured()) return;

  const run = async (why: string) => {
    try {
      const r = await runBackup();
      if (r)
        console.log(
          `[backup] ${why}: ${r.snapshot}, uploads +${r.uploadsCopied} (${r.uploadsSkipped} already there), pruned ${r.pruned}` +
            (r.pg ? `; Postgres ${r.pg.prefix}: ${r.pg.tables} tables, ${r.pg.rows} rows, pruned ${r.pg.pruned}` : "")
        );
    } catch (e) {
      console.error(`[backup] ${why} failed:`, e instanceof Error ? e.message : e);
    }
  };

  const schedule = () => {
    const wait = msUntilNextRun();
    setTimeout(async () => {
      await run("nightly");
      schedule();
    }, wait).unref?.();
  };

  // A minute after boot, then every night at 03:15 server time.
  setTimeout(() => void run("after start"), 60_000).unref?.();
  schedule();
}
