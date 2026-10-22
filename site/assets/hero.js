(() => {
  'use strict';

  const home = document.getElementById('home-view');
  const marquee = document.getElementById('hero-marquee');
  const motionButton = document.getElementById('hero-motion-toggle');
  const courseDialog = document.getElementById('course-dialog');
  const openButton = document.getElementById('open-courses');
  const closeButton = document.getElementById('close-courses');
  if (!home || !marquee || !courseDialog || !openButton || !closeButton) return;

  const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
  const pauseKey = 'review-center.hero-poetry-paused';
  let manuallyPaused = false;
  let previousFocus = null;
  let priorOverflow = null;
  let sheetAnimation = null;
  let pointerStartedOutside = false;
  let coverIntroAllowed = true;
  let coverAnimations = [];
  try { manuallyPaused = localStorage.getItem(pauseKey) === 'true'; } catch (_) { /* Private browsing still works. */ }

  function cancelCoverIntro() {
    coverIntroAllowed = false;
    coverAnimations.forEach((animation) => animation.cancel());
    coverAnimations = [];
  }

  async function introduceCover() {
    const scene = document.querySelector('.hero-scene');
    const figure = document.querySelector('.hero-figure');
    if (!scene || !figure || !figure.animate || motionPreference.matches) return;
    await Promise.allSettled([scene.decode(), figure.decode()]);
    if (!coverIntroAllowed || document.body.dataset.view !== 'home' || document.hidden || motionPreference.matches) return;
    coverIntroAllowed = false;
    coverAnimations = [
      scene.animate([{ opacity: 0 }, { opacity: .2 }], { duration: 800, easing: 'ease-out' }),
      // Individual transforms leave the fixed 3.3% alignment correction intact.
      figure.animate([
        { opacity: 0, translate: '0 2vh', scale: '1.015' },
        { opacity: 1, translate: '0 0', scale: '1' }
      ], { duration: 880, delay: 100, fill: 'backwards', easing: 'cubic-bezier(.22,1,.36,1)' })
    ];
    const animations = coverAnimations;
    await Promise.allSettled(animations.map((animation) => animation.finished));
    animations.forEach((animation) => animation.cancel());
    if (coverAnimations === animations) coverAnimations = [];
  }

  function updateMotion() {
    const reduced = motionPreference.matches;
    const homeActive = document.body.dataset.view === 'home';
    const playing = !manuallyPaused && !reduced && !document.hidden && homeActive && !document.querySelector('dialog[open]');
    home.dataset.poetryMoving = String(playing);
    if (!motionButton) return;
    motionButton.setAttribute('aria-pressed', String(manuallyPaused || reduced));
    motionButton.textContent = reduced ? '诗词静止展示' : manuallyPaused ? '播放诗词' : '暂停诗词';
    motionButton.setAttribute('aria-label', reduced ? '已按系统减少动态效果设置静止展示诗词' : manuallyPaused ? '播放背景诗词' : '暂停背景诗词');
    motionButton.title = reduced ? '跟随系统的减少动态效果设置' : '只控制首页背景诗词';
  }

  function renderPoetry(poems) {
    const valid = poems.filter((p) => p && typeof p.text === 'string' && p.text.trim());
    const shuffled = [...valid];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const selected = shuffled.slice(0, 10);
    const group = document.createElement('div');
    group.className = 'hero-marquee-group';
    selected.forEach((poem) => {
      const verse = document.createElement('span');
      verse.className = 'hero-marquee-verse';
      verse.textContent = poem.text.trim();
      verse.title = [poem.author, poem.work ? `《${poem.work}》` : ''].join('');
      group.appendChild(verse);
      const separator = document.createElement('span');
      separator.className = 'hero-marquee-dot';
      separator.textContent = '·';
      group.appendChild(separator);
    });
    marquee.replaceChildren(group, group.cloneNode(true));
    updateMotion();
  }

  renderPoetry([
    { text: '莫等闲，白了少年头，空悲切。', author: '岳飞', work: '满江红' },
    { text: '待从头、收拾旧山河，朝天阙。', author: '岳飞', work: '满江红' },
    { text: '了却君王天下事，赢得生前身后名。', author: '辛弃疾', work: '破阵子' }
  ]);
  fetch('/study-center/assets/poems.json', { cache: 'force-cache' })
    .then((response) => { if (!response.ok) throw new Error('Poetry unavailable'); return response.json(); })
    .then((poems) => { if (Array.isArray(poems) && poems.length) renderPoetry(poems); })
    .catch(() => { /* The bundled fallback keeps the composition usable offline. */ });

  motionButton?.addEventListener('click', () => {
    if (motionPreference.matches) { updateMotion(); return; }
    manuallyPaused = !manuallyPaused;
    try { localStorage.setItem(pauseKey, String(manuallyPaused)); } catch (_) { /* Optional preference. */ }
    updateMotion();
  });
  document.addEventListener('visibilitychange', updateMotion);
  document.addEventListener('review:overlay-change', updateMotion);
  document.querySelectorAll('dialog').forEach((surface)=>surface.addEventListener('toggle',updateMotion));
  motionPreference.addEventListener('change', () => { if (motionPreference.matches) cancelCoverIntro(); updateMotion(); });

  function cancelSheetAnimation() {
    sheetAnimation?.cancel();
    sheetAnimation = null;
  }

  function closeCourses(options = {}) {
    if (!courseDialog.open) return;
    cancelSheetAnimation();
    courseDialog.close();
    if (options.restoreFocus !== false && document.body.dataset.view === 'home') {
      const target = previousFocus?.isConnected ? previousFocus : openButton;
      target.focus({ preventScroll: true });
    }
  }

  function openCourses() {
    if (courseDialog.open || document.body.dataset.view !== 'home') return;
    cancelSheetAnimation();
    previousFocus = document.activeElement;
    priorOverflow = document.body.style.overflow;
    courseDialog.showModal();
    openButton.setAttribute('aria-expanded', 'true');
    document.body.style.overflow = 'hidden';
    closeButton.focus({ preventScroll: true });
    if (!motionPreference.matches) {
      sheetAnimation = courseDialog.animate([
        { transform: 'translateX(32px)', opacity: .4 },
        { transform: 'translateX(0)', opacity: 1 }
      ], { duration: 280, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }
    updateMotion();
  }

  openButton.addEventListener('click', openCourses);
  closeButton.addEventListener('click', () => closeCourses());
  courseDialog.addEventListener('cancel', (event) => { event.preventDefault(); closeCourses(); });
  courseDialog.addEventListener('pointerdown', (event) => {
    const rect = courseDialog.getBoundingClientRect();
    pointerStartedOutside = event.target === courseDialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom);
  });
  courseDialog.addEventListener('click', (event) => {
    if (!pointerStartedOutside) return;
    const rect = courseDialog.getBoundingClientRect();
    const outside = event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
    pointerStartedOutside = false;
    if (outside) closeCourses();
  });
  courseDialog.addEventListener('close', () => {
    cancelSheetAnimation();
    openButton.setAttribute('aria-expanded', 'false');
    if (priorOverflow !== null) { document.body.style.overflow = priorOverflow; priorOverflow = null; }
    pointerStartedOutside = false;
    updateMotion();
  });
  document.addEventListener('review:view-change', (event) => {
    if (event.detail?.view !== 'home') { cancelCoverIntro(); closeCourses({ restoreFocus: false }); }
    updateMotion();
  });
  openButton.setAttribute('aria-expanded', 'false');
  updateMotion();
  introduceCover();
})();
