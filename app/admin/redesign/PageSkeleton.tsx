import "./messages/messages.css";
import "../../components/ui/ui.css";
import "./training/draft.css";
import "./training/trn.css";
import "./measurements/measurements.css";
import "./rail.css";
import PageSkeletonChat from "./PageSkeletonChat";

// A view's outline, drawn at once on a move while its page is read (22 Nov, docs/rail-layout-plan.md): every view's
// loading.tsx is this. The page's own room (`.rd-page`) with the view's real header, its title in words (Training's
// bare head), and one or two empty hairline cards of a believable height; a client's screens the tab bar's grey track
// first, no words in it, and an empty header. Still, no shimmer: only live things pulse (docs/DESIGN-RULES.md §7).
// A server component: no state, nothing to send but the outline. The CSS in the pages' own order, so the outline wears
// what the page will.

/** The client's tabs in the shell's order (RedesignShell's TABS; a client module can't lend its list to the server). */
const TAB_LABELS = ["Home", "Plan", "Lifestyle", "Training", "Nutrition", "Shape update", "Meetings", "Invoices"];

export type PageSkeletonProps = {
  /** The view's title as its header says it (Feed, Phases, Calendar, Library, Business, Coaches, Settings). None, an
   *  empty header (a client's screens, whose title is the client's own). */
  title?: string;
  /** A client's screens: the tab bar's grey track over the header, its tabs' room kept, no words. */
  tabs?: boolean;
  /** The empty cards under the header, each its height in px (default one of 240). [] for none. */
  cards?: number[];
  /** A client's header as the tab draws it, so the cards sit where the page's will: `home` the HOME eyebrow over the
   *  56px face's row; `track` a track tab's (Lifestyle, Training, Nutrition: `trn-head` with its 76px kept for the fact
   *  line); `bare` the bare head (the coach-wide views, Shape update, Meetings, Invoices, the Plan). */
  head?: "home" | "track" | "bare";
};

export default function PageSkeleton({ title, tabs = false, cards = [240], head = "bare" }: PageSkeletonProps) {
  return (
    <>
    {/* The chat's tab (and a chat kept open) as every framed page has it, before the page as they draw it. */}
    <PageSkeletonChat />
    <div className="rd-page rd-skel" aria-busy="true" aria-label={title ? `${title}, loading` : "Loading"}>
      {tabs && (
        <nav className="rd-nav rd-skel-nav" aria-hidden="true">
          {TAB_LABELS.map((l) => (
            <button key={l} type="button" data-label={l} tabIndex={-1} disabled>
              {l}
            </button>
          ))}
        </nav>
      )}
      <div className="rd trn rls">
        <header className={head === "track" ? "trn-head" : "trn-head bare"}>
          <div className="trn-head-main">
            <div className="trn-name-row">{title ? <h1 className="trn-name">{title}</h1> : <span className={`rd-skel-title${head === "home" ? " home" : ""}`} aria-hidden="true" />}</div>
          </div>
        </header>
        {cards.length > 0 && (
          <section className="rls-section rd-skel-cards" aria-hidden="true">
            {cards.map((h, i) => (
              <div key={i} className="rls-card rd-skel-card" style={{ height: h }} />
            ))}
          </section>
        )}
      </div>
    </div>
    </>
  );
}
