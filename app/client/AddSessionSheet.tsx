"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { CompassIcon, CopyIcon } from "../components/icons";
import RingEdge from "../components/RingEdge";
import { Bars } from "./Bars";
import "./gyms.css";

// The + under the week's sessions (9 Nov, Alex): a rogue session, or one of this week's sessions again, in the gym
// picker's voice. Duplicate first asks which.
export default function AddSessionSheet({
  sessions,
  busy,
  onRogue,
  onDuplicate,
  onClose,
}: {
  sessions: { key: number; title: string; exercises: number; cardio: number }[];
  busy: boolean;
  onRogue: () => void;
  onDuplicate: (key: number) => void;
  onClose: () => void;
}) {
  const [picking, setPicking] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div className="gpk-overlay" onClick={onClose}>
      <div className="gpk-card" role="dialog" aria-modal="true" aria-labelledby="ads-title" onClick={(e) => e.stopPropagation()}>
        <div className="gpk-content">
          <div className="gpk-head center">
            {picking && (
              <button data-back type="button" className="gpk-round" onClick={() => setPicking(false)} aria-label="Back">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m14.5 6-6 6 6 6" />
                </svg>
                <RingEdge size={32} />
              </button>
            )}
            <h2 id="ads-title" className="gpk-title sm ads-title">
              {picking ? "Duplicate which?" : "Add a session"}
            </h2>
            {/* The ✕ on the right, as every pop-up's. */}
            <button type="button" className="gpk-round" onClick={onClose} aria-label="Close">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
              <RingEdge size={32} />
            </button>
          </div>
          <div className="gpk-rows">
            {picking ? (
              sessions.length === 0 ? (
                <p className="ads-note">Nothing planned</p>
              ) : (
                sessions.map((s) => (
                  <button key={s.key} type="button" className="gpk-addrow flat training" disabled={busy} onClick={() => onDuplicate(s.key)}>
                    <span className="gpk-addrow-ico" aria-hidden="true">
                      <CopyIcon />
                    </span>
                    <span className="ads-row-text">
                      <span>{s.title}</span>
                      <span className="ads-row-fact">
                        <Bars parts={[s.exercises > 0 && `${s.exercises} exercise${s.exercises === 1 ? "" : "s"}`, s.cardio > 0 && `${s.cardio} cardio`]} />
                      </span>
                    </span>
                    <span className="gpk-chev" aria-hidden="true" />
                  </button>
                ))
              )
            ) : (
              <>
                <button type="button" className="gpk-addrow flat training" disabled={busy} onClick={onRogue}>
                  <span className="gpk-addrow-ico" aria-hidden="true">
                    <CompassIcon size={18} />
                  </span>
                  {/* A line under each (28 Nov, Alex: "just one sentence on each"), the session rows' own grey fact. */}
                  <span className="ads-row-text">
                    <span>Rogue session</span>
                    <span className="ads-row-fact">Build your own workout at the gym</span>
                  </span>
                  <span className="gpk-chev" aria-hidden="true" />
                </button>
                <button type="button" className="gpk-addrow flat training" disabled={busy} onClick={() => setPicking(true)}>
                  <span className="gpk-addrow-ico" aria-hidden="true">
                    <CopyIcon />
                  </span>
                  <span className="ads-row-text">
                    <span>Duplicate a session</span>
                    <span className="ads-row-fact">Do one of this week’s sessions again</span>
                  </span>
                  <span className="gpk-chev" aria-hidden="true" />
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
