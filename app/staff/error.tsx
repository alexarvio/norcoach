"use client";

// A staff page that couldn't be drawn (Clerk unreachable, StaffUnavailableError in app/lib/staff.ts, or anything else):
// a short fact and Try again in words, never a sign-in loop.
export default function StaffError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="stf-out">
      <div className="stf-out-card">
        <h1>Not reached</h1>
        <button type="button" className="stf-act" onClick={() => reset()}>
          Try again
        </button>
      </div>
    </div>
  );
}
