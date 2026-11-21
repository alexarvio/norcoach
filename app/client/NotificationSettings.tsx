"use client";

import { useEffect, useRef, useState, useSyncExternalStore, useTransition } from "react";
import { nativePlatform } from "../lib/native";
import { NOTIF_GROUPS, type NotifGroup } from "../lib/notifGroups";
import { saveNotificationPrefsAction } from "../lib/notifPrefsActions";
import type { NotifPrefs, QuietHours } from "../lib/notifPrefs";
import SettingsFold from "./SettingsFold";
import { PushSwitch, type NativeReady, type PushRowProps } from "./PushToggle";
import "./notif-settings.css";

// Settings · Notifications (19 Nov, Alex: docs/boards/notification-popup-mockup.html, the Settings phone): this phone's
// notifications, then a switch a group (white while off, ink while on, its fact grey under it), then Quiet hours with
// From and To in the phone's own time picker. Each change saved at once. A switch stops the push alone: the bell keeps
// every notification. Blocked in the phone's settings, the fold says so and nothing else.

const noSubscribe = () => () => {};
const DEFAULT_QUIET = { from: "22:00", to: "07:00" };
const phoneZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

export default function NotificationSettings({ coachFirst, prefs, publicKey, nativeReady }: { coachFirst: string; prefs: NotifPrefs; publicKey: string | null; nativeReady: NativeReady }) {
  const platform = useSyncExternalStore(noSubscribe, nativePlatform, () => null);
  // A browser this server can't push to has no phone switch; the groups still show (they go for every phone).
  const canPush = !!platform || !!publicKey;
  return (
    <SettingsFold title="Notifications">
      {canPush ? (
        <PushSwitch publicKey={publicKey} nativeReady={nativeReady} row={(push) => <Body coachFirst={coachFirst} prefs={prefs} push={push} />} />
      ) : (
        <Body coachFirst={coachFirst} prefs={prefs} push={null} />
      )}
    </SettingsFold>
  );
}

function Switch({ on }: { on: boolean }) {
  return (
    <span className={`settings-switch${on ? " on" : ""}`} aria-hidden="true">
      <span className="settings-switch-knob" />
    </span>
  );
}

function Body({ coachFirst, prefs, push }: { coachFirst: string; prefs: NotifPrefs; push: PushRowProps | null }) {
  const [groups, setGroups] = useState(prefs.push_groups);
  const [quiet, setQuiet] = useState<QuietHours | null>(prefs.quiet);
  const [, start] = useTransition();
  // The server's answer is what stays (a coach looking saves nothing, so a switch goes back). 19 Nov: a failed save
  // puts back only what it changed, to the last answer (not the page's), and an answer is shown whole only once no
  // other save is on its way, so a quick second switch never flickers back.
  const lastSaved = useRef<NotifPrefs>(prefs);
  const inFlight = useRef(0);
  const save = (patch: Parameters<typeof saveNotificationPrefsAction>[0]) =>
    start(async () => {
      inFlight.current += 1;
      const saved = await saveNotificationPrefsAction(patch).catch(() => null);
      inFlight.current -= 1;
      if (saved) {
        lastSaved.current = saved;
        if (inFlight.current === 0) {
          setGroups(saved.push_groups);
          setQuiet(saved.quiet);
        }
      } else {
        const back = lastSaved.current;
        if (patch.push_groups) {
          const keys = Object.keys(patch.push_groups) as NotifGroup[];
          setGroups((s) => ({ ...s, ...Object.fromEntries(keys.map((k) => [k, back.push_groups[k]])) }));
        }
        if (patch.quiet !== undefined) setQuiet(back.quiet);
      }
    });

  // Times are the phone's own (19 Nov, Alex): a phone gone to another zone moves its quiet hours with it.
  const zoneChecked = useRef(false);
  useEffect(() => {
    if (zoneChecked.current) return;
    zoneChecked.current = true;
    const tz = phoneZone();
    if (prefs.quiet && prefs.quiet.tz !== tz) save({ quiet: { ...prefs.quiet, tz } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = (g: NotifGroup) => {
    const next = !groups[g];
    setGroups((s) => ({ ...s, [g]: next }));
    save({ push_groups: { [g]: next } });
  };

  // The times saved a moment after the picker stops turning, the whole quiet hours each time, in the phone's own zone.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const setQuietNow = (next: QuietHours, wait = 0) => {
    setQuiet(next);
    if (timer.current) clearTimeout(timer.current);
    if (wait) timer.current = setTimeout(() => save({ quiet: next }), wait);
    else save({ quiet: next });
  };
  const q: QuietHours = quiet ?? { on: false, ...DEFAULT_QUIET, tz: phoneZone() };
  const quietOn = q.on;

  if (push?.blocked) return <div className="nfs-blocked">Blocked in phone settings</div>;

  return (
    <div className="home-dark-rows nfs">
      {push && (
        <button type="button" className="settings-toggle-row" onClick={push.onClick} disabled={push.disabled} aria-pressed={push.on}>
          <div className="home-dark-row-body">
            <div className="home-dark-row-title">Notifications on this phone</div>
            {push.detail && <div className="home-dark-row-detail">{push.detail}</div>}
          </div>
          <Switch on={push.on} />
        </button>
      )}
      {/* The phone's switch is the one for all (19 Nov, Alex: "one notification toggle that toggles all on and off"): off, the
          groups and quiet hours fade and rest, each keeping its own setting for when it comes back on. */}
      <div className={`nfs-groups${push && !push.on ? " off" : ""}`} inert={!!push && !push.on}>
      {NOTIF_GROUPS.map((g) => (
        <button key={g.id} type="button" className="settings-toggle-row" onClick={() => toggle(g.id)} aria-pressed={groups[g.id] !== false}>
          <div className="home-dark-row-body">
            <div className="home-dark-row-title">{g.label(coachFirst)}</div>
            {g.fact && <div className="home-dark-row-detail">{g.fact}</div>}
          </div>
          <Switch on={groups[g.id] !== false} />
        </button>
      ))}
      <div className="nfs-quiet">
        <button type="button" className="settings-toggle-row" onClick={() => setQuietNow({ ...q, on: !quietOn, tz: phoneZone() })} aria-pressed={quietOn}>
          <div className="home-dark-row-body">
            <div className="home-dark-row-title">Quiet hours</div>
          </div>
          <Switch on={quietOn} />
        </button>
        <div className={`so-fold${quietOn ? " open" : ""}`} aria-hidden={!quietOn} inert={!quietOn}>
          <div className="so-fold-in">
            <div className="nfs-times">
              <input
                type="time"
                className="nfs-time"
                aria-label="From"
                value={q.from}
                onChange={(e) => e.target.value && setQuietNow({ ...q, from: e.target.value.slice(0, 5), tz: phoneZone() }, 700)}
              />
              <span className="nfs-arrow" aria-hidden="true">
                →
              </span>
              <input
                type="time"
                className="nfs-time"
                aria-label="To"
                value={q.to}
                onChange={(e) => e.target.value && setQuietNow({ ...q, to: e.target.value.slice(0, 5), tz: phoneZone() }, 700)}
              />
            </div>
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}
