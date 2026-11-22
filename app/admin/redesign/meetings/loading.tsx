import PageSkeleton from "../PageSkeleton";

// A client's Meetings outline: the tab track, an empty header, the next call and the past ones (docs/rail-layout-plan.md): drawn at once on a move while the page is read, beside a rail that stays.
export default function Loading() {
  return <PageSkeleton tabs cards={[260, 180]} />;
}
