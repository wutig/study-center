/* Public-domain Southern Song poetry. Sources are bundled with the excerpts. */
(() => {
  'use strict';
  const node = document.getElementById('brand-quote');
  if (!node) return;
  const INTERVAL = 20000;
  let quotes = [], order = [], previous = '', timer = null, transition = null, hovering = false;
  try { previous = sessionStorage.getItem('review-center:last-quote') || ''; } catch (_) {}

  function shuffledIndices() {
    const result = quotes.map((_, index) => index);
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    if (result.length > 1 && quotes[result[result.length - 1]].text === previous) {
      [result[0], result[result.length - 1]] = [result[result.length - 1], result[0]];
    }
    return result;
  }

  function display(quote) {
    node.textContent = quote.text;
    node.title = `${quote.author}《${quote.work}》${quote.note ? `\n${quote.note}` : ''}\n${quote.source_url}\n每20秒随机换一句；本轮不重复`;
    node.dataset.author = quote.author;
    node.dataset.work = quote.work;
    previous = quote.text;
    try { sessionStorage.setItem('review-center:last-quote', previous); } catch (_) {}
    node.classList.remove('is-changing');
  }

  function next(immediate = false) {
    if (!quotes.length) return;
    if (!order.length) order = shuffledIndices();
    const quote = quotes[order.pop()];
    clearTimeout(transition);
    if (immediate || matchMedia('(prefers-reduced-motion: reduce)').matches) display(quote);
    else {
      node.classList.add('is-changing');
      transition = setTimeout(() => display(quote), 180);
    }
  }

  function schedule() {
    clearInterval(timer);
    timer = null;
    if (quotes.length > 1 && !document.hidden && !hovering) timer = setInterval(() => next(), INTERVAL);
  }

  node.addEventListener('mouseenter', () => { hovering = true; schedule(); });
  node.addEventListener('mouseleave', () => { hovering = false; schedule(); });
  document.addEventListener('visibilitychange', schedule);

  fetch('/study-center/assets/poems.json', {cache:'no-cache'})
    .then(response => {
      if (!response.ok) throw new Error('poetry-unavailable');
      return response.json();
    })
    .then(data => {
      const seen = new Set();
      quotes = (Array.isArray(data) ? data : data.quotes || []).filter(quote => {
        if (!quote || typeof quote.text !== 'string' || !quote.text.trim() || seen.has(quote.text) || !quote.author || !quote.work || !quote.source_url) return false;
        seen.add(quote.text);
        return true;
      });
      next(true);
      schedule();
    })
    .catch(() => { /* The source-verified fallback stays visible offline. */ });
})();
