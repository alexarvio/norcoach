"use client";

// The browser's print sheet, which also saves as PDF. `label`: the coach's page says the action alone, `Print`
// (16 Nov, Alex: the audit); the client's keeps its words.
export default function PrintButton({ label = "Print or save as PDF" }: { label?: string }) {
  return (
    <button type="button" className="ivp-btn primary" onClick={() => window.print()}>
      {label}
    </button>
  );
}
