/* Encrypted content stays encrypted in the network cache. Decryption happens here. */
'use strict';
const BASE='/study-center/',VERSION='2026-10-26-mvorjoxh',PREFIX='review-center-site-',CACHE=PREFIX+VERSION;
let manifestPromise=null,keyPromise=null;
function accessDB(){return new Promise((resolve,reject)=>{const request=indexedDB.open('review-center-web-access',1);request.onupgradeneeded=()=>request.result.createObjectStore('config',{keyPath:'key'});request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
async function readAccessKey(){const db=await accessDB();try{return await new Promise((resolve,reject)=>{const request=db.transaction('config').objectStore('config').get('content-key');request.onsuccess=()=>resolve(request.result?.value||null);request.onerror=()=>reject(request.error);});}finally{db.close();}}
async function contentKey(){if(!keyPromise)keyPromise=(async()=>{const value=await readAccessKey();if(!value)return null;const bytes=Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')+'='),c=>c.charCodeAt(0));return crypto.subtle.importKey('raw',bytes,'AES-GCM',false,['decrypt']);})();return keyPromise;}
async function digest(response){const bytes=await response.clone().arrayBuffer();return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');}
function relativeURL(value){const url=new URL(typeof value==='string'?value:value.url,location.origin);if(url.origin!==location.origin||!url.pathname.startsWith(BASE))return null;const relative=decodeURIComponent(url.pathname.slice(BASE.length));return relative||'index.html';}
function expectedHashes(data){const result=new Map(Object.entries(data.static_hashes||{}));for(const item of Object.values(data.files||{}))if(item.cipher_sha256)result.set(item.url,item.cipher_sha256);return result;}
function requiredShell(relative){return relative==='index.html'||/\.(?:css|js|mjs|webmanifest)$/.test(relative)||relative==='assets/poems.json'||relative==='assets/campaign-data.json';}
async function matches(response,hash){return Boolean(response?.ok&&hash&&await digest(response)===hash);}
async function manifest(){if(!manifestPromise)manifestPromise=(async()=>{
  const cache=await caches.open(CACHE),stored=await cache.match(BASE+'manifest.json');
  if(stored){const data=await stored.json();if(data.version===VERSION)return data;}
  const response=await fetch(BASE+'manifest.json',{cache:'no-store'});if(!response.ok)throw new Error('资料目录暂时不可用');
  const data=await response.clone().json();if(data.version!==VERSION)throw new Error('网站正在更新，请稍后刷新。');
  await cache.put(BASE+'manifest.json',response);return data;
})().catch(error=>{manifestPromise=null;throw error;});return manifestPromise;}
async function fallbackResponse(request,hash){
  // Recovery bytes from an old cache must match the new manifest.
  for(const name of await caches.keys())if(name.startsWith(PREFIX)&&name!==CACHE){const cache=await caches.open(name),response=await cache.match(request,{ignoreSearch:true});if(await matches(response,hash))return response;}
  return null;
}
async function cachedNetwork(request,preferCache=false,data=null){
  data=data||await manifest();const relative=relativeURL(request),cache=await caches.open(CACHE),hash=expectedHashes(data).get(relative);
  const canonical=BASE+relative,old=await cache.match(canonical);
  if(preferCache&&old)return old;
  try{
    const response=await fetch(request,{cache:'no-store'});
    if(response.ok&&response.type!=='opaque'){
      if(!hash||!await matches(response,hash))throw new Error('资料版本正在更新，请稍后重试。');
      await cache.put(canonical,response.clone());return response;
    }
    if(old)return old;const fallback=await fallbackResponse(canonical,hash);if(fallback){await cache.put(canonical,fallback.clone());return fallback;}return response;
  }catch(error){if(old)return old;const fallback=await fallbackResponse(canonical,hash);if(fallback){await cache.put(canonical,fallback.clone());return fallback;}throw error;}
}
async function migrateCaches(cleanup=false){
  const data=await manifest(),hashes=expectedHashes(data),target=await caches.open(CACHE),oldNames=(await caches.keys()).filter(name=>name.startsWith(PREFIX)&&name!==CACHE);
  let complete=true;
  for(const name of oldNames){const old=await caches.open(name);for(const request of await old.keys()){
    const relative=relativeURL(request),hash=hashes.get(relative);if(!hash)continue;
    try{if(await target.match(BASE+relative))continue;const response=await old.match(request);if(await matches(response,hash))await target.put(BASE+relative,response);}catch(_){complete=false;}
  }}
  // Complete a coherent public shell before retiring any old runtime. An
  // interrupted upgrade retains recovery caches and never touches notes.
  for(const relative of Object.keys(data.static_hashes||{}).filter(requiredShell)){
    try{const response=await cachedNetwork(BASE+relative,true,data);if(!response.ok)complete=false;}catch(_){complete=false;}
  }
  if(complete&&cleanup)for(const name of oldNames)await caches.delete(name);
  return complete;
}
async function decryptedContent(relative){const key=await contentKey();if(!key)return new Response('题库尚未解锁',{status:401});const data=await manifest(),item=data.files[relative];if(!item)return new Response('未找到资料',{status:404});const response=await cachedNetwork(BASE+item.url,true,data);if(!response.ok)return response;const bytes=new Uint8Array(await response.arrayBuffer());try{const plaintext=await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes.slice(0,12),additionalData:new TextEncoder().encode(relative)},key,bytes.slice(12));return new Response(plaintext,{headers:{'Content-Type':item.mime,'Content-Length':String(plaintext.byteLength),'Cache-Control':'no-store'}});}catch(_){keyPromise=null;return new Response('解锁密钥无效，请重新打开私有链接',{status:401});}}
async function media(relative){const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('review-center-web-v1',1);request.onupgradeneeded=()=>{const database=request.result;database.createObjectStore('records',{keyPath:'key'});database.createObjectStore('media',{keyPath:'key'});database.createObjectStore('conflicts',{keyPath:'id'});};request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});try{const value=await new Promise((resolve,reject)=>{const request=db.transaction('media').objectStore('media').get(relative);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});return value?.blob?new Response(value.blob,{headers:{'Content-Type':'image/png','Cache-Control':'no-store'}}):new Response('未找到笔记图片',{status:404});}finally{db.close();}}
self.addEventListener('install',event=>event.waitUntil((async()=>{if(!await migrateCaches())throw new Error('页面更新未完成，保留原来的离线版本。');await self.skipWaiting();})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{try{await migrateCaches(true);}finally{await self.clients.claim();}})()));
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);if(url.origin!==location.origin||!url.pathname.startsWith(BASE)||event.request.method!=='GET')return;
  const relative=decodeURIComponent(url.pathname.slice(BASE.length));
  if(relative.startsWith('api/')||relative==='sw.js')return;
  event.respondWith((async()=>{try{
    if(relative.startsWith('content/'))return await decryptedContent(relative);
    if(relative.startsWith('media/'))return await media(relative.slice('media/'.length));
    if(relative==='manifest.json'){const data=await manifest();return new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});}
    if(event.request.mode==='navigate')return await cachedNetwork(BASE+'index.html',false);
    return await cachedNetwork(event.request,true);
  }catch(_){return new Response('资料未缓存，请联网后重试',{status:503});}})());
});
self.addEventListener('message',event=>{
  if(event.data?.type==='KEY_CHANGED'){keyPromise=null;return;}
  const port=event.ports[0];if(!port)return;
  if(event.data?.type==='GET_VERSION'){port.postMessage({ok:true,version:VERSION});return;}
  event.waitUntil((async()=>{try{
    const data=await manifest();
    if(event.data.type==='CACHE_SHELL'){
      for(const relative of ['index.html','bootstrap.js','assets/mobile.css','assets/tablet.css']){const response=await cachedNetwork(BASE+relative,true,data);if(!response.ok)throw new Error('页面资源下载失败，请联网重试。');}
      port.postMessage({ok:true});return;
    }
    if(event.data.type==='CACHE_ALL'){
      const paths=[...new Set(['index.html',...Object.keys(data.static_hashes||{}),...Object.values(data.files).map(file=>file.url)])];let done=0,cursor=0;
      const next=async()=>{while(cursor<paths.length){const relative=paths[cursor++],response=await cachedNetwork(BASE+relative,true,data);if(!response.ok)throw new Error('部分资料下载失败，请稍后重试。');done++;port.postMessage({progress:true,done,total:paths.length});}};
      await Promise.all([next(),next(),next()]);port.postMessage({ok:true,done,total:paths.length});return;
    }
    port.postMessage({error:'未知缓存请求'});
  }catch(error){port.postMessage({error:error.message||'缓存未完成'});}})());
});
