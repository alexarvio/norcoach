import { cookies } from "next/headers";
import AdminOpening from "./AdminOpening";
import { OPENED_COOKIE, QUIET_COOKIE } from "../lib/quietLoad";

// Every coach admin screen (7 Nov): the opening plays over the first one a page load draws; this layout stays mounted
// from screen to screen, so moving around the admin never plays it again.
// A load onto a new build (FreshBuild's quiet cookie, 16 Nov, Alex) skips it: the coach was mid-work, not opening the app.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // And any load after the first in this browser session: a reload, or a tab the browser put to sleep coming back.
  const jar = await cookies();
  const quiet = jar.get(QUIET_COOKIE)?.value === "1" || jar.get(OPENED_COOKIE)?.value === "1";
  return (
    <>
      {children}
      <AdminOpening quiet={quiet} />
    </>
  );
}
