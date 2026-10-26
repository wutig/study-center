/* Public runtime. The private content key is supplied in the URL fragment or by the user. */
(() => {
  'use strict';
  const base='/study-center/',version='2026-10-26-mvorjoxh';
  const scripts=["/study-center/vendor/marked/marked.umd.js","/study-center/vendor/katex/katex.min.js","/study-center/vendor/jszip/jszip.min.js","/study-center/assets/browser-store.js","/study-center/assets/app.js","/study-center/assets/poetry.js","/study-center/assets/experience.js","/study-center/assets/fullscreen.js","/study-center/assets/hero.js","/study-center/assets/campaign.js","/study-center/assets/mobile.js","/study-center/assets/tablet.js"];
  const accessDB='review-center-web-access';
  let manifest,unlockUI,privateLink='',appLoaded=false;
  const books=new Map();
  function dbAccess(){return new Promise((resolve,reject)=>{const request=indexedDB.open(accessDB,1);request.onupgradeneeded=()=>request.result.createObjectStore('config',{keyPath:'key'});request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
  async function savedKey(value){const db=await dbAccess();try{return await new Promise((resolve,reject)=>{const transaction=db.transaction('config',value===undefined?'readonly':'readwrite'),store=transaction.objectStore('config');const request=value===undefined?store.get('content-key'):store.put({key:'content-key',value});request.onsuccess=()=>{if(value===undefined)resolve(request.result?.value||null);};transaction.oncomplete=()=>{if(value!==undefined)resolve(value);};transaction.onerror=()=>reject(transaction.error);});}finally{db.close();}}
  function decodeKey(value){let text=String(value||'').trim();try{if(text.includes('#'))text=new URL(text,location.href).hash.slice(1);if(text.startsWith('key='))text=new URLSearchParams(text).get('key')||'';}catch(_){throw new Error('请粘贴完整私有链接，或其中的解锁密钥。');}if(!/^[A-Za-z0-9_-]{43}$/.test(text))throw new Error('链接或密钥不完整，请重新复制。');return text;}
  function rawKey(value){const bin=atob(value.replace(/-/g,'+').replace(/_/g,'/')+'=');return Uint8Array.from(bin,c=>c.charCodeAt(0));}
  async function checkKey(value){const first=manifest.books[0];if(!first)throw new Error('题库索引为空。');const entry=manifest.files[first.path],response=await fetch(base+entry.url);if(!response.ok)throw new Error('暂时无法下载题库，请检查网络后重试。');const bytes=new Uint8Array(await response.arrayBuffer()),key=await crypto.subtle.importKey('raw',rawKey(value),'AES-GCM',false,['decrypt']);try{await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes.slice(0,12),additionalData:new TextEncoder().encode(first.path)},key,bytes.slice(12));}catch(_){throw new Error('密钥不正确，请粘贴原来的完整私有链接。');}}
  function makeUnlock(){
    const dialog=document.createElement('dialog');dialog.id='site-unlock-dialog';dialog.className='help-dialog';dialog.setAttribute('aria-labelledby','site-unlock-title');
    dialog.innerHTML='<div class="dialog-heading"><div><h2 id="site-unlock-title">打开我的复习题库</h2></div></div><form id="site-unlock-form" style="padding:22px"><p style="margin-bottom:14px">粘贴私有链接或解锁密钥。题库只会在这台设备解密。</p><label for="site-key-input">私有链接或密钥</label><textarea id="site-key-input" rows="3" autocomplete="off" autocapitalize="off" spellcheck="false" style="display:block;width:100%;font-size:16px;margin:8px 0;padding:12px;resize:vertical"></textarea><p id="site-unlock-error" role="alert" style="color:#9c302c;min-height:28px"></p><button id="site-unlock-button" class="button button-primary" type="submit" style="min-height:44px">解锁题库</button></form>';
    document.body.append(dialog);dialog.addEventListener('cancel',event=>event.preventDefault());
    const input=dialog.querySelector('textarea'),button=dialog.querySelector('button'),error=dialog.querySelector('[role="alert"]');
    unlockUI={dialog,input,button,error,submit:null};
    dialog.querySelector('form').addEventListener('submit',async event=>{event.preventDefault();if(!unlockUI.submit)return;button.disabled=true;error.textContent='正在打开…';try{const value=decodeKey(input.value);await checkKey(value);await savedKey(value);navigator.serviceWorker.controller?.postMessage({type:'KEY_CHANGED'});input.value='';dialog.close();unlockUI.submit(value);unlockUI.submit=null;}catch(problem){error.textContent=problem.message;}finally{button.disabled=false;}});
    return unlockUI;
  }
  function askKey(message=''){const ui=unlockUI||makeUnlock();ui.error.textContent=message;if(!ui.dialog.open)ui.dialog.showModal();return new Promise(resolve=>{ui.submit=resolve;});}
  async function controllerVersion(){const controller=navigator.serviceWorker.controller;if(!controller)return null;return new Promise(resolve=>{const channel=new MessageChannel(),timer=setTimeout(()=>{channel.port1.close();resolve(null);},1000);channel.port1.onmessage=event=>{clearTimeout(timer);channel.port1.close();resolve(event.data?.version||null);};controller.postMessage({type:'GET_VERSION'},[channel.port2]);});}
  async function waitController(){const deadline=Date.now()+45000;while(Date.now()<deadline){if(await controllerVersion()===version)return;await new Promise(resolve=>setTimeout(resolve,150));}throw new Error('页面更新尚未完成。请保持联网，稍后重新打开。');}
  async function workerMessage(message,onProgress){const registration=await navigator.serviceWorker.ready;return new Promise((resolve,reject)=>{const channel=new MessageChannel();channel.port1.onmessage=event=>{const value=event.data;if(value.progress){onProgress?.(value);return;}channel.port1.close();value.error?reject(new Error(value.error)):resolve(value);};registration.active.postMessage(message,[channel.port2]);});}
  async function getBook(id){if(books.has(id))return books.get(id);const item=manifest.books.find(book=>book.id===id);if(!item)throw new Error('未找到这门课程。');const response=await fetch(base+item.path);if(!response.ok)throw new Error(response.status===401?'请重新输入私有链接解锁。':'暂时无法读取课程资料。');const book=await response.json();books.set(id,book);return book;}
  async function initialize(){
    if(!window.isSecureContext||!navigator.serviceWorker||!crypto.subtle)throw new Error('请用 Chrome、Edge 或 Safari 打开 HTTPS 私有链接。');
    navigator.serviceWorker.addEventListener('controllerchange',async()=>{const next=await controllerVersion();if(!appLoaded&&next&&next!==version)location.reload();});
    await navigator.serviceWorker.register(base+'sw.js',{scope:base,updateViaCache:'none'});
    await navigator.serviceWorker.ready;await waitController();
    const response=await fetch(base+'manifest.json',{cache:'no-store'});if(!response.ok)throw new Error('暂时无法读取资料目录，请稍后重试。');manifest=await response.json();if(manifest.version!==version)throw new Error('页面正在更新，请刷新后重试。');
    let key=null,problem='';
    if(location.hash.startsWith('#key=')){try{key=decodeKey(location.hash.slice(1));}catch(error){problem=error.message;}history.replaceState(null,'',location.pathname+location.search+'#/');}
    if(!key)try{key=await savedKey();}catch(_){problem='当前浏览器无法保存解锁状态，请确认未禁用网站储存。';}
    if(key){try{await checkKey(key);await savedKey(key);navigator.serviceWorker.controller.postMessage({type:'KEY_CHANGED'});}catch(error){key=null;problem=error.message;}}
    if(!key)key=await askKey(problem);
    privateLink=location.origin+base+'#key='+key;
    await workerMessage({type:'CACHE_SHELL'});
  }
  const ready=initialize();
  window.ReviewSite={base,version,ready,getBook,getBooks:async()=>Promise.all(manifest.books.map(item=>getBook(item.id))),requestUnlock:askKey};
  async function loadScript(src){return new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=src;script.onload=resolve;script.onerror=()=>reject(new Error('页面资源暂时无法下载，请联网刷新。'));document.head.append(script);});}
  ready.then(async()=>{
    for(const src of scripts)await loadScript(src);
    appLoaded=true;
    document.getElementById('site-show-unlock')?.addEventListener('click',async()=>{document.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close());await askKey();books.clear();location.reload();});
    document.getElementById('site-copy-private-link')?.addEventListener('click',()=>{
      const fallback=document.getElementById('site-private-link-fallback'),status=document.getElementById('site-copy-status');
      const showFallback=()=>{fallback.value=privateLink;fallback.hidden=false;fallback.focus();fallback.select();status.textContent='长按下面的链接，选择拷贝；请将它保留在自己的备忘录中。';};
      // Clipboard is invoked directly in the tap handler for Safari's gesture policy.
      if(navigator.clipboard?.writeText)navigator.clipboard.writeText(privateLink).then(()=>{fallback.hidden=true;fallback.value='';status.textContent='私有链接已复制，可在主屏幕入口的解锁框中粘贴。';}).catch(showFallback);else showFallback();
    });
    document.getElementById('site-offline-download')?.addEventListener('click',async()=>{const button=document.getElementById('site-offline-download'),status=document.getElementById('site-offline-status');button.disabled=true;status.textContent='正在缓存资料…';try{await workerMessage({type:'CACHE_ALL'},value=>{status.textContent=`正在缓存 ${value.done} / ${value.total} 项`;});status.textContent='全部资料已缓存，可在这台设备离线复习。';}catch(error){status.textContent=error.message+' 保持联网后可以再试。';}finally{button.disabled=false;}});
    try{navigator.storage?.persist?.();}catch(_){/* Optional storage request. */}
  }).catch(error=>{const ui=unlockUI||makeUnlock();ui.error.textContent=error.message;ui.button.disabled=true;if(!ui.dialog.open)ui.dialog.showModal();});
})();
