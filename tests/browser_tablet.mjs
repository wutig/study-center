import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'file:///C:/Users/ROG/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';

// Each context has fresh IndexedDB and Caches. All writes are confined to this
// disposable project-path fixture, never to the user's live browser or notes.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixture = path.join(root, '.runtime', `tablet-browser-${Date.now()}`);
const site = path.join(fixture, 'site'), basePath = '/study-center/';
const legacySite = path.join(root, '.runtime', 'tablet-before-20261022', 'site');
let servedSite = site;
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const checks = [], errors = [], external = [], failedResponses = [], measurements = [];
const screenshots = [];
let browser, server, origin, base, currentPage;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const checked = text => { checks.push(text);console.log('PASS: ' + text); };
async function until(check, text, timeout = 30000) {
  const start = Date.now();while (Date.now() - start < timeout) { if (await check()) return;await delay(80); }throw Error(text);
}
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.pdf': 'application/pdf' };
async function serve(request, response) {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === basePath.slice(0, -1)) { response.writeHead(302, { Location: basePath });return response.end(); }
    if (!pathname.startsWith(basePath)) { response.writeHead(404);return response.end('Project path required'); }
    const file = path.resolve(servedSite, decodeURIComponent(pathname.slice(basePath.length)) || 'index.html');
    assert(file.startsWith(path.resolve(servedSite) + path.sep));
    const bytes = await fs.readFile(file);
    response.writeHead(200, { 'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });response.end(bytes);
  } catch { response.writeHead(404);response.end('Not found'); }
}
function watch(page) {
  currentPage = page;page.on('pageerror', error => errors.push(error.message));page.on('dialog', dialog => dialog.accept());
  page.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin) external.push(new URL(request.url()).origin); });
  page.on('response', response => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${new URL(response.url()).pathname}`); });
}
async function unlock(page, key) {
  await page.goto(base + '#key=' + encodeURIComponent(key));
  await page.waitForSelector('.course-card', { state: 'attached', timeout: 60000 });
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  assert(!page.url().includes('key='), 'key remained in address bar');
}
async function openCourse(page, sid) {
  if (await page.evaluate(() => document.body.dataset.view === 'reader')) { await page.locator('#back-home').click();await page.waitForFunction(() => document.body.dataset.view === 'home'); }
  await page.locator('#open-courses').click();await page.locator('#course-dialog').waitFor({ state: 'visible' });
  await page.locator(`.course-card[data-course-id="${sid}"]`).click();
  await page.waitForFunction(sid => document.body.dataset.view === 'reader' && app.active?.id === sid && document.querySelectorAll('.question-card').length > 0, sid);
}
async function records(page, sid) { return page.evaluate(async sid => (await (await fetch('/api/state/' + sid)).json()).records, sid); }
async function noOverflow(page, name) {
  const size = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  assert(size.document <= size.width + 1 && size.body <= size.width + 1, `${name}: ${JSON.stringify(size)}`);
}
async function screenshot(page, filename) { const file = path.join(fixture, filename);await page.screenshot({ path: file });screenshots.push(file); }
async function touchTargets(page, selectors, label) {
  const sizes = await page.evaluate(selectors => selectors.map(selector => {
    const el = document.querySelector(selector), rect = el?.getBoundingClientRect();
    return { selector, width: rect?.width || 0, height: rect?.height || 0, visible: Boolean(rect?.width && rect?.height) };
  }), selectors);
  for (const item of sizes) assert(item.visible && item.width >= 47.5 && item.height >= 47.5, `${label}: touch target ${JSON.stringify(item)}`);
}
async function closeOverlays(page) {
  for (const selector of ['#tablet-outline-close', '#close-courses', '#campaign-close', '#source-dialog .dialog-close', '#help-dialog .dialog-close']) {
    const el = page.locator(selector);if (await el.isVisible().catch(() => false)) await el.click().catch(() => {});
  }
}
async function courseGrid(page, columns) {
  await page.locator('#open-courses').click();await page.locator('#course-dialog').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.course-card').count(), 5);
  const count = await page.locator('#subject-list').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(/\s+/).length);
  assert.equal(count, columns, 'course grid columns');
  await page.locator('#course-dialog').evaluate(el => { el.scrollTop = el.scrollHeight; });
  const close = await page.locator('#close-courses').boundingBox();assert(close.y >= 0 && close.y + close.height <= (await page.viewportSize()).height + 1, 'course close is unreachable after scrolling');
  await touchTargets(page, ['#close-courses'], 'course dialog');
  await screenshot(page, `选课_${(await page.viewportSize()).width}x${(await page.viewportSize()).height}.png`);
  await page.locator('#close-courses').click();
}

await fs.mkdir(fixture, { recursive: true });await fs.cp(path.join(root, 'site'), site, { recursive: true });
const key = (await fs.readFile(path.join(root, '.private', 'key.txt'), 'utf8')).trim();
assert(key.length >= 32);
const manifest = JSON.parse(await fs.readFile(path.join(site, 'manifest.json'), 'utf8'));
try {
  server = http.createServer((request, response) => { serve(request, response); });
  await new Promise((resolve, reject) => { server.once('error', reject);server.listen(0, '127.0.0.1', resolve); });
  origin = `http://localhost:${server.address().port}`;base = origin + basePath;
  browser = await chromium.launch({ executablePath: edge, headless: true });
  const tablet = await browser.newContext({ viewport: { width: 1400, height: 984 }, screen: { width: 1400, height: 984 }, deviceScaleFactor: 1.5, isMobile: true, hasTouch: true, reducedMotion: 'reduce', acceptDownloads: true });
  const page = await tablet.newPage();const tabletCDP = await tablet.newCDPSession(page);watch(page);await unlock(page, key);
  await page.waitForFunction(() => document.documentElement.classList.contains('review-tablet'));
  await noOverflow(page, 'tablet home');await touchTargets(page, ['#open-courses', '#help-button', '#backup-link', '#restore-button'], 'tablet home');
  await screenshot(page, '平板横屏_首页.png');await courseGrid(page, 2);
  checked('Android触控条件激活平板样式，横屏首页无全局横溢出，课程两列且关闭按钮滚动后可达');

  const books = await page.evaluate(async () => await ReviewSite.getBooks());let total = 0;
  for (const book of books) {
    total += book.questions.length;await openCourse(page, book.id);
    assert.equal(await page.locator('.question-card').count(), book.questions.length);
    assert.equal(await page.locator('.math-error').count(), 0, book.id + ' formula');
    await noOverflow(page, book.id);
    await until(async () => await page.locator('#tablet-outline-list button[data-target]').count() === book.questions.length, book.id + ' outline count');
  }
  assert.equal(total, 203);
  checked('五课程203条目全部显示，公式无错误，目录条目与当前课程题目逐一对应');

  const sid = 'linear-algebra-2026-autumn';await openCourse(page, sid);
  await until(async () => await page.locator('#tablet-outline-list button[data-target]').count() === 82, 'linear outline not ready');
  const outlineTarget = page.locator('#tablet-outline-list button[data-target]').nth(7), target = await outlineTarget.getAttribute('data-target');
  await outlineTarget.click();
  await until(async () => (await outlineTarget.getAttribute('aria-current')) === 'location', 'outline does not highlight jumped question');
  const targetRect = await page.locator('#' + target).boundingBox();assert(targetRect.y >= -1 && targetRect.y < 450, 'outline jump did not place target below navigation');
  await touchTargets(page, ['#tablet-switch-course', '#tablet-outline-list button[data-target]', '.mark-button', '.reviewed-button', '.notes-toggle', '.answer-details summary', '#toggle-all-answers', '#toggle-all-notes', '#search-input', '#topic-select'], 'tablet reader');
  await screenshot(page, '平板横屏_目录与题目.png');
  checked('横屏侧目录能跳题并高亮，原题答案笔记维持单列顺序，关键触控区至少48px');
  await page.locator('#tablet-switch-course').click();await page.locator('#course-dialog').waitFor({ state: 'visible' });
  await page.locator('.course-card[data-course-id="analog-electronics-2026-autumn"]').click();
  await page.waitForFunction(() => app.active?.id === 'analog-electronics-2026-autumn');
  await until(async () => await page.locator('#tablet-outline-list button[data-target]').count() === 32, 'switch course did not update outline');
  await openCourse(page, sid);

  await page.locator('#toggle-all-answers').click();
  const answerClosed = await page.locator('.answer-details').evaluateAll(items => items.every(el => !el.open));assert(answerClosed);
  assert(await page.locator('.notes-editor').evaluateAll(items => items.every(el => el.hidden)), 'answer fold unexpectedly opened notes');
  await page.locator('#toggle-all-notes').click();assert(await page.locator('.notes-editor').evaluateAll(items => items.every(el => !el.hidden)));
  assert(await page.locator('.answer-details').evaluateAll(items => items.every(el => !el.open)), 'notes action changed answers');
  await page.locator('#toggle-all-notes').click();await page.locator('#toggle-all-answers').click();
  checked('批量答案与批量笔记开关彼此独立，全部展开与收起均生效');

  const first = page.locator('.question-card').first(), qid = await first.getAttribute('data-question-id');
  await first.locator('.notes-toggle').click();const editor = first.locator('textarea');
  await editor.fill('平板测试笔记：横竖屏和分屏保持同一题的理解记录。');
  const png = await page.evaluate(() => { const c = document.createElement('canvas');c.width = 420;c.height = 140;const ctx = c.getContext('2d');ctx.fillStyle = '#f1ece2';ctx.fillRect(0, 0, 420, 140);ctx.fillStyle = '#8b332b';ctx.font = '22px sans-serif';ctx.fillText('Tablet screenshot note', 18, 60);return c.toDataURL('image/png').split(',')[1]; });
  const chooserPromise = page.waitForEvent('filechooser');await first.getByRole('button', { name: '添加图片', exact: true }).click();
  const chooser = await chooserPromise;await chooser.setFiles({ name: 'tablet-note.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await first.locator('.mark-button').click();
  await until(async () => { const r = (await records(page, sid))[qid];return r.needs_review && r.notes.includes('平板测试笔记') && r.notes.includes('![截图]') && !r.notes.includes('截图处理中'); }, 'tablet photo note was not saved');
  await first.locator('.reviewed-button').click();
  await until(async () => (await page.locator(`#tablet-outline-list button[data-target="${await first.getAttribute('id')}"]`).getAttribute('aria-label')).includes('已复习'), 'outline did not reflect reviewed status');
  await page.locator('.filter-tab[data-filter="marked"]').click();
  await until(async () => await page.locator('#tablet-outline-list button[data-target]').count() === 1, 'outline did not follow marked filter');
  await page.locator('.filter-tab[data-filter="all"]').click();
  await until(async () => await page.locator('#tablet-outline-list button[data-target]').count() === 82, 'outline did not restore all questions');
  await page.reload();await page.waitForSelector('.question-card');await first.locator('.notes-toggle').click();
  assert((await editor.inputValue()).includes('平板测试笔记'));
  await page.waitForFunction(() => { const img = document.querySelector('.question-card .note-image-gallery img');return img?.complete && img.naturalWidth === 420; });
  checked('照片选择入口将文字、PNG及标记保存到隔离IndexedDB，刷新后图片与文字均可读取');

  for (const size of [{ width: 1120, height: 787 }, { width: 984, height: 1400 }, { width: 800, height: 1138 }, { width: 700, height: 900 }, { width: 1400, height: 450 }]) {
    await closeOverlays(page);if (size.height === 450) await editor.focus();await page.setViewportSize(size);
    if (size.height === 450) {
      // setViewportSize also resizes Playwright's screen. A real software
      // keyboard compresses the viewport while physical screen bounds remain.
      await tabletCDP.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1.5, mobile: true, screenWidth: 1400, screenHeight: 984 });
      await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    }
    await delay(160);await noOverflow(page, `reader ${size.width}x${size.height}`);
    assert((await editor.inputValue()).includes('平板测试笔记'), 'rotation lost note textarea');
    const r = (await records(page, sid))[qid];assert(r.notes.includes('平板测试笔记') && r.notes.includes('![截图]'));
    const width = await first.evaluate(el => el.getBoundingClientRect().width);assert(width <= 900, 'tablet reading line became too wide');
    if (size.width < 1100) {
      await page.locator('#tablet-outline-toggle').click();await page.locator('#tablet-outline').waitFor({ state: 'visible' });
      const last = page.locator('#tablet-outline-list button[data-target]').last();await last.scrollIntoViewIfNeeded();
      await touchTargets(page, ['#tablet-outline-close'], 'outline drawer');
      const close = await page.locator('#tablet-outline-close').boundingBox();assert(close.y >= 0 && close.y + close.height <= size.height + 1, 'outline close unreachable');
      await last.click();await until(async () => !(await page.locator('#tablet-outline').isVisible()), 'drawer did not close after jump');
    }
    if (size.height === 450) {
      const keyboard = await page.evaluate(() => ({ active: document.activeElement?.tagName, width: innerWidth, height: innerHeight, visual: visualViewport?.height, screen: { width: screen.width, height: screen.height }, className: document.documentElement.className }));
      assert(keyboard.className.includes('tablet-keyboard-open'), 'focused keyboard-compressed layout not activated: ' + JSON.stringify(keyboard));await editor.scrollIntoViewIfNeeded();
    }
    else await first.scrollIntoViewIfNeeded();
    await screenshot(page, `平板读题_${size.width}x${size.height}.png`);
    measurements.push({ ...size, questionWidth: width });
  }
  checked('横屏/竖屏/分屏与键盘压缩视口无全局横溢出，目录抽屉可关闭且跳题后收起，旋转不丢文字和截图');

  await page.setViewportSize({ width: 984, height: 1400 });await closeOverlays(page);await page.locator('#back-home').click();await courseGrid(page, 2);
  await screenshot(page, '平板竖屏_首页.png');await openCourse(page, sid);
  await page.locator('.source-link:not(:disabled)').first().click();await page.locator('#source-dialog').waitFor({ state: 'visible' });
  await page.waitForFunction(() => [...document.querySelectorAll('#source-images img')].some(img => img.complete && img.naturalWidth > 0));
  await page.locator('#zoom-in').click();await page.locator('#source-images').evaluate(el => { el.scrollTop = el.scrollHeight;el.scrollLeft = el.scrollWidth; });
  await touchTargets(page, ['#source-dialog .dialog-close', '#zoom-in', '#zoom-out'], 'source image');await screenshot(page, '平板竖屏_原图.png');await page.locator('#source-dialog .dialog-close').click();
  await page.locator('#campaign-reader-open').click();await page.locator('#campaign-dialog').waitFor({ state: 'visible' });await page.locator('#campaign-zoom-in').click();
  assert.notEqual((await page.locator('#campaign-zoom-value').textContent()).trim(), '100%');
  await page.locator('#campaign-dialog').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await touchTargets(page, ['#campaign-close'], 'campaign map');
  const close = await page.locator('#campaign-close').boundingBox();assert(close.y >= 0 && close.y + close.height <= 1401, 'map close unreachable after scroll');
  await screenshot(page, '平板竖屏_地图.png');await page.locator('#campaign-close').click();
  checked('竖屏课程保持两列，原图可缩放滚动，地图可缩放，弹窗关闭按钮保持可达');

  const appManifest = await page.evaluate(async () => { const url = document.querySelector('link[rel="manifest"]').href;return { url, data: await (await fetch(url)).json() }; });
  assert.equal(appManifest.data.display, 'standalone');assert(!appManifest.data.orientation || appManifest.data.orientation === 'any');
  assert(new URL(appManifest.data.start_url, appManifest.url).pathname.startsWith(basePath));assert(new URL(appManifest.data.scope, appManifest.url).pathname.startsWith(basePath));
  for (const size of ['192x192', '512x512']) assert(appManifest.data.icons.some(icon => icon.sizes === size));
  assert(!JSON.stringify(appManifest).includes(key));checked('Android主屏幕manifest使用standalone、允许转向、具备192/512图标且项目路径正确');

  const phone = await browser.newContext({ viewport: { width: 393, height: 852 }, screen: { width: 393, height: 852 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  const phonePage = await phone.newPage();watch(phonePage);await unlock(phonePage, key);
  assert.equal(await phonePage.evaluate(() => document.documentElement.classList.contains('review-tablet')), false);
  await noOverflow(phonePage, 'phone home regression');await openCourse(phonePage, sid);await noOverflow(phonePage, 'phone reader regression');await screenshot(phonePage, '原手机_回归.png');
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 1000 }, screen: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false, reducedMotion: 'reduce' });
  const desktopPage = await desktop.newPage();watch(desktopPage);await unlock(desktopPage, key);
  assert.equal(await desktopPage.evaluate(() => document.documentElement.classList.contains('review-tablet')), false);
  await noOverflow(desktopPage, 'desktop home regression');await openCourse(desktopPage, sid);await noOverflow(desktopPage, 'desktop reader regression');await screenshot(desktopPage, '原电脑_回归.png');
  checked('393px手机及1440px鼠标桌面不误启平板样式，首页与读题均无全局横溢出');

  // Install the actual previously deployed site in a fresh context, then swap
  // the HTTP fixture to the new deployment at the same origin and path.
  await fs.access(path.join(legacySite, 'sw.js'));
  servedSite = legacySite;
  const upgrade = await browser.newContext({ viewport: { width: 1120, height: 787 }, screen: { width: 1400, height: 984 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  const upgradePage = await upgrade.newPage();watch(upgradePage);await unlock(upgradePage, key);await openCourse(upgradePage, sid);
  const legacyCaches = await upgradePage.evaluate(async () => await caches.keys());
  assert(legacyCaches.some(name => name.includes('2026-10-22-mvjld2fw')), 'fixture is not the previously deployed worker');
  const legacyCard = upgradePage.locator('.question-card').first();await legacyCard.locator('.notes-toggle').click();
  await legacyCard.locator('textarea').fill('旧公网版升级测试：保留我原来的笔记。');await legacyCard.locator('.mark-button').click();
  await until(async () => { const r = (await records(upgradePage, sid))[qid];return r.notes.includes('旧公网版升级测试') && r.needs_review; }, 'legacy note did not save');
  const encrypted = Object.values(manifest.files)[0].url;
  await upgradePage.evaluate(async encrypted => { const response = await fetch(encrypted);if (!response.ok) throw Error('legacy encrypted download failed'); }, encrypted);
  const before = (await records(upgradePage, sid))[qid];
  servedSite = site;
  await upgradePage.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    const changed = new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    await registration.update();await changed;
  });
  await upgradePage.reload();await upgradePage.waitForSelector('.question-card');await upgradePage.waitForFunction(() => document.documentElement.classList.contains('review-tablet'));
  const after = (await records(upgradePage, sid))[qid];assert.equal(after.notes, before.notes);assert.equal(after.version, before.version);assert.equal(after.needs_review, before.needs_review);
  await upgrade.setOffline(true);
  const cached = await upgradePage.evaluate(async encrypted => { const response = await fetch(encrypted);return { status: response.status, size: (await response.arrayBuffer()).byteLength }; }, encrypted);
  assert.equal(cached.status, 200);assert(cached.size > 28);await upgrade.setOffline(false);
  checked('旧Service Worker更新后原IndexedDB笔记版本、文字、标记均保持，旧密文缓存迁移后可断网读取');

  assert.equal(errors.length, 0, errors.join('\n'));assert.equal(external.length, 0, external.join('\n'));
  const unexpected = failedResponses.filter(value => !value.startsWith('401 ') && !value.startsWith('403 '));assert.equal(unexpected.length, 0, unexpected.join('\n'));
  const result = { passed: true, engine: 'Edge Chromium Android tablet touch emulation', realVivoPad5Verified: false, checks, measurements, screenshots, errors, externalRequests: external, failedResponses, fixture };
  await fs.writeFile(path.join(root, '.runtime', 'tablet-browser-results.json'), JSON.stringify(result, null, 2));console.log(JSON.stringify(result, null, 2));
} catch (error) { if (currentPage) await screenshot(currentPage, 'failure.png').catch(() => {});throw error; }
finally { await browser?.close();if (server) await new Promise(resolve => server.close(resolve)); }
