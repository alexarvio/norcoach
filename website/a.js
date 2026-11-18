/* Direction A: the top bar, the entrances and How it works' three tracks (see a.css). */
(function () {
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');

  /* The top bar turns to dark glass once the page moves. */
  var top = document.querySelector('.top');
  function onScroll() { top.classList.toggle('scrolled', window.scrollY > 8); }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* Each section comes in once, as it scrolls into view. */
  var reveals = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window && !reduce.matches) {
    var rio = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('in'); rio.unobserve(e.target); }
      });
    }, { rootMargin: '0px 0px -6% 0px', threshold: 0.08 });
    reveals.forEach(function (el) { rio.observe(el); });
  } else {
    reveals.forEach(function (el) { el.classList.add('in'); });
  }

  /* How it works: Lifestyle | Training | Nutrition. The screens change by themselves every few seconds (the line in
     the picked pill fills until the next), and stop for good once the visitor picks one, taps an arrow, swipes or uses
     the arrow keys. Paused while the pointer is over it, while it has the keyboard, and while it is off screen. */
  var T = document.querySelector('[data-tracks]');
  if (T) {
    var tabs = Array.prototype.slice.call(T.querySelectorAll('[role="tab"]'));
    var texts = Array.prototype.slice.call(T.querySelectorAll('[role="tabpanel"]'));
    var lapImgs = Array.prototype.slice.call(T.querySelectorAll('.lid .screen.stack img'));
    var phImgs = Array.prototype.slice.call(T.querySelectorAll('.phone .screen.stack img'));
    var pill = T.querySelector('.pill');
    var bar = T.querySelector('.prog i');
    var stage = T.querySelector('.stage');
    var cur = Math.max(0, tabs.findIndex(function (t) { return t.getAttribute('aria-selected') === 'true'; }));
    var auto = !reduce.matches;
    var inView = false, hovered = false, focused = false, wasTimer = 0;

    function placePill(instant) {
      var t = tabs[cur];
      if (instant) pill.style.transition = 'none';
      pill.style.width = t.offsetWidth + 'px';
      pill.style.transform = 'translateX(' + t.offsetLeft + 'px)';
      if (instant) { void pill.offsetWidth; pill.style.transition = ''; }
    }
    function swap(list, n) {
      list.forEach(function (img, k) {
        if (k === n) { img.classList.remove('was'); img.classList.add('on'); img.removeAttribute('aria-hidden'); }
        else if (img.classList.contains('on')) { img.classList.remove('on'); img.classList.add('was'); img.setAttribute('aria-hidden', 'true'); }
        else { img.classList.remove('was'); img.setAttribute('aria-hidden', 'true'); }
      });
    }
    function setPaused() {
      T.classList.toggle('paused', !inView || hovered || focused || document.hidden);
    }
    function restartBar() {
      bar.classList.remove('run');
      void bar.offsetWidth;
      if (auto) bar.classList.add('run');
      setPaused();
    }
    function stopAuto() {
      auto = false;
      T.classList.remove('auto');
      bar.classList.remove('run');
    }
    function show(n, how) {
      n = (n + tabs.length) % tabs.length;
      var changed = n !== cur;
      cur = n;
      tabs.forEach(function (t, k) {
        var on = k === n;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
      });
      texts.forEach(function (p, k) {
        var on = k === n;
        p.classList.toggle('on', on);
        p.setAttribute('aria-hidden', String(!on));
      });
      if (changed || how === 'init') {
        swap(lapImgs, n); swap(phImgs, n);
        clearTimeout(wasTimer);
        wasTimer = setTimeout(function () {
          T.querySelectorAll('.screen.stack img.was').forEach(function (img) { img.classList.remove('was'); });
        }, 900);
      }
      T.style.setProperty('--c', tabs[n].getAttribute('data-colour'));
      placePill(how === 'init');
      if (how === 'user') stopAuto();
      restartBar();
    }

    if (auto) T.classList.add('auto');
    show(cur, 'init');

    bar.addEventListener('animationend', function () { if (auto) show(cur + 1, 'auto'); });

    tabs.forEach(function (t, k) {
      t.addEventListener('click', function () { show(k, 'user'); });
    });
    T.querySelector('[role="tablist"]').addEventListener('keydown', function (e) {
      var next = null;
      if (e.key === 'ArrowRight') next = cur + 1;
      else if (e.key === 'ArrowLeft') next = cur - 1;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = tabs.length - 1;
      if (next === null) return;
      e.preventDefault();
      show(next, 'user');
      tabs[cur].focus();
    });
    T.querySelector('[data-prev]').addEventListener('click', function () { show(cur - 1, 'user'); });
    T.querySelector('[data-next]').addEventListener('click', function () { show(cur + 1, 'user'); });

    /* The arrow keys anywhere on the page while the screens are in view (not while typing, not in the tabs, which
       handle their own). */
    document.addEventListener('keydown', function (e) {
      if (!inView || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      var el = e.target;
      if (el && el.closest && (el.closest('input, textarea, select, [contenteditable]') || el.closest('[role="tablist"]'))) return;
      show(cur + (e.key === 'ArrowRight' ? 1 : -1), 'user');
    });

    /* Swipe on touch: sideways only, an up-and-down swipe still scrolls the page. */
    var sx = null, sy = 0;
    stage.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) { sx = null; return; }
      sx = e.touches[0].clientX; sy = e.touches[0].clientY;
    }, { passive: true });
    stage.addEventListener('touchend', function (e) {
      if (sx === null) return;
      var t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
      sx = null;
      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.3) show(cur + (dx < 0 ? 1 : -1), 'user');
    }, { passive: true });

    /* Pause while the mouse is on the toggle or its arrows (a tap is not a hover; over the screens it keeps playing)
       and while it has the keyboard. */
    var controls = T.querySelector('.controls');
    controls.addEventListener('pointerenter', function (e) { if (e.pointerType === 'mouse') { hovered = true; setPaused(); } });
    controls.addEventListener('pointerleave', function (e) { if (e.pointerType === 'mouse') { hovered = false; setPaused(); } });
    T.addEventListener('focusin', function () { focused = true; setPaused(); });
    T.addEventListener('focusout', function (e) { if (!T.contains(e.relatedTarget)) { focused = false; setPaused(); } });
    document.addEventListener('visibilitychange', setPaused);

    /* Plays only while it is on screen, and fetches all six screens as it comes near. */
    var loaded = false;
    function loadAll() {
      if (loaded) return;
      loaded = true;
      lapImgs.concat(phImgs).forEach(function (img) { img.loading = 'eager'; });
    }
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        entries.forEach(function (e) { if (e.isIntersecting) loadAll(); });
      }, { rootMargin: '600px 0px' }).observe(T);
      new IntersectionObserver(function (entries) {
        entries.forEach(function (e) { inView = e.isIntersecting; setPaused(); });
      }, { threshold: 0.35 }).observe(stage);
    } else {
      loadAll(); inView = true; setPaused();
    }

    var onReduce = function () { if (reduce.matches) stopAuto(); };
    if (reduce.addEventListener) reduce.addEventListener('change', onReduce); else if (reduce.addListener) reduce.addListener(onReduce);
    window.addEventListener('resize', function () { placePill(true); });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { placePill(true); });
  }

})();
