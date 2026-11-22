import PageSkeleton from "../PageSkeleton";

// The Calendar's outline: its header, the month and the day (docs/rail-layout-plan.md): drawn at once on a move while the page is read, beside a rail that stays.
export default function Loading() {
  return <PageSkeleton title="Calendar" cards={[360, 480]} />;
}
