"use client";

import { useState } from "react";
import { EyeIcon } from "../components/icons";

// A password field with an eye at its end: shown as dots until pressed, then
// as typed, so a long password can be checked before it is sent. The eye is
// crossed while the password is hidden and open while it shows. Uncontrolled
// in a plain form (name), or controlled with value and onChange (the Clerk
// screens, 17 Nov).
export default function PasswordInput({
  name,
  autoComplete,
  required = true,
  autoFocus = false,
  minLength,
  value,
  onChange,
  label,
}: {
  name: string;
  autoComplete: string;
  required?: boolean;
  autoFocus?: boolean;
  minLength?: number;
  value?: string;
  onChange?: (value: string) => void;
  /** Its words for a screen reader when no label wraps it. */
  label?: string;
}) {
  const [shown, setShown] = useState(false);
  return (
    <span className="auth-pass">
      <input
        name={name}
        type={shown ? "text" : "password"}
        autoComplete={autoComplete}
        required={required}
        autoFocus={autoFocus}
        minLength={minLength}
        aria-label={label}
        {...(onChange ? { value: value ?? "", onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value) } : {})}
      />
      <button type="button" className="auth-pass-eye" onClick={() => setShown((s) => !s)} aria-label={shown ? "Hide password" : "Show password"} aria-pressed={shown} title={shown ? "Hide password" : "Show password"}>
        <EyeIcon off={!shown} />
      </button>
    </span>
  );
}
