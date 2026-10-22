/* Encrypted content stays encrypted in the network cache. Decryption happens here. */
'use strict';
const BASE='__SITE_BASE__',VERSION='__SITE_VERSION__',CACHE='review-center-site-'+VERSION;
let manifestPromise=null,keyPromise=null;
function accessDB(){return new Promise((resolve,reject)=>{const request=indexedDB.open('review-center-web-access',1);request.onupgradeneeded=()=>request.result.createObjectStore('config',{keyPath:'key'});request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
async function readAccessKey(){const db=await accessDB();try{return await new Promise((resolve,reject)=>{const request=db.transaction('config').objectStore('config').get('content-key');request.onsuccess=()=>resolve(request.result?.value||null);request.onerror=()=>reject(request.error);});}finally{db.close();}}
async function contentKey(){if(!keyPromise)keyPromise=(async()=>{const value=await readAccessKey();if(!value)return null;const bytes=Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')+'='),c=>c.charCodeAt(0));return crypto.subtle.importKey('raw',bytes,'AES-GCM',false,['decrypt']);})();return keyPromise;}
async function cachedNetwork(request,preferCache=false){const cache=await caches.open(CACHE),old=await cache.match(request);if(preferCache&&old)return old;try{const response=await fetch(request);if(response.ok&&response.type!=='opaque')await cache.put(request,response.clone());if(!response.ok&&old)return old;return response;}catch(error){if(old)return old;throw error;}}
async function manifest(){if(!manifestPromise)manifestPromise=cachedNetwork(BASE+'manifest.json').then(response=>{if(!response.ok)throw new Error('资料目录暂时不可用');return response.json();}).catch(error=>{manifestPromise=null;throw error;});return manifestPromise;}
async function decryptedContent(relative){const key=await contentKey();if(!key)return new Response('题库尚未解锁',{status:401});const data=await manifest(),item=data.files[relative];if(!item)return new Response('未找到资料',{status:404});const response=await cachedNetwork(BASE+item.url,true);if(!response.ok)return response;const bytes=new Uint8Array(await response.arrayBuffer());try{const plaintext=await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes.slice(0,12),additionalData:new TextEncoder().encode(relative)},key,bytes.slice(12));return new Response(plaintext,{headers:{'Content-Type':item.mime,'Content-Length':String(plaintext.byteLength),'Cache-Control':'no-store'}});}catch(_){keyPromise=null;return new Response('解锁密钥无效，请重新打开私有链接',{status:401});}}
async function media(relative){const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('review-center-web-v1',1);request.onupgradeneeded=()=>{const database=request.result;database.createObjectStore('records',{keyPath:'key'});database.createObjectStore('media',{keyPath:'key'});database.createObjectStore('conflicts',{keyPath:'id'});};request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});try{const value=await new Promise((resolve,reject)=>{const request=db.transaction('media').objectStore('media').get(relative);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});return value?.blob?new Response(value.blob,{headers:{'Content-Type':'image/png','Cache-Control':'no-store'}}):new Response('未找到笔记图片',{status:404});}finally{db.close();}}
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil((async()=>{await self.clients.claim();for(const name of await caches.keys())if(name.startsWith('review-center-site-')&&name!==CACHE)await caches.delete(name);})()));
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);if(url.origin!==location.origin||!url.pathname.startsWith(BASE)||event.request.method!=='GET')return;
  const relative=decodeURIComponent(url.pathname.slice(BASE.length));
  if(relative.startsWith('api/'))return;
  event.respondWith((async()=>{try{
    if(relative.startsWith('content/'))return await decryptedContent(relative);
    if(relative.startsWith('media/'))return await media(relative.slice('media/'.length));
    if(event.request.mode==='navigate'){try{return await cachedNetwork(event.request);}catch(_){const cache=await caches.open(CACHE);return await cache.match(BASE)||await cache.match(BASE+'index.html')||new Response('请联网打开一次复习中心',{status:503});}}
    return await cachedNetwork(event.request,relative!=='manifest.json'&&relative!=='bootstrap.js');
  }catch(_){return new Response('资料未缓存，请联网后重试',{status:503});}})());
});
self.addEventListener('message',event=>{
  if(event.data?.type==='KEY_CHANGED'){keyPromise=null;return;}
  const port=event.ports[0];if(!port)return;
  event.waitUntil((async()=>{try{
    const data=await manifest();
    if(event.data.type==='CACHE_SHELL'){
      for(const relative of ['','index.html','bootstrap.js','manifest.json','assets/mobile.css'])await cachedNetwork(BASE+relative,true);
      port.postMessage({ok:true});return;
    }
    if(event.data.type==='CACHE_ALL'){
      const paths=[...new Set(['','index.html',...data.static,...Object.values(data.files).map(file=>file.url)])];let done=0,cursor=0;
      const next=async()=>{while(cursor<paths.length){const relative=paths[cursor++],response=await cachedNetwork(BASE+relative,true);if(!response.ok)throw new Error('部分资料下载失败，请稍后重试。');done++;port.postMessage({progress:true,done,total:paths.length});}};
      await Promise.all([next(),next(),next()]);port.postMessage({ok:true,done,total:paths.length});return;
    }
    port.postMessage({error:'未知缓存请求'});
  }catch(error){port.postMessage({error:error.message||'缓存未完成'});}})());
});
