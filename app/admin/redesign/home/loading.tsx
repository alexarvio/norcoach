import PageSkeleton from "../PageSkeleton";

// A client's Home outline: the tab track, an empty header, the phase tiles and Muscle balance (docs/rail-layout-plan.md): drawn at once on a move while the page is read, beside a rail that stays.
export default function Loading() {
  return <PageSkeleton tabs head="home" cards={[148, 360]} />;
}
