"use client";

import { useEffect, useRef, useState } from "react";
import { Dialog, DialogClose, DialogContent } from "../../../components/ui/dialog";
import { PlusIcon } from "../../../components/icons";
import type { GuideFields, GuideView } from "../../../lib/guides";
import { GUIDE_SCREENS, GUIDE_TOPICS } from "../../../lib/guideScreens";
import { deleteGuideAction, discardGuideUploadsAction, saveGuideAction, uploadGuideVideoAction } from "../../../lib/guidesActions";
import { uploadFirst } from "../../../lib/uploadFirst";
import { SepJoin } from "../Sep";
import { PopupTitle } from "../PopupWho";
import { ConfirmDialog } from "../training/TrainingDraft";
import { GuideThumb, minutes, videoSource } from "../help/guideMedia";
import "../help/help.css";

// The owner's Guides on Coaches (24 Nov, Alex: "you add them yourself, from the owner's Coaches screen"; B of
// docs/boards/coach-help-mockup.html, lib/guides.ts): the help guides every coach sees from the ? on their admin.
// `Guides` with + Guide as the white pill, then one hairline card, a guide a row: its poster, the title semi-bold, its
// topic, length and screens grey after the drawn bar, and its state pill (Published green, Draft grey). A row opens the
// edit pop-up in the .dlh voice: the title, the topic (the floating list of the usual ones, or typed) and order, the
// screens it belongs to as chips, the video (a YouTube or Vimeo link, or a file uploaded as the Library's demos are),
// its length (taken from an uploaded file, else typed), the steps one a line, Draft | Published; Delete in red words
// asking first. Coaches see the published ones the next time they open the panel.

const BLANK: GuideFields = { title: "", topic: GUIDE_TOPICS[0], screens: [], video: null, seconds: null, steps: [], published: false, order: 0 };
const MAX_MB = 128;

/** "3:20" → 200, "3" → 180 (minutes), "45s" → 45, "3 min" → 180; null when it reads as none. */
function parseLength(s: string): number | null {
  const t = s.trim().toLowerCase();
  if (!t) return null;
  const mss = /^(\d{1,3}):([0-5]?\d)$/.exec(t);
  if (mss) return Number(mss[1]) * 60 + Number(mss[2]);
  const sec = /^(\d{1,5})\s*s(ec(onds?)?)?$/.exec(t);
  if (sec) return Number(sec[1]);
  const min = /^(\d{1,3}(?:[.,]\d+)?)\s*(m|min|mins|minutes?)?$/.exec(t);
  if (min) return Math.round(Number(min[1].replace(",", ".")) * 60);
  return null;
}
const lengthText = (seconds: number | null) => (seconds == null ? "" : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`);

const screenWord = (key: string) => GUIDE_SCREENS.find((s) => s.key === key)?.label ?? key;

export default function GuidesSection({ initial }: { initial: GuideView[] }) {
  const [guides, setGuides] = useState(initial);
  const [had, setHad] = useState(initial);
  if (had !== initial) {
    setHad(initial);
    setGuides(initial);
  }
  // null: closed; "new": + Guide; else the guide opened.
  const [editing, setEditing] = useState<GuideView | "new" | null>(null);
  const [deleting, setDeleting] = useState<GuideView | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  return (
    <section className="rls-section">
      <div className="trn-weekhead">
        <div>
          <h2>Guides</h2>
        </div>
        <button type="button" className="trn-pill" onClick={() => setEditing("new")}>
          <PlusIcon /> Guide
        </button>
      </div>
      <div className="rls-card hlp-gcard">
        {guides.length === 0 ? (
          <p className="rls-none">None</p>
        ) : (
          guides.map((g) => (
            <button key={g.id} type="button" className="hlp-grow" onClick={() => setEditing(g)}>
              <GuideThumb video={g.video} />
              <span className="hlp-grow-w">
                <span className="hlp-grow-t">{g.title}</span>
                <span className="hlp-grow-s">
                  <SepJoin parts={[g.topic, minutes(g.seconds), g.screens.map(screenWord).join(", ")]} />
                </span>
              </span>
              <span className={`trn-state hlp-gstate${g.published ? " good" : ""}`}>{g.published ? "Published" : "Draft"}</span>
            </button>
          ))
        )}
      </div>
      {deleteError && (
        <p className="dlh-error" role="alert">
          {deleteError}
        </p>
      )}

      <Dialog open={editing != null} onOpenChange={(o) => !o && setEditing(null)}>
        {editing != null && (
          <GuideDialog
            guide={editing === "new" ? null : editing}
            nextOrder={guides.reduce((m, g) => Math.max(m, g.order), -1) + 1}
            onSaved={(list) => {
              setGuides(list);
              setEditing(null);
            }}
            onDelete={(g) => {
              setEditing(null);
              setDeleteError(null);
              setDeleting(g);
            }}
          />
        )}
      </Dialog>

      <Dialog open={deleting != null} onOpenChange={(o) => !o && setDeleting(null)}>
        {deleting && (
          <ConfirmDialog
            title={`Delete the guide “${deleting.title}”?`}
            description={[deleting.video?.startsWith("/uploads/") && "Its video is deleted with it.", deleting.published && "Coaches no longer see it."].filter(Boolean).join(" ") || undefined}
            confirm="Delete"
            danger
            onConfirm={() => {
              const g = deleting;
              setDeleting(null);
              deleteGuideAction(g.id).then(
                (list) => (list ? setGuides(list) : setDeleteError("Not deleted. Try again.")),
                () => setDeleteError("Not deleted. Try again.")
              );
            }}
          />
        )}
      </Dialog>
    </section>
  );
}

function GuideDialog({ guide, nextOrder, onSaved, onDelete }: { guide: GuideView | null; nextOrder: number; onSaved: (list: GuideView[]) => void; onDelete: (g: GuideView) => void }) {
  const start = guide ?? { ...BLANK, order: nextOrder };
  const [title, setTitle] = useState(start.title);
  const [topic, setTopic] = useState(start.topic);
  const [topicOpen, setTopicOpen] = useState(false);
  // Opened, the list shows every topic; only typing in the field narrows it (else a topic already set hid the others).
  const [topicTyped, setTopicTyped] = useState(false);
  const [screens, setScreens] = useState<string[]>(start.screens);
  const [video, setVideo] = useState<string | null>(start.video);
  const [link, setLink] = useState("");
  const [length, setLength] = useState(lengthText(start.seconds));
  const [steps, setSteps] = useState(start.steps.join("\n"));
  const [published, setPublished] = useState(start.published);
  const [order, setOrder] = useState(String(start.order));
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  // Typed in this pop-up: only then does a new file's own length not take its place (a Replace brings its length).
  const lengthTyped = useRef(false);
  // The clips uploaded here: as the pop-up closes, saved or not, each no guide names goes (discardGuideUploadsAction;
  // the server keeps the one a guide was saved with). Not while a save is on its way, which may yet name one.
  const uploaded = useRef<string[]>([]);
  const gone = useRef(false);
  const saving = useRef(false);
  useEffect(() => {
    gone.current = false;
    return () => {
      gone.current = true;
      if (saving.current || uploaded.current.length === 0) return;
      void discardGuideUploadsAction(uploaded.current).catch(() => {});
      uploaded.current = [];
    };
  }, []);

  const linkOk = /^https?:\/\/\S+\.\S+/i.test(link.trim());
  const linkBad = link.trim() !== "" && !linkOk;
  const seconds = parseLength(length);
  const lengthBad = length.trim() !== "" && seconds == null;
  const ready = !!title.trim() && !busy && !uploading && !lengthBad && (!link.trim() || linkOk);

  const toggle = (key: string) => setScreens((s) => (s.includes(key) ? s.filter((x) => x !== key) : [...s, key]));

  const upload = (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("video/")) return setError(`${file.name} isn't a video.`);
    if (file.size > MAX_MB * 1024 * 1024) return setError(`${file.name} is over ${MAX_MB} MB.`);
    setError(null);
    // Its length from the file itself, unless one was typed.
    if (!lengthTyped.current) {
      const url = URL.createObjectURL(file);
      const probe = document.createElement("video");
      probe.preload = "metadata";
      probe.onloadedmetadata = () => {
        if (Number.isFinite(probe.duration) && probe.duration > 0 && !lengthTyped.current) setLength(lengthText(Math.round(probe.duration)));
        URL.revokeObjectURL(url);
      };
      probe.onerror = () => URL.revokeObjectURL(url);
      probe.src = url;
    }
    setUploading(true);
    const fd = new FormData();
    fd.set("file", file);
    uploadFirst(fd, "video")
      .then((refused) => (refused ? { ok: false as const, error: refused } : uploadGuideVideoAction(fd)))
      .then(
        (r) => {
          if (!r.ok) return setError(r.error);
          // Closed while it went up: nothing will name it.
          if (gone.current) return void discardGuideUploadsAction([r.path]).catch(() => {});
          uploaded.current.push(r.path);
          setVideo(r.path);
          setLink("");
        },
        () => setError("Not uploaded. Try again.")
      )
      .finally(() => setUploading(false));
  };

  const save = () => {
    if (!ready) return;
    const fields: GuideFields = {
      title,
      topic,
      screens,
      video: link.trim() ? link.trim() : video,
      seconds,
      steps: steps.split("\n"),
      published,
      order: Number(order) || 0,
    };
    setBusy(true);
    saving.current = true;
    setError(null);
    saveGuideAction(guide?.id ?? null, fields)
      .then(
        (r) => {
          saving.current = false;
          if (!r.ok) {
            if (gone.current && uploaded.current.length) {
              void discardGuideUploadsAction(uploaded.current).catch(() => {});
              uploaded.current = [];
            }
            return setError(r.error);
          }
          // The uploads this one didn't keep go now (the pop-up's close is already under way).
          if (uploaded.current.length) {
            void discardGuideUploadsAction(uploaded.current).catch(() => {});
            uploaded.current = [];
          }
          onSaved(r.guides);
        },
        () => {
          saving.current = false;
          // Closed while it was on its way: what it uploaded goes, as on any close.
          if (gone.current && uploaded.current.length) {
            void discardGuideUploadsAction(uploaded.current).catch(() => {});
            uploaded.current = [];
          }
          setError("Not saved. Try again.");
        }
      )
      .finally(() => setBusy(false));
  };

  // The topics as typed narrows them (all of them until something is typed); the one typed exactly stays listed.
  const shownTopics = GUIDE_TOPICS.filter((t) => !topicTyped || !topic.trim() || t.toLowerCase().includes(topic.trim().toLowerCase()) || t === topic);
  useEffect(() => {
    if (!topicOpen) return;
    const away = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setTopicOpen(false);
      }
    };
    window.addEventListener("keydown", away, true);
    return () => window.removeEventListener("keydown", away, true);
  }, [topicOpen]);

  return (
    <DialogContent className="dlh hlp-edit" aria-describedby={undefined}>
      <div className="dlh-head">
        <PopupTitle>{guide ? "Edit guide" : "New guide"}</PopupTitle>
        <DialogClose className="dlh-x" aria-label="Close">
          ✕
        </DialogClose>
      </div>
      <div className="hlp-form">
        <label className="dlh-field">
          <span className="dlh-label">Title</span>
          <input className="dlh-line" value={title} maxLength={120} autoFocus onChange={(e) => setTitle(e.target.value)} />
        </label>

        <div className="hlp-pair">
          <div className="dlh-field hlp-topic">
            <label className="dlh-label" htmlFor="hlp-topic">
              Topic
            </label>
            <input
              id="hlp-topic"
              className="dlh-line"
              value={topic}
              maxLength={40}
              autoComplete="off"
              role="combobox"
              aria-expanded={topicOpen && shownTopics.length > 0}
              aria-controls="hlp-topics"
              onFocus={() => {
                setTopicTyped(false);
                setTopicOpen(true);
              }}
              onBlur={() => setTopicOpen(false)}
              onChange={(e) => {
                setTopic(e.target.value);
                setTopicTyped(true);
                setTopicOpen(true);
              }}
            />
            {topicOpen && shownTopics.length > 0 && (
              <ul className="hlp-menu" id="hlp-topics" role="listbox">
                {shownTopics.map((t) => (
                  <li key={t} role="option" aria-selected={t === topic}>
                    <button
                      type="button"
                      tabIndex={-1}
                      className={t === topic ? "on" : ""}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setTopic(t);
                        setTopicOpen(false);
                      }}
                    >
                      {t}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <label className="dlh-field">
            <span className="dlh-label">Order</span>
            <input className="dlh-line" inputMode="numeric" value={order} maxLength={4} onChange={(e) => setOrder(e.target.value.replace(/\D/g, ""))} />
          </label>
        </div>

        <div className="dlh-field">
          <span className="dlh-label">Screens</span>
          {(["views", "client"] as const).map((group) => (
            <div key={group} className="hlp-chips" role="group" aria-label={group === "views" ? "Views over every client" : "A client's tabs"}>
              {GUIDE_SCREENS.filter((s) => s.group === group).map((s) => (
                <button key={s.key} type="button" className={`hlp-chip${screens.includes(s.key) ? " on" : ""}`} aria-pressed={screens.includes(s.key)} onClick={() => toggle(s.key)}>
                  {s.label}
                </button>
              ))}
            </div>
          ))}
        </div>

        <div className="dlh-field">
          <span className="dlh-label">Video</span>
          {video && !link.trim() ? (
            <div className="hlp-vid">
              <GuideThumb video={video} />
              <span className="hlp-vid-w" title={video}>
                {videoSource(video)}
              </span>
              <button type="button" className="hlp-word" disabled={uploading} onClick={() => picker.current?.click()}>
                Replace
              </button>
              <button type="button" className="hlp-word red" disabled={uploading} onClick={() => setVideo(null)}>
                Remove
              </button>
            </div>
          ) : (
            <div className="hlp-vidline">
              <input className="dlh-line" value={link} maxLength={1000} aria-label="Video link" aria-invalid={linkBad || undefined} onChange={(e) => setLink(e.target.value)} />
              {uploading ? (
                <span className="hlp-progress">Uploading</span>
              ) : (
                <button type="button" className="hlp-word" onClick={() => picker.current?.click()}>
                  Upload a file
                </button>
              )}
            </div>
          )}
          {linkBad && <p className="hlp-fieldfact">Not a link yet</p>}
          <input
            ref={picker}
            type="file"
            accept="video/*"
            hidden
            onChange={(e) => {
              upload(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </div>

        <label className="dlh-field">
          <span className="dlh-label">Length</span>
          <input
            className="dlh-line"
            value={length}
            maxLength={8}
            aria-invalid={lengthBad || undefined}
            onChange={(e) => {
              lengthTyped.current = true;
              setLength(e.target.value);
            }}
          />
          {lengthBad && <span className="hlp-fieldfact">Not a length</span>}
        </label>

        <label className="dlh-field">
          <span className="dlh-label">Steps</span>
          <textarea className="dlh-line" rows={4} value={steps} maxLength={6000} onChange={(e) => setSteps(e.target.value)} />
        </label>

        <div className="dlh-seg" role="radiogroup" aria-label="Who sees it">
          <button type="button" role="radio" aria-checked={!published} className={!published ? "on" : ""} onClick={() => setPublished(false)}>
            Draft
          </button>
          <button type="button" role="radio" aria-checked={published} className={published ? "on" : ""} onClick={() => setPublished(true)}>
            Published
          </button>
        </div>

        {error && (
          <p className="dlh-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="dlh-foot">
        {guide && (
          <button type="button" className="dlh-delete" onClick={() => onDelete(guide)}>
            Delete
          </button>
        )}
        <DialogClose className="dlh-cancel">Cancel</DialogClose>
        <button type="button" className="dlh-go" disabled={!ready} onClick={save}>
          Save
        </button>
      </div>
    </DialogContent>
  );
}
