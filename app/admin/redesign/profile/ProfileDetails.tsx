"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { DEFAULT_DIAL, DIAL_CODES } from "../../InfoRow";
import { removeCoachPhotoAction, saveCoachContactAction, uploadCoachPhotoAction } from "../../../lib/actions";
import { saveCoachAboutDetailsAction } from "../../../lib/profileActions";
import { COACH_PROFILE_LIMITS as LIMIT } from "../../../lib/coachProfileView";
import { pic } from "../../../lib/pic";
import AvatarCropDialog from "../../AvatarCropDialog";
import DateText from "../DateText";
import Picker from "../Picker";
import { SepJoin } from "../Sep";
import { useSaveSlot } from "../settings/SaveHost";
import JoinCode from "./JoinCode";

// Settings, Profile, Your details (23 Nov, Alex: "build A", docs/boards/settings-profile-mockup.html): one identity card in
// Branding's language. The band in the coach's colour holds who they are: their face (the picture clients see in the chat
// and on the phone), changed right there and saved at once, their name as it is typed, their business and what they
// coach; their Norcode on its right. The paper rising over its foot holds the form in three parts, About you, Contact and
// Address, each a small caps label over its fields on clean lines; every field starts empty, no sample text. The fields'
// changes go on Settings' one bar (useSaveSlot) and wait there while Profile is folded. Only the coach (and the owner)
// sees these; the public profile is the other tab.

export type ProfileDetailsData = {
  first: string;
  last: string;
  /** YYYY-MM-DD, or "". */
  birthdate: string;
  /** What they coach (the profile's title). */
  title: string;
  /** The business name, from Settings' Business details (shown, not edited here). */
  business: string;
  email: string;
  phoneCode: string;
  phone: string;
  address: string;
  postcode: string;
  city: string;
  countryCode: string;
};

type Fields = Omit<ProfileDetailsData, "business" | "email">;
const ABOUT: (keyof Fields)[] = ["first", "last", "birthdate", "title"];
const CONTACT: (keyof Fields)[] = ["phoneCode", "phone", "address", "postcode", "city", "countryCode"];

const fieldsOf = (data: ProfileDetailsData): Fields => ({
  first: data.first,
  last: data.last,
  birthdate: data.birthdate,
  title: data.title,
  phoneCode: data.phoneCode || DEFAULT_DIAL,
  phone: data.phone,
  address: data.address,
  postcode: data.postcode,
  city: data.city,
  countryCode: data.countryCode,
});

export default function ProfileDetails({
  coachId,
  data,
  countries,
  joinCode = "",
  photo,
  fallbackName,
}: {
  coachId: number;
  data: ProfileDetailsData;
  countries: { code: string; name: string }[];
  /** The code clients join with (18 Nov; lib/joinRequests.ts). */
  joinCode?: string;
  /** The coach's face (the profile's avatar). */
  photo: string | null;
  /** The name shown while neither name is typed (the profile's, from the email). */
  fallbackName: string;
}) {
  const [d, setD] = useState<Fields>(() => fieldsOf(data));
  const [was, setWas] = useState<Fields>(() => fieldsOf(data));
  const [problem, setProblem] = useState<string | null>(null);
  const changedOf = (keys: (keyof Fields)[]) => keys.filter((k) => d[k] !== was[k]);
  const changed = changedOf([...ABOUT, ...CONTACT]).length;
  const dirty = changed > 0;
  const set = (k: keyof Fields) => (v: string) => {
    setProblem(null);
    setD((x) => ({ ...x, [k]: v }));
  };
  // The names are asked for only once one of them is changed: a name kept from before (one word) never holds the rest.
  const naming = changedOf(["first", "last"]).length > 0;
  const nameMissing = naming && (!d.first.trim() || !d.last.trim());
  const [photoError, setPhotoError] = useState("");

  const save = async () => {
    setProblem(null);
    const id = String(coachId);
    let ok = true;
    if (changedOf(ABOUT).length) {
      const fd = new FormData();
      fd.set("coachId", id);
      if (naming) {
        fd.set("first", d.first);
        fd.set("last", d.last);
      }
      fd.set("birthdate", d.birthdate);
      fd.set("title", d.title);
      const res = await saveCoachAboutDetailsAction(fd);
      if (res.ok) setWas((w) => ({ ...w, ...(naming ? { first: d.first.trim(), last: d.last.trim() } : {}), birthdate: d.birthdate, title: d.title.trim() }));
      else {
        ok = false;
        setProblem(res.error ?? "Not saved. Try again.");
      }
    }
    if (changedOf(CONTACT).length) {
      const fd = new FormData();
      fd.set("coachId", id);
      fd.set("phone_code", d.phoneCode);
      fd.set("phone", d.phone);
      fd.set("address", d.address);
      fd.set("postcode", d.postcode);
      fd.set("city", d.city);
      fd.set("country_code", d.countryCode);
      const res = await saveCoachContactAction(fd);
      if (res.ok) setWas((w) => ({ ...w, phoneCode: d.phoneCode, phone: d.phone, address: d.address, postcode: d.postcode, city: d.city, countryCode: d.countryCode }));
      else ok = false;
    }
    // Saved words read as saved (trimmed), so the bar doesn't count them again.
    if (ok) setD((x) => ({ ...x, first: x.first.trim(), last: x.last.trim(), title: x.title.trim() }));
    return ok;
  };
  // A part of the Profile section: its changes on the page's bar, its dot on Profile's title.
  useSaveSlot("profile:details", {
    dirty,
    count: changed,
    blocked: nameMissing,
    problem: nameMissing ? "Add your first and last name" : problem,
    save,
    cancel: () => {
      setProblem(null);
      setD(was);
    },
  });
  // The dial codes as the floating list (design rules 6); a code saved before that isn't on it stays, first.
  const dials = [...(DIAL_CODES.some(([, c]) => c === d.phoneCode) ? [] : [{ value: d.phoneCode, label: d.phoneCode }]), ...DIAL_CODES.map(([iso, c]) => ({ value: c, label: `${iso} ${c}` }))];
  const name = `${d.first.trim()} ${d.last.trim()}`.trim() || fallbackName;

  return (
    <div className="rpf-id">
      <div className="rpf-band">
        <i className="rpf-band-mark" aria-hidden="true" />
        <Face coachId={coachId} photo={photo} initial={(name.charAt(0) || "?").toUpperCase()} name={name} facts={[data.business, d.title.trim()]} onError={setPhotoError} />
        <JoinCode code={joinCode} />
      </div>

      <div className="rpf-paper">
        {/* A picture not saved: in red on the paper, as Branding says its band's (`rbr-err`), never on the dark. */}
        {photoError && (
          <p className="rpf-perr" role="alert">
            {photoError}
          </p>
        )}
        <section className="rpf-part" aria-label="About you">
          <h3>About you</h3>
          <div className="rpf-fields">
            <Line label="First name" value={d.first} onChange={set("first")} max={LIMIT.displayName} auto="given-name" />
            <Line label="Last name" value={d.last} onChange={set("last")} max={LIMIT.displayName} auto="family-name" />
            <div className="rst-field">
              <span className="dlh-label">Date of birth</span>
              <DateText value={d.birthdate} onChange={set("birthdate")} label="Date of birth" fromYear={1900} placeholder="" className="rpf-dateline" />
            </div>
            <Line label="What you coach" value={d.title} onChange={set("title")} max={LIMIT.title} />
          </div>
        </section>

        <section className="rpf-part" aria-label="Contact">
          <h3>Contact</h3>
          <div className="rpf-fields">
            <div className="rst-field">
              <span className="dlh-label">Email</span>
              <span className="rst-static rpf-email">{data.email}</span>
            </div>
            <div className="rst-field">
              <span className="dlh-label">Phone</span>
              <span className="rpf-phone">
                <Picker value={d.phoneCode} onChange={set("phoneCode")} label="Country dial code" className="rst-pick rpf-dial" options={dials} />
                <input className="dlh-line" type="tel" inputMode="tel" value={d.phone} onChange={(e) => set("phone")(e.target.value)} aria-label="Phone number" autoComplete="off" maxLength={30} />
              </span>
            </div>
          </div>
        </section>

        <section className="rpf-part" aria-label="Address">
          <h3>Address</h3>
          <div className="rpf-fields three">
            <Line label="Address" value={d.address} onChange={set("address")} max={160} auto="street-address" wide />
            <Line label="Postcode" value={d.postcode} onChange={set("postcode")} max={20} auto="postal-code" />
            <Line label="City" value={d.city} onChange={set("city")} max={80} auto="address-level2" />
            <div className="rst-field">
              <span className="dlh-label">Country</span>
              <Picker value={d.countryCode} onChange={set("countryCode")} label="Country" className="rst-pick" empty="" options={countries.map((c) => ({ value: c.code, label: c.name }))} />
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

/** A field on its clean line, its label over it, nothing in it until typed. */
function Line({ label, value, onChange, max, auto, wide = false }: { label: string; value: string; onChange: (v: string) => void; max: number; auto?: string; wide?: boolean }) {
  return (
    <label className={`rst-field${wide ? " wide" : ""}`}>
      <span className="dlh-label">{label}</span>
      <input className="dlh-line" value={value} onChange={(e) => onChange(e.target.value)} maxLength={max} autoComplete={auto ?? "off"} />
    </label>
  );
}

/** The face on the band: the picture, else the initial on white; the camera on its edge and Replace photo (Upload photo
 *  with none) open the computer's own picker in one tap, framed, then saved at once; Remove asks in place and brings the
 *  initial back. The same picture as Public profile's (uploadCoachPhotoAction, kind avatar). */
function Face({ coachId, photo, initial, name, facts, onError }: { coachId: number; photo: string | null; initial: string; name: string; facts: string[]; onError: (error: string) => void }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, start] = useTransition();
  const [framing, setFraming] = useState<File | null>(null);
  const [asking, setAsking] = useState(false);
  // Said on the paper under the band (the parent's), in red.
  const setError = onError;
  // What shows until the page reads the saved picture back: a picture just framed (from the computer), or none.
  const [local, setLocal] = useState<{ src: string | null } | null>(null);
  const [seen, setSeen] = useState(photo);
  if (photo !== seen) {
    setSeen(photo);
    setLocal(null);
  }
  const src = local ? local.src : photo ? pic(photo, 480) : null;

  const send = (file: File) => {
    // uploadCoachPhotoAction saves nothing and says nothing for an empty file, one over 6 MB or one that isn't a
    // picture, so those are refused here, before the face shows a picture that was never kept.
    if (file.size === 0 || !file.type.startsWith("image/")) return setError("That file isn't a picture.");
    if (file.size > 6 * 1024 * 1024) return setError(`${Math.round(file.size / 1024 / 1024)} MB is over 6 MB.`);
    const fd = new FormData();
    fd.set("coachId", String(coachId));
    fd.set("kind", "avatar");
    fd.set("file", file);
    setError("");
    setLocal({ src: URL.createObjectURL(file) });
    start(async () => {
      try {
        await uploadCoachPhotoAction(fd);
        router.refresh();
      } catch {
        setLocal(null);
        setError("Not saved. Try again.");
      }
    });
  };
  const remove = () => {
    setAsking(false);
    setError("");
    const fd = new FormData();
    fd.set("coachId", String(coachId));
    fd.set("kind", "avatar");
    setLocal({ src: null });
    start(async () => {
      try {
        await removeCoachPhotoAction(fd);
        router.refresh();
      } catch {
        setLocal(null);
        setError("Not removed. Try again.");
      }
    });
  };
  const pick = () => input.current?.click();

  return (
    <div className="rpf-who">
      <span className={`rpf-face${busy ? " busy" : ""}`}>
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element -- the coach's own face, or the one just picked
          <img src={src} alt="" />
        ) : (
          <span className="rpf-face-none" aria-hidden="true">
            {initial}
          </span>
        )}
        <button type="button" className="rpf-cam" onClick={pick} disabled={busy} aria-label={src ? "Replace photo" : "Upload photo"} title={src ? "Replace photo" : "Upload photo"}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
            <circle cx="12" cy="13" r="3.5" />
          </svg>
        </button>
      </span>
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file && file.type.startsWith("image/")) setFraming(file);
        }}
      />
      <div className="rpf-who-words">
        <b>{name}</b>
        {facts.some(Boolean) && (
          <span>
            <SepJoin parts={facts} />
          </span>
        )}
        <div className="rpf-who-acts">
          {asking ? (
            <>
              <span className="rpf-ask">Remove photo?</span>
              <button type="button" className="rpf-bword" onClick={() => setAsking(false)}>
                Cancel
              </button>
              <button type="button" className="rpf-bword" onClick={remove}>
                Remove
              </button>
            </>
          ) : (
            <>
              <button type="button" className="rpf-bpill" onClick={pick} disabled={busy}>
                {busy ? "Saving…" : src ? "Replace photo" : "Upload photo"}
              </button>
              {src && !busy && (
                <button type="button" className="rpf-bword" onClick={() => setAsking(true)}>
                  Remove
                </button>
              )}
            </>
          )}
        </div>
      </div>
      {framing && (
        <AvatarCropDialog
          file={framing}
          onCancel={() => setFraming(null)}
          onUse={(cropped) => {
            setFraming(null);
            send(cropped);
          }}
        />
      )}
    </div>
  );
}
