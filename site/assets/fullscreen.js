/* Fullscreen is always user initiated. Study content and notes stay in app.js. */
(() => {
  'use strict';

  const readerButton = document.getElementById('fullscreen-button');
  const homeButton = document.getElementById('home-fullscreen-button');
  const buttons = [readerButton, homeButton].filter(Boolean);
  if (!buttons.length) return;
  const root = document.documentElement;
  const body = document.body;
  let immersive = false;
  let entering = false;
  let cancelEntering = false;
  let exiting = false;
  let pendingAnchor = null;
  let lastAnchor = null;
  let anchorFrame = 0;
  let restoreFrame = 0;
  let restoreVersion = 0;
  let noticeTimer = 0;
  let previousMode = '';
  let previousView = body.dataset.view;

  const inReader = () => body.dataset.view === 'reader';
  const activeButton = () => inReader() ? readerButton : homeButton;
  const isFullscreen = () => document.fullscreenElement === root;
  const mode = () => isFullscreen() ? 'fullscreen' : immersive ? 'immersive' : 'window';

  function notice(message) {
    if (typeof window.showToast === 'function') {
      window.showToast(message);
      return;
    }
    const toast = document.getElementById('toast');
    if (!toast) return;
    clearTimeout(noticeTimer);
    toast.textContent = message;
    toast.hidden = false;
    noticeTimer = setTimeout(() => { toast.hidden = true; }, 4200);
  }

  function captureAnchor() {
    if (!inReader()) return null;
    const cards = [...document.querySelectorAll('#reader-view .question-card:not([hidden])')];
    const topEdge = Math.min(innerHeight * .22, 120);
    const card = cards.find(item => {
      const rect = item.getBoundingClientRect();
      return rect.height > 0 && rect.bottom > topEdge;
    });
    return card ? {id:card.id, top:card.getBoundingClientRect().top, scrollY} : {scrollY};
  }

  function rememberAnchor() {
    if (entering || exiting || pendingAnchor || !inReader()) return;
    lastAnchor = captureAnchor();
  }

  function scheduleRemember() {
    if (anchorFrame) return;
    anchorFrame = requestAnimationFrame(() => { anchorFrame = 0; rememberAnchor(); });
  }

  function restoreAnchor(anchor) {
    if (!anchor || !inReader()) return;
    const version = ++restoreVersion;
    cancelAnimationFrame(restoreFrame);
    // Two frames let the browser fullscreen resize and the reading chrome settle.
    restoreFrame = requestAnimationFrame(() => {
      restoreFrame = requestAnimationFrame(() => {
        restoreFrame = 0;
        if (version !== restoreVersion || !inReader()) return;
        const card = anchor.id && document.getElementById(anchor.id);
        if (card && !card.hidden && card.getBoundingClientRect().height > 0) {
          window.scrollBy({top:card.getBoundingClientRect().top - anchor.top, behavior:'instant'});
        } else {
          window.scrollTo({top:anchor.scrollY || 0, behavior:'instant'});
        }
        pendingAnchor = null;
        lastAnchor = captureAnchor();
      });
    });
  }

  function syncState() {
    const currentMode = mode();
    const active = currentMode !== 'window';
    body.classList.toggle('is-fullscreen', currentMode === 'fullscreen');
    body.classList.toggle('is-immersive', currentMode === 'immersive');
    for (const button of buttons) {
      const label = button.querySelector('.fullscreen-label');
      const icon = button.querySelector('.fullscreen-icon');
      const text = currentMode === 'fullscreen' ? '退出全屏' : currentMode === 'immersive' ? '退出沉浸' : button === homeButton ? '首页全屏' : '全屏学习';
      button.setAttribute('aria-pressed', String(active));
      if (label) label.textContent = text;
      if (icon) icon.textContent = active ? '⊡' : '⛶';
      button.setAttribute('aria-label', text);
      button.title = active ? `${text}（Esc）` : button === homeButton ? '全屏查看收复地图与学习首页' : '隐藏浏览器界面，专注当前课程';
    }
    if (previousMode !== currentMode) {
      previousMode = currentMode;
      document.dispatchEvent(new CustomEvent('review:fullscreen-change', {detail:{mode:currentMode, active}}));
    }
  }

  function setImmersive(value) {
    pendingAnchor = pendingAnchor || captureAnchor();
    immersive = value;
    syncState();
    restoreAnchor(pendingAnchor);
  }

  function exit() {
    cancelEntering = true;
    if (immersive) setImmersive(false);
    if (!isFullscreen() || exiting) {
      syncState();
      return;
    }
    pendingAnchor = pendingAnchor || captureAnchor();
    exiting = true;
    let result;
    try { result = document.exitFullscreen(); }
    catch (_) {
      exiting = false;
      pendingAnchor = null;
      syncState();
      notice('暂时无法退出全屏，请按 Esc。');
      return;
    }
    Promise.resolve(result).then(() => {
      exiting = false;
      syncState();
      if (!isFullscreen()) restoreAnchor(pendingAnchor);
    }).catch(() => {
      exiting = false;
      pendingAnchor = null;
      syncState();
      notice('暂时无法退出全屏，请按 Esc。');
    });
  }

  function enterFromClick(event) {
    if (event.currentTarget !== activeButton()) return;
    if (entering) {
      cancelEntering = true;
      return;
    }
    if (isFullscreen() || immersive) {
      exit();
      return;
    }
    if (!event.isTrusted || (navigator.userActivation && !navigator.userActivation.isActive)) {
      notice(`请点击「${inReader() ? '全屏学习' : '首页全屏'}」进入全屏。`);
      return;
    }
    pendingAnchor = captureAnchor();
    lastAnchor = pendingAnchor;
    cancelEntering = false;
    if (typeof root.requestFullscreen !== 'function' || document.fullscreenEnabled === false) {
      setImmersive(true);
      notice('当前浏览器不支持页面全屏，已进入沉浸模式；按 Esc 退出。');
      return;
    }
    let result;
    entering = true;
    // Keep the browser API on the trusted click stack; no await or timer first.
    try { result = root.requestFullscreen(); }
    catch (_) { result = Promise.reject(new Error('fullscreen-unavailable')); }
    Promise.resolve(result).then(() => {
      entering = false;
      syncState();
      if (cancelEntering) exit();
      else restoreAnchor(pendingAnchor);
    }).catch(() => {
      entering = false;
      if (cancelEntering) {
        pendingAnchor = null;
        syncState();
        return;
      }
      setImmersive(true);
      notice('浏览器未允许全屏，已进入沉浸模式；按 Esc 退出。');
    });
  }

  buttons.forEach(button => button.addEventListener('click', enterFromClick));
  document.addEventListener('fullscreenchange', () => {
    const anchor = pendingAnchor || lastAnchor;
    if (isFullscreen()) immersive = false;
    syncState();
    if (cancelEntering && isFullscreen()) exit();
    else restoreAnchor(anchor);
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || !immersive) return;
    if (document.querySelector('dialog[open]')) return;
    // Let an open reading-settings popover consume its own Escape first.
    try { if (document.querySelector(':popover-open')) return; } catch (_) {}
    event.preventDefault();
    exit();
    activeButton()?.focus({preventScroll:true});
  });
  document.addEventListener('review:view-change', event => {
    const nextView = event.detail?.view;
    const leavingReader = previousView === 'reader' && nextView === 'home';
    previousView = nextView;
    syncState();
    if (nextView !== 'home') {
      requestAnimationFrame(rememberAnchor);
      return;
    }
    ++restoreVersion;
    cancelAnimationFrame(restoreFrame);
    restoreFrame = 0;
    pendingAnchor = null;
    lastAnchor = null;
    // Keep homepage fullscreen while selecting a course. Returning from a reader
    // retains the established exit behavior, so the next course starts predictably.
    if (leavingReader) exit();
  });
  window.addEventListener('scroll', scheduleRemember, {passive:true});
  window.addEventListener('resize', () => {
    // During a native fullscreen transition, fullscreenchange restores its anchor.
    if (!entering && !exiting) requestAnimationFrame(scheduleRemember);
  }, {passive:true});

  window.reviewFullscreen = Object.freeze({get mode() { return mode(); }, exit});
  syncState();
  requestAnimationFrame(rememberAnchor);
})();
