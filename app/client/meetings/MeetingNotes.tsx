import { agreedPoints } from "../../lib/meetingDates";
import "./notes.css";
import CoachSays from "../CoachSays";

// A call's notes, one way (3 Nov, Alex: section 4 of docs/boards/drawn-several-ways-mockup.html): the Meetings screen's
// calls and Home's Meeting summary alike. The points as To focus on draws its goals, a small ink ring each on a thin line
// down the left, nothing to tick and no kind colour; a one-line summary a plain paragraph. The coach's typed dashes and
// numbers go (agreedPoints).
export default function MeetingNotes({ notes, title, coach }: { notes: string[] | string | null | undefined; /** The summary's own title, where nothing over it says it already (Home). */ title?: string | null; /** The coach's first name: the notes are theirs, so their face and name are over them (16 Nov, Alex: whatever the coach says, their face and name are with it). */ coach?: string }) {
  const { points, prose } = agreedPoints(notes);
  if (points.length === 0 && !title) return null;
  const body = (
    <div className="mt-notes">
      {title && <b className="mt-notes-title">{title}</b>}
      {points.length > 0 &&
        (prose ? (
          <p className="mt-notes-prose">{points[0]}</p>
        ) : (
          <ul className="mt-notes-list">
            {points.map((p, i) => (
              <li key={i} className="mt-notes-pt">
                <svg className="mt-notes-node" width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
                  <circle cx="5.5" cy="5.5" r="4.2" />
                </svg>
                <span>{p}</span>
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
  return coach ? (
    <div className="mt-notes-says">
      <CoachSays label={coach}>{body}</CoachSays>
    </div>
  ) : (
    body
  );
}
