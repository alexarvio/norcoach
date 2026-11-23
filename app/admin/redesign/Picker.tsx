"use client";

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../components/ui/dropdown-menu";
import type React from "react";
import { ChevronDownIcon } from "../../components/icons";
import "./picker.css";

// One choice from a short list, as the same menu the add rows use: a field
// that reads its choice, and a list under it. Takes the place of a native
// select wherever the drafts need one, so every list looks the same.
export default function Picker<T extends string>({ value, options, onChange, label, className = "", menuClassName = "", empty, align = "start" }: { value: T; options: { value: T; label: string; hint?: string; /** A colour for the name (a phase's track, 20 Oct): it sits in a soft capsule of it instead of a word saying the track. */ color?: string }[]; onChange: (v: T) => void; label: string; className?: string; /** On the floating list (a long one that scrolls after six rows). */ menuClassName?: string; /** What the field reads while its value is none of the options (a field that starts empty, 23 Nov: ""); without it, the first option. */ empty?: string; /** Which edge of the field the list hangs from (23 Nov: "end" for a field on a row's right, the list's edge on its chevron's). */ align?: "start" | "end" }) {
  const current = options.find((o) => o.value === value) ?? (empty != null ? undefined : options[0]);
  const name = (o: { label: string; color?: string }) => (o.color ? <span className="rd-picker-tone" style={{ "--tone": o.color } as React.CSSProperties}>{o.label}</span> : o.label);
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger className={`rd-input rd-picker ${className}`} aria-label={label}>
        <span>{current ? name(current) : (empty ?? "—")}</span>
        <ChevronDownIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className={`pb-menu rd-picker-menu${menuClassName ? ` ${menuClassName}` : ""}`}>
        {options.map((o) => (
          <DropdownMenuItem key={o.value} className={o.value === value ? "on" : ""} onSelect={() => onChange(o.value)}>
            {name(o)}
            {o.hint && <small>{o.hint}</small>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
