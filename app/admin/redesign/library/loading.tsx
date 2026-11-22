import PageSkeleton from "../PageSkeleton";

// The Library's outline: its header and the groups (docs/rail-layout-plan.md): drawn at once on a move while the page is read, beside a rail that stays.
export default function Loading() {
  return <PageSkeleton title="Library" cards={[480]} />;
}
