import PageSkeleton from "../PageSkeleton";

// A client's Shape update outline: the tab track, an empty header and the update on top (docs/rail-layout-plan.md): drawn at once on a move while the page is read, beside a rail that stays.
export default function Loading() {
  return <PageSkeleton tabs cards={[420]} />;
}
