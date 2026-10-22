import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import crypto from 'node:crypto';
import test from 'node:test';
import {encryptedContainer,sha256} from '../build-support.mjs';

test('AES container reuse authenticates the content, key, path, and tag',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'review-cipher-'));
  try{
    const file=path.join(dir,'container.bin'),key=crypto.randomBytes(32),plain=Buffer.from('一题的原图与答案');
    const first=await encryptedContainer('content/book.json',plain,key,file);assert.equal(first.reused,false);await fs.writeFile(file,first.bytes);
    const same=await encryptedContainer('content/book.json',plain,key,file);assert.equal(same.reused,true);assert.deepEqual(same.bytes,first.bytes);
    for(const [name,bytes,secret] of [['content/changed.json',plain,key],['content/book.json',Buffer.from('修改的题目'),key],['content/book.json',plain,crypto.randomBytes(32)]]){
      const changed=await encryptedContainer(name,bytes,secret,file);assert.equal(changed.reused,false);assert.notDeepEqual(changed.bytes,first.bytes);
    }
    const corrupt=Buffer.from(first.bytes);corrupt[15]^=1;await fs.writeFile(file,corrupt);
    assert.equal((await encryptedContainer('content/book.json',plain,key,file)).reused,false);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

const origin='https://fixture.invalid',base='/study-center/',oldName='review-center-site-old',newName='review-center-site-new';
const source=(await fs.readFile(new URL('../client/sw.js',import.meta.url),'utf8')).replaceAll('__SITE_BASE__',base).replaceAll('__SITE_VERSION__','new');
function fixture({failShell=false}={}){
  const stores=new Map(),listeners=new Map(),network=new Map(),fetches=[];
  const url=value=>new URL(typeof value==='string'?value:value.url,origin).href;
  const cache=name=>{if(!stores.has(name))stores.set(name,new Map());const values=stores.get(name);return{match:async request=>values.get(url(request))?.clone(),put:async(request,response)=>{values.set(url(request),response.clone());},keys:async()=>[...values.keys()].map(value=>new Request(value))};};
  const shell=Buffer.from('new bootstrap, verified'),oldShell=Buffer.from('old bootstrap must never enter new cache'),cipher=crypto.randomBytes(128);
  const manifest={version:'new',static_hashes:{'bootstrap.js':sha256(shell),'assets/hero.png':sha256(Buffer.from('large optional image'))},files:{'content/book.json':{url:'secrets/unchanged.bin',cipher_sha256:sha256(cipher)}}};
  network.set(base+'manifest.json',new Response(JSON.stringify(manifest)));if(!failShell)network.set(base+'bootstrap.js',new Response(shell));
  const scope={addEventListener:(type,fn)=>listeners.set(type,fn),skipWaiting:async()=>{},clients:{claim:async()=>{}}};
  vm.runInNewContext(source,{self:scope,location:{origin},caches:{open:async name=>cache(name),keys:async()=>[...stores.keys()],delete:async name=>stores.delete(name)},fetch:async request=>{const relative=new URL(url(request)).pathname;fetches.push(relative);return network.get(relative)?.clone()||new Response('offline',{status:503});},crypto:crypto.webcrypto,TextEncoder,URL,Response,Uint8Array,atob,console,indexedDB:{open:()=>{throw Error('Migration must not open or clear personal IndexedDB');}}});
  return{cache,stores,manifest,cipher,shell,oldShell,fetches,async emit(type,data={}){let promise;listeners.get(type)({...data,waitUntil:value=>{promise=value;}});await promise;}};
}
test('old cache bytes migrate only after new-manifest verification; no cipher redownload or IDB mutation',async()=>{
  const f=fixture(),old=f.cache(oldName);
  // Legacy manifests do not need the new hash fields: new manifest authenticates bytes.
  await old.put(base+'manifest.json',new Response(JSON.stringify({version:'old',files:{'content/book.json':{url:'secrets/unchanged.bin'}}})));
  await old.put(base+'secrets/unchanged.bin',new Response(f.cipher));await old.put(base+'bootstrap.js',new Response(f.oldShell));
  await f.emit('install');assert(f.stores.has(oldName),'install must retain old active runtime');
  const target=f.cache(newName);assert.deepEqual(Buffer.from(await(await target.match(base+'secrets/unchanged.bin')).arrayBuffer()),f.cipher);
  assert.equal(await(await target.match(base+'bootstrap.js')).text(),f.shell.toString());
  assert(!f.fetches.includes(base+'secrets/unchanged.bin'),'unchanged 125 MB source assets should reuse local ciphertext');
  assert(!f.fetches.includes(base+'assets/hero.png'),'large images must not block first installation');
  await f.emit('activate');assert(!f.stores.has(oldName),'cleanup follows successful coherent shell');
});
test('failed public-shell upgrade keeps old active cache and rejects installation',async()=>{
  const f=fixture({failShell:true}),old=f.cache(oldName);await old.put(base+'bootstrap.js',new Response(f.oldShell));await old.put(base+'secrets/unchanged.bin',new Response(f.cipher));
  await assert.rejects(f.emit('install'),/页面更新未完成/);assert(f.stores.has(oldName));
  assert.equal(await(await old.match(base+'bootstrap.js')).text(),f.oldShell.toString());
  assert.equal(await f.cache(newName).match(base+'bootstrap.js'),undefined,'unverified old JavaScript cannot enter new cache');
});
