/* Reading preferences and keyboard affordances; study records stay in app.js. */
(() => {
  'use strict';
  const root = document.documentElement;
  const trigger = document.getElementById('reading-settings-trigger');
  const popover = document.getElementById('reading-settings');
  const search = document.getElementById('search-input');
  const sizes = {standard:'1.0625rem', large:'1.1875rem', largest:'1.3125rem'};
  const key = 'review-center:reading-size';
  const nativePopover = typeof popover.showPopover === 'function';
  const isOpen = () => nativePopover ? popover.matches(':popover-open') : !popover.hidden;
  function closePopover() {
    if (nativePopover) { if (isOpen()) popover.hidePopover(); }
    else { popover.hidden = true;trigger.setAttribute('aria-expanded','false'); }
  }
  if (!nativePopover) {
    // Safari versions without Popover still get the same reading-size controls.
    popover.dataset.popoverFallback = 'true';popover.hidden = true;
    trigger.removeAttribute('popovertarget');
    trigger.addEventListener('click', () => {
      popover.hidden = !popover.hidden;trigger.setAttribute('aria-expanded',String(!popover.hidden));
      if (!popover.hidden) positionPopover();
    });
    document.addEventListener('pointerdown', event => {
      if (!popover.contains(event.target) && !trigger.contains(event.target)) closePopover();
    });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') closePopover(); });
  }

  function applySize(value, remember = false) {
    if (!Object.hasOwn(sizes, value)) value = 'standard';
    const anchor = [...document.querySelectorAll('.question-card:not([hidden])')].find(el => {
      const rect = el.getBoundingClientRect();
      return rect.bottom > 90 && rect.top < innerHeight;
    });
    const before = anchor?.getBoundingClientRect().top;
    root.dataset.readingSize = value;
    root.style.setProperty('--reading-font-size', sizes[value]);
    for (const button of popover.querySelectorAll('[data-reading-size]')) {
      button.setAttribute('aria-pressed', String(button.dataset.readingSize === value));
    }
    if (anchor && Math.abs(anchor.getBoundingClientRect().top - before) > 1) {
      window.scrollBy({top:anchor.getBoundingClientRect().top - before, behavior:'instant'});
    }
    if (remember) try { localStorage.setItem(key, value); } catch (_) {}
  }

  function positionPopover() {
    const rect = trigger.getBoundingClientRect();
    const width = Math.min(292, innerWidth - 24);
    popover.style.width = `${width}px`;
    popover.style.left = `${Math.max(12, Math.min(innerWidth - width - 12, rect.right - width))}px`;
    const height = popover.offsetHeight || 200;
    popover.style.top = `${Math.max(12, Math.min(innerHeight - height - 12, rect.bottom + 8))}px`;
  }

  let preference = 'standard';
  try { preference = localStorage.getItem(key) || preference; } catch (_) {}
  applySize(preference);
  popover.addEventListener('click', event => {
    const button = event.target.closest('[data-reading-size]');
    if (button) applySize(button.dataset.readingSize, true);
  });
  popover.addEventListener('beforetoggle', event => {
    if (event.newState === 'open') positionPopover();
  });
  popover.addEventListener('toggle', event => {
    trigger.setAttribute('aria-expanded', String(event.newState === 'open'));
    if (event.newState === 'open') positionPopover();
  });
  window.addEventListener('resize', () => {
    if (isOpen()) positionPopover();
  });
  window.addEventListener('scroll', () => {
    if (isOpen()) positionPopover();
  }, {passive:true});

  const hint = document.querySelector('.search-shortcut');
  if (hint && /Mac|iPhone|iPad/.test(navigator.platform)) hint.textContent = '⌘ K';
  document.addEventListener('keydown', event => {
    const editing = event.target.closest?.('textarea, [contenteditable="true"]');
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'k' && !event.isComposing && !editing && !document.querySelector('dialog[open]')) {
      if (!search || search.offsetParent === null) return;
      event.preventDefault();
      closePopover();
      search.focus();search.select();
    }
  });
  search.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.isComposing && search.value) {
      event.preventDefault();event.stopPropagation();
      search.value = '';search.dispatchEvent(new Event('input', {bubbles:true}));
    }
  });
})();
