/* Local-only API adapter for the static Review Center. No study record is sent
 * to a server. IDB transactions own version checks; the service worker reads
 * image Blobs from the same documented database. ZIP support: vendored JSZip. */
(function () {
  'use strict';
  const DB_NAME = 'review-center-web-v1', DB_VERSION = 1;
  const RECORDS = '我的复习记录', CONFLICTS = '恢复冲突', MANIFEST = '__review_hub_backup__.json';
  const MAX_JSON = 2 * 1024 * 1024, MAX_IMAGE = 10 * 1024 * 1024, MAX_BACKUP = 512 * 1024 * 1024;
  const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/, HASH = /^[0-9a-f]{64}$/, IMAGE = /^[0-9a-f]{64}\.png$/;
  const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', {fatal: true});
  const nativeFetch = window.fetch.bind(window);
  let dbPromise;

  class StoreError extends Error {
    constructor(status, error, message, extra) { super(message); this.status = status; this.payload = {error, message, ...(extra || {})}; }
  }
  function fail(status, error, message, extra) { throw new StoreError(status, error, message, extra); }
  function validID(value) { if (typeof value !== 'string' || !ID.test(value)) fail(400, 'invalid_id', '无效的学科或题目 ID。'); return value; }
  function emptyRecord() { return {needs_review: false, reviewed: false, notes: '', version: '', updated_at: ''}; }
  async function sha(bytes) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join(''); }
  function json(status, value) { return new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'}}); }
  function storageError(error) {
    if (error instanceof StoreError) return error;
    if (error?.name === 'QuotaExceededError') return new StoreError(507, 'storage_full', '此设备的网页存储空间不足，请先导出备份，再腾出空间。笔记草稿仍保留在页面。');
    return new StoreError(503, 'storage_error', '此设备暂时无法保存网页记录，请保留笔记草稿并重试。');
  }
  function openDB() {
    if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('records')) db.createObjectStore('records', {keyPath: 'key'});
        if (!db.objectStoreNames.contains('media')) db.createObjectStore('media', {keyPath: 'key'});
        if (!db.objectStoreNames.contains('conflicts')) db.createObjectStore('conflicts', {keyPath: 'id'});
      };
      request.onerror = () => reject(storageError(request.error));
      request.onblocked = () => reject(new StoreError(503, 'storage_blocked', '请关闭其他旧版复习中心页面后重试。'));
      request.onsuccess = () => { request.result.onversionchange = () => {request.result.close(); dbPromise = null;}; resolve(request.result); };
    }).catch(error => {dbPromise = null; throw error;});
    return dbPromise;
  }
  async function read(store, key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly'); let result;
      const request = key === undefined ? tx.objectStore(store).getAll() : tx.objectStore(store).get(key);
      request.onsuccess = () => {result = request.result;};
      tx.oncomplete = () => resolve(result); tx.onabort = tx.onerror = () => reject(storageError(tx.error));
    });
  }
  async function allSnapshot() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['records', 'media', 'conflicts'], 'readonly'), snapshot = {};
      for (const name of ['records', 'media', 'conflicts']) {
        const request = tx.objectStore(name).getAll(); request.onsuccess = () => {snapshot[name] = request.result;};
      }
      tx.oncomplete = () => resolve(snapshot); tx.onabort = tx.onerror = () => reject(storageError(tx.error));
    });
  }
  async function book(id) {
    validID(id); let value;
    try {value = await window.ReviewSite.getBook(id);}
    catch (error) {
      if (/未找到|找不到/.test(error?.message || '')) fail(404, 'unknown_subject', '找不到此学科题库。');
      fail(503, 'content_unavailable', error?.message || '暂时无法读取课程资料，请联网后重试。');
    }
    if (!value || value.id !== id || !Array.isArray(value.questions)) fail(404, 'unknown_subject', '找不到此学科题库。');
    return value;
  }
  async function question(sid, qid) {
    validID(qid); const value = await book(sid), q = value.questions.find(item => item.id === qid);
    if (!q) fail(404, 'unknown_question', '找不到此题目，已有记录不会被删除。');
    return {book: value, question: q};
  }
  function scalar(value) {
    value = value.trim();
    if (value.startsWith('"')) {const result = JSON.parse(value); if (typeof result !== 'string') throw Error('文字属性无效'); return result;}
    if (value.startsWith("'")) {if (value.length < 2 || !value.endsWith("'")) throw Error('属性引号不完整'); return value.slice(1, -1).replace(/''/g, "'");}
    if (value === 'true' || value === 'false') return value === 'true';
    if (value === '1') return 1;
    if (!value || /^[\[{>|&*!%@`]/.test(value) || value.includes(' #')) throw Error('属性格式无效');
    return value;
  }
  function parseMarkdown(bytes, sid, qid) {
    try {
      const text = decoder.decode(bytes).replace(/\r\n/g, '\n');
      if (!text.startsWith('---\n')) throw Error('缺少 YAML 属性开头');
      let end = text.indexOf('\n---\n', 3), notes;
      if (end < 0) {if (!text.endsWith('\n---')) throw Error('缺少 YAML 属性结尾'); end = text.length - 4; notes = '';}
      else notes = text.slice(end + 5);
      const header = text.slice(4, end).split('\n'), values = {}, positions = {};
      const required = ['复习中心格式', '题目ID', '学科ID', '题目', '学科', '还不会', '更新时间'];
      for (let i = 0; i < header.length; i++) {
        const line = header[i]; if (!line || /^\s|^#/.test(line)) continue;
        const match = /^([^:]+):[ \t]*(.*)$/.exec(line); if (!match) throw Error('YAML 属性行格式不正确');
        if ([...required, '本轮已复习'].includes(match[1])) {
          if (Object.hasOwn(values, match[1])) throw Error('属性重复');
          values[match[1]] = scalar(match[2]); positions[match[1]] = i;
        }
      }
      if (required.some(key => !Object.hasOwn(values, key)) || values['复习中心格式'] !== 1 || values['题目ID'] !== qid || values['学科ID'] !== sid) throw Error('题目或学科属性不符');
      if (typeof values['还不会'] !== 'boolean' || (Object.hasOwn(values, '本轮已复习') && typeof values['本轮已复习'] !== 'boolean')) throw Error('标记必须为 true 或 false');
      if (['题目', '学科', '更新时间'].some(key => typeof values[key] !== 'string')) throw Error('文字属性不正确');
      return {header, positions, record: {needs_review: values['还不会'], reviewed: values['本轮已复习'] || false, notes, version: '', updated_at: values['更新时间']}};
    } catch (error) {fail(422, 'invalid_record', '记录格式无法确认，已保留原文。' + error.message);}
  }
  function defaultPath(sid, qid, title) {
    const cleaned = String(title).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^[ .]+|[ .]+$/g, '').slice(0, 60) || '题目';
    return `${RECORDS}/${sid}/${qid}--${cleaned}.md`;
  }
  async function state(sid) {
    const value = await book(sid), rows = new Map((await read('records')).filter(row => row.subject_id === sid).map(row => [row.question_id, row]));
    return {subject_id: sid, records: Object.fromEntries(value.questions.map(q => [q.id, rows.get(q.id)?.record || emptyRecord()])), record_errors: []};
  }
  async function library() {
    const books = await window.ReviewSite.getBooks(), rows = await read('records'), known = new Map();
    const subjects = books.map(value => {
      const ids = new Set(value.questions.map(q => q.id)); known.set(value.id, ids);
      const records = rows.filter(row => row.subject_id === value.id && ids.has(row.question_id)).map(row => row.record);
      return {id: value.id, title: value.title, subtitle: value.subtitle || '', question_count: value.questions.length,
        marked_count: records.filter(row => row.needs_review).length, reviewed_count: records.filter(row => row.reviewed).length,
        note_count: records.filter(row => row.notes.trim()).length,
        uncertain_count: value.questions.filter(q => ![undefined, null, '', 'high', 'confirmed', 'verified', '明确', '确定'].includes(q.confidence)).length};
    });
    return {subjects, diagnostics: [], orphaned_records: rows.filter(row => !known.get(row.subject_id)?.has(row.question_id)).map(row => ({subject_id: row.subject_id, question_id: row.question_id, path: row.path, reason: 'not_in_current_book'}))};
  }
  async function patchRecord(sid, qid, update) {
    if (!update || typeof update !== 'object' || Array.isArray(update) || Object.keys(update).some(key => !['base_version', 'needs_review', 'reviewed', 'notes'].includes(key))) fail(400, 'invalid_update', '仅支持 base_version、needs_review、reviewed、notes 字段。');
    if (typeof update.base_version !== 'string' || (update.base_version && !HASH.test(update.base_version))) fail(400, 'invalid_version', '请提交读取时的 base_version。');
    if (!['needs_review', 'reviewed', 'notes'].some(key => Object.hasOwn(update, key))) fail(400, 'invalid_update', '没有需要保存的字段。');
    for (const key of ['needs_review', 'reviewed']) if (Object.hasOwn(update, key) && typeof update[key] !== 'boolean') fail(400, 'invalid_update', `${key} 必须是布尔值。`);
    if (Object.hasOwn(update, 'notes') && (typeof update.notes !== 'string' || encoder.encode(update.notes).length > MAX_JSON / 2)) fail(400, 'invalid_update', '笔记必须是文字且不超过 1 MB。');
    const meta = await question(sid, qid), key = `${sid}/${qid}`, before = await read('records', key), current = before?.record || emptyRecord();
    if (current.version !== update.base_version) fail(409, 'conflict', '此题记录已在另一页面更新，请先核对新版。', {record: current});
    let header, positions;
    if (before) ({header, positions} = parseMarkdown(before.bytes || encoder.encode(before.markdown), sid, qid));
    else {
      header = ['复习中心格式: 1', `题目ID: ${JSON.stringify(qid)}`, `学科ID: ${JSON.stringify(sid)}`, `题目: ${JSON.stringify(meta.question.title)}`, `学科: ${JSON.stringify(meta.book.title)}`, '还不会: false', '更新时间: ""'];
      positions = {'还不会': 5, '更新时间': 6};
    }
    const candidate = {...current, ...Object.fromEntries(['needs_review', 'reviewed', 'notes'].filter(name => Object.hasOwn(update, name)).map(name => [name, update[name]])), updated_at: new Date().toISOString()};
    header[positions['还不会']] = '还不会: ' + candidate.needs_review;
    const reviewed = '本轮已复习: ' + candidate.reviewed;
    if (Object.hasOwn(positions, '本轮已复习')) header[positions['本轮已复习']] = reviewed; else header.push(reviewed);
    header[positions['更新时间']] = '更新时间: ' + JSON.stringify(candidate.updated_at);
    const markdown = '---\n' + header.join('\n') + '\n---\n' + candidate.notes, bytes = encoder.encode(markdown);
    candidate.version = await sha(bytes);
    const row = {key, subject_id: sid, question_id: qid, path: before?.path || defaultPath(sid, qid, meta.question.title), markdown, bytes, record: candidate};
    const db = await openDB();
    // No await inside this transaction: compare and put commit atomically even
    // when another tab prepares an update at the same time.
    return new Promise((resolve, reject) => {
      const tx = db.transaction('records', 'readwrite'), store = tx.objectStore('records'); let failure;
      const request = store.get(key);
      request.onsuccess = () => {
        const latest = request.result?.record || emptyRecord();
        if (latest.version !== update.base_version) {failure = new StoreError(409, 'conflict', '此题记录已在另一页面更新，请先核对新版。', {record: latest}); tx.abort();}
        else store.put(row);
      };
      tx.oncomplete = () => resolve({record: candidate}); tx.onabort = tx.onerror = () => reject(failure || storageError(tx.error));
    });
  }
  const crcTable = Uint32Array.from({length: 256}, (_, n) => {for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ n >>> 1 : n >>> 1; return n >>> 0;});
  function crc32(bytes) {let value = 0xffffffff; for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ value >>> 8; return (value ^ 0xffffffff) >>> 0;}
  function validatePNG(bytes) {
    if (!bytes.length || bytes.length > MAX_IMAGE) fail(413, 'image_too_large', '单张图片请控制在 10 MB 以内。');
    if ([137,80,78,71,13,10,26,10].some((value, i) => bytes[i] !== value)) fail(415, 'invalid_image', '需要有效的 PNG 图片。');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let pos = 8, width = 0, height = 0, pixels = false, ended = false;
    while (pos + 12 <= bytes.length) {
      const length = view.getUint32(pos), end = pos + 12 + length;
      if (end > bytes.length) fail(415, 'invalid_image', '图片数据不完整。');
      const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
      if (crc32(bytes.subarray(pos + 4, pos + 8 + length)) !== view.getUint32(pos + 8 + length)) fail(415, 'invalid_image', '图片校验失败，请重新选择。');
      if (pos === 8) {
        if (type !== 'IHDR' || length !== 13) fail(415, 'invalid_image', '图片头无效。');
        width = view.getUint32(pos + 8); height = view.getUint32(pos + 12);
        if (!width || !height || width > 16000 || height > 16000 || width * height > 40000000) fail(413, 'image_dimensions', '图片尺寸过大，请截取需要的部分。');
      }
      if (type === 'IDAT') pixels = true;
      if (type === 'IEND') {ended = length === 0 && end === bytes.length; break;}
      pos = end;
    }
    if (!ended || !pixels) fail(415, 'invalid_image', '图片数据不完整。');
    return {width, height};
  }
  async function upload(sid, qid, bytes) {
    await question(sid, qid); const dimensions = validatePNG(bytes), filename = await sha(bytes) + '.png', key = `${sid}/${qid}/${filename}`, db = await openDB();
    const blob = new Blob([bytes], {type: 'image/png'});
    await new Promise((resolve, reject) => {const tx = db.transaction('media', 'readwrite'); tx.objectStore('media').put({key, subject_id: sid, question_id: qid, filename, blob}); tx.oncomplete = resolve; tx.onabort = tx.onerror = () => reject(storageError(tx.error));});
    return {url: base() + `media/${sid}/${qid}/${filename}`, markdown: `![截图](attachments/${qid}/${filename})`, filename, bytes: bytes.length, ...dimensions};
  }
  function safeArchivePath(name) {
    if (!name || name.includes('\\') || name.includes('\0') || name.startsWith('/') || name.split('/').some(part => part === '..' || part === '.' || part.includes(':') || /[ .]$/.test(part) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(part))) fail(400, 'invalid_archive', '备份包含不安全路径，未导入任何记录。');
    return name.replace(/\/$/, '');
  }
  function zipDirectory(bytes) {
    // Validate original central-directory names before JSZip normalizes them.
    // Also cap expansion before any member is inflated (including ignored PDFs).
    if (bytes.length > MAX_BACKUP) fail(413, 'backup_too_large', '备份文件不能超过 512 MB。');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.length) {end = i; break;}
    if (end < 0 || view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) fail(400, 'invalid_archive', '无法读取此 ZIP 备份。');
    const count = view.getUint16(end + 10, true), size = view.getUint32(end + 12, true), start = view.getUint32(end + 16, true);
    if (count > 20000 || count !== view.getUint16(end + 8, true) || start + size !== end || start === 0xffffffff) fail(400, 'invalid_archive', 'ZIP 结构或文件数量不受支持。');
    const entries = [], seen = new Set(); let pos = start, expanded = 0;
    for (let index = 0; index < count; index++) {
      if (pos + 46 > end || view.getUint32(pos, true) !== 0x02014b50) fail(400, 'invalid_archive', 'ZIP 目录不完整。');
      const length = view.getUint16(pos + 28, true), extra = view.getUint16(pos + 30, true), comment = view.getUint16(pos + 32, true), next = pos + 46 + length + extra + comment;
      if (next > end) fail(400, 'invalid_archive', 'ZIP 目录不完整。');
      const name = decoder.decode(bytes.subarray(pos + 46, pos + 46 + length)), canonical = safeArchivePath(name), lower = canonical.toLowerCase();
      if (seen.has(lower)) fail(400, 'invalid_archive', '备份包含重复文件名，未导入任何记录。');
      seen.add(lower);
      const mode = view.getUint32(pos + 38, true) >>> 16 & 0xf000;
      if (mode && mode !== 0x8000 && mode !== 0x4000) fail(400, 'invalid_archive', '备份包含链接或特殊文件。');
      const uncompressed = view.getUint32(pos + 24, true), flags = view.getUint16(pos + 8, true);
      expanded += uncompressed;
      if (expanded > MAX_BACKUP || uncompressed === 0xffffffff) fail(413, 'backup_too_large', '备份展开后超过 512 MB。');
      if (flags & 1) fail(400, 'invalid_archive', '请使用复习中心导出的普通 ZIP 备份。');
      entries.push({name, canonical, size: uncompressed, crc: view.getUint32(pos + 16, true), directory: name.endsWith('/')}); pos = next;
    }
    if (pos !== end) fail(400, 'invalid_archive', 'ZIP 目录边界不正确。');
    return entries;
  }
  async function backup() {
    if (!window.JSZip) fail(503, 'zip_unavailable', '备份组件尚未加载，请刷新后重试。');
    const snapshot = await allSnapshot(), zip = new JSZip(); let size = 0;
    zip.file(MANIFEST, JSON.stringify({app: 'review-hub', format: 1, created_at: new Date().toISOString(), source: 'browser-local'}));
    for (const row of snapshot.records) {const bytes = row.bytes || encoder.encode(row.markdown); size += bytes.length; zip.file(row.path, bytes);}
    for (const row of snapshot.media) {size += row.blob.size; zip.file(`${RECORDS}/${row.subject_id}/attachments/${row.question_id}/${row.filename}`, new Uint8Array(await row.blob.arrayBuffer()));}
    for (const row of snapshot.conflicts) {size += row.bytes.length; zip.file(row.incoming_path, row.bytes);}
    if (size > MAX_BACKUP) fail(413, 'backup_too_large', '记录超过 512 MB，请先分批整理图片。');
    const bytes = await zip.generateAsync({type: 'uint8array', compression: 'DEFLATE', compressionOptions: {level: 6}, platform: 'UNIX'});
    return new Response(bytes, {headers: {'Content-Type': 'application/zip', 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="review-hub-backup.zip"'}});
  }
  async function restore(bytes) {
    if (!window.JSZip) fail(503, 'zip_unavailable', '备份组件尚未加载，请刷新后重试。');
    let entries, zip;
    try {entries = zipDirectory(bytes); zip = await JSZip.loadAsync(bytes, {createFolders: false});}
    catch (error) {if (error instanceof StoreError) throw error; fail(400, 'invalid_archive', '无法读取此 ZIP 备份，未导入任何记录。');}
    async function member(entry) {
      const file = zip.file(entry.name); if (!file) fail(400, 'invalid_archive', 'ZIP 文件名不一致。');
      // Stop inflating as soon as a member exceeds its declared bounded size;
      // a dishonest central directory must not turn a tiny ZIP into a memory bomb.
      return new Promise((resolve, reject) => {
        let value, position = 0, stream;
        const invalid = () => new StoreError(400, 'invalid_archive', 'ZIP 文件校验失败，未导入任何记录。');
        try {
          value = new Uint8Array(entry.size); stream = file.internalStream('uint8array');
          stream.on('data', chunk => {
            if (position + chunk.length > value.length) {stream.pause(); reject(invalid()); return;}
            value.set(chunk, position); position += chunk.length;
          });
          stream.on('error', () => reject(invalid()));
          stream.on('end', () => position === value.length && crc32(value) === entry.crc ? resolve(value) : reject(invalid()));
          stream.resume();
        } catch (_) {reject(invalid());}
      });
    }
    const manifestEntry = entries.find(entry => entry.name === MANIFEST);
    if (!manifestEntry || manifestEntry.size > 8192) fail(400, 'invalid_archive', '这不是可识别的复习中心备份。');
    let manifest;
    try {manifest = JSON.parse(decoder.decode(await member(manifestEntry)));} catch (error) {if (error instanceof StoreError) throw error;}
    if (manifest?.app !== 'review-hub' || manifest.format !== 1) fail(400, 'invalid_archive', '这不是可识别的复习中心备份。');
    const records = new Map(), media = new Map(), pendingConflicts = [], batch = new Date().toISOString().replace(/[-:.TZ]/g, '');
    function preserve(path, value) {
      const id = crypto.randomUUID(), original = path.startsWith(CONFLICTS + '/') && path.includes('/' + RECORDS + '/') ? path.slice(path.lastIndexOf('/' + RECORDS + '/') + 1) : path;
      const incoming_path = `${CONFLICTS}/${batch}-${id.replace(/-/g, '').slice(0, 16)}/${original}`;
      return {id, path, incoming_path, bytes: value, created_at: new Date().toISOString()};
    }
    // Validate and inflate all relevant members before opening a write transaction.
    for (const entry of entries) {
      if (entry.directory || entry.name === MANIFEST) continue;
      if (!entry.name.startsWith(RECORDS + '/') && !entry.name.startsWith(CONFLICTS + '/')) continue; // Never install program or content files.
      const value = await member(entry), path = entry.canonical;
      if (path.startsWith(CONFLICTS + '/')) {pendingConflicts.push(preserve(path, value)); continue;}
      const parts = path.split('/');
      if (parts.length === 3 && ID.test(parts[1]) && parts[2].endsWith('.md')) {
        const sid = parts[1], qid = parts[2].includes('--') ? parts[2].split('--', 1)[0] : parts[2].slice(0, -3);
        if (!ID.test(qid) || value.length > MAX_JSON) {pendingConflicts.push(preserve(path, value)); continue;}
        try {
          const parsed = parseMarkdown(value, sid, qid), key = `${sid}/${qid}`;
          parsed.record.version = await sha(value);
          const row = {key, subject_id: sid, question_id: qid, path, bytes: value, markdown: decoder.decode(value), record: parsed.record};
          if (records.has(key)) pendingConflicts.push(preserve(path, value)); else records.set(key, row);
        } catch (error) {if (!(error instanceof StoreError)) throw error; pendingConflicts.push(preserve(path, value));}
      } else if (parts.length === 5 && ID.test(parts[1]) && parts[2] === 'attachments' && ID.test(parts[3]) && IMAGE.test(parts[4])) {
        try {
          validatePNG(value);
          if (await sha(value) + '.png' !== parts[4]) throw Error('图片名称校验不符');
          const key = `${parts[1]}/${parts[3]}/${parts[4]}`;
          media.set(key, {key, subject_id: parts[1], question_id: parts[3], filename: parts[4], hash: parts[4].slice(0, -4), blob: new Blob([value], {type: 'image/png'}), bytes: value, path});
        } catch (error) {pendingConflicts.push(preserve(path, value));}
      } else pendingConflicts.push(preserve(path, value));
    }
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['records', 'media', 'conflicts'], 'readwrite'); let restored = 0;
      const conflicts = pendingConflicts.map(row => ({path: row.path, incoming_path: row.incoming_path}));
      const conflictStore = tx.objectStore('conflicts');
      for (const row of pendingConflicts) conflictStore.put(row);
      for (const [name, rows] of [['records', records], ['media', media]]) for (const row of rows.values()) {
        const store = tx.objectStore(name), request = store.get(row.key);
        request.onsuccess = () => {
          const existing = request.result;
          if (!existing) {store.put(row); restored++;}
          else if (name === 'records' && existing.record.version !== row.record.version) {
            const copy = preserve(row.path, row.bytes); conflictStore.put(copy); conflicts.push({path: copy.path, incoming_path: copy.incoming_path});
          }
          // PNGs are content-addressed and validated before the transaction.
        };
      }
      tx.oncomplete = () => resolve({restored_count: restored, conflicts}); tx.onabort = tx.onerror = () => reject(storageError(tx.error));
    });
  }
  function base() {let value = window.ReviewSite?.base || '/'; return value.endsWith('/') ? value : value + '/';}
  function routePath(url) {
    let path = url.pathname;
    if (base() !== '/' && path.startsWith(base())) path = '/' + path.slice(base().length);
    return path;
  }
  async function body(request, max, type) {
    if ((request.headers.get('Content-Type') || '').split(';', 1)[0].trim().toLowerCase() !== type) fail(415, 'invalid_content_type', `此接口需要 ${type}。`);
    if (Number(request.headers.get('Content-Length')) > max) fail(413, 'body_too_large', '提交内容超过大小限制。');
    const bytes = new Uint8Array(await request.arrayBuffer()); if (bytes.length > max) fail(413, 'body_too_large', '提交内容超过大小限制。'); return bytes;
  }
  async function dispatch(request, rawPath) {
    await window.ReviewSite.ready;
    let path; try {path = decodeURIComponent(rawPath);} catch (_) {fail(400, 'invalid_path', '请求路径编码不正确。');}
    if (path.includes('\\') || path.includes('\0') || path.split('/').includes('..')) fail(400, 'invalid_path', '无效的请求路径。');
    const parts = path.split('/').filter(Boolean), method = request.method;
    if (method === 'GET' || method === 'HEAD') {
      if (path === '/api/health') return json(200, {app: 'review-hub', version: 'browser-1', mode: 'browser', storage: 'device-only'});
      if (path === '/api/library') return json(200, await library());
      if (parts.length === 3 && parts[0] === 'api' && parts[1] === 'books') return json(200, await book(parts[2]));
      if (parts.length === 3 && parts[0] === 'api' && parts[1] === 'state') return json(200, await state(parts[2]));
      if (path === '/api/backup') return backup();
      if (parts.length === 4 && parts[0] === 'media') {
        validID(parts[1]); validID(parts[2]); if (!IMAGE.test(parts[3])) fail(400, 'invalid_image_name', '图片文件名无效。');
        const image = await read('media', parts.slice(1).join('/')); if (!image) fail(404, 'not_found', '找不到这张笔记图片。');
        return new Response(method === 'HEAD' ? null : image.blob, {headers: {'Content-Type': 'image/png', 'Cache-Control': 'no-store'}});
      }
      fail(404, 'not_found', '找不到此接口。');
    }
    if (method === 'PATCH' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'state') {
      let update; try {update = JSON.parse(decoder.decode(await body(request, MAX_JSON, 'application/json')));} catch (error) {if (error instanceof StoreError) throw error; fail(400, 'invalid_json', '无法读取提交的 JSON。');}
      return json(200, await patchRecord(parts[2], parts[3], update));
    }
    if (method === 'POST' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'media') return json(201, await upload(parts[2], parts[3], await body(request, MAX_IMAGE, 'image/png')));
    if (method === 'POST' && path === '/api/restore') return json(200, await restore(await body(request, MAX_BACKUP, 'application/zip')));
    fail(405, 'method_not_allowed', '此地址不支持该操作。');
  }
  window.fetch = function (input, init) {
    const url = new URL(input instanceof Request ? input.url : input, location.href), path = routePath(url);
    if (url.origin !== location.origin || (!path.startsWith('/api/') && !path.startsWith('/media/'))) return nativeFetch(input, init);
    return (async () => {
      try {const request = input instanceof Request ? new Request(input, init) : new Request(url, init); if (request.signal.aborted) throw new DOMException('Aborted', 'AbortError'); return await dispatch(request, path);}
      catch (error) {if (error?.name === 'AbortError') throw error; const failure = storageError(error); return json(failure.status, failure.payload);}
    })();
  };
  window.ReviewBrowserStore = Object.freeze({dbName: DB_NAME, dbVersion: DB_VERSION, openDB});
})();
