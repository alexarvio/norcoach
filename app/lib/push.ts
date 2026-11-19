import { and, eq, inArray, sql } from "drizzle-orm";
import webpush from "web-push";
import { pg } from "./pg/direct";
import { push_subscriptions } from "./pg/schema";
import { getData, persistNow } from "./db";
import type { NotifGroup } from "./notifGroups";
import { fcmConfigured, sendFcm } from "./fcm";
import { apnsConfigured, sendApns } from "./apns";

// Push notifications: the lock-screen kind, delivered while the app is shut.
//
// A device that says yes gets an address from its delivery service (the
// browser's push service, Firebase for the Android app (lib/fcm.ts), Apple's
// for the iPhone app (lib/apns.ts)). The app
// posts that address to /api/push, it is kept in push_subscriptions, and
// sendPush() hands a short message to the delivery service for every device
// the user has. An address the service reports as gone (the app was removed,
// or notifications turned off) is deleted on the spot.
//
// Web push needs a VAPID key pair, which identifies this server to the push
// services: VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY, made once with
//   npx web-push generate-vapid-keys
// Without them, or without Postgres, push is off and every call here is a
// quiet no-op, so nothing else depends on it being set up.

export type PushMessage = {
  title: string;
  body: string;
  // Where tapping the notification opens.
  url: string;
  // Notifications with the same tag replace each other on the lock screen
  // instead of piling up.
  tag?: string;
  /** How long the push services may hold it for a phone that is off (19 Nov, Alex: a workout's "still going" is
      stale within half an hour). A day when absent. */
  ttlSeconds?: number;
  /** A client's push by its Settings · Notifications group (19 Nov, Alex; app/lib/notifGroups.ts): dropped while that
      group is switched off, held in their quiet hours. "always": neither (a workout left running, Your app is ready).
      Absent: as "always". Never sent to the phone. */
  group?: NotifGroup | "always";
};

const DAY_SECONDS = 24 * 60 * 60;
/** The seconds a message may wait, from its own ttlSeconds or a day (the web, Firebase and Apple alike). */
export function pushTtlSeconds(message: PushMessage): number {
  const t = message.ttlSeconds;
  return typeof t === "number" && Number.isFinite(t) && t > 0 ? Math.round(t) : DAY_SECONDS;
}

export type WebSubscription = { endpoint: string; keys: { p256dh: string; auth: string } };

/** The public half of the key pair, which the browser needs to subscribe; null when push is off. */
export function pushPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY?.trim() || null;
}

function vapid() {
  const publicKey = pushPublicKey();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  if (!publicKey || !privateKey) return null;
  // Push services want a way to reach whoever runs the server.
  const owner = process.env.OWNER_EMAIL?.trim();
  const subject = process.env.VAPID_SUBJECT?.trim() || (owner ? `mailto:${owner}` : "mailto:push@ironline.invalid");
  return { subject, publicKey, privateKey };
}

/** Saves a device's subscription for this user; the same device signing in as someone else moves to them. */
export async function saveWebSubscription(userId: number, sub: WebSubscription, userAgent: string | null) {
  const db = await pg();
  if (!db) return;
  const row = { user_id: userId, kind: "web" as const, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, user_agent: userAgent };
  await db
    .insert(push_subscriptions)
    .values(row)
    .onConflictDoUpdate({ target: push_subscriptions.endpoint, set: { user_id: row.user_id, p256dh: row.p256dh, auth: row.auth, user_agent: row.user_agent } });
}

/** Which phone apps this server can send to: the Android app through Firebase, the iPhone app through Apple. */
export function nativePushReady(): { android: boolean; ios: boolean } {
  return { android: fcmConfigured(), ios: apnsConfigured() };
}

/** Saves a phone app's token for this user (Firebase's on Android, Apple's on an iPhone), the same way. */
export async function saveNativeToken(userId: number, kind: "fcm" | "apns", token: string, userAgent: string | null) {
  const db = await pg();
  if (!db) return;
  await db
    .insert(push_subscriptions)
    .values({ user_id: userId, kind, endpoint: token, user_agent: userAgent })
    .onConflictDoUpdate({ target: push_subscriptions.endpoint, set: { user_id: userId, kind, user_agent: userAgent } });
}

/** Forgets a device (the user turned notifications off on it). Only their own. */
export async function removeSubscription(userId: number, endpoint: string) {
  const db = await pg();
  if (!db) return;
  await db.delete(push_subscriptions).where(and(eq(push_subscriptions.user_id, userId), eq(push_subscriptions.endpoint, endpoint)));
}

/** Forgets every device of these users (their account is being deleted). */
export async function removeAllSubscriptions(userIds: number[]) {
  const db = await pg();
  if (!db || userIds.length === 0) return;
  await db.delete(push_subscriptions).where(inArray(push_subscriptions.user_id, userIds));
}

/** Whether this device is subscribed for this user. */
export async function hasSubscription(userId: number, endpoint: string): Promise<boolean> {
  const db = await pg();
  if (!db) return false;
  const rows = await db
    .select({ id: push_subscriptions.id })
    .from(push_subscriptions)
    .where(and(eq(push_subscriptions.user_id, userId), eq(push_subscriptions.endpoint, endpoint)));
  return rows.length > 0;
}

/** Sends to every device the user has; returns how many took it. A client's push whose group is switched off goes
 *  nowhere; one in their quiet hours is held and sent when they end (releaseHeldPushes). */
export async function sendPush(userId: number, message: PushMessage): Promise<number> {
  if (!vapid() && !fcmConfigured() && !apnsConfigured()) return 0;
  const gate = await clientGate(userId, message);
  if (gate === "drop") return 0;
  if (gate === "hold") {
    holdPush(userId, message);
    // Saved before the answer, so a crash right after never loses it.
    await persistNow().catch(() => {});
    return 0;
  }
  return deliver(userId, message);
}

/** Sends to every device the user has, asking no switch or quiet hours; returns how many took it. */
async function deliver(userId: number, message: PushMessage): Promise<number> {
  const keys = vapid();
  const db = await pg();
  if (!db || (!keys && !fcmConfigured() && !apnsConfigured())) return 0;
  const devices = await db.select().from(push_subscriptions).where(eq(push_subscriptions.user_id, userId));
  const web = keys ? devices.filter((d) => d.kind === "web" && d.p256dh && d.auth) : [];
  const fcm = fcmConfigured() ? devices.filter((d) => d.kind === "fcm") : [];
  const apns = apnsConfigured() ? devices.filter((d) => d.kind === "apns") : [];
  if (web.length === 0 && fcm.length === 0 && apns.length === 0) return 0;

  const { ttlSeconds: _ttl, group: _group, ...shown } = message;
  const payload = JSON.stringify(shown);
  const ttl = pushTtlSeconds(message);
  const gone: number[] = [];
  const sent: number[] = [];
  await Promise.all(
    web.map(async (d) => {
      try {
        await webpush.sendNotification({ endpoint: d.endpoint, keys: { p256dh: d.p256dh!, auth: d.auth! } }, payload, {
          vapidDetails: keys!,
          // Hold it for a day if the phone is off (less when the message says so); after that it's stale news.
          TTL: ttl,
          urgency: "normal",
        });
        sent.push(d.id);
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        // 404/410: the address no longer exists. Anything else is the push
        // service having a bad moment; the device stays for next time.
        if (status === 404 || status === 410) gone.push(d.id);
        else console.error(`[push] sending to device ${d.id} failed (${status ?? "no status"}):`, error instanceof Error ? error.message : error);
      }
    })
  );
  await Promise.all(
    fcm.map(async (d) => {
      const r = await sendFcm(d.endpoint, message).catch((error) => {
        console.error(`[push] sending to device ${d.id} failed:`, error instanceof Error ? error.message : error);
        return "failed" as const;
      });
      if (r === "sent") sent.push(d.id);
      else if (r === "gone") gone.push(d.id);
    })
  );
  await Promise.all(
    apns.map(async (d) => {
      const r = await sendApns(d.endpoint, message).catch((error) => {
        console.error(`[push] sending to device ${d.id} failed:`, error instanceof Error ? error.message : error);
        return "failed" as const;
      });
      if (r === "sent") sent.push(d.id);
      else if (r === "gone") gone.push(d.id);
    })
  );
  if (gone.length) await db.delete(push_subscriptions).where(inArray(push_subscriptions.id, gone));
  if (sent.length) await db.update(push_subscriptions).set({ last_sent_at: sql`now()` }).where(inArray(push_subscriptions.id, sent));
  return sent.length;
}

/** sendPush for callers that can't wait: never throws, errors go to the log and Sentry. */
export function sendPushInBackground(userId: number, message: PushMessage) {
  sendPush(userId, message).catch((error) => {
    console.error("[push] send failed:", error);
    import("@sentry/nextjs").then((Sentry) => Sentry.captureException(error)).catch(() => {});
  });
}

// ---- A client's switches and quiet hours (19 Nov, Alex: Settings · Notifications) -----------------------------------
// A group switched off: the push goes nowhere (the bell keeps the notification). In quiet hours: held, the newest of each
// tag kept, and sent at once when they end (releaseHeldPushes, from instrumentation.ts). Held in `kv` (notif_held), so a
// deploy at night loses none. The coach's own pushes have their own rules (coachPush.ts).

type Held = { m: PushMessage; at: number };
type HeldBox = Record<string, Record<string, Held>>;
const HELD_KEY = "notif_held";
/** Nothing waits longer than its own life (ttlSeconds, a day when absent), nor two days in any case. */
const HELD_MAX_MS = 2 * 24 * 60 * 60 * 1000;

function heldBox(): HeldBox {
  // chat-door: notes-door: food-door: its own key alone (notif_held); no chat, notifications or food.
  const d = getData() as unknown as Record<string, unknown>;
  const box = d[HELD_KEY];
  if (box && typeof box === "object" && !Array.isArray(box)) return box as HeldBox;
  const fresh: HeldBox = {};
  d[HELD_KEY] = fresh;
  return fresh;
}

async function clientGate(userId: number, message: PushMessage): Promise<"send" | "drop" | "hold"> {
  const group = message.group;
  if (!group || group === "always") return "send";
  const user = getData().users.find((u) => u.id === userId);
  if (!user || user.role !== "client" || user.client_id == null) return "send";
  const { pushGroupOn, clientInQuiet } = await import("./notifPrefs");
  if (!pushGroupOn(user.client_id, group)) return "drop";
  // Held only where the release timer runs (19 Nov): elsewhere nothing would ever send it, so it goes now.
  return clientInQuiet(user.client_id) && notifHoldOn() ? "hold" : "send";
}

const heldTag = (m: PushMessage) => m.tag || `url:${m.url}`;
const stale = (h: Held, now: number) => now - h.at >= Math.min(pushTtlSeconds(h.m) * 1000, HELD_MAX_MS);

function holdPush(userId: number, message: PushMessage) {
  const box = heldBox();
  const now = Date.now();
  const mine = (box[String(userId)] ??= {});
  for (const [tag, h] of Object.entries(mine)) if (stale(h, now)) delete mine[tag];
  // The newest of each tag, as the lock screen would have shown it.
  mine[heldTag(message)] = { m: message, at: now };
}

/** Whether held pushes are sent once quiet hours end: the live server only, as the reminders. NOTIF_HOLD=on forces it,
 *  =off stops it; a non-production Railway environment (staging, on a copy of live's phones) stays quiet. */
export function notifHoldOn(): boolean {
  if (process.env.NOTIF_HOLD === "on") return true;
  if (process.env.NOTIF_HOLD === "off" || process.env.NODE_ENV !== "production") return false;
  return (process.env.RAILWAY_ENVIRONMENT_NAME ?? "production") === "production";
}

/** Sends what was held for every client whose quiet hours are over, at once: the newest of each tag, for what life it
 *  has left; one gone stale, or whose group was switched off meanwhile, goes nowhere. Returns how many devices took one. */
export async function releaseHeldPushes(now: number = Date.now()): Promise<number> {
  const box = heldBox();
  const users = Object.keys(box);
  if (!users.length) return 0;
  const { pushGroupOn, clientInQuiet } = await import("./notifPrefs");
  const due: { userId: number; m: PushMessage; at: number }[] = [];
  let changed = false;
  const taken: HeldBox = {};
  for (const key of users) {
    const userId = Number(key);
    const user = getData().users.find((u) => u.id === userId);
    const clientId = user?.role === "client" ? user.client_id : null;
    if (clientId != null && clientInQuiet(clientId, now)) continue;
    for (const h of Object.values(box[key] ?? {})) {
      if (clientId == null || stale(h, now)) continue;
      const g = h.m.group;
      if (g && g !== "always" && !pushGroupOn(clientId, g)) continue;
      const left = Math.max(60, Math.round((Math.min(pushTtlSeconds(h.m) * 1000, HELD_MAX_MS) - (now - h.at)) / 1000));
      due.push({ userId, m: { ...h.m, ttlSeconds: left }, at: h.at });
    }
    taken[key] = box[key];
    delete box[key];
    changed = true;
  }
  if (!changed) return 0;
  // Out of the box and saved before anything is sent, so a restart mid-send never sends one twice; a save that fails
  // puts them back for the next round (19 Nov).
  try {
    await persistNow();
  } catch (error) {
    for (const [key, held] of Object.entries(taken)) box[key] = { ...held, ...(box[key] ?? {}) };
    console.error("[push] saving the held pushes failed, sent next round:", error instanceof Error ? error.message : error);
    return 0;
  }
  let sent = 0;
  // Oldest first, so the newest lands on top of the lock screen.
  for (const d of due.sort((a, b) => a.at - b.at)) {
    try {
      sent += await deliver(d.userId, d.m);
    } catch (error) {
      console.error(`[push] a held push to user ${d.userId} failed:`, error instanceof Error ? error.message : error);
    }
  }
  return sent;
}
