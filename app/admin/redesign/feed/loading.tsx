import PageSkeleton from "../PageSkeleton";

// The Feed's outline: its header, Needs you and Activity (docs/rail-layout-plan.md): drawn at once on a move while the page is read, beside a rail that stays.
export default function Loading() {
  return <PageSkeleton title="Feed" cards={[200, 320]} />;
}
