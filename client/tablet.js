/* Tablet navigation is a view onto the existing cards. It never owns study records. */
(() => {
  'use strict';
  const html = document.documentElement;
  const reader = document.getElementById('reader-view');
  const content = document.getElementById('main-content');
  const cardsHost = document.getElementById('question-list');
  const route = document.querySelector('.route-bar');
  if (!reader || !content || !cardsHost || !route) return;
  const forced = new URLSearchParams(location.search).get('layout') === 'tablet';
  const touch = navigator.maxTouchPoints > 0 || matchMedia('(any-pointer: coarse)').matches;
  const tabletScreen = Math.min(screen.width, screen.height) >= 600;
  if (!forced && !(touch && tabletScreen)) return;
  html.classList.add('review-tablet');

  const aside = document.createElement('aside');
  aside.id = 'tablet-outline';
  aside.className = 'tablet-outline';
  aside.setAttribute('aria-label', '课程与题目目录');
  aside.innerHTML = '<div class="tablet-outline-heading"><h2 id="tablet-outline-title">题目目录</h2><button id="tablet-outline-close" type="button" class="icon-button" aria-label="关闭题目目录">×</button></div><div class="tablet-course-heading"><strong id="tablet-course-title"></strong><button id="tablet-switch-course" class="button button-outline" type="button" aria-haspopup="dialog" aria-controls="course-dialog">切换课程 <span aria-hidden="true">↗</span></button></div><p id="tablet-outline-position" class="tablet-outline-position" aria-live="off"></p><nav id="tablet-outline-list" class="tablet-outline-list" aria-label="跳转到题目"></nav>';
  const drawer = document.createElement('dialog');
  drawer.id = 'tablet-outline-dialog';
  drawer.className = 'tablet-outline-dialog';
  drawer.setAttribute('aria-labelledby', 'tablet-outline-title');
  document.body.append(drawer);
  const toggle = document.createElement('button');
  toggle.id = 'tablet-outline-toggle';
  toggle.className = 'button button-outline tablet-outline-toggle';
  toggle.type = 'button';
  toggle.setAttribute('aria-haspopup', 'dialog');
  toggle.setAttribute('aria-controls', drawer.id);
  toggle.setAttribute('aria-expanded', 'false');
  toggle.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M9 6h12M9 12h12M9 18h12M3 6h1M3 12h1M3 18h1"/></svg><span>目录</span>';
  route.insertBefore(toggle, document.getElementById('route-context'));
  const list = aside.querySelector('#tablet-outline-list');
  const position = aside.querySelector('#tablet-outline-position');
  const title = aside.querySelector('#tablet-course-title');
  const closeButton = aside.querySelector('#tablet-outline-close');
  const wideQuery = matchMedia('(min-width: 1100px) and (orientation: landscape)');
  let visibleCards = [], buttons = new Map(), signature = '', activeId = '', frame = 0;
  let lastListTouch = 0, previousWidth = innerWidth, previousHeight = innerHeight;
  let resizeAnchor = null, resizeTimer = 0, courseOverflow = null;

  function closeDrawer() { if (drawer.open) drawer.close(); }
  toggle.addEventListener('click', () => {
    if (drawer.open) return closeDrawer();
    drawer.showModal();
    toggle.setAttribute('aria-expanded', 'true');
    const active = buttons.get(activeId);
    (active || closeButton).focus({preventScroll: true});
    if (active) list.scrollTop = Math.max(0, active.offsetTop - list.offsetTop - list.clientHeight / 3);
  });
  closeButton.addEventListener('click', closeDrawer);
  drawer.addEventListener('close', () => toggle.setAttribute('aria-expanded', 'false'));
  drawer.addEventListener('click', event => {
    if (event.target !== drawer) return;
    const rect = drawer.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDrawer();
  });
  aside.querySelector('#tablet-switch-course').addEventListener('click', () => {
    closeDrawer();
    const courses = document.getElementById('course-dialog');
    if (!courses || courses.open) return;
    courseOverflow = document.body.style.overflow;
    courses.showModal();
    document.body.style.overflow = 'hidden';
    document.getElementById('close-courses')?.focus({preventScroll: true});
  });
  document.getElementById('course-dialog')?.addEventListener('close', () => {
    if (courseOverflow !== null) { document.body.style.overflow = courseOverflow; courseOverflow = null; }
  });
  for (const type of ['pointerdown', 'wheel', 'touchstart']) list.addEventListener(type, () => { lastListTouch = performance.now(); }, {passive: true});

  function readingEdge() { return Math.max(0, route.getBoundingClientRect().bottom) + 18; }
  function schedule() { if (!frame) frame = requestAnimationFrame(updateCurrent); }
  function updateCurrent() {
    frame = 0;
    if (document.body.dataset.view !== 'reader' || !visibleCards.length) return;
    const edge = readingEdge();
    const current = visibleCards.find(card => card.getBoundingClientRect().bottom > edge) || visibleCards.at(-1);
    if (!current) return;
    // Keep a pre-resize reading anchor; note editors and cards are never remounted.
    resizeAnchor = {id: current.id, offset: current.getBoundingClientRect().top};
    if (current.id === activeId) return;
    const old = buttons.get(activeId);
    old?.removeAttribute('aria-current');
    activeId = current.id;
    const button = buttons.get(activeId);
    button?.setAttribute('aria-current', 'location');
    position.textContent = `第 ${visibleCards.indexOf(current) + 1} / ${visibleCards.length} 题`;
    if (button && wideQuery.matches && performance.now() - lastListTouch > 1800) {
      const box = button.getBoundingClientRect(), bounds = list.getBoundingClientRect();
      if (box.top < bounds.top || box.bottom > bounds.bottom) list.scrollTop += box.top - bounds.top - 16;
    }
  }
  function mountLayout() {
    const wide = wideQuery.matches;
    html.dataset.tabletWide = String(wide);
    if (wide) { closeDrawer(); if (aside.parentNode !== reader) reader.insertBefore(aside, content); }
    else if (aside.parentNode !== drawer) drawer.append(aside);
    const header = document.querySelector('.topbar');
    const hiddenHeader = document.body.classList.contains('is-fullscreen') || document.body.classList.contains('is-immersive') || document.fullscreenElement;
    html.style.setProperty('--tablet-header-height', `${hiddenHeader ? 0 : Math.ceil(header?.getBoundingClientRect().height || 0)}px`);
    const editing = document.activeElement?.matches('textarea,input:not([type="checkbox"]):not([type="file"])');
    const viewport = window.visualViewport;
    const keyboard = Boolean(editing && viewport && (innerHeight - viewport.height > 140 || viewport.height < Math.min(screen.width, screen.height) * .6));
    html.classList.toggle('tablet-keyboard-open', keyboard);
    schedule();
  }
  function rebuild() {
    const cards = [...cardsHost.querySelectorAll('.question-card')].filter(card => !card.hidden);
    const courseTitle = document.getElementById('book-title')?.textContent || '';
    const next = courseTitle + cards.map(card => `${card.id}:${card.classList.contains('marked')}:${card.classList.contains('is-reviewed')}`).join('|');
    if (next === signature) return schedule();
    signature = next;
    visibleCards = cards;
    title.textContent = courseTitle;
    const scroll = list.scrollTop, focusedTarget = list.contains(document.activeElement) ? document.activeElement.dataset.target : null;
    buttons = new Map();
    const fragment = document.createDocumentFragment();
    for (const [index, card] of cards.entries()) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'tablet-question-link';
      button.dataset.target = card.id;
      const number = card.querySelector('.question-number')?.textContent || String(index + 1);
      const label = card.querySelector('.question-title')?.textContent || number;
      const marked = card.classList.contains('marked'), reviewed = card.classList.contains('is-reviewed');
      const count = document.createElement('span');count.className = 'tablet-question-number';count.textContent = number;
      const copy = document.createElement('span');copy.className = 'tablet-question-copy';copy.textContent = label;
      const state = document.createElement('span');state.className = 'tablet-question-mark';state.textContent = marked ? '⚑' : reviewed ? '✓' : '';state.setAttribute('aria-hidden', 'true');
      button.setAttribute('aria-label', `${number}，${label}${marked ? '，还不会' : ''}${reviewed ? '，已复习' : ''}`);
      button.append(count, copy, state);
      button.addEventListener('click', () => {
        closeDrawer();
        const top = card.getBoundingClientRect().top + scrollY - readingEdge();
        window.scrollTo({top: Math.max(0, top), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'});
        card.tabIndex = -1;
        card.focus({preventScroll: true});
        schedule();
      });
      buttons.set(card.id, button);
      fragment.append(button);
    }
    if (!cards.length) { const empty = document.createElement('p');empty.className = 'tablet-outline-empty';empty.textContent = '没有符合筛选的题目';fragment.append(empty); }
    list.replaceChildren(fragment);
    list.scrollTop = scroll;
    if (focusedTarget) buttons.get(focusedTarget)?.focus({preventScroll: true});
    activeId = '';
    position.textContent = cards.length ? `共 ${cards.length} 题` : '共 0 题';
    schedule();
  }
  new MutationObserver(rebuild).observe(cardsHost, {childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class']});
  new MutationObserver(() => { if (document.body.dataset.view !== 'reader') closeDrawer();mountLayout(); }).observe(document.body, {attributes: true, attributeFilter: ['data-view', 'class']});
  if (typeof ResizeObserver === 'function') new ResizeObserver(mountLayout).observe(document.querySelector('.topbar'));
  document.addEventListener('review:view-change', () => { closeDrawer();mountLayout();rebuild(); });
  document.addEventListener('review:fullscreen-change', mountLayout);
  document.addEventListener('focusin', mountLayout);
  document.addEventListener('focusout', () => setTimeout(mountLayout, 120));
  document.addEventListener('visibilitychange', () => { if (document.hidden) closeDrawer(); });
  window.addEventListener('scroll', schedule, {passive: true});
  window.addEventListener('resize', () => {
    const changedWidth = Math.abs(innerWidth - previousWidth) > 100;
    const changedOrientation = (innerWidth > innerHeight) !== (previousWidth > previousHeight);
    const anchor = resizeAnchor;
    previousWidth = innerWidth;previousHeight = innerHeight;
    mountLayout();
    if (changedWidth && changedOrientation && anchor && document.body.dataset.view === 'reader' && !document.activeElement?.matches('textarea,input')) {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const card = document.getElementById(anchor.id);
        if (card && !card.hidden) window.scrollTo({top: Math.max(0, card.getBoundingClientRect().top + scrollY - Math.max(readingEdge(), anchor.offset)), behavior: 'instant'});
        schedule();
      }, 180);
    }
  }, {passive: true});
  window.visualViewport?.addEventListener('resize', mountLayout, {passive: true});
  wideQuery.addEventListener?.('change', mountLayout);
  mountLayout();rebuild();
})();
