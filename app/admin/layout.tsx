import { cookies, headers } from "next/headers";
import AdminOpening from "./AdminOpening";
import { redirect } from "next/navigation";
import { cameFromSite, NATIVE_COOKIE, OPENED_COOKIE, QUIET_COOKIE } from "../lib/quietLoad";

// Every coach admin screen (7 Nov): the opening plays over the first one a page load draws; this layout stays mounted
// from screen to screen, so moving around the admin never plays it again.
// A load onto a new build (FreshBuild's quiet cookie, 16 Nov, Alex) skips it: the coach was mid-work, not opening the app.
// A mouse or trackpad that has moved over the admin (22 Nov, Alex: on his touchscreen laptop the row tools showed all the
// time): Chrome on Windows can report that nothing hovers (hover: none, any-hover: none, pointer: coarse) though a
// trackpad is there, so no media query tells it from a tablet. The first real mouse move marks the page (data-mouse on
// <html>, never a class React renders) and the laptop remembers it; the "always shown on a touch screen" rules apply only
// without it (html:not([data-mouse]) in the any-hover: none blocks), so hover-to-show is back. Touch alone never marks it.
const MOUSE_SCRIPT = `(function(){var d=document.documentElement,K="nc-mouse";try{if(localStorage.getItem(K)==="1")d.setAttribute("data-mouse","")}catch(e){}function f(e){if(e.pointerType!=="mouse")return;d.setAttribute("data-mouse","");try{localStorage.setItem(K,"1")}catch(e){}removeEventListener("pointermove",f)}addEventListener("pointermove",f,{passive:true})})();`;

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // And any load after the first in this browser session: a reload, or a tab the browser put to sleep coming back.
  const jar = await cookies();
  // In the phone app a coach belongs on their phone screens (21 Oct); sent there before the admin draws (17 Nov, Alex).
  if (jar.get(NATIVE_COOKIE)?.value === "1") redirect("/coach");
  // Arriving from the website's Sign in is an open, though it played before in this browser session (19 Nov, Alex).
  const fromSite = cameFromSite((await headers()).get("referer"));
  const quiet = jar.get(QUIET_COOKIE)?.value === "1" || (jar.get(OPENED_COOKIE)?.value === "1" && !fromSite);
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: MOUSE_SCRIPT }} />
      {children}
      <AdminOpening quiet={quiet} />
    </>
  );
}
