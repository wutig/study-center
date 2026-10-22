/* Small viewport adjustments; the same server remains the owner of all records. */
(() => {
  'use strict';
  const root = document.documentElement;
  const header = document.querySelector('.topbar');
  const mobile = matchMedia('(max-width: 900px) and (pointer: coarse), (max-width: 600px)');
  let frame = 0;
  function measure() {
    frame = 0;
    if (!mobile.matches) { root.style.removeProperty('--mobile-header-height');return; }
    root.style.setProperty('--mobile-header-height', `${Math.ceil(header.getBoundingClientRect().height)}px`);
    const viewport = window.visualViewport;
    const editing = document.activeElement?.matches('textarea,input:not([type="checkbox"]):not([type="file"])');
    document.body.classList.toggle('mobile-keyboard-open', Boolean(viewport && editing && innerHeight - viewport.height > 140));
  }
  function schedule() { if (!frame) frame = requestAnimationFrame(measure); }
  if (typeof ResizeObserver === 'function') new ResizeObserver(schedule).observe(header);
  window.addEventListener('resize', schedule, {passive:true});
  window.visualViewport?.addEventListener('resize', schedule, {passive:true});
  document.addEventListener('focusin', schedule);
  document.addEventListener('focusout', schedule);
  document.addEventListener('review:view-change', schedule);
  document.addEventListener('review:fullscreen-change', schedule);
  measure();
})();
