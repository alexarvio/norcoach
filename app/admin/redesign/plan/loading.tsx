import PageSkeleton from "../PageSkeleton";

// A client's Plan outline: the tab track, an empty header, Phases and Events (docs/rail-layout-plan.md): drawn at once on a move while the page is read, beside a rail that stays.
export default function Loading() {
  return <PageSkeleton tabs cards={[300, 220]} />;
}
