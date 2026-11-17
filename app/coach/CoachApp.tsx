"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useChatStream } from "../components/useChatStream";
import { useSearchParams } from "next/navigation";
import { chatWhen } from "../admin/redesign/ChatList";
import { dayMonth } from "../lib/dayMonth";
import { coachInboxAction, markVideoDoneAction, type CoachInbox } from "./actions";
import type { PhoneVideo } from "../lib/coachPhone";
import ChatThread from "./ChatThread";
import { markThreadsReadable, prefetchThreads, setThreadOwner } from "./threadCache";
import PhoneReview from "./PhoneReview";
import CoachSettings, { type SettingsCoach } from "./CoachSettings";
import { Avatar, Facts, Icon } from "./parts";
import CoachCalendar, { useCalendarState, type CalendarState } from "./CoachCalendar";
import type { PhoneCalendar } from "./calendar";
import ChatLastLine from "../components/ChatLastLine";
import RingEdge from "../components/RingEdge";
import { sized } from "../components/ChatMedia";
import type { NativeReady } from "../client/PushToggle";
import { NativePush } from "../client/NativePush";
import { subscribeKeyboard } from "../client/keyboard";

// The coach's phone (21 Oct, Alex): Chats and Videos on a floating tab bar,
// and since 22 Oct the Calendar (CoachCalendar.tsx); a chat or a video over
// them. Where it is lives in the address (?c=, ?v=, ?tab=videos,
// ?tab=calendar), moved with the browser's own history so the phone's Back
// works and nothing is fetched to switch screens. The lists ask for
// themselves every 15 s while the app is showing, as the chat does.
// The coach's face opens Settings (?settings=1, CoachSettings.tsx), a pushed
// screen where notifications are turned on; a tapped one opens its chat or video (lib/coachPush.ts; NativePush in the
// iPhone and Android apps, the service worker in a browser).

const POLL_MS = 15000;

type Push = { publicKey: string | null; nativeReady: NativeReady };
type Tab = "chats" | "videos" | "calendar";

export default function CoachApp({ inbox: fromPage, calendar, today, coach, push }: { inbox: CoachInbox; calendar: PhoneCalendar; /** The server's day, for the first paint. */ today: string; coach: { id: number } & SettingsCoach; push: Push }) {
  // The threads this phone keeps are this coach's (threadCache.ts).
  setThreadOwner(coach.id);
  // The keyboard source from the start, not only in a chat (13 Nov: the app's web view no longer shrinks to it; a
  // sheet's fields lift by --kb, coach.css).
  useEffect(() => subscribeKeyboard(() => {}), []);
  // Hydrated: a chat opened from here on draws its kept copy in its first render (threadCache.ts).
  useEffect(() => markThreadsReadable(), []);
  const params = useSearchParams();
  const chatId = Number(params.get("c")) || null;
  const videoId = Number(params.get("v")) || null;
  const settings = params.get("settings") === "1";
  const asked = params.get("tab");
  const tab: Tab = asked === "videos" || asked === "calendar" ? asked : "chats";
  // The Calendar's week and day, kept here so a chat opened from it comes back to them.
  const cal = useCalendarState(calendar);

  const [inbox, setInbox] = useState(fromPage);
  const pageKey = JSON.stringify(fromPage);
  const [seenPage, setSeenPage] = useState(pageKey);
  if (seenPage !== pageKey) {
    setSeenPage(pageKey);
    setInbox(fromPage);
  }
  const refresh = useCallback(async () => {
    const next = await coachInboxAction().catch(() => null);
    if (next) setInbox(next);
  }, []);
  // In real time (27 Oct, Alex): a new message moves its chat to the top as it comes in.
  useChatStream("all", () => void refresh(), 400);
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const id = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [refresh]);

  // What Settings saved in this visit, kept here: Settings mounts again from the first render's props each time it is
  // opened, and /coach is not read again after a save, so without this it would open on old values and send them back.
  // A fresh read of the page (its own record changed) starts from the server again.
  const [kept, setKept] = useState<{ notify?: SettingsCoach["notify"]; asked?: boolean }>({});
  const coachKey = JSON.stringify([coach.notify, coach.deletionAsked]);
  const [seenCoach, setSeenCoach] = useState(coachKey);
  if (seenCoach !== coachKey) {
    setSeenCoach(coachKey);
    setKept({});
  }

  // The first chats fetched ahead while the list shows, so opening one draws it at once (17 Nov, Alex).
  useEffect(() => {
    if (chatId || videoId || tab !== "chats") return;
    const t = setTimeout(() => prefetchThreads(inbox.chats), 300);
    return () => clearTimeout(t);
  }, [inbox.chats, chatId, videoId, tab]);

  // Opened from a list in this visit: Back is the browser's. Opened straight from a link: Back is the list.
  const fromList = useRef(false);
  const go = (query: string, how: "push" | "replace" = "push") => window.history[how === "push" ? "pushState" : "replaceState"](null, "", query ? `/coach?${query}` : "/coach");
  const open = (query: string) => {
    fromList.current = true;
    go(query);
  };
  const back = () => {
    if (fromList.current) {
      fromList.current = false;
      window.history.back();
    } else go(videoId || tab === "videos" ? "tab=videos" : "", "replace");
    void refresh();
  };
  if (chatId) {
    const chat = inbox.chats.find((c) => c.id === chatId) ?? null;
    return (
      <div className="cph">
        <NativePush />
        <ChatThread
          key={chatId}
          clientId={chatId}
          name={chat?.name ?? ""}
          avatarPath={chat?.avatarPath ?? null}
          onBack={back}
          onRead={() => setInbox((b) => ({ ...b, chats: b.chats.map((c) => (c.id === chatId ? { ...c, unread: false, unreadCount: 0 } : c)) }))}
        />
      </div>
    );
  }
  if (videoId) {
    return (
      <div className="cph">
        <NativePush />
        <PhoneReview key={videoId} requestId={videoId} onBack={back} onSent={() => void refresh()} />
      </div>
    );
  }
  if (settings) {
    // Settings, pushed over the tab it was opened from (17 Nov, Alex: A of docs/boards/coach-settings-mockup.html).
    return (
      <div className="cph">
        <NativePush />
        <CoachSettings
          coach={{ ...coach, notify: kept.notify ?? coach.notify, deletionAsked: kept.asked || coach.deletionAsked }}
          push={push}
          onBack={back}
          onNotifySaved={(notify) => setKept((k) => ({ ...k, notify }))}
          onDeletionAsked={() => setKept((k) => ({ ...k, asked: true }))}
        />
      </div>
    );
  }

  const unreadChats = inbox.chats.filter((c) => c.unread).length;
  const waiting = inbox.videos.waiting.length;
  return (
    <div className="cph">
      <NativePush />
      <Lists
        tab={tab}
        inbox={inbox}
        setInbox={setInbox}
        cal={cal}
        today={today}
        coach={coach}
        onOpenSettings={() => {
          listY[tab] = window.scrollY;
          open("settings=1");
        }}
        onOpenChat={(id) => {
          listY[tab] = window.scrollY;
          open(`c=${id}`);
        }}
        onOpenVideo={(id) => {
          listY[tab] = window.scrollY;
          open(`v=${id}`);
        }}
      />
      <nav className="cph-nav" aria-label="Coach app">
        <button type="button" className={`cph-tab${tab === "chats" ? " on" : ""}`} aria-current={tab === "chats" ? "page" : undefined} onClick={() => tab !== "chats" && go("", "replace")}>
          <Icon name="chat" />
          Chats
          {unreadChats > 0 && <b aria-label={`${unreadChats} unread`}>{unreadChats}</b>}
        </button>
        <button type="button" className={`cph-tab${tab === "videos" ? " on" : ""}`} aria-current={tab === "videos" ? "page" : undefined} onClick={() => tab !== "videos" && go("tab=videos", "replace")}>
          <Icon name="video" />
          Videos
          {waiting > 0 && <b aria-label={`${waiting} waiting`}>{waiting}</b>}
        </button>
        <button type="button" className={`cph-tab${tab === "calendar" ? " on" : ""}`} aria-current={tab === "calendar" ? "page" : undefined} onClick={() => tab !== "calendar" && go("tab=calendar", "replace")}>
          <Icon name="calendar" />
          Calendar
        </button>
      </nav>
    </div>
  );
}

/** Where each list was left, for coming back from a chat or a video. */
const listY: Record<string, number> = {};

function Lists({ tab, inbox, setInbox, cal, today, coach, onOpenSettings, onOpenChat, onOpenVideo }: { tab: Tab; inbox: CoachInbox; setInbox: React.Dispatch<React.SetStateAction<CoachInbox>>; cal: CalendarState; today: string; coach: { name: string; photoPath: string | null }; onOpenSettings: () => void; onOpenChat: (id: number) => void; onOpenVideo: (id: number) => void }) {
  const [q, setQ] = useState("");
  const shownTab = useRef<Tab | null>(null);
  // Back from a chat or a video: the list where it was left.
  useEffect(() => {
    // Another tab opens at its top (17 Nov, Alex: "make sure that it always starts from the top"); coming back from a chat
    // or a video, the list is where it was left.
    if (shownTab.current !== null && shownTab.current !== tab) for (const k of Object.keys(listY)) delete listY[k];
    shownTab.current = tab;
    window.scrollTo(0, listY[tab] ?? 0);
  }, [tab]);
  const needle = q.trim().toLowerCase();
  const chats = inbox.chats.filter((c) => !needle || c.name.toLowerCase().includes(needle));
  const now = new Date();
  const me = (
    <button type="button" className="cph-me" onClick={onOpenSettings} aria-label="Settings">
      <Avatar name={coach.name} src={coach.photoPath} size={30} />
    </button>
  );

  return (
    <main className="cph-list">
      {tab !== "calendar" && (
        <header className="cph-head">
          <h1>{tab === "chats" ? "Chats" : "Videos"}</h1>
          {me}
        </header>
      )}

      {tab === "calendar" ? (
        <CoachCalendar state={cal} serverToday={today} me={me} onOpenChat={onOpenChat} />
      ) : tab === "chats" ? (
        <>
          <label className="cph-search">
            <Icon name="search" />
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search clients" aria-label="Search clients" enterKeyHint="search" />
          </label>
          {chats.length === 0 ? (
            <p className="cph-empty">{needle ? "No match" : "None yet"}</p>
          ) : (
            <ul className="cph-rows">
              {chats.map((c) => {
                const n = c.unreadCount ?? (c.unread ? 1 : 0);
                return (
                  <li key={c.id}>
                    <button type="button" className={`cph-chat${n > 0 ? " unread" : ""}`} onClick={() => onOpenChat(c.id)}>
                      <Avatar name={c.name} src={c.avatarPath} size={46} />
                      <span className="cph-chat-main">
                        <span className="cph-chat-top">
                          <b>{c.name}</b>
                          <time>{c.last ? chatWhen(c.last.at, now) : ""}</time>
                        </span>
                        <span className="cph-chat-bottom">
                          <span className="cph-chat-line">
                            <ChatLastLine last={c.last} />
                          </span>
                          {n > 0 && <i className="cph-count" aria-label={`${n} unread`}>{n}</i>}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      ) : (
        <>
          <h2 className="cph-label">Waiting</h2>
          {inbox.videos.waiting.length === 0 && <p className="cph-empty left">None</p>}
          {<VideoRows
              rows={inbox.videos.waiting}
              now={now.getTime()}
              onOpen={onOpenVideo}
              onDone={(id) => {
                // Gone from Waiting at once; the inbox comes back with it under Replied as Done.
                setInbox((b) => ({ ...b, videos: { ...b.videos, waiting: b.videos.waiting.filter((v) => v.id !== id) } }));
                void markVideoDoneAction(id).then((next) => next && setInbox(next));
              }}
            />}
          {inbox.videos.replied.length > 0 && (
            <>
              <h2 className="cph-label quiet">Replied</h2>
              <VideoRows rows={inbox.videos.replied} now={now.getTime()} onOpen={onOpenVideo} past />
            </>
          )}
        </>
      )}
    </main>
  );
}


/** How long it has waited: minutes, hours, then days (rust past a day, as the Feed's waits). */
function waitFor(since: number, now: number): { text: string; late: boolean } {
  const m = Math.max(0, Math.round((now - since) / 60000));
  if (m < 60) return { text: `${Math.max(1, m)} min`, late: false };
  const h = Math.round(m / 60);
  if (h < 24) return { text: `${h} h`, late: false };
  const d = Math.floor(h / 24);
  return { text: `${d} day${d === 1 ? "" : "s"}`, late: true };
}

/** The photo or the video's first frame on its row (25 Oct, Alex: "the thumbnail of the picture or video"); the mark
    alone while it loads or when there is none to be had. */
function Thumb({ v }: { v: PhoneVideo }) {
  const [failed, setFailed] = useState(false);
  const src = v.media === "photo" ? sized(v.path, 480) : `${v.path}${v.path.includes("?") ? "&" : "?"}poster=1`;
  return (
    <span className="cph-thumb" aria-hidden="true">
      {!failed && v.path.startsWith("/uploads/") && (
        // eslint-disable-next-line @next/next/no-img-element -- an upload served by the app's own route
        <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
      )}
      {(failed || v.media !== "photo") && <Icon name={v.media === "photo" ? "photo" : "play"} />}
    </span>
  );
}

/**
 * The rows as they come and go, eased (17 Nov, Alex: after a reply "the screen jumps just a tiny bit"): a video leaving
 * the list (replied, marked done) folds shut on the shared fold before it goes, one arriving folds open, so nothing
 * under them snaps. The rows on first showing simply show.
 */
const FOLD_MS = 340;
function useEasedRows(rows: PhoneVideo[]) {
  const [shown, setShown] = useState<{ v: PhoneVideo; state: "in" | "open" | "out" }[]>(() => rows.map((v) => ({ v, state: "open" })));
  const [seen, setSeen] = useState(rows);
  if (seen !== rows) {
    setSeen(rows);
    const ids = new Set(rows.map((v) => v.id));
    const had = new Set(shown.map((s) => s.v.id));
    const next: { v: PhoneVideo; state: "in" | "open" | "out" }[] = rows.map((v) => ({ v, state: had.has(v.id) ? "open" : "in" }));
    // Those that left stay where they were, folding shut, until the fold is done.
    shown.forEach((s, i) => {
      if (!ids.has(s.v.id)) next.splice(Math.min(i, next.length), 0, { v: s.v, state: "out" });
    });
    setShown(next);
  }
  useEffect(() => {
    if (!shown.some((s) => s.state !== "open")) return;
    // In: open on the next frame, so the fold eases from shut. Out: gone once folded.
    const raf = requestAnimationFrame(() => setShown((list) => list.map((s) => (s.state === "in" ? { ...s, state: "open" } : s))));
    const t = window.setTimeout(() => setShown((list) => list.filter((s) => s.state !== "out")), FOLD_MS);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(t);
    };
  }, [shown]);
  return shown;
}

function VideoRows({ rows, now, onOpen, onDone, past = false }: { rows: PhoneVideo[]; now: number; onOpen: (id: number) => void; onDone?: (id: number) => void; past?: boolean }) {
  const eased = useEasedRows(rows);
  return (
    <ul className="cph-rows">
      {eased.map(({ v, state }) => {
        const wait = waitFor(v.sentAt, now);
        const first = v.client.split(/\s+/)[0] || v.client;
        return (
          <li key={v.id} className={`so-fold cph-video-fold${state === "open" ? " open" : ""}`} aria-hidden={state === "out" || undefined}>
          <div className="so-fold-in">
          <div className="cph-video-li">
            <button type="button" className={`cph-video${past ? " past" : ""}`} onClick={() => onOpen(v.id)}>
              <Thumb v={v} />
              <span className="cph-video-main">
                <b>{v.exercise}</b>
                <span className="cph-video-who">
                  <Avatar name={v.client} src={v.avatarPath} size={18} />
                  <Facts parts={[first, v.week]} />
                </span>
                <span className="cph-video-facts">
                  {past ? (
                    <Facts parts={[v.reply === "review" ? "Form review" : v.reply === "done" ? "Done" : "Written reply", v.repliedAt ? dayMonth(new Date(v.repliedAt)) : null]} />
                  ) : (
                    <Facts parts={[v.asked ? "Asked for" : null, <span key="w" className={wait.late ? "late" : undefined}>{wait.text} ago</span>]} />
                  )}
                </span>
              </span>
            </button>
            {/* Review it, or mark it done without a reply (25 Oct, Alex: "so it doesn't stay there for ever"). */}
            {!past && (
              <span className="cph-video-acts">
                <button type="button" className="cph-round small" onClick={() => onOpen(v.id)} aria-label={`Review ${v.exercise}`}>
                  <Icon name="pen" />
                  <RingEdge size={36} />
                </button>
                {onDone && (
                  <button type="button" className="cph-round small" onClick={() => onDone(v.id)} aria-label={`Mark ${v.exercise} done without a reply`}>
                    <Icon name="check" />
                    <RingEdge size={36} />
                  </button>
                )}
              </span>
            )}
          </div>
          </div>
          </li>
        );
      })}
    </ul>
  );
}
