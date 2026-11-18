import "server-only";
import fs from "fs";
import { after as afterResponse } from "next/server";
import { describeMessageLink, hasMealComment, saveChatMedia, sendChatMessage, type ChatMedia } from "./queries";
import { fitPhoto, photoName, posterFromDevice, prepareChatMedia, putUpload, putUploadFromDisk, webVideo } from "./storage";
import { claimUpload, discardUpload, placeUpload } from "./streamUpload";
import { releaseOnce, takenKeyOf, takeOnce } from "./once";
import { fetchFoodComments } from "./chat/rows";
import { parseMessageLink, type MessageLink } from "./messageLinks";
import { pushCoachMessage } from "./coachPush";
import type { SessionUser } from "./auth";

// One message sent to a chat, its caller already checked (17 Nov): the body of sendChatMessageAction, shared with the
// chats' own route (app/api/chat/send), which sends without waiting behind the page's other server actions. Kept out
// of the "use server" file on purpose: anything exported there is callable from a browser, and this takes the user.

/** What the saving queries write where the upload then lands: the bytes stay on the disk, never in memory. */
const EMPTY = Buffer.alloc(0);

/** True once posted (false for a repeat, nothing to send, or a meal's second comment). Sends `formData`'s message (text, upload handle, poster, link, replyTo, nonce) to `clientId`'s chat as `user`. */
export async function sendChatAs(user: Pick<SessionUser, "id" | "role">, clientId: number, formData: FormData): Promise<boolean> {
  // Who you are is decided by your session, not by a form field.
  const sender: "client" | "coach" = user.role === "coach" ? "coach" : "client";

  const text = String(formData.get("text") || "").trim();
  // A photo, video, voice message or file was sent ahead to /api/upload and written to the disk as it came (4 Nov,
  // Alex: memory; there was no cap here before, now the upload's 128 MB a video, 20 MB a picture, 25 MB a file).
  // Taken once, only by the user who sent it and for this client.
  const up = claimUpload(formData.get("upload"), { userId: user.id, clientId: clientId || null, kinds: ["chat"] });
  if (!clientId) return (discardUpload(up), false);
  // A retry of a send that already arrived (its answer lost on the way): taken once (27 Oct, the outbox).
  const nonce = String(formData.get("nonce") || "").slice(0, 80);
  // Known in the store, so one that comes again after a restart or a deploy is still known (6 Nov, lib/once.ts).
  if (nonce && !takeOnce(`chat${clientId}`, nonce)) return (discardUpload(up), false);

  let media: ChatMedia | undefined;
  // Filing the file can fail (the disk, the bucket); its key is then given back, so the send going again goes through
  // instead of being taken for one already posted (6 Nov, review).
  if (up)
    try {
      // A picture (20 MB at most) is read once and kept shrunk, 2048 at most, never the phone's original as well (4 Nov,
      // Alex, fix 2: storage; fitPhoto); its name takes the fitted one's extension, which saveChatMedia files it under.
      const fitted = (up.type || "").startsWith("image/") ? await fitPhoto(fs.readFileSync(up.file)) : null;
      media = fitted ? saveChatMedia(clientId, fitted.bytes, fitted.type, photoName(up.name, fitted.type)) : saveChatMedia(clientId, EMPTY, up.type || "application/octet-stream", up.name);
      const onDisk = fitted ? (discardUpload(up), "") : placeUpload(up, media.path);
      // A video's first frame taken by the sending device (25 Oct, as WhatsApp): its poster at once.
      const frame = formData.get("poster") as File | null;
      if (media.type === "video" && frame && frame.size > 0 && frame.size < 5 * 1024 * 1024) await posterFromDevice(media.path, Buffer.from(await frame.arrayBuffer()));
      if (media.type === "image") {
        // Its small copies are made from these bytes while it goes to the bucket (25 Oct).
        const buffer = fitted?.bytes ?? fs.readFileSync(onDisk);
        void prepareChatMedia(media.path, "image", buffer);
        await putUpload(media.path, buffer, fitted?.type ?? (up.type || undefined));
      } else {
        // A video, a voice message or a file streams to the bucket, never read in.
        await putUploadFromDisk(media.path, onDisk, up.type || undefined);
      }
    } catch (err) {
      if (nonce) releaseOnce(`chat${clientId}`, nonce);
      throw err;
    }
  if (!text && !media) return false;

  // A link only one that parses, and only one the client can actually open.
  // The client links only their own sessions and exercises (asking about one
  // from the workout); describeMessageLink checks the day is theirs.
  let link: MessageLink | null = null;
  {
    try {
      link = parseMessageLink(JSON.parse(String(formData.get("link") || "null")));
    } catch {
      link = null;
    }
    if (link && sender === "client" && link.kind !== "session" && link.kind !== "exercise") link = null;
    if (link && describeMessageLink(clientId, link).gone) link = null;
    // A meal takes one comment: a second send (two tabs, a double click) is dropped. Its comments fetched, then checked and
    // the message made with nothing awaited between (the door writes memory before it yields).
    if (link?.kind === "food" && link.meal && hasMealComment(await fetchFoodComments(clientId, "send.mealGuard"), clientId, link.date, link.meal)) return false;
  }

  // A reply to one message (WhatsApp-style): sendChatMessage keeps it only if that message is in this chat.
  const replyTo = Number(formData.get("replyTo")) || null;
  const meal = link?.kind === "food" && link.meal ? { date: link.date, meal: link.meal } : null;
  // The key exactly as takeOnce kept it, or none when takeOnce ignored the nonce (not a one-time key's shape).
  const onceKey = takenKeyOf(`chat${clientId}`, nonce);
  await sendChatMessage(clientId, sender, text, media, link, replyTo, {
    // For the shadow to run the cut-over's statement with them; memory took the once key above (takeOnce).
    onceKey: onceKey ? { key: onceKey, at: Date.now() } : null,
    mealGuard: meal,
    path: meal ? "w.insert.mealComment" : "w.insert.send",
  });
  // The coach's phone buzzes for what a client writes (21 Oct, /coach).
  if (sender === "client") pushCoachMessage(clientId, { text, media: media?.type });
  // A video: its poster at once, then its small web copy, which the message then shows (25 Oct, Alex), the original
  // dropped once it does (4 Nov, Alex, fix 2: storage). Made after the answer, so the first to open the chat doesn't wait.
  const kind = media?.type;
  if (media && kind === "video") afterResponse(async () => (await prepareChatMedia(media.path, kind), await webVideo(media.path, { dropOriginal: true })));
  return true;
}
