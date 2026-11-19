// Keep one element where it is on screen while things around it fold (16 Nov, Alex: opening a session closed the one
// above it and "the whole screen jumps"). Every frame for `ms` the scroller is moved by however far the element has
// drifted, so the row the coach clicked stays under the pointer while the session above folds away and its own opens.
// The browser's own scroll anchoring is off meanwhile, so the two never correct the same move twice; the coach's own
// scrolling (wheel, touch, keys) ends it at once.

let stop: (() => void) | null = null;

/** An element's top put at a place on screen, at once: a session opened again where it was after the page loaded anew. */
export function putOnScreen(el: HTMLElement | null, top: number) {
  if (!el) return;
  const scroller = scrollerOf(el);
  const drift = el.getBoundingClientRect().top - top;
  if (Math.abs(drift) < 0.5) return;
  if (scroller === document.scrollingElement || scroller === document.documentElement || scroller === document.body) window.scrollBy({ top: drift, behavior: "instant" });
  else scroller.scrollTop += drift;
}

function scrollerOf(el: HTMLElement): HTMLElement {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY;
    if ((y === "auto" || y === "scroll" || y === "overlay") && p.scrollHeight > p.clientHeight) return p;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

export function pinOnScreen(el: HTMLElement | null, ms = 420) {
  stop?.();
  if (!el) return;
  const scroller = scrollerOf(el);
  const root = scroller === document.scrollingElement || scroller === document.documentElement || scroller === document.body;
  const anchorEl = root ? document.documentElement : scroller;
  const anchorWas = anchorEl.style.overflowAnchor;
  anchorEl.style.overflowAnchor = "none";
  const top = el.getBoundingClientRect().top;
  const end = performance.now() + ms;
  let frame = 0;
  const step = () => {
    if (!el.isConnected) return done();
    const drift = el.getBoundingClientRect().top - top;
    if (Math.abs(drift) >= 0.5) {
      if (root) window.scrollBy(0, drift);
      else scroller.scrollTop += drift;
    }
    if (performance.now() < end) frame = requestAnimationFrame(step);
    else done();
  };
  const done = () => {
    cancelAnimationFrame(frame);
    anchorEl.style.overflowAnchor = anchorWas;
    window.removeEventListener("wheel", done);
    window.removeEventListener("touchstart", done);
    window.removeEventListener("keydown", done);
    if (stop === done) stop = null;
  };
  window.addEventListener("wheel", done, { passive: true });
  window.addEventListener("touchstart", done, { passive: true });
  window.addEventListener("keydown", done);
  stop = done;
  // The first correction before the next paint: React has committed the click's change by the time this frame runs.
  frame = requestAnimationFrame(step);
}
