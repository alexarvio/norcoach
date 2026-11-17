"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { logoutAction } from "../lib/auth-actions";
import { saveCoachNotifyAction, uploadCoachPhotoAction } from "../lib/actions";
import { sendSupportAction } from "../lib/supportActions";
import { newOnceKey } from "../lib/onceKey";
import type { CoachNotify } from "../lib/db";
import { PushSwitch, type NativeReady } from "../client/PushToggle";
import { forgetAllThreads } from "./threadCache";
import { Avatar, Icon, Sheet } from "./parts";

// The coach phone's Settings (17 Nov, Alex: option A of docs/boards/coach-settings-mockup.html, with Help and legal and
// Delete account): a pushed screen opened from the coach's face on every tab. Only what touches the phone's three jobs:
// who you are, what buzzes, when it stays quiet, the account. One record with the laptop's Settings: the face is the
// profile photo (uploadCoachPhotoAction, kind avatar), Messages, Videos and Quiet hours are Settings, Notifications
// (saveCoachNotifyAction), so a change on either shows on both. Name and business are read here, changed on the laptop.

export type SettingsCoach = {
  name: string;
  photoPath: string | null;
  business: string;
  email: string;
  notify: CoachNotify;
  /** A coach's account has a Support thread; the owner's has none, so no Delete account. */
  canAskSupport: boolean;
  /** Already asked Norcoach support to delete the account. */
  deletionAsked: boolean;
};

const QUARTERS = Array.from({ length: 96 }, (_, i) => `${String(Math.floor(i / 4)).padStart(2, "0")}:${String((i % 4) * 15).padStart(2, "0")}`);
const DELETE_TEXT = "Please delete my account.";

/** A photo picked on the phone made a square face, 800px at most, as a JPEG (a phone photo can be over the 6 MB the
    action takes); the file itself when the browser can't read it. */
async function faceOf(file: File): Promise<File> {
  try {
    const bmp = await createImageBitmap(file);
    const side = Math.min(bmp.width, bmp.height);
    const out = Math.min(800, side);
    const canvas = document.createElement("canvas");
    canvas.width = out;
    canvas.height = out;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, out, out);
    bmp.close();
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", 0.88));
    return blob ? new File([blob], "avatar.jpg", { type: "image/jpeg" }) : file;
  } catch {
    return file;
  }
}

function Switch({ on }: { on: boolean }) {
  return (
    <span className={`cph-set-sw${on ? " on" : ""}`} aria-hidden="true">
      <i />
    </span>
  );
}

/** The most the photo action takes (uploadCoachPhotoAction); it refuses anything larger without a word. */
const PHOTO_MAX = 6 * 1024 * 1024;

export default function CoachSettings({
  coach,
  push,
  onBack,
  onNotifySaved,
  onDeletionAsked,
}: {
  coach: SettingsCoach;
  push: { publicKey: string | null; nativeReady: NativeReady };
  onBack: () => void;
  /** The record the server now holds, so Settings opened again in this visit shows it (CoachApp keeps it). */
  onNotifySaved: (n: CoachNotify) => void;
  onDeletionAsked: () => void;
}) {
  const router = useRouter();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  // ---- The face: the phone's own picker in one tap, saved at once.
  const file = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoFailed, setPhotoFailed] = useState(false);
  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);
  const pickPhoto = async (f: File | undefined) => {
    if (!f || !f.type.startsWith("image/")) return;
    setPreview(URL.createObjectURL(f));
    setPhotoBusy(true);
    setPhotoFailed(false);
    try {
      const face = await faceOf(f);
      // The action refuses an empty file, one over 6 MB or one that isn't a picture without saying so: say it here
      // rather than leave the preview on the face as if saved (a photo the browser couldn't shrink comes back as it was).
      if (face.size === 0 || face.size > PHOTO_MAX || !face.type.startsWith("image/")) throw new Error("refused");
      const fd = new FormData();
      fd.set("kind", "avatar");
      fd.set("file", face);
      await uploadCoachPhotoAction(fd);
      // The page reads the profile again, so the face on every tab is the new one.
      router.refresh();
    } catch {
      setPhotoFailed(true);
      setPreview(null);
    } finally {
      setPhotoBusy(false);
    }
  };

  // ---- Notifications and quiet hours: the laptop's record, saved whole on each change, in order.
  const [notify, setNotify] = useState<CoachNotify>(coach.notify ?? {});
  const [notifyFailed, setNotifyFailed] = useState(false);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  // Each save numbered: only the latest one's answer says whether the record is saved, so an earlier failure never
  // sticks once a later save (which carries the whole record, the failed change too) has gone through.
  const seq = useRef(0);
  const send = (rec: CoachNotify) => {
    const n = ++seq.current;
    setNotifyFailed(false);
    chain.current = chain.current
      .then(() => saveCoachNotifyAction(rec))
      .then(
        () => {
          onNotifySaved(rec);
          if (n === seq.current) setNotifyFailed(false);
        },
        () => {
          if (n === seq.current) setNotifyFailed(true);
        },
      );
  };
  const change = (patch: Partial<CoachNotify>) => {
    const next = { ...notify, ...patch };
    setNotify(next);
    send(next);
  };
  const chat = notify.chat !== false;
  const video = notify.video !== false;
  const quiet = !!notify.quiet;
  const from = notify.quietFrom ?? "22:00";
  const to = notify.quietTo ?? "07:00";

  // The quarter-hour list (New entry's, EntrySheet): under the box tapped, above it when there is no room below.
  const [drop, setDrop] = useState<{ which: "from" | "to"; top: number; left: number } | null>(null);
  const dropList = useRef<HTMLDivElement>(null);
  const openDrop = (which: "from" | "to", el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const W = 150;
    const H = 6 * 40 + 10;
    const below = r.bottom + 6 + H < window.innerHeight - 16;
    setDrop({ which, top: below ? r.bottom + 6 : Math.max(16, r.top - 6 - H), left: Math.min(Math.max(16, r.left), window.innerWidth - 16 - W) });
  };
  useLayoutEffect(() => {
    const on = dropList.current?.querySelector<HTMLElement>(".on");
    if (on && dropList.current) dropList.current.scrollTop = on.offsetTop - dropList.current.clientHeight / 2 + on.clientHeight / 2;
  }, [drop]);

  // ---- Delete account: asked first, then a word to Norcoach support; nothing is deleted from here.
  const [confirm, setConfirm] = useState(false);
  const [asked, setAsked] = useState(coach.deletionAsked);
  const [askBusy, setAskBusy] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const askKey = useRef<string | null>(null);
  const askDeletion = async () => {
    setAskBusy(true);
    setAskError(null);
    // One key for this ask, kept on a retry, so a dropped signal never sends it twice (lib/once.ts).
    askKey.current ??= newOnceKey();
    const fd = new FormData();
    fd.set("kind", "message");
    fd.set("text", DELETE_TEXT);
    fd.set("onceKey", askKey.current);
    try {
      const res = await sendSupportAction(fd);
      if (res.ok) {
        setAsked(true);
        onDeletionAsked();
        setConfirm(false);
      } else setAskError(res.error);
    } catch {
      setAskError("Not sent. Try again");
    } finally {
      setAskBusy(false);
    }
  };

  const face = preview ?? coach.photoPath;
  return (
    <main className="cph-set">
      <header className="cph-set-top">
        <button type="button" className="cph-icon-btn" onClick={onBack} aria-label="Back">
          <Icon name="back" />
        </button>
        <h1>Settings</h1>
        <span aria-hidden="true" />
      </header>

      <div className="cph-set-me">
        <button type="button" className={`cph-set-face${photoBusy ? " busy" : ""}`} onClick={() => file.current?.click()} aria-label="Change your photo" disabled={photoBusy}>
          <Avatar name={coach.name} src={face} size={64} />
          <i>
            <Icon name="camera" size={14} />
          </i>
        </button>
        {/* A plain field the button calls, no capture, so the camera stays one of the phone's own choices (design rules 6). */}
        <input
          ref={file}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            void pickPhoto(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        <span className="cph-set-who">
          <b>{coach.name}</b>
          {coach.business && <small>{coach.business}</small>}
          {photoFailed && <small className="bad">Photo not saved. Try again</small>}
        </span>
      </div>

      <section className="cph-set-grp">
        <h2 className="cph-set-lbl">Notifications</h2>
        <PushSwitch
          publicKey={push.publicKey}
          nativeReady={push.nativeReady}
          row={(p) => (
            <button type="button" className="cph-set-row" onClick={p.onClick} disabled={p.disabled} aria-pressed={p.on}>
              <span className="cph-set-name">
                On this phone
                {p.detail && <small>{p.detail}</small>}
              </span>
              <Switch on={p.on} />
            </button>
          )}
        />
        <button type="button" className="cph-set-row" onClick={() => change({ chat: !chat })} aria-pressed={chat}>
          <span className="cph-set-name">Messages from clients</span>
          <Switch on={chat} />
        </button>
        <button type="button" className="cph-set-row" onClick={() => change({ video: !video })} aria-pressed={video}>
          <span className="cph-set-name">Videos to review</span>
          <Switch on={video} />
        </button>
      </section>

      <section className="cph-set-grp">
        <h2 className="cph-set-lbl">Quiet hours</h2>
        <button type="button" className="cph-set-row" onClick={() => change({ quiet: !quiet })} aria-pressed={quiet}>
          <span className="cph-set-name">Hold pushes overnight</span>
          <Switch on={quiet} />
        </button>
        <div className={`cph-set-times${quiet ? "" : " off"}`}>
          <button type="button" className="cph-set-tb" disabled={!quiet} onClick={(e) => openDrop("from", e.currentTarget)} aria-label={`From ${from}`}>
            {from}
          </button>
          <span className="cph-set-arr" aria-hidden="true">
            <Icon name="right" size={16} />
          </span>
          <button type="button" className="cph-set-tb" disabled={!quiet} onClick={(e) => openDrop("to", e.currentTarget)} aria-label={`To ${to}`}>
            {to}
          </button>
        </div>
        {/* A tap sends the record as it stands again (a tap on the switch would only flip it back). */}
        {notifyFailed && (
          <button type="button" className="cph-set-bad" onClick={() => send(notify)}>
            Not saved. Try again
          </button>
        )}
      </section>

      <section className="cph-set-grp">
        <h2 className="cph-set-lbl">Help and legal</h2>
        <a className="cph-set-row" href="/support" target="_blank" rel="noopener noreferrer">
          <span className="cph-set-name">Support</span>
          <Icon name="forward" size={16} />
        </a>
        <a className="cph-set-row" href="/privacy" target="_blank" rel="noopener noreferrer">
          <span className="cph-set-name">Privacy policy</span>
          <Icon name="forward" size={16} />
        </a>
      </section>

      <section className="cph-set-grp">
        <h2 className="cph-set-lbl">Account</h2>
        <div className="cph-set-row still">
          <span className="cph-set-name quiet">{coach.email}</span>
        </div>
        <button
          type="button"
          className="cph-set-row"
          onClick={() => {
            // The chats kept on this phone go with the session (the sign-in page clears them too).
            forgetAllThreads();
            void logoutAction();
          }}
        >
          <span className="cph-set-name strong">Sign out</span>
        </button>
        {coach.canAskSupport &&
          (asked ? (
            <div className="cph-set-row still">
              <span className="cph-set-name quiet">Deletion requested</span>
            </div>
          ) : (
            <button type="button" className="cph-set-row" onClick={() => setConfirm(true)}>
              <span className="cph-set-name strong danger">Delete account</span>
            </button>
          ))}
      </section>

      {drop && (
        <>
          <button type="button" className="cph-ent-dropscrim" aria-label="Close the times" onClick={() => setDrop(null)} />
          <div ref={dropList} className="cph-ent-drop" role="listbox" aria-label={drop.which === "from" ? "From" : "To"} style={{ top: drop.top, left: drop.left }}>
            {QUARTERS.map((t) => {
              const on = t === (drop.which === "from" ? from : to);
              return (
                <button
                  key={t}
                  type="button"
                  role="option"
                  aria-selected={on}
                  className={on ? "on" : ""}
                  onClick={() => {
                    change(drop.which === "from" ? { quietFrom: t } : { quietTo: t });
                    setDrop(null);
                  }}
                >
                  {t}
                </button>
              );
            })}
          </div>
        </>
      )}

      {confirm && (
        <Sheet onClose={() => !askBusy && setConfirm(false)} label="Delete your account">
          <div className="cph-confirm">
            <h2>Delete your account?</h2>
            <p>Norcoach support deletes your account and your clients&rsquo; data. You&rsquo;ll get a reply in Support.</p>
            {askError && <p className="cph-set-bad">{askError}</p>}
            <div className="cph-confirm-row">
              <button type="button" className="cph-text-btn" onClick={() => setConfirm(false)} disabled={askBusy}>
                Cancel
              </button>
              <button type="button" className="cph-text-btn danger" onClick={() => void askDeletion()} disabled={askBusy}>
                Delete
              </button>
            </div>
          </div>
        </Sheet>
      )}
    </main>
  );
}
