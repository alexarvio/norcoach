import "./chat-new-line.css";

// Where the new messages start (26 Nov, Alex: "every time I open the chat, if there's a new message, I want that
// labeled… a line that separates that new message from the rest of the chat… new message or messages if there's more
// than one"). One for every chat (the client's, the coach's phone, the laptop's panel): a hairline across the thread
// right above the first message from the other side that was unread when the chat opened, `New message` or `New
// messages` in the day heads' small caps in ink on it. It stays while the chat is open; opened again with nothing new,
// there is none.

/** The first unread message as the chat opened, and how many of the other side's messages run from it. */
export type NewLine = { id: number; count: number } | null;

/** The line's place in a thread: before the first of the other side's messages from `first` (a message id) on, never
 *  before one this side wrote after (they had it: a reply, or a read mark that never came), counting them. */
export function newLineOf(messages: readonly { id: number; mine: boolean }[], first: number | null | undefined): NewLine {
  if (first == null) return null;
  const lastMine = Math.max(0, ...messages.filter((m) => m.mine && m.id > 0).map((m) => m.id));
  const theirs = messages.filter((m) => !m.mine && m.id >= first && m.id > lastMine);
  if (!theirs.length) return null;
  return { id: Math.min(...theirs.map((m) => m.id)), count: theirs.length };
}

export default function ChatNewLine({ count }: { count: number }) {
  const words = count > 1 ? "New messages" : "New message";
  return (
    <div className="chat-new-line" role="separator" aria-label={words}>
      <span>{words}</span>
    </div>
  );
}
