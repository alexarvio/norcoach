import PageSkeleton from "../PageSkeleton";

// A client's Training outline: the tab track, an empty header, the week rail and the sessions (docs/rail-layout-plan.md): drawn at once on a move while the page is read, beside a rail that stays.
export default function Loading() {
  return <PageSkeleton tabs head="track" cards={[120, 420]} />;
}
