"use client";

import { useId, type SVGProps } from "react";

/**
 * The header's bell with how many notifications are unread (28 Nov, Alex: "a number instead of a dot… like A, but without
 * the pill… in Adobe Illustrator you can do offset path… the bell would cut the line, put the 3 there, and then continue
 * after"): the number sits on the bell's top-right in the bell's own colour, and the bell's line stops short of it all
 * round: the mask is the number itself grown by a stroke (an offset path), so the bell gives way exactly round the
 * figure, no disc behind it. Past 9 it reads 9+. Nothing unread, the bell alone.
 */
const FONT = "600 12.6px var(--font-archivo, Archivo), system-ui, sans-serif";

export function NotifBell({ count }: { count: number }) {
  const id = `nb${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const label = count > 9 ? "9+" : String(count);
  // In the bell's 24-unit box (drawn at 18px): the figure's middle, a two-figure one a touch further out.
  const x = label.length > 1 ? 20.4 : 19.6;
  const y = 4.4;
  const figure = (extra: SVGProps<SVGTextElement>) => (
    <text x={x} y={y} textAnchor="middle" dominantBaseline="central" style={{ font: FONT, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em" }} {...extra}>
      {label}
    </text>
  );
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ overflow: "visible" }} aria-hidden="true">
      {count > 0 && (
        <defs>
          <mask id={id} maskUnits="userSpaceOnUse" x="-6" y="-6" width="36" height="36">
            <rect x="-6" y="-6" width="36" height="36" fill="#fff" />
            {/* The offset: the figure's own outline, 2.2 units round it. */}
            {figure({ fill: "#000", stroke: "#000", strokeWidth: 4.4, strokeLinejoin: "round" })}
          </mask>
        </defs>
      )}
      <g mask={count > 0 ? `url(#${id})` : undefined}>
        <path
          d="M6 9a6 6 0 0 1 12 0c0 3.2 1 5.1 1.8 6.1.4.5.1 1.2-.5 1.2H4.7c-.6 0-.9-.7-.5-1.2C5 14.1 6 12.2 6 9Z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <path d="M9.5 19.2a2.6 2.6 0 0 0 5 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </g>
      {count > 0 && figure({ fill: "currentColor" })}
    </svg>
  );
}
