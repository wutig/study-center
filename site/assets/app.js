/* The server owns study records. localStorage holds only unsaved drafts,
 * reading positions and display preferences; no CDN or remote services. */
'use strict';

const $ = (id) => document.getElementById(id);
const FIELD_NAMES = ['needs_review', 'reviewed', 'notes'];
const EDITOR_ID = (() => {
  try {let id=sessionStorage.getItem('review-center:editor-id');if(!id){id=globalThis.crypto?.randomUUID?globalThis.crypto.randomUUID():`${Date.now()}-${Math.random().toString(36).slice(2)}`;sessionStorage.setItem('review-center:editor-id',id);}return id;}
  catch(_){return `${Date.now()}-${Math.random().toString(36).slice(2)}`;}
})();
const app = {
  library: [], contexts: new Map(), active: null, loadingToken: 0,
  filter: 'all', topic: '', search: '', pinned: new Set(),
  hideAnswers: false, conflictState: null, conflictSnapshot: null, sourceView: null,
  storageError: false, positionEnabled: false, scrollTimer: null,
  filterTimer: null, toastTimer: null, syncRunning: false, backupPending: false, returnPosition: null,
  view: 'home', routeId: null, viewAnimation: null, eventsAttached: false, libraryReady: false, navigationPosition: null,
};

function readingScrollBehavior() { return matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'; }

function readingTopEdge() {
  const bar=document.querySelector('.route-bar');
  return Math.min(innerHeight*.45,Math.max(0,bar?.getBoundingClientRect().bottom||76)+12);
}

function updateReturnButton() {
  const button=$('back-to-top');
  button.hidden=app.view!=='reader'||(window.scrollY<750&&!app.returnPosition);
  button.textContent=app.returnPosition?'↳':'↑';
  button.title=app.returnPosition?'回到刚才的位置':'返回顶部';
  button.setAttribute('aria-label',button.title);
}

function toggleReadingReturn() {
  if(app.returnPosition?.bookId===app.active?.id){
    const saved=app.returnPosition;const anchor=app.active.states.get(saved.questionId)?.dom.card;
    const top=anchor&&!anchor.hidden?anchor.getBoundingClientRect().top+window.scrollY-saved.offset:saved.top;
    app.returnPosition=null;updateReturnButton();
    window.scrollTo({top,behavior:readingScrollBehavior()});
  }else{
    saveReadingPosition();
    const anchor=visibleStates().find(st=>st.dom.card.getBoundingClientRect().bottom>90);
    app.returnPosition={bookId:app.active?.id,top:window.scrollY,questionId:anchor?.id,offset:anchor?.dom.card.getBoundingClientRect().top,reachedTop:false};updateReturnButton();
    window.scrollTo({top:0,behavior:readingScrollBehavior()});
  }
}

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function safeURL(value, imageOnly = false) {
  if (!value || typeof value !== 'string') return null;
  try {
    const url = new URL(value, location.href);
    if (!['http:', 'https:', ...(imageOnly ? [] : ['mailto:'])].includes(url.protocol)) return null;
    if (imageOnly && url.origin !== location.origin) return null;
    return url.href;
  } catch (_) { return null; }
}

function sanitizeMarkdownHTML(html) {
  const template = document.createElement('template');
  template.innerHTML = html;
  const allowed = new Set(['P','BR','HR','H1','H2','H3','H4','H5','H6','UL','OL','LI','BLOCKQUOTE','PRE','CODE','STRONG','EM','DEL','S','TABLE','THEAD','TBODY','TFOOT','TR','TH','TD','A','IMG']);
  for (const el of [...template.content.querySelectorAll('*')]) {
    if (!allowed.has(el.tagName)) { el.replaceWith(document.createTextNode(el.textContent)); continue; }
    for (const attr of [...el.attributes]) {
      if (!['href','title','alt','src','colspan','rowspan','start'].includes(attr.name)) el.removeAttribute(attr.name);
    }
    if (el.tagName === 'A') {
      const href = safeURL(el.getAttribute('href'));
      if (href) { el.setAttribute('href', href); el.setAttribute('target','_blank'); el.setAttribute('rel','noopener noreferrer'); }
      else el.removeAttribute('href');
    }
    if (el.tagName === 'IMG') {
      const src = safeURL(el.getAttribute('src'), true);
      if (!src) el.replaceWith(document.createTextNode(el.getAttribute('alt') || '[图片]'));
      else { el.setAttribute('src', src); el.setAttribute('loading','lazy'); }
    }
  }
  return template.innerHTML;
}

function renderMarkdown(value) {
  const source = String(value ?? '');
  const formulas = [];
  const markerPrefix = `REVIEWMATH${Math.random().toString(36).slice(2)}TOKEN`;
  const mathPattern = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<!\\)\$([^\n$]+?)(?<!\\)\$/g;
  const protectedText = source.split(/(```[\s\S]*?```|`[^`\n]+`)/g).map((chunk, i) => i % 2 ? chunk : chunk.replace(mathPattern, (full, displayDollar, displayBracket, inlineBracket, inlineDollar) => {
    const tex = displayDollar ?? displayBracket ?? inlineBracket ?? inlineDollar;
    const display = displayDollar !== undefined || displayBracket !== undefined;
    const marker = `${markerPrefix}${formulas.length}END`;
    let result;
    try {
      if (!window.katex) throw new Error('公式库尚未加载');
      result = window.katex.renderToString(tex, {displayMode:display,throwOnError:true,trust:false,strict:'ignore',maxExpand:1000});
    } catch (err) {
      result = `<span class="math-error" title="${escapeHTML(err.message)}">${escapeHTML(full)}</span>`;
    }
    formulas.push({marker, result});
    return display ? `\n\n${marker}\n\n` : marker;
  })).join('');
  // Raw HTML is displayed as text, including HTML in imported documents.
  const escaped = protectedText.replace(/</g,'&lt;').replace(/>/g,'&gt;');
  let html = window.marked ? window.marked.parse(escaped, {gfm:true,breaks:false}) : `<pre>${escapeHTML(protectedText)}</pre>`;
  html = sanitizeMarkdownHTML(html);
  for (const {marker, result} of formulas) html = html.split(marker).join(result);
  return html;
}

function markdownNode(text, className = '') {
  const node = document.createElement('div');
  node.className = `markdown ${className}`.trim();
  node.innerHTML = renderMarkdown(text);
  return node;
}

function noteImageMatches(notes) {
  return [...notes.matchAll(/!\[([^\]\n]*)\]\((attachments\/([A-Za-z0-9][A-Za-z0-9_-]*)\/([a-f0-9]{64}\.png))\)/g)];
}

const NOTE_IMAGE_SECTION = '\n\n<!-- review-hub-images -->\n';
function editableNoteText(notes) {
  const stripImages = part => {
    let text = part.replace(/<!--\s*review-hub-images\s*-->/g,'');
    for (const match of noteImageMatches(part)) text = text.replace(match[0],'');
    return text;
  };
  const parts = notes.split(NOTE_IMAGE_SECTION);
  let text = stripImages(parts.shift());
  // Obsidian may add prose after an image, and a conflict merge can contain
  // several image sections. Keep all such prose instead of treating it as metadata.
  for (const part of parts) {
    const remainder = stripImages(part);
    if (remainder.trim()) text += '\n\n' + remainder.replace(/^\n+/,'');
  }
  return text;
}
function composeNoteText(text, images) { return images.length ? text + NOTE_IMAGE_SECTION + images.join('\n\n') : text; }
function mergeEditableNote(st, text) { return composeNoteText(text,noteImageMatches(st.desired.notes).map(match=>match[0])); }

function renderNoteImages(st) {
  if (!st.dom || st.renderedImageNotes === st.desired.notes) return;
  st.renderedImageNotes = st.desired.notes;
  const gallery = st.dom.gallery;
  gallery.replaceChildren();
  noteImageMatches(st.desired.notes).forEach((match, index) => {
    const figure = document.createElement('figure');
    const url = `/study-center/media/${encodeURIComponent(st.bookId)}/${encodeURIComponent(match[3])}/${match[4]}`;
    const link = document.createElement('a');link.href = url;link.target = '_blank';link.rel = 'noopener';
    const img = document.createElement('img');img.src = url;img.alt = match[1] || `笔记截图 ${index + 1}`;img.loading = 'lazy';link.append(img);
    const caption = document.createElement('figcaption');caption.append(document.createTextNode(`截图 ${index + 1} · 点击查看原图`));
    const remove = makeButton('移除','text-button',() => {
      if (st.fileError || app.backupPending) return;
      const remaining = noteImageMatches(st.desired.notes).map(item=>item[0]);
      const position = remaining.indexOf(match[0]);
      if (position >= 0) { remaining.splice(position,1);setDirty(st,'notes',composeNoteText(editableNoteText(st.desired.notes),remaining)); }
    });caption.append(remove);figure.append(link,caption);gallery.append(figure);
  });
  gallery.hidden = !gallery.childElementCount;
}

async function clipboardPNG(file) {
  if (!file.type.startsWith('image/')) throw new Error('请选择图片文件。');
  // iOS can decode more photo formats through <img> than createImageBitmap,
  // and older Safari does not provide createImageBitmap at all.
  let bitmap;
  if (typeof window.createImageBitmap === 'function') {
    try { bitmap = await window.createImageBitmap(file); } catch (_) { /* Try Safari's image decoder below. */ }
  }
  if (!bitmap) {
    bitmap = await new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => { URL.revokeObjectURL(url);resolve(image); };
      image.onerror = () => { URL.revokeObjectURL(url);reject(new Error('无法读取这张照片，请选择截图、PNG 或 JPEG 图片。')); };
      image.src = url;
    });
  }
  try {
    const width = bitmap.naturalWidth || bitmap.width, height = bitmap.naturalHeight || bitmap.height;
    if (!width || !height || width * height > 64_000_000 || width > 20000 || height > 20000) throw new Error('图片过大，请先截取需要的部分。');
    // Keep screenshots crisp while staying below Safari's canvas memory limits.
    const scale = Math.min(1,4096 / Math.max(width,height),Math.sqrt(8_000_000 / (width * height)));
    const canvas = document.createElement('canvas');canvas.width = Math.max(1,Math.round(width * scale));canvas.height = Math.max(1,Math.round(height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('暂时无法处理图片，请关闭其他页面后重试。');
    context.drawImage(bitmap,0,0,canvas.width,canvas.height);
    const png = await new Promise(resolve => canvas.toBlob(resolve,'image/png'));
    if (!png) throw new Error('无法读取这张图片，请重新截图后粘贴。');
    if (png.size > 10 * 1024 * 1024) throw new Error('单张图片请控制在10MB以内，请缩小截图范围。');
    return png;
  } finally { if (typeof bitmap.close === 'function') bitmap.close(); }
}

function insertNoteImages(st, files) {
  if (st.fileError || app.backupPending || !files.length) return;
  const textarea = st.dom.textarea;
  const tokens = files.map(() => `〔截图处理中·${globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : Math.random().toString(36).slice(2)}〕`);
  const insertion = '\n' + tokens.join('\n\n') + '\n';
  textarea.setRangeText(insertion,textarea.selectionStart,textarea.selectionEnd,'end');
  st.pendingMedia = (st.pendingMedia || 0) + files.length;
  setDirty(st,'notes',mergeEditableNote(st,textarea.value));
  const previous = st.mediaPromise || Promise.resolve();
  st.mediaPromise = previous.then(async () => {
    for (let i=0;i<files.length;i++) {
      try {
        const png = await clipboardPNG(files[i]);
        const result = await requestJSON(`/study-center/api/media/${encodeURIComponent(st.bookId)}/${encodeURIComponent(st.id)}`,{method:'POST',headers:{'Content-Type':'image/png'},body:png});
        if (st.desired.notes.includes(tokens[i])) {
          const text = editableNoteText(st.desired.notes).replace(tokens[i],'');
          const images = noteImageMatches(st.desired.notes).map(match=>match[0]);images.push(result.markdown);
          setDirty(st,'notes',composeNoteText(text,images));
        }
      } catch (err) {
        if (st.desired.notes.includes(tokens[i])) setDirty(st,'notes',st.desired.notes.replace(tokens[i],''));
        showToast(`图片未插入：${err.message} 请保留原截图后重新粘贴。`,6500);
      } finally { st.pendingMedia--;updateQuestionControls(st); }
    }
  }).finally(() => { if (!st.pendingMedia) saveQuestion(st); });
}

function visibleStates() { return app.active ? [...app.active.states.values()].filter(st=>!st.dom.card.hidden) : []; }

function updateBulkButtons() {
  const states = visibleStates();
  const sourceStates = states.filter(st=>st.dom.source);
  $('toggle-all-sources').disabled = !sourceStates.length;
  $('toggle-all-sources').textContent = sourceStates.length && sourceStates.every(st=>st.dom.source.open) ? '折叠全部原图' : '展开全部原图';
  $('toggle-all-sources').title = `作用于当前筛选显示且有原图的 ${sourceStates.length} 道题`;
  $('toggle-all-answers').disabled = $('toggle-all-notes').disabled = !states.length;
  $('toggle-all-answers').textContent = states.length && states.every(st=>st.dom.answer.open) ? '折叠全部答案' : '展开全部答案';
  $('toggle-all-notes').textContent = states.length && states.every(st=>!st.dom.notesEditor.hidden) ? '折叠全部笔记' : '展开全部笔记';
  for (const id of ['toggle-all-answers','toggle-all-notes']) $(id).title = `作用于当前筛选显示的 ${states.length} 道题`;
}

function setNotesOpen(st, open, focus = false) {
  st.dom.notesEditor.hidden = !open;st.dom.notesToggle.setAttribute('aria-expanded',String(open));
  if (open && focus) st.dom.textarea.focus({preventScroll:true});
  if (!open) saveQuestion(st);
  updateQuestionControls(st);updateBulkButtons();
}

function localRead(key, fallback = null) {
  try { const value = localStorage.getItem(key); return value === null ? fallback : JSON.parse(value); }
  catch (_) { return fallback; }
}

function localWrite(key, value) {
  try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch (_) {
    if (!app.storageError) {
      app.storageError = true;
      showBanner('浏览器暂时无法保存离线草稿。请保持页面打开，确认每道题显示「已保存」，并及时备份记录。');
    }
    return false;
  }
}

function draftKey(st) { return `review-center:draft:${st.bookId}:${st.id}:${EDITOR_ID}`; }
function positionKey(id) { return `review-center:position:${id}`; }

function normalizeRecord(record = {}) {
  return {needs_review:record.needs_review === true,reviewed:record.reviewed === true,notes:typeof record.notes === 'string' ? record.notes : '',version:record.version == null ? '' : String(record.version),updated_at:record.updated_at || null};
}

function persistDraft(st) {
  if (!st.dirty.size && !st.conflict) { localWrite(draftKey(st), null); return; }
  const fields = {};
  for (const field of st.dirty) fields[field] = st.desired[field];
  if (st.conflict) for (const field of FIELD_NAMES) fields[field] = st.desired[field];
  localWrite(draftKey(st), {base_version:st.record.version,base:{...st.record},fields,mergeDraft:st.mergeDraft || null,saved_at:new Date().toISOString(),conflict:!!st.conflict});
}

async function requestJSON(url, options = {}) {
  const response = await fetch(url, {cache:'no-store',...options});
  let body;
  try { body = await response.json(); } catch (_) { body = {}; }
  if (!response.ok) {
    const error = new Error(body.message || body.error || `请求失败（${response.status}）`);
    error.status = response.status; error.body = body; throw error;
  }
  return body;
}

function showToast(message, duration = 4200) {
  clearTimeout(app.toastTimer); $('toast').textContent = message; $('toast').hidden = false;
  app.toastTimer = setTimeout(() => { $('toast').hidden = true; }, duration);
}

function showBanner(message, buttonText, action) {
  const banner = $('error-banner'); banner.replaceChildren();
  const text = document.createElement('span'); text.textContent = message; banner.append(text);
  if (buttonText && action) {
    const button = document.createElement('button'); button.className = 'text-button'; button.type='button';button.textContent=buttonText;button.addEventListener('click',action);banner.append(button);
  }
  banner.hidden = false;
}

function hideBanner() { if (!app.storageError) $('error-banner').hidden = true; }

function getContextStates() { return [...app.contexts.values()].flatMap((ctx) => [...ctx.states.values()]); }

function updateGlobalStatus() {
  const states = getContextStates();
  const conflicts = states.filter((st) => st.conflict).length;
  const errors = states.filter((st) => st.error || st.fileError).length;
  const pending = states.filter((st) => st.dirty.size || st.saving || st.pendingMedia).length;
  const node = $('global-save-status');
  const label = conflicts ? `${conflicts} 题待核对` : errors ? `${errors} 题待保存` : pending ? '正在保存…' : '记录已保存';
  node.className = `global-save-status${conflicts || errors ? ' has-error' : pending ? ' is-saving' : ''}`;
  node.replaceChildren(); const dot=document.createElement('span');dot.className='status-dot';node.append(dot,document.createTextNode(label));
}

function setDirty(st, field, value) {
  if (st.fileError) return;
  st.desired[field] = value;
  const pendingDifferentValue=st.inflight&&Object.prototype.hasOwnProperty.call(st.inflight,field)&&st.inflight[field]!==value;
  if (st.record[field] === value && !st.conflict && !pendingDifferentValue) st.dirty.delete(field); else st.dirty.add(field);
  st.error = null;
  persistDraft(st);
  updateQuestionControls(st);
  updateCounts();
  clearTimeout(st.timer);
  if (!st.conflict) st.timer = setTimeout(() => saveQuestion(st), 550);
}

function updateQuestionControls(st) {
  const dom = st.dom;
  if (!dom) return;
  dom.card.classList.toggle('marked', st.desired.needs_review);
  dom.card.classList.toggle('is-reviewed', st.desired.reviewed);
  dom.mark.disabled=!!st.fileError||app.backupPending;dom.textarea.disabled=!!st.fileError||app.backupPending;
  dom.reviewed.disabled=!!st.fileError||app.backupPending;
  dom.reviewed.setAttribute('aria-pressed',String(st.desired.reviewed));
  dom.reviewed.querySelector('.reviewed-label').textContent=st.desired.reviewed?'本轮已复习':'标记本轮已复习';
  dom.reviewed.title=st.desired.reviewed?'点击撤销本题的完成记录，地图会相应回退一片。':'本题已复习后点亮；保存成功即收复一片土地。';
  dom.addImage.disabled=!!st.fileError||app.backupPending;
  dom.mark.setAttribute('aria-pressed',String(st.desired.needs_review));
  dom.mark.querySelector('.mark-label').textContent = st.desired.needs_review ? '还不会 · 已标记' : '还不会';
  dom.mark.title = st.desired.needs_review ? '点击取消标记' : '点击标记，下次集中复习';
  const editable = editableNoteText(st.desired.notes);
  if (dom.textarea.value !== editable) dom.textarea.value = editable;
  dom.indicator.hidden = !st.desired.notes.trim();
  const imageCount = noteImageMatches(st.desired.notes).length;
  dom.noteCount.textContent = editable.trim() || imageCount ? `${editable.length} 字${imageCount ? ` · ${imageCount} 张截图` : ''} · 自动保存` : '支持 Markdown，停笔后自动保存';
  renderNoteImages(st);
  dom.pinnedNotice.hidden = !(app.active?.id === st.bookId && app.pinned.has(st.id));
  for (const statusNode of [dom.status,dom.compactStatus]) {
    statusNode.replaceChildren();
    statusNode.className = 'save-status';
    let text = '已保存';
    if (st.fileError) { text = `记录文件有误，暂不能保存：${st.fileError.path ? `${st.fileError.path} · ` : ''}${st.fileError.message || '请检查 Markdown 文件格式'}`;statusNode.classList.add('error'); }
    else if (st.conflict) { text = '检测到其他修改，草稿已保留'; statusNode.classList.add('conflict'); }
    else if (st.error) { text = '保存失败，草稿已保留'; statusNode.classList.add('error'); }
    else if (st.pendingMedia) { text = `正在插入 ${st.pendingMedia} 张图片…`; statusNode.classList.add('saving'); }
    else if (st.saving) { text = '正在保存…'; statusNode.classList.add('saving'); }
    else if (st.dirty.size) { text = '待保存 · 草稿已保留'; statusNode.classList.add('saving'); }
    else if (!st.record.version) text = '尚未记录';
    const label = document.createElement('span'); label.textContent=text;statusNode.append(label);
    if (st.fileError || st.conflict || st.error) {
      const button = document.createElement('button');button.type='button';button.className='text-button';button.textContent=st.fileError?'重新检查':st.conflict?'核对两份记录':'重试保存';
      button.addEventListener('click',() => st.fileError?refreshActiveState():st.conflict?openConflict(st):saveQuestion(st));statusNode.append(button);
    }
  }
  dom.compactStatus.hidden = dom.notesEditor.hidden === false || (!st.fileError && !st.error && !st.conflict && !st.dirty.size && !st.saving);
  updateGlobalStatus();
}

function saveQuestion(st) {
  clearTimeout(st.timer);
  if(st.saving)return st.savePromise || Promise.resolve();
  if (st.conflict || st.fileError || st.pendingMedia || !st.dirty.size) return Promise.resolve();
  st.saving = true;st.error=null;updateQuestionControls(st);
  st.savePromise=executeQuestionSave(st);
  return st.savePromise;
}

async function executeQuestionSave(st) {
  let completedNow=false;
  try {
    // One in-flight request per question. Edits made while awaiting remain dirty.
    while (st.dirty.size && !st.conflict && !st.pendingMedia) {
      const sent = {};for (const field of st.dirty) sent[field] = st.desired[field];
      st.inflight=sent;
      const payload = {base_version:st.record.version,...sent};
      let result;
      try {
        result = await requestJSON(`/study-center/api/state/${encodeURIComponent(st.bookId)}/${encodeURIComponent(st.id)}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      } catch (err) {
        if (err.status === 409 && err.body.record) {
          st.conflict = normalizeRecord(err.body.record);persistDraft(st);break;
        }
        throw err;
      }
      if(!st.record.reviewed&&result.record.reviewed===true)completedNow=true;
      st.record = normalizeRecord(result.record);
      st.inflight=null;
      for (const field of FIELD_NAMES) {
        if (Object.prototype.hasOwnProperty.call(sent,field)) {
          if(st.desired[field]===st.record[field])st.dirty.delete(field);else st.dirty.add(field);
        }
        if (!st.dirty.has(field)) st.desired[field] = st.record[field];
      }
      persistDraft(st);updateQuestionControls(st);
    }
  } catch (err) { st.error=err.message;persistDraft(st); }
  finally {
    st.saving=false;st.savePromise=null;st.inflight=null;updateQuestionControls(st);updateCounts();
    if(completedNow&&!st.error&&!st.conflict&&st.record.reviewed&&st.desired.reviewed){
      document.dispatchEvent(new CustomEvent('review:question-completed',{detail:{bookId:st.bookId,id:st.id,title:st.question.title}}));
    }
  }
}

function initializeState(ctx, question, incoming) {
  const record = normalizeRecord(incoming);
  const st = {bookId:ctx.id,id:String(question.id),question,record,desired:{needs_review:record.needs_review,reviewed:record.reviewed,notes:record.notes},dirty:new Set(),saving:false,inflight:null,error:null,fileError:ctx.recordErrors?.get(String(question.id)) || null,conflict:null,mergeDraft:null,timer:null,dom:null,pendingMedia:0,mediaPromise:null};
  const draft = localRead(draftKey(st));
  if (draft?.fields && typeof draft.fields === 'object') {
    if(draft.mergeDraft&&typeof draft.mergeDraft.notes==='string')st.mergeDraft={notes:draft.mergeDraft.notes,needs_review:draft.mergeDraft.needs_review===true,reviewed:typeof draft.mergeDraft.reviewed==='boolean'?draft.mergeDraft.reviewed:record.reviewed};
    for (const field of FIELD_NAMES) {
      if (!Object.prototype.hasOwnProperty.call(draft.fields,field)) continue;
      if (field === 'notes' && typeof draft.fields[field] !== 'string') continue;
      if (field !== 'notes' && typeof draft.fields[field] !== 'boolean') continue;
      st.desired[field] = draft.fields[field];
      if (st.desired[field] !== record[field]) st.dirty.add(field);
    }
    if (st.dirty.size && String(draft.base_version ?? '') !== record.version) {
      st.conflict = record;
      st.record = normalizeRecord(draft.base || {version:draft.base_version});
    }
    persistDraft(st);
  }
  return st;
}

function makeButton(text, className, onClick) {
  const button = document.createElement('button');button.type='button';button.className=className;button.textContent=text;if(onClick)button.addEventListener('click',onClick);return button;
}

function questionLabel(question) {
  if (question.number !== undefined && question.number !== null && question.number !== '') return `第 ${question.number} 题`;
  return question.title || question.id;
}

function getTopic(question) { return String(question.topic || '未分类'); }
function isUncertain(question) { return question.confidence === '存疑' || question.confidence === '残缺'; }

function layoutSourceFrame(frame, available, zoom = 1) {
  if (available <= 0) return;
  const w=Number(frame.dataset.width)||1800,h=Number(frame.dataset.height)||1800,rotation=Number(frame.dataset.rotation)||0;
  const rotated=Math.abs(rotation)%180===90,boundW=rotated?h:w,boundH=rotated?w:h;
  const scale=Math.min(available/boundW,1)*zoom;
  frame.style.width=`${boundW*scale}px`;frame.style.height=`${boundH*scale}px`;
  const image=frame.querySelector('img');
  image.style.width=`${w*scale}px`;image.style.height=`${h*scale}px`;image.style.transform=`translate(-50%,-50%) rotate(${rotation}deg)`;
}

function layoutInlineSources(details) {
  if (!details?.open) return;
  for (const frame of details.querySelectorAll('.inline-source-frame')) {
    const figure=frame.closest('.source-inline-item'),style=getComputedStyle(figure);
    const available=figure.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight);
    layoutSourceFrame(frame,available);
  }
}

function createInlineSources(ctx, pages) {
  const seen=new Set(),images=[];
  for (const page of pages) {
    const source=ctx.sourceMap.get(String(page));
    for (const [index,meta] of (source?.images || []).entries()) {
      const src=safeURL(meta.url,true);if(!src||seen.has(src))continue;
      seen.add(src);images.push({page,meta,src,index});
    }
  }
  if (!images.length) return null;
  const details=document.createElement('details');details.className='source-details';
  const summary=document.createElement('summary');summary.className='source-toggle';summary.textContent='展开原题图片';
  const list=document.createElement('div');list.className='inline-source-list';details.append(summary,list);
  let populated=false;
  details.addEventListener('toggle',()=>{
    summary.textContent=details.open?'收起原题图片':'展开原题图片';
    if (details.open && !populated) {
      populated=true;
      const fragment=document.createDocumentFragment();
      for (const {page,meta,src,index} of images) {
        const figure=document.createElement('figure');figure.className='source-inline-item';
        const frame=document.createElement('div');frame.className='source-frame inline-source-frame';
        frame.dataset.width=Number(meta.width)||1800;frame.dataset.height=Number(meta.height)||1800;frame.dataset.rotation=Number(meta.rotation)||0;
        const image=document.createElement('img');image.className='inline-source-image';image.loading='lazy';image.decoding='async';image.draggable=false;image.alt=`第 ${page} 页原图 ${index+1}`;
        const error=document.createElement('div');error.className='source-inline-error';error.hidden=true;
        const message=document.createElement('span');message.textContent='图片暂时未能加载。';
        const retry=makeButton('重试','text-button',()=>{error.hidden=true;image.src=src;});error.append(message,retry);
        image.addEventListener('load',()=>{error.hidden=true;if(!meta.width)frame.dataset.width=image.naturalWidth;if(!meta.height)frame.dataset.height=image.naturalHeight;layoutInlineSources(details);});
        image.addEventListener('error',()=>{error.hidden=false;});
        image.src=src;frame.append(image);
        const caption=document.createElement('figcaption');const label=document.createElement('span');label.textContent=`第 ${page} 页 · 原图 ${index+1}`;
        const zoom=makeButton('放大查看','button button-quiet',()=>openSources(ctx,[page]));zoom.setAttribute('aria-label',`放大查看第 ${page} 页原图 ${index+1}`);caption.append(label,zoom);
        figure.append(frame,error,caption);fragment.append(figure);
      }
      list.append(fragment);
      if (typeof ResizeObserver === 'function') new ResizeObserver(()=>layoutInlineSources(details)).observe(list);
    }
    if(details.open)requestAnimationFrame(()=>layoutInlineSources(details));
    updateBulkButtons();
  });
  return details;
}

function createQuestionCard(ctx, st) {
  const q=st.question;
  const card = document.createElement('article');card.className='question-card';card.id=`q-${String(q.id).replace(/[^\w\u4e00-\u9fff-]/g,'_')}`;card.dataset.questionId=String(q.id);
  const header = document.createElement('div');header.className='question-header';
  const headline=document.createElement('div');headline.className='question-headline';
  const labels=document.createElement('div');labels.className='question-labels';
  const number=document.createElement('span');number.className='question-number';number.textContent=questionLabel(q);labels.append(number);
  const topic=document.createElement('span');topic.className='topic-chip';topic.textContent=getTopic(q);labels.append(topic);
  if(isUncertain(q)){const confidence=document.createElement('span');confidence.className='confidence-chip';confidence.textContent=`原题${q.confidence}`;labels.append(confidence);}
  const title=document.createElement('h2');title.className='question-title';title.textContent=q.title || questionLabel(q);headline.append(labels,title);
  const mark=document.createElement('button');mark.type='button';mark.className='mark-button';mark.innerHTML='<span class="mark-icon" aria-hidden="true">⚑</span><span class="mark-label">还不会</span>';
  mark.addEventListener('click',()=>{
    if (app.filter === 'marked' && st.desired.needs_review) app.pinned.add(st.id);
    setDirty(st,'needs_review',!st.desired.needs_review);
    if (app.active?.id===st.bookId) applyFilters(false);
  });
  const reviewed=makeButton('','reviewed-button',()=>{
    setDirty(st,'reviewed',!st.desired.reviewed);
    if(!st.conflict)saveQuestion(st);
  });
  reviewed.innerHTML='<span class="reviewed-icon" aria-hidden="true">✓</span><span class="reviewed-label">标记本轮已复习</span>';
  const questionActions=document.createElement('div');questionActions.className='question-actions';questionActions.append(mark,reviewed);
  header.append(headline,questionActions);card.append(header);
  const body=document.createElement('div');body.className='question-body';
  const questionSection=document.createElement('div');questionSection.className='question-section-label';questionSection.textContent='原题';body.append(questionSection,markdownNode(q.question || '此条目未提供可识别的文字，请核对原图。'));
  const pages=Array.isArray(q.source_pages)?[...new Map(q.source_pages.map(page=>[String(page),page])).values()]:[];
  if(pages.length){
    const links=document.createElement('div');links.className='source-links';const label=document.createElement('span');label.textContent='对照原图';links.append(label);
    for(const page of pages){const source=ctx.sourceMap.get(String(page));const label=source?`第 ${page} 页 ↗`:`第 ${page} 页（未取得）`;const button=makeButton(label,'source-link',()=>openSources(ctx,[page]));button.disabled=!source;links.append(button);}body.append(links);
  }
  const source=createInlineSources(ctx,pages);if(source)body.append(source);
  const sourceNotes=Array.isArray(q.notes)?q.notes:q.notes?[q.notes]:[];
  if(sourceNotes.length){const notes=document.createElement('aside');notes.className='source-explanation';notes.append(markdownNode(sourceNotes.map((s)=>`- ${String(s)}`).join('\n')));body.append(notes);}
  const answer=document.createElement('details');answer.className='answer-details';answer.open=!app.hideAnswers;
  answer.addEventListener('toggle',updateBulkButtons);
  const summary=document.createElement('summary');summary.innerHTML='查看详细解答 <small>可收起，自测后再核对</small>';answer.append(summary);
  const answerContent=document.createElement('div');answerContent.className='answer-content';answerContent.append(markdownNode(q.answer || '这道题暂未附详细解答。'));
  if(Array.isArray(q.followups)&&q.followups.length){
    const followups=document.createElement('section');followups.className='followups';const followTitle=document.createElement('div');followTitle.className='followups-title';followTitle.textContent=`追问与复习提示 · ${q.followups.length}`;followups.append(followTitle);
    q.followups.forEach((f,i)=>{const item=document.createElement('div');item.className='followup';const label=document.createElement('div');label.className='followup-label';label.textContent=`追问 ${i+1}${f.kind?` · ${f.kind}`:''}`;item.append(label,markdownNode(f.question || '（原记录未保留追问文字）'));if(f.answer){const reply=document.createElement('div');reply.className='followup-answer';const replyLabel=document.createElement('div');replyLabel.className='followup-label';replyLabel.textContent='解答';reply.append(replyLabel,markdownNode(f.answer));item.append(reply);}followups.append(item);});answerContent.append(followups);
  }
  answer.append(answerContent);body.append(answer);card.append(body);
  const cardStatus=document.createElement('div');cardStatus.className='card-status';const pinnedNotice=document.createElement('span');pinnedNotice.className='pinned-notice';pinnedNotice.textContent='已取消标记，刷新筛选后移除';pinnedNotice.hidden=true;const compactStatus=document.createElement('span');compactStatus.className='save-status';cardStatus.append(pinnedNotice,compactStatus);card.append(cardStatus);
  const notes=document.createElement('section');notes.className='question-notes';
  const notesToggle=document.createElement('button');notesToggle.className='notes-toggle';notesToggle.type='button';notesToggle.setAttribute('aria-expanded','false');notesToggle.innerHTML='<span class="notes-toggle-label"><span class="note-glyph" aria-hidden="true">✎</span> 我的笔记 <span class="notes-indicator" aria-label="已有笔记" hidden></span></span><span class="notes-toggle-arrow" aria-hidden="true">›</span>';
  const notesEditor=document.createElement('div');notesEditor.className='notes-editor';notesEditor.hidden=true;notesEditor.id=`notes-${card.id}`;notesToggle.setAttribute('aria-controls',notesEditor.id);
  const textarea=document.createElement('textarea');textarea.className='notes-textarea';textarea.rows=4;textarea.placeholder='写下自己的理解，也可以在这里 Ctrl+V 粘贴截图…';textarea.setAttribute('aria-label',`${questionLabel(q)} 我的笔记`);textarea.spellcheck=false;
  textarea.addEventListener('input',()=>setDirty(st,'notes',mergeEditableNote(st,textarea.value)));textarea.addEventListener('blur',()=>saveQuestion(st));
  notesEditor.addEventListener('paste',event=>{let files=[...(event.clipboardData?.items || [])].filter(item=>item.kind==='file'&&item.type.startsWith('image/')).map(item=>item.getAsFile()).filter(Boolean);if(!files.length)files=[...(event.clipboardData?.files || [])].filter(file=>file.type.startsWith('image/'));if(files.length){event.preventDefault();insertNoteImages(st,files);}});
  const imageTools=document.createElement('div');imageTools.className='note-image-tools';
  const addImage=makeButton('添加图片','button button-outline',()=>imageFile.click());
  const imageFile=document.createElement('input');imageFile.type='file';imageFile.accept='image/*';imageFile.multiple=true;imageFile.hidden=true;imageFile.addEventListener('change',()=>{insertNoteImages(st,[...imageFile.files]);imageFile.value='';});
  const imageHint=document.createElement('span');imageHint.textContent=matchMedia('(pointer:coarse)').matches?'从照片中添加截图，也可在输入框长按粘贴':'在输入框内 Ctrl+V 粘贴截图，图片会随笔记一起保存';imageTools.append(addImage,imageFile,imageHint);
  const gallery=document.createElement('div');gallery.className='note-image-gallery';gallery.hidden=true;
  const notesBottom=document.createElement('div');notesBottom.className='notes-bottom';const noteCount=document.createElement('span');const status=document.createElement('span');status.className='save-status';notesBottom.append(noteCount,status);notesEditor.append(textarea,imageTools,gallery,notesBottom);notes.append(notesToggle,notesEditor);card.append(notes);
  notesToggle.addEventListener('click',()=>setNotesOpen(st,notesEditor.hidden,!matchMedia('(pointer:coarse)').matches));
  st.dom={card,mark,reviewed,source,answer,textarea,notesToggle,notesEditor,indicator:notesToggle.querySelector('.notes-indicator'),noteCount,status,compactStatus,pinnedNotice,addImage,gallery};
  st.searchText=[q.title,q.question,q.answer,getTopic(q),...(q.followups||[]).map((f)=>`${f.question} ${f.answer}`)].join('\n').toLowerCase();
  updateQuestionControls(st);return card;
}

function subjectCounts(ctx) {
  let marked=0,notes=0,uncertain=0,reviewed=0,savedReviewed=0,pendingReviewed=0;
  for(const st of ctx.states.values()){
    if(st.desired.needs_review)marked++;if(st.desired.notes.trim())notes++;if(isUncertain(st.question))uncertain++;
    if(!st.fileError){
      const saved=st.conflict||st.record;
      if(st.desired.reviewed)reviewed++;if(saved.reviewed)savedReviewed++;if(st.desired.reviewed!==saved.reviewed)pendingReviewed++;
    }
  }
  return{total:ctx.states.size,marked,notes,uncertain,reviewed,savedReviewed,pendingReviewed};
}

function effectiveSubject(subject) {
  const ctx=app.contexts.get(subject.id);
  if(!ctx)return subject;
  const count=subjectCounts(ctx);
  return {...subject,question_count:count.total,marked_count:count.marked,note_count:count.notes,reviewed_count:count.reviewed,saved_reviewed_count:count.savedReviewed,pending_reviewed_count:count.pendingReviewed};
}

function courseMeta(subject) {
  const fragment=document.createDocumentFragment();
  for(const [text,className] of [[`${subject.question_count||0} 个条目`, ''],[`${subject.saved_reviewed_count??subject.reviewed_count??0} 题已复习`, 'course-reviewed'],[`${subject.marked_count||0} 道待复习`, 'course-marked'],[`${subject.note_count||0} 题有笔记`, '']]){
    const span=document.createElement('span');span.className=className;span.textContent=text;fragment.append(span);
  }
  return fragment;
}

function updateHomeSummary() {
  const subjects=app.library.map(effectiveSubject);
  const total=subjects.reduce((sum,s)=>sum+(Number(s.question_count)||0),0);
  const last=subjects.find(s=>s.id===localRead('review-center:last-subject'));
  $('home-resume').hidden=!last;
  if(last){
    const position=localRead(positionKey(last.id));
    const question=position&&app.contexts.get(last.id)?.states.get(String(position.id))?.question;
    $('home-resume-title').textContent=last.title;
    $('home-resume-detail').textContent=question?`上次读到 ${questionLabel(question)} · ${question.title}`:position?.title?`上次读到第 ${position.number||''} 题 · ${position.title}`:position?'从上次的阅读位置接着看。':'回到这门课程，继续复习。';
    $('home-continue').dataset.courseId=last.id;
  }
  for(const subject of subjects){
    const card=[...$('subject-list').children].find(el=>el.dataset.courseId===subject.id);
    if(card){
      card.querySelector('.course-card-meta').replaceChildren(courseMeta(subject));
      card.querySelector('.course-card-action').textContent=localRead(positionKey(subject.id))?'继续复习 →':'进入复习 →';
    }
  }
  const snapshot={total,reviewed:0,savedReviewed:0,pendingReviewed:0,subjects:subjects.map(s=>({id:s.id,title:s.title,total:Number(s.question_count)||0,reviewed:Number(s.reviewed_count)||0,savedReviewed:Number(s.saved_reviewed_count??s.reviewed_count)||0}))};
  for(const subject of subjects){snapshot.reviewed+=Number(subject.reviewed_count)||0;snapshot.savedReviewed+=Number(subject.saved_reviewed_count??subject.reviewed_count)||0;snapshot.pendingReviewed+=Number(subject.pending_reviewed_count)||0;}
  const signature=JSON.stringify(snapshot);
  if(signature!==app.progressSignature){app.progressSignature=signature;window.reviewProgressSnapshot=snapshot;document.dispatchEvent(new CustomEvent('review:progress',{detail:snapshot}));}
}

function updateCounts() {
  const ctx=app.active;if(!ctx)return;const count=subjectCounts(ctx);
  $('question-count').innerHTML=`<strong>${count.total}</strong> 道题`;
  $('marked-count').innerHTML=`<strong>${count.marked}</strong> 道还不会`;$('marked-count').classList.add('is-marked');
  $('note-count').innerHTML=`<strong>${count.notes}</strong> 题有笔记`;$('note-count').classList.add('is-notes');
  $('reviewed-count').innerHTML=`<strong>${count.savedReviewed}</strong> 题已复习`;
  $('uncertain-count').hidden=!count.uncertain;$('uncertain-count').innerHTML=`<strong>${count.uncertain}</strong> 条原题待核对`;
  $('filter-marked-count').textContent=count.marked;
  const libraryItem=app.library.find((item)=>item.id===ctx.id);if(libraryItem){libraryItem.marked_count=count.marked;libraryItem.note_count=count.notes;libraryItem.question_count=count.total;libraryItem.reviewed_count=count.savedReviewed;}
  updateHomeSummary();
}

function renderLibrary() {
  $('subject-list').replaceChildren();
  app.library.forEach((raw,index)=>{
    const subject=effectiveSubject(raw);
    const button=makeButton('','subject-button course-card',()=>loadSubject(subject.id));button.dataset.courseId=subject.id;
    const icon=document.createElement('span');icon.className='course-icon';icon.dataset.courseIndex=String(index%5);icon.setAttribute('aria-hidden','true');
    icon.innerHTML='<svg viewBox="0 0 24 24" width="25" height="25" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 4.5h6.2c1.2 0 1.8.5 1.8 1.5v14c0-1-.6-1.5-1.8-1.5H4.5zM19.5 4.5h-5.2c-1.2 0-1.8.5-1.8 1.5v14c0-1 .6-1.5 1.8-1.5h5.2z"/></svg>';
    const heading=document.createElement('span');heading.className='course-card-heading';
    const strong=document.createElement('strong');strong.textContent=subject.title;
    const subtitle=document.createElement('span');subtitle.className='course-subtitle';subtitle.textContent=subject.subtitle||'原题与详解';heading.append(strong,subtitle);
    const meta=document.createElement('span');meta.className='course-card-meta';meta.append(courseMeta(subject));
    const action=document.createElement('span');action.className='course-card-action';action.textContent='进入复习 →';
    button.append(icon,heading,meta,action);$('subject-list').append(button);
  });
  $('home-message').textContent=app.library.length?'':'还没有课程资料。点击「过河！过河！过河！」可查看添加方式。';
  updateHomeSummary();
}

function renderTopics(ctx) {
  const topics=new Map();for(const st of ctx.states.values()){const topic=getTopic(st.question);topics.set(topic,(topics.get(topic)||0)+1);}
  $('topic-select').replaceChildren(new Option('全部章节',''));
  for(const[topic,count]of topics)$('topic-select').append(new Option(`${topic} · ${count}`,topic));
}

function setTopic(topic) {app.topic=topic;$('topic-select').value=topic;applyFilters(true);}

function setFilter(filter) {app.filter=filter;for(const tab of $('filter-tabs').querySelectorAll('button')){const active=tab.dataset.filter===filter;tab.classList.toggle('active',active);tab.setAttribute('aria-pressed',String(active));}applyFilters(true);}

function applyFilters(resetPinned=true) {
  const ctx=app.active;if(!ctx)return;if(resetPinned){app.pinned.clear();app.returnPosition=null;updateReturnButton();}
  const words=app.search.toLowerCase().trim().split(/\s+/).filter(Boolean);let shown=0;
  for(const st of ctx.states.values()){
    const searchMatch=words.every((word)=>`${st.searchText}\n${st.desired.notes.toLowerCase()}`.includes(word));
    const topicMatch=!app.topic||getTopic(st.question)===app.topic;
    const filterMatch=app.filter==='all'||app.filter==='marked'&&(st.desired.needs_review||app.pinned.has(st.id))||app.filter==='notes'&&!!st.desired.notes.trim()||app.filter==='uncertain'&&isUncertain(st.question);
    const visible=searchMatch&&topicMatch&&filterMatch;st.dom.card.hidden=!visible;if(visible)shown++;st.dom.pinnedNotice.hidden=!app.pinned.has(st.id);
  }
  $('result-label').textContent=`显示 ${shown} / ${ctx.states.size} 道题${app.pinned.size?' · 已保留正在编辑的题目':''}`;
  $('refresh-filter').hidden=!app.pinned.size;$('clear-filter').hidden=app.filter==='all'&&!app.search&&!app.topic;
  $('empty-state').hidden=shown>0;
  $('empty-state-text').textContent=app.filter==='marked'&&!app.search&&!app.topic?'还没有标记为「还不会」的题目。阅读时点一下题目右上角即可留下。':app.filter==='notes'&&!app.search&&!app.topic?'还没有写过笔记。展开任意题目的「我的笔记」就能开始。':'试着换个关键词，或清除筛选查看全部题目。';
  updateBulkButtons();
}

function resetFilters() {app.search='';app.topic='';$('search-input').value='';$('topic-select').value='';setFilter('all');}

function showRecordErrors(ctx) {
  if(app.active!==ctx||app.view!=='reader')return;
  const count=[...ctx.states.values()].filter((st)=>st.fileError).length;
  if(count){showBanner(`有 ${count} 条学习记录文件格式异常，这些题目已暂停编辑。请按题目下方的路径修复文件，其他题目仍可正常使用。`,'重新检查',refreshActiveState);$('error-banner').dataset.kind='record-errors';}
  else if($('error-banner').dataset.kind==='record-errors'){hideBanner();delete $('error-banner').dataset.kind;}
}

function mountBook(ctx) {
  app.active=ctx;app.positionEnabled=false;app.returnPosition=null;updateReturnButton();app.search='';app.topic='';app.filter='all';app.pinned.clear();$('search-input').value='';
  $('book-title').textContent=ctx.book.title;$('book-subtitle').textContent=ctx.book.subtitle || '标出还不会的题，留下自己的理解。';$('book-eyebrow').textContent='我的题目复习';document.title=`${ctx.book.title} · 复习中心`;
  $('book-scope').hidden=!ctx.book.scope;$('book-scope-text').textContent=ctx.book.scope || '';
  const pdfURL=safeURL(ctx.book.pdf_url);$('pdf-link').hidden=!pdfURL;if(pdfURL)$('pdf-link').href=pdfURL;
  renderTopics(ctx);$('route-context').textContent=ctx.book.title;
  const fragment=document.createDocumentFragment();for(const st of ctx.states.values()){fragment.append(st.dom?.card || createQuestionCard(ctx,st));st.dom.answer.open=!app.hideAnswers;}$('question-list').replaceChildren(fragment);
  $('review-toolbar').hidden=false;$('book-footer').hidden=false;$('loading-state').hidden=true;
  setFilter('all');updateCounts();updateResume();hideBanner();showRecordErrors(ctx);window.scrollTo({top:0,behavior:'instant'});
  const routeToken=app.loadingToken;
  requestAnimationFrame(()=>requestAnimationFrame(()=>{if(app.active===ctx&&app.view==='reader'&&routeToken===app.loadingToken)app.positionEnabled=true;}));
  const drafts=[...ctx.states.values()].filter((st)=>st.dirty.size);
  if(drafts.length)showToast(`已找回 ${drafts.length} 道题的未保存草稿${drafts.some((st)=>st.conflict)?'，请核对其他窗口的修改。':'，正在尝试保存。'}`,6000);
  for(const st of drafts)if(!st.conflict)saveQuestion(st);
}

function animateRoute(view) {
  app.viewAnimation?.cancel();app.viewAnimation=null;
  if(matchMedia('(prefers-reduced-motion: reduce)').matches||!view.animate)return;
  const animation=view.animate([{opacity:0,transform:`translateY(${app.view==='reader'?8:-6}px)`},{opacity:1,transform:'translateY(0)'}],{duration:240,easing:'cubic-bezier(.2,.8,.2,1)'});
  app.viewAnimation=animation;animation.finished.catch(()=>{});
}

function setVisibleView(view,animate=true) {
  app.view=view;document.body.dataset.view=view;
  $('home-view').hidden=view!=='home';$('reader-view').hidden=view!=='reader';updateReturnButton();
  document.dispatchEvent(new CustomEvent('review:view-change',{detail:{view}}));
  if(animate)animateRoute(view==='home'?$('home-view'):$('reader-view'));
}

function flushStudyDrafts() {
  for(const st of getContextStates()){
    if(st.dirty.size||st.conflict||st.saving)persistDraft(st);
    if(st.dirty.size&&!st.conflict)saveQuestion(st);
  }
}

function closeRouteSurfaces() {
  if(app.conflictState?.conflict){
    app.conflictState.mergeDraft={notes:$('conflict-merged-notes').value,needs_review:$('conflict-merged-mark').checked,reviewed:$('conflict-merged-reviewed').checked};persistDraft(app.conflictState);
  }
  for(const dialog of document.querySelectorAll('dialog[open]'))dialog.close();
  const popover=$('reading-settings');if(typeof popover.hidePopover==='function'&&popover.matches(':popover-open'))popover.hidePopover();else if(popover.dataset.popoverFallback==='true'){popover.hidden=true;$('reading-settings-trigger').setAttribute('aria-expanded','false');}
  app.conflictState=null;app.conflictSnapshot=null;
}

function loadSubject(id) {
  const hash=`#/course/${encodeURIComponent(id)}`;
  if(location.hash===hash)return handleRoute();
  location.hash=hash;
}

function goHome() {if(location.hash==='#/'||!location.hash)return handleRoute();location.hash='#/';}

function captureLeavingPosition() {
  if(app.view!=='reader'||!app.active||app.active.id!==app.routeId)return;
  saveReadingPosition();
  app.navigationPosition={bookId:app.active.id,position:localRead(positionKey(app.active.id)),capturedAt:performance.now()};
}

async function loadCourseForRoute(id,token) {
  if(app.contexts.has(id)){
    localWrite('review-center:last-subject',id);mountBook(app.contexts.get(id));
    if(localRead(positionKey(id)))resumeReading({instant:true});
    animateRoute($('reader-view'));$('main-content').focus({preventScroll:true});
    await refreshActiveState();return;
  }
  $('loading-state').hidden=false;$('question-list').replaceChildren();$('review-toolbar').hidden=true;$('empty-state').hidden=true;$('resume-banner').hidden=true;$('book-footer').hidden=true;$('book-title').textContent='正在打开复习册';
  $('route-context').textContent=app.library.find(subject=>subject.id===id)?.title||'课程复习';
  try{
    const[book,state]=await Promise.all([requestJSON(`/study-center/api/books/${encodeURIComponent(id)}`),requestJSON(`/study-center/api/state/${encodeURIComponent(id)}`)]);
    if(token!==app.loadingToken||app.view!=='reader'||app.routeId!==id)return;
    const ctx={id,book,states:new Map(),recordErrors:new Map((state.record_errors||[]).map((error)=>[String(error.question_id),error])),sourceMap:new Map((book.sources||[]).map((s)=>[String(s.page),s]))};
    for(const q of book.questions||[])ctx.states.set(String(q.id),initializeState(ctx,q,state.records?.[q.id]));
    app.contexts.set(id,ctx);
    localWrite('review-center:last-subject',id);mountBook(ctx);
    if(localRead(positionKey(id)))resumeReading({instant:true});
    animateRoute($('reader-view'));$('main-content').focus({preventScroll:true});
  }catch(err){if(token!==app.loadingToken||app.view!=='reader')return;$('loading-state').hidden=true;$('book-title').textContent='暂时无法打开复习册';showBanner('无法打开这门课程，请确认本地服务已启动，再重试。','重新打开',()=>handleRoute());app.active=null;}
}

async function handleRoute(options={}) {
  if(!app.libraryReady)return;
  const token=++app.loadingToken;
  const pendingPosition=app.navigationPosition;app.navigationPosition=null;
  if(app.view==='reader'){
    if(pendingPosition&&app.active&&pendingPosition.bookId===app.active.id&&pendingPosition.position&&performance.now()-pendingPosition.capturedAt<1500){localWrite(positionKey(app.active.id),pendingPosition.position);updateResume();}
    else saveReadingPosition();
  }
  app.positionEnabled=false;app.returnPosition=null;clearTimeout(app.scrollTimer);
  flushStudyDrafts();closeRouteSurfaces();
  let id=null;
  try{const match=location.hash.match(/^#\/course\/([^/]+)$/);if(match)id=decodeURIComponent(match[1]);}catch(_){}
  if(id&&app.library.some(subject=>subject.id===id)){
    app.routeId=id;setVisibleView('reader',false);
    await loadCourseForRoute(id,token);return;
  }
  app.routeId=null;
  if(location.hash&&location.hash!=='#/')history.replaceState(null,'','#/');
  setVisibleView('home');document.title='我的课程 · 复习中心';
  if($('error-banner').dataset.kind==='record-errors'){hideBanner();delete $('error-banner').dataset.kind;}
  updateHomeSummary();window.scrollTo({top:0,behavior:'instant'});$('home-view').focus({preventScroll:true});
  if(id)showToast('这门课程暂时不在资料库中，请重新选择。');
  if(options.refreshHome!==false){try{await refreshLibrary();}catch(_){if(token===app.loadingToken)showBanner('课程列表暂时未能更新，已加载的资料仍可使用。','重试',()=>handleRoute());}}
}

async function refreshLibrary() {
  const result=await requestJSON('/study-center/api/library');app.library=Array.isArray(result.subjects)?result.subjects:[];app.libraryReady=true;renderLibrary();
}

async function refreshActiveState() {
  const ctx=app.active;if(!ctx||app.syncRunning)return;app.syncRunning=true;
  try{
    const result=await requestJSON(`/study-center/api/state/${encodeURIComponent(ctx.id)}`);
    ctx.recordErrors=new Map((result.record_errors||[]).map((error)=>[String(error.question_id),error]));
    for(const st of ctx.states.values()){
      st.fileError=ctx.recordErrors.get(st.id)||null;
      if(st.fileError){updateQuestionControls(st);continue;}
      updateQuestionControls(st);
      if(st.saving)continue;
      const incoming=normalizeRecord(result.records?.[st.id]);
      if(incoming.version===st.record.version&&FIELD_NAMES.every(field=>incoming[field]===st.record[field]))continue;
      if(st.dirty.size||st.conflict){
        if(FIELD_NAMES.every((f)=>st.desired[f]===incoming[f])){st.record=incoming;st.dirty.clear();st.conflict=null;st.error=null;persistDraft(st);}
        else{st.conflict=incoming;persistDraft(st);}
      }else{st.record=incoming;st.desired={needs_review:incoming.needs_review,reviewed:incoming.reviewed,notes:incoming.notes};}
      updateQuestionControls(st);
    }
    updateCounts();showRecordErrors(ctx);
  }catch(_){/* A failed background check must not interrupt reading or local drafts. */}
  finally{app.syncRunning=false;}
}

function openConflict(st) {
  if(!st.conflict)return;app.conflictState=st;app.conflictSnapshot={...st.conflict};
  $('conflict-local-notes').textContent=st.desired.notes || '（没有笔记）';$('conflict-remote-notes').textContent=st.conflict.notes || '（没有笔记）';
  const recordLabel=value=>`${value.needs_review?'⚑ 还不会':'未标记'} · ${value.reviewed?'✓ 本轮已复习':'本轮未复习'}`;
  $('conflict-local-mark').textContent=recordLabel(st.desired);$('conflict-remote-mark').textContent=recordLabel(st.conflict);
  let merged=st.desired.notes;
  if(!merged.trim())merged=st.conflict.notes;
  else if(st.conflict.notes.trim()&&st.conflict.notes!==merged)merged=`${merged}\n\n---\n\n${st.conflict.notes}`;
  $('conflict-merged-notes').value=st.mergeDraft?st.mergeDraft.notes:merged;$('conflict-merged-mark').checked=st.mergeDraft?st.mergeDraft.needs_review:st.desired.needs_review||st.conflict.needs_review;
  $('conflict-merged-reviewed').checked=st.mergeDraft?st.mergeDraft.reviewed:st.desired.reviewed||st.conflict.reviewed;
  $('conflict-dialog').showModal();
}

function resolveConflict(choice) {
  const st=app.conflictState;if(!st?.conflict)return;
  const latest=app.conflictSnapshot || st.conflict;
  const selected=choice==='remote'?{needs_review:latest.needs_review,reviewed:latest.reviewed,notes:latest.notes}:choice==='merged'?{needs_review:$('conflict-merged-mark').checked,reviewed:$('conflict-merged-reviewed').checked,notes:$('conflict-merged-notes').value}:{...st.desired};
  st.record=latest;st.conflict=null;st.error=null;st.mergeDraft=null;st.dirty.clear();st.desired=selected;
  for(const field of FIELD_NAMES)if(st.desired[field]!==latest[field])st.dirty.add(field);
  persistDraft(st);$('conflict-dialog').close();app.conflictState=null;app.conflictSnapshot=null;updateQuestionControls(st);updateCounts();
  if(st.dirty.size)saveQuestion(st);else {showToast('已采用浏览器中的记录。');refreshActiveState();}
}

function updateResume() {
  const ctx=app.active;if(!ctx)return;const position=localRead(positionKey(ctx.id));
  const st=position?.id&&ctx.states.get(String(position.id));$('resume-banner').hidden=!st;
  if(st)$('resume-label').textContent=`上次读到 ${questionLabel(st.question)} · ${st.question.title || getTopic(st.question)}`;
}

function saveReadingPosition() {
  const ctx=app.active;if(!ctx||app.view!=='reader'||!app.positionEnabled||app.returnPosition)return;
  const visible=[...ctx.states.values()].filter((st)=>!st.dom.card.hidden);if(!visible.length)return;
  const target=visible.find(st=>st.dom.card.getBoundingClientRect().bottom>readingTopEdge())||visible[visible.length-1];
  const top=target.dom.card.getBoundingClientRect().top;
  localWrite(positionKey(ctx.id),{id:target.id,number:target.question.number,title:target.question.title,top:Math.max(-1500,Math.min(500,top)),updated_at:new Date().toISOString()});updateResume();
}

function resumeReading(options={}) {
  const ctx=app.active;if(!ctx)return;const position=localRead(positionKey(ctx.id));const st=ctx.states.get(String(position?.id));if(!st)return;
  if(st.dom.card.hidden)resetFilters();app.positionEnabled=false;app.returnPosition=null;updateReturnButton();
  const offset=Number.isFinite(Number(position.top))?Math.min(innerHeight-100,Math.max(-1500,Number(position.top))):readingTopEdge();
  const top=st.dom.card.getBoundingClientRect().top+window.scrollY-offset;
  const token=app.loadingToken;const instant=options.instant===true||matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.scrollTo({top:Math.max(0,top),behavior:instant?'instant':readingScrollBehavior()});
  if(!options.instant){st.dom.card.classList.remove('flash');requestAnimationFrame(()=>st.dom.card.classList.add('flash'));}
  setTimeout(()=>{if(app.active===ctx&&app.view==='reader'&&token===app.loadingToken)app.positionEnabled=true;},instant?0:1100);
}

function openSources(ctx,pages) {
  const sources=pages.map((p)=>ctx.sourceMap.get(String(p))).filter(Boolean);if(!sources.length)return;
  app.sourceView={sources,zoom:1};$('source-title').textContent=sources.length===1?(sources[0].title || `原题 · 第 ${sources[0].page} 页`):`原题 · 第 ${pages.join('、')} 页`;
  $('source-images').replaceChildren();
  for(const source of sources){
    if(!source.images?.length){const text=document.createElement('div');text.className='source-original-text';text.textContent=source.text || '此页没有可显示的原图。';$('source-images').append(text);continue;}
    for(const[imageIndex,img]of source.images.entries()){
      const src=safeURL(img.url,true);if(!src)continue;
      const item=document.createElement('div');item.className='source-image-item';
      const frame=document.createElement('div');frame.className='source-frame';frame.dataset.width=img.width||1800;frame.dataset.height=img.height||1800;frame.dataset.rotation=Number(img.rotation)||0;
      const image=document.createElement('img');image.src=src;image.alt=`第 ${source.page} 页原图 ${imageIndex+1}`;image.draggable=false;
      image.addEventListener('load',()=>{if(!img.width)frame.dataset.width=image.naturalWidth;if(!img.height)frame.dataset.height=image.naturalHeight;layoutSourceImages();});frame.append(image);item.append(frame);
      const original=document.createElement('a');original.href=src;original.target='_blank';original.rel='noopener';original.textContent=`第 ${source.page} 页 · 原图 ${imageIndex+1} · 在新窗口打开`;item.append(original);$('source-images').append(item);
    }
  }
  $('source-dialog').showModal();requestAnimationFrame(layoutSourceImages);
}

function layoutSourceImages() {
  if(!app.sourceView)return;const available=Math.max(150,$('source-images').clientWidth-(innerWidth<780?26:48));
  for(const frame of $('source-images').querySelectorAll('.source-frame')){
    layoutSourceFrame(frame,available,app.sourceView.zoom);
  }
  $('zoom-label').textContent=app.sourceView.zoom===1?'适合宽度':`${Math.round(app.sourceView.zoom*100)}%`;
}

function changeZoom(amount) {if(!app.sourceView)return;app.sourceView.zoom=Math.max(.5,Math.min(3,Math.round((app.sourceView.zoom+amount)*100)/100));layoutSourceImages();}

async function downloadBackup() {
  if(app.backupPending)return;
  app.backupPending=true;$('backup-link').textContent='保存后备份…';$('backup-link').setAttribute('aria-busy','true');
  const states=getContextStates();for(const st of states)updateQuestionControls(st);
  try{
    await Promise.all(states.map(st=>st.mediaPromise || Promise.resolve()));
    await Promise.all(states.map((st)=>saveQuestion(st)));
    if(states.some((st)=>st.dirty.size||st.saving||st.conflict||st.error||st.pendingMedia)){
      showBanner('还有记录未能保存，暂未下载备份。请先核对冲突或重试保存，再点击「备份记录」。');showToast('备份已暂停：请先处理未保存的记录。');return;
    }
    const response=await fetch('/study-center/api/backup',{cache:'no-store'});if(!response.ok)throw new Error(`备份下载失败（${response.status}）`);
    const blob=await response.blob();const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=`复习记录备份_${new Date().toISOString().slice(0,10)}.zip`;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);showToast('记录已全部保存，备份已开始下载。');
  }catch(err){showBanner(`备份失败：${err.message}。请确认本地服务已启动后重试。`);}
  finally{app.backupPending=false;$('backup-link').textContent='备份记录';$('backup-link').removeAttribute('aria-busy');for(const st of states)updateQuestionControls(st);}
}

async function restoreBackup(file) {
  if(!file)return;
  const button=$('restore-button');button.disabled=true;button.textContent='正在恢复…';
  try{
    // The restore endpoint retains different local content rather than overwriting it.
    const result=await requestJSON('/study-center/api/restore',{method:'POST',headers:{'Content-Type':'application/zip'},body:file});
    const conflicts=Array.isArray(result.conflicts)?result.conflicts:[];
    await refreshLibrary();await refreshActiveState();
    if(conflicts.length)showBanner(`已恢复 ${Number(result.restored_count)||0} 条记录。有 ${conflicts.length} 条记录与本机内容不同，本机记录已保留；请保留备份 ZIP，以便核对。`);
    showToast(`已恢复 ${Number(result.restored_count)||0} 条记录${conflicts.length?`，${conflicts.length} 条存在差异。`:'。'}`,6000);
  }catch(err){showBanner(`恢复失败：${err.message}。当前记录仍保留。`);}
  finally{button.disabled=false;button.textContent='恢复备份';$('restore-file').value='';}
}

function attachEvents() {
  for(const control of [$('back-home'),document.querySelector('.brand')]){
    control.addEventListener('pointerdown',captureLeavingPosition);
    control.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' ')captureLeavingPosition();});
  }
  $('back-home').addEventListener('click',goHome);
  $('home-continue').addEventListener('click',()=>{const id=$('home-continue').dataset.courseId;if(id)loadSubject(id);});
  window.addEventListener('hashchange',()=>handleRoute());
  $('filter-tabs').addEventListener('click',(event)=>{const button=event.target.closest('button[data-filter]');if(button)setFilter(button.dataset.filter);});
  $('search-input').addEventListener('input',()=>{clearTimeout(app.filterTimer);app.filterTimer=setTimeout(()=>{app.search=$('search-input').value;applyFilters(true);},140);});
  $('topic-select').addEventListener('change',()=>setTopic($('topic-select').value));
  $('hide-answers').addEventListener('change',()=>{app.hideAnswers=$('hide-answers').checked;localWrite('review-center:hide-answers',app.hideAnswers);if(app.active)for(const st of app.active.states.values())st.dom.answer.open=!app.hideAnswers;});
  $('toggle-all-answers').addEventListener('click',()=>{const states=visibleStates();const open=!states.every(st=>st.dom.answer.open);app.hideAnswers=!open;$('hide-answers').checked=!open;localWrite('review-center:hide-answers',!open);for(const st of states)st.dom.answer.open=open;updateBulkButtons();});
  $('toggle-all-sources').addEventListener('click',()=>{const states=visibleStates().filter(st=>st.dom.source);const open=!states.every(st=>st.dom.source.open);for(const st of states)st.dom.source.open=open;updateBulkButtons();});
  $('toggle-all-notes').addEventListener('click',()=>{const states=visibleStates();const open=!states.every(st=>!st.dom.notesEditor.hidden);for(const st of states)setNotesOpen(st,open);updateBulkButtons();});
  $('refresh-filter').addEventListener('click',()=>applyFilters(true));$('clear-filter').addEventListener('click',resetFilters);$('empty-reset-button').addEventListener('click',resetFilters);
  $('resume-button').addEventListener('click',resumeReading);
  for(const id of ['help-button','footer-help','add-subject-button'])$(id).addEventListener('click',()=>$('help-dialog').showModal());
  for(const button of document.querySelectorAll('.dialog-close'))button.addEventListener('click',()=>button.closest('dialog').close());
  for(const dialog of document.querySelectorAll('dialog'))dialog.addEventListener('click',(event)=>{if(event.target===dialog){const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)dialog.close();}});
  $('conflict-use-local').addEventListener('click',()=>resolveConflict('local'));$('conflict-use-remote').addEventListener('click',()=>resolveConflict('remote'));$('conflict-merge').addEventListener('click',()=>resolveConflict('merged'));
  const saveMergeDraft=()=>{const st=app.conflictState;if(!st?.conflict)return;st.mergeDraft={notes:$('conflict-merged-notes').value,needs_review:$('conflict-merged-mark').checked,reviewed:$('conflict-merged-reviewed').checked};persistDraft(st);};
  $('conflict-merged-notes').addEventListener('input',saveMergeDraft);$('conflict-merged-mark').addEventListener('change',saveMergeDraft);
  $('conflict-merged-reviewed').addEventListener('change',saveMergeDraft);
  $('zoom-in').addEventListener('click',()=>changeZoom(.25));$('zoom-out').addEventListener('click',()=>changeZoom(-.25));$('zoom-fit').addEventListener('click',()=>{if(app.sourceView){app.sourceView.zoom=1;layoutSourceImages();}});
  $('restore-button').addEventListener('click',()=>$('restore-file').click());$('restore-file').addEventListener('change',()=>restoreBackup($('restore-file').files[0]));
  $('backup-link').addEventListener('click',(event)=>{event.preventDefault();downloadBackup();});
  $('back-to-top').addEventListener('click',toggleReadingReturn);
  window.addEventListener('resize',()=>{if($('source-dialog').open)layoutSourceImages();for(const st of visibleStates())layoutInlineSources(st.dom.source);});
  window.addEventListener('scroll',()=>{if(app.returnPosition){if(window.scrollY<50)app.returnPosition.reachedTop=true;else if(app.returnPosition.reachedTop&&window.scrollY>750)app.returnPosition=null;}updateReturnButton();clearTimeout(app.scrollTimer);app.scrollTimer=setTimeout(saveReadingPosition,450);},{passive:true});
  const interruptReadingReturn=()=>{if(app.returnPosition){app.returnPosition=null;updateReturnButton();}};
  window.addEventListener('wheel',interruptReadingReturn,{passive:true});
  window.addEventListener('touchmove',interruptReadingReturn,{passive:true});
  window.addEventListener('pointerdown',event=>{if(app.returnPosition&&!app.returnPosition.reachedTop&&!event.target.closest('#back-to-top'))interruptReadingReturn();},{passive:true});
  window.addEventListener('keydown',event=>{if(!event.target.closest('input,textarea,[contenteditable=true]')&&['PageUp','PageDown','Home','End','ArrowUp','ArrowDown',' '].includes(event.key))interruptReadingReturn();});
  window.addEventListener('focus',refreshActiveState);
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')refreshActiveState();else{saveReadingPosition();for(const st of getContextStates())if(st.dirty.size){persistDraft(st);saveQuestion(st);}}});
  window.addEventListener('online',()=>{for(const st of getContextStates())if(st.dirty.size&&!st.conflict)saveQuestion(st);refreshActiveState();});
  window.addEventListener('beforeunload',(event)=>{saveReadingPosition();const unsaved=getContextStates().filter((st)=>st.dirty.size||st.saving||st.conflict||st.pendingMedia);for(const st of unsaved)persistDraft(st);if(unsaved.length){event.preventDefault();event.returnValue='';}});
  setInterval(()=>{if(document.visibilityState==='visible')refreshActiveState();},25000);
}

async function start() {
  if(!app.eventsAttached){attachEvents();app.eventsAttached=true;history.scrollRestoration='manual';}
  app.hideAnswers=localRead('review-center:hide-answers',false)===true;$('hide-answers').checked=app.hideAnswers;
  try{
    await refreshLibrary();
    await handleRoute({refreshHome:false});
  }catch(err){setVisibleView('home',false);$('home-message').textContent='暂时无法读取课程，请检查连接后重试。';showBanner('暂时无法读取资料，请检查网络或重新打开私有链接。','重试',start);}
}

start();
