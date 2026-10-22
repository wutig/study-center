import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'file:///C:/Users/ROG/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';

// A new browser context supplies an isolated IndexedDB/Caches profile. The
// HTTP fixture exposes the site only below a project path, as GitHub Pages does.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const localApp = path.join(path.dirname(root), '复习中心');
const fixture = path.join(root, '.runtime', `web-browser-${Date.now()}`);
assert(path.resolve(fixture).startsWith(path.resolve(root, '.runtime') + path.sep));
const site = path.join(fixture, 'site'), basePath = '/study-center/';
const checks = [], pageErrors = [], externalRequests = [], badResponses = [];
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const python = 'C:/Users/ROG/AppData/Local/Programs/Python/Python313/python.exe';
let browser, server, base, origin, currentPage;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const checked = value => { checks.push(value);console.log('PASS: ' + value); };
async function until(check, message, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await check()) return;await delay(80); }
  throw Error(message);
}
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.pdf': 'application/pdf' };
async function serve(request, response) {
  try {
    const requestPath = new URL(request.url, 'http://localhost').pathname;
    if (requestPath === basePath.slice(0, -1)) { response.writeHead(302, { Location: basePath });return response.end(); }
    if (!requestPath.startsWith(basePath)) { response.writeHead(404);return response.end('Project path required'); }
    const relative = decodeURIComponent(requestPath.slice(basePath.length)) || 'index.html';
    const file = path.resolve(site, relative);
    if (!file.startsWith(path.resolve(site) + path.sep)) { response.writeHead(403);return response.end(); }
    const content = await fs.readFile(file);
    response.writeHead(200, { 'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });response.end(content);
  } catch { response.writeHead(404);response.end('Not found'); }
}
async function api(page, resource, options = {}) {
  return page.evaluate(async ({ resource, options }) => {
    const response = await fetch(resource, options);let data;try { data = await response.json(); } catch { data = null; }
    return { status: response.status, data };
  }, { resource, options });
}
async function state(page, sid) {
  const result = await api(page, '/api/state/' + sid);assert.equal(result.status, 200);return result.data.records;
}
async function openCourse(page, sid) {
  if (await page.evaluate(() => document.body.dataset.view === 'reader')) { await page.locator('#back-home').tap();await page.waitForFunction(() => document.body.dataset.view === 'home'); }
  await page.locator('#open-courses').tap();await page.locator('#course-dialog').waitFor({ state: 'visible' });
  await page.locator(`.course-card[data-course-id="${sid}"]`).tap();
  await page.waitForFunction(sid => document.body.dataset.view === 'reader' && app.active?.id === sid && document.querySelectorAll('.question-card').length > 0, sid);
}
async function unlock(page, key) {
  // Ensure bootstrap receives the fragment during a real document load, even
  // when the preceding locked page was already open at this same path.
  await page.goto('about:blank');
  await page.goto(base + '#key=' + encodeURIComponent(key));
  await page.waitForSelector('.course-card', { state: 'attached', timeout: 60000 });
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, { timeout: 30000 });
  assert(!page.url().includes('key='), 'content key must leave the visible address after unlock');
}
async function noOverflow(page, name) {
  const size = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  assert(size.document <= size.width + 1 && size.body <= size.width + 1, `${name}: ${JSON.stringify(size)}`);
}
async function runPython(code, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-c', code, ...args], { cwd: fixture, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';child.stdout.on('data', data => text += data);child.stderr.on('data', data => text += data);
    child.on('error', reject);child.once('exit', code => code === 0 ? resolve(text) : reject(Error(`Python migration check (${code}): ${text}`)));
  });
}
async function copyBookIndexes(target) {
  for (const entry of await fs.readdir(path.join(localApp, 'content'))) {
    const directory = path.join(target, 'content', entry);await fs.mkdir(directory, { recursive: true });
    await fs.copyFile(path.join(localApp, 'content', entry, 'book.json'), path.join(directory, 'book.json'));
  }
}
async function scanFiles(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await scanFiles(file));else files.push(file);
  }
  return files;
}

await fs.mkdir(fixture, { recursive: true });await fs.cp(path.join(root, 'site'), site, { recursive: true });
const key = (await fs.readFile(path.join(root, '.private', 'key.txt'), 'utf8')).trim();
assert(key && key.length >= 32, 'private content key is missing');
const manifest = JSON.parse(await fs.readFile(path.join(site, 'manifest.json'), 'utf8'));
assert.equal(manifest.books.length, 5);
const allFiles = await scanFiles(site);
for (const file of allFiles) {
  const relative = path.relative(site, file).replaceAll('\\', '/');
  assert(!relative.includes('.private') && !relative.includes('我的复习记录') && !relative.endsWith('key.txt'), `private artifact published: ${relative}`);
  const bytes = await fs.readFile(file);
  assert(!bytes.includes(Buffer.from(key)), `content key leaked into ${relative}`);
  if (/\.(?:html|js|json|md|txt)$/i.test(relative)) assert(!bytes.includes(Buffer.from('右乘矩阵方程：求')), `plaintext private question leaked into ${relative}`);
}
for (const [name, info] of Object.entries(manifest.files)) {
  assert(info.url.startsWith('secrets/'), `unencrypted source asset: ${name}`);
  const bytes = await fs.readFile(path.join(site, info.url));
  assert(bytes.length >= 28, `bad encrypted container: ${name}`);
  assert(!bytes.subarray(0, 5).equals(Buffer.from('%PDF-')), `plaintext PDF published: ${name}`);
  if (name.endsWith('/book.json')) assert(!bytes.includes(Buffer.from('"questions"')), `plaintext book published: ${name}`);
}
checked('发布目录仅含加密题库、原图和PDF容器，未发现内容密钥、个人记录或题目明文');
try {
  server = http.createServer((request, response) => { serve(request, response); });
  await new Promise((resolve, reject) => { server.once('error', reject);server.listen(0, '127.0.0.1', resolve); });
  origin = `http://localhost:${server.address().port}`;base = origin + basePath;
  browser = await chromium.launch({ executablePath: edge, headless: true });
  const context = await browser.newContext({ viewport: { width: 393, height: 852 }, screen: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, reducedMotion: 'reduce', acceptDownloads: true });
  const page = await context.newPage();currentPage = page;
  page.on('pageerror', error => pageErrors.push(error.message));
  context.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin) externalRequests.push(request.url()); });
  page.on('response', response => { if (response.status() >= 400) badResponses.push(`${response.status()} ${new URL(response.url()).pathname}`); });
  page.on('dialog', dialog => dialog.accept());
  await page.goto(base);await page.locator('#site-unlock-dialog').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.course-card').count(), 0);
  const lockedContent = await page.evaluate(async url => (await fetch(url)).status, base + manifest.books[0].path);
  assert.equal(lockedContent, 401, 'unlocked virtual book must be unavailable without its content key');
  await page.locator('#site-key-input').fill('x'.repeat(43));await page.locator('#site-unlock-button').tap();
  await until(async () => { const text = (await page.locator('#site-unlock-error').textContent()).trim();return text && text !== '正在打开…'; }, 'wrong key should explain failure');
  assert.equal(await page.locator('.question-card').count(), 0);
  checked('真实 /study-center/ 子路径下无密钥保持锁定，错误密钥不能读题');
  await unlock(page, key);
  const books = await page.evaluate(async () => await window.ReviewSite.getBooks());
  assert.equal(books.length, 5);
  assert.equal(await page.locator('.course-card').count(), 5);
  checked('私有 #key 入口解锁五课程，地址栏去除密钥，Service Worker 受项目子路径控制');

  let total = 0;
  for (const metadata of books) {
    const book = await page.evaluate(async id => await ReviewSite.getBook(id), metadata.id);
    total += book.questions.length;
    await openCourse(page, metadata.id);
    assert.equal(await page.locator('.question-card').count(), book.questions.length);
    assert.equal(await page.locator('.math-error').count(), 0, `${metadata.id}: formula rendering`);
    await noOverflow(page, metadata.id);
    const sources = book.sources || [];
    const image = sources.flatMap(source => source.images || []).find(item => item.url);
    if (image) {
      const result = await page.evaluate(async url => {
        const response = await fetch(url);const bytes = await response.arrayBuffer();return { status: response.status, type: response.headers.get('Content-Type'), size: bytes.byteLength, url: new URL(url, location.href).pathname };
      }, image.url);
      assert.equal(result.status, 200, `${metadata.id} original image request`);assert(result.type.startsWith('image/'));assert(result.size > 100);
      assert(result.url.startsWith(basePath), `${metadata.id} image escaped project path: ${result.url}`);
    }
    if (book.pdf_url) {
      const result = await page.evaluate(async url => { const response = await fetch(url);return { status: response.status, text: new TextDecoder().decode((await response.arrayBuffer()).slice(0, 5)), path: new URL(url, location.href).pathname }; }, book.pdf_url);
      assert.equal(result.status, 200);assert.equal(result.text, '%PDF-');assert(result.path.startsWith(basePath));
    }
  }
  assert.equal(total, 203);
  checked('五科203题公式及窄屏显示正常，原图和PDF由项目子路径解密读取');

  const sid = 'linear-algebra-2026-autumn';await openCourse(page, sid);
  const first = page.locator('.question-card').first(), qid = await first.getAttribute('data-question-id');
  await first.locator('.notes-toggle').tap();
  const editor = first.locator('textarea');await editor.fill('手机公网版测试笔记：复查矩阵乘法顺序。');
  const png = await page.evaluate(() => { const canvas = document.createElement('canvas');canvas.width = 420;canvas.height = 140;const ctx = canvas.getContext('2d');ctx.fillStyle = '#efe4d2';ctx.fillRect(0, 0, 420, 140);ctx.fillStyle = '#80382c';ctx.font = '22px sans-serif';ctx.fillText('Offline screenshot note', 20, 60);return canvas.toDataURL('image/png').split(',')[1]; });
  const chooserPromise = page.waitForEvent('filechooser');await first.getByRole('button', { name: '添加图片', exact: true }).tap();
  const chooser = await chooserPromise;await chooser.setFiles({ name: 'web-note.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await first.locator('.mark-button').tap();
  await until(async () => { const r = (await state(page, sid))[qid];return r.needs_review && r.notes.includes('手机公网版测试笔记') && r.notes.includes('![截图]') && !r.notes.includes('截图处理中'); }, 'IndexedDB note/image did not save');
  await first.locator('.note-image-gallery').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(fixture, '手机公网版_截图笔记.png') });
  await page.reload();await page.waitForSelector('.question-card');await first.locator('.notes-toggle').tap();
  assert((await editor.inputValue()).includes('手机公网版测试笔记'));
  await page.waitForFunction(() => { const image = document.querySelector('.question-card .note-image-gallery img');return image?.complete && image.naturalWidth === 420; });
  assert.equal(await first.locator('.mark-button').getAttribute('aria-pressed'), 'true');
  checked('标记、文字及PNG截图写入新浏览器IndexedDB，刷新后保持且图片可读');

  const other = await context.newPage();other.on('pageerror', error => pageErrors.push(error.message));await other.goto(base);await other.waitForSelector('.course-card', { state: 'attached' });
  const oldRecord = (await state(page, sid))[qid];
  const updates = await Promise.all([page, other].map((tab, index) => api(tab, `/api/state/${sid}/${qid}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base_version: oldRecord.version, notes: oldRecord.notes + `\n并发保存窗口 ${index + 1}` }) })));
  assert.deepEqual(updates.map(result => result.status).sort(), [200, 409]);
  const conflict = updates.find(result => result.status === 409);assert(conflict.data.record.notes.includes('并发保存窗口'));
  await other.close();await page.reload();await page.waitForSelector('.question-card');
  checked('同一浏览器两个标签并发基于旧版本保存，一份成功一份409并返回新版，未静默覆盖');

  const secondQid = await page.locator('.question-card').nth(1).getAttribute('data-question-id');
  const desktopSeed = path.join(fixture, 'desktop-seed'), desktopZip = path.join(fixture, 'desktop-seed.zip');
  await copyBookIndexes(desktopSeed);await fs.writeFile(path.join(fixture, 'desktop-seed.png'), Buffer.from(png, 'base64'));
  await runPython('import sys\nfrom pathlib import Path\nsys.path.insert(0,sys.argv[1])\nfrom server import ReviewStore\ns=ReviewStore(Path(sys.argv[2])); sid,qid=sys.argv[4:6]\ni=s.upload_image(sid,qid,Path(sys.argv[6]).read_bytes())\ns.patch(sid,qid,{"base_version":"","reviewed":True,"notes":"电脑旧笔记：导出后在手机继续复习。\\n\\n"+i["markdown"]})\nPath(sys.argv[3]).write_bytes(s.backup())\n', [localApp, desktopSeed, desktopZip, sid, secondQid, path.join(fixture, 'desktop-seed.png')]);
  await page.locator('#restore-file').setInputFiles(desktopZip);
  await until(async () => {const record = (await state(page, sid))[secondQid];return record.reviewed && record.notes.includes('电脑旧笔记');}, 'desktop ZIP did not import into web IndexedDB');
  checked('原Python程序生成的ZIP可导入网页，另一题旧笔记、复习状态和截图附件保留');

  const downloadPromise = page.waitForEvent('download');await page.locator('#backup-link').tap();
  const download = await downloadPromise, backupFile = path.join(fixture, 'browser-notes.zip');await download.saveAs(backupFile);
  assert((await fs.stat(backupFile)).size > 500);
  const fresh = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce', acceptDownloads: true });
  const restoredPage = await fresh.newPage();restoredPage.on('pageerror', error => pageErrors.push(error.message));restoredPage.on('dialog', dialog => dialog.accept());await unlock(restoredPage, key);
  assert.equal((await state(restoredPage, sid))[qid].notes, '');
  await restoredPage.locator('#restore-file').setInputFiles(backupFile);
  await until(async () => (await state(restoredPage, sid))[qid].notes.includes('手机公网版测试笔记'), 'ZIP restore did not populate fresh IndexedDB');
  await openCourse(restoredPage, sid);const restoredCard = restoredPage.locator('.question-card').first();await restoredCard.locator('.notes-toggle').tap();
  await restoredPage.waitForFunction(() => { const image = document.querySelector('.question-card .note-image-gallery img');return image?.complete && image.naturalWidth > 0; });
  assert.equal(await restoredCard.locator('.mark-button').getAttribute('aria-pressed'), 'true');
  assert((await state(restoredPage, sid))[secondQid].notes.includes('电脑旧笔记'));
  checked('浏览器ZIP备份导入全新context后恢复文字、标记、图片，独立浏览器不自动共享记录');

  const migration = path.join(fixture, 'python-migration');await copyBookIndexes(migration);
  await runPython('import sys,json,re\nfrom pathlib import Path\nsys.path.insert(0,sys.argv[1])\nfrom server import ReviewStore\ns=ReviewStore(Path(sys.argv[2])); result=s.restore(Path(sys.argv[3]).read_bytes())\nrecords=s.state(sys.argv[4])["records"];r=records[sys.argv[5]]\nassert r["needs_review"] and "手机公网版测试笔记" in r["notes"]\nold=records[sys.argv[6]]\nassert old["reviewed"] and "电脑旧笔记" in old["notes"]\nrefs=re.findall(r"attachments/([^/]+)/([a-f0-9]{64}\\.png)",r["notes"]+old["notes"])\nassert len(refs)==2\nfor qid,name in refs: assert s.media_path(sys.argv[4],qid,name).read_bytes().startswith(b"\\x89PNG\\r\\n\\x1a\\n")\nprint(json.dumps({"restored_count":result["restored_count"],"images":len(refs)}))\n', [localApp, migration, backupFile, sid, qid, secondQid]);
  checked('电脑ZIP→网页→网页ZIP→Python restore往返兼容，两题Markdown、状态和PNG均完整');

  const dangerousZip = path.join(fixture, 'invalid-path.zip');
  await runPython('import sys,json,zipfile\nwith zipfile.ZipFile(sys.argv[1],"w") as z:\n z.writestr("__review_hub_backup__.json",json.dumps({"app":"review-hub","format":1}))\n z.writestr("../escape.md","must never be restored")\n', [dangerousZip]);
  const beforeBadRestore = (await state(page, sid))[qid].version;
  const malformed = await page.evaluate(async encoded => { const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));const response = await fetch('/api/restore', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: bytes });return response.status; }, (await fs.readFile(dangerousZip)).toString('base64'));
  assert.equal(malformed, 400);
  assert.equal((await state(page, sid))[qid].version, beforeBadRestore);
  checked('含 ../ 越界成员的ZIP整体拒绝为400，已有笔记版本保持不变');

  const appManifest = await page.evaluate(async () => { const url = document.querySelector('link[rel="manifest"]').href;const response = await fetch(url);return { url, data: await response.json() }; });
  assert.equal(appManifest.data.display, 'standalone');
  assert(new URL(appManifest.data.start_url, appManifest.url).pathname.startsWith(basePath));
  assert(new URL(appManifest.data.scope, appManifest.url).pathname.startsWith(basePath));
  assert(!JSON.stringify(appManifest).includes(key));
  checked('主屏幕manifest为standalone，start_url和scope均限定项目子路径且无密钥');

  await page.locator('#help-button').tap();
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }));
  await page.locator('#site-copy-private-link').tap();
  await page.locator('#site-private-link-fallback').waitFor({ state: 'visible' });
  const copyFallback = await page.locator('#site-private-link-fallback').inputValue();
  assert(copyFallback.includes('#key=') && copyFallback.includes(key), 'copy fallback must retain the usable private entry');
  checked('手机复制私有链接在Clipboard受限时提供完整可选择入口，方便迁移到主屏幕入口');
  await page.locator('#site-offline-download').tap();
  await until(async () => (await page.locator('#site-offline-status').textContent()).includes('全部资料已缓存'), 'complete offline cache did not finish', 180000);
  await page.locator('#help-dialog .dialog-close').tap();
  const cached = await page.evaluate(async () => { const names = await caches.keys();const requests = [];for (const name of names) for (const request of await (await caches.open(name)).keys()) requests.push(request.url);return requests; });
  for (const file of Object.values(manifest.files)) assert(cached.includes(base + file.url), `encrypted asset absent from completed cache: ${file.url}`);
  assert(!cached.some(url => new URL(url).pathname.startsWith(basePath + 'content/')), 'decrypted original assets must not enter the network cache');
  checked('点击全部离线下载并等待完成后，每一项加密资料均已实际缓存，网络缓存未存题库明文');

  // Claim offline behavior only after exercising it with network disabled.
  await context.setOffline(true);
  await page.reload();await page.waitForSelector('.question-card', { timeout: 30000 });
  await first.locator('.notes-toggle').tap();
  assert((await editor.inputValue()).includes('手机公网版测试笔记'));
  await page.waitForFunction(() => { const image = document.querySelector('.question-card .note-image-gallery img');return image?.complete && image.naturalWidth === 420; });
  assert.equal(await page.locator('.math-error').count(), 0);
  for (const metadata of books) {
    const book = await page.evaluate(async id => await ReviewSite.getBook(id), metadata.id);
    await openCourse(page, metadata.id);
    assert.equal(await page.locator('.question-card').count(), book.questions.length);
    const image = (book.sources || []).flatMap(source => source.images || []).find(item => item.url);
    if (image) assert.equal(await page.evaluate(async url => (await fetch(url)).status, image.url), 200);
    if (book.pdf_url) assert.equal(await page.evaluate(async url => (await fetch(url)).status, book.pdf_url), 200);
  }
  await context.setOffline(false);
  checked('实际断网刷新后五科题目、公式、各科抽查原图/PDF及本浏览器截图笔记仍可读取');

  assert.equal(pageErrors.length, 0, pageErrors.join('\n'));
  assert.equal(externalRequests.length, 0, externalRequests.join('\n'));
  // Wrong-key UI and initial locked virtual resources may report expected 401;
  // any project path misses or decrypted source failures are always errors.
  const unexpected = badResponses.filter(value => !value.startsWith('401 ') && !value.startsWith('403 '));
  assert.equal(unexpected.length, 0, unexpected.join('\n'));
  const result = { passed: true, engine: 'Edge / Chromium iPhone16 touch emulation', realIPhoneVerified: false, checks, pageErrors, externalRequests, badResponses, fixture };
  await fs.writeFile(path.join(root, '.runtime', 'web-browser-results.json'), JSON.stringify(result, null, 2));console.log(JSON.stringify(result, null, 2));
} catch (error) {
  if (currentPage) await currentPage.screenshot({ path: path.join(fixture, 'failure.png') }).catch(() => {});throw error;
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
}
