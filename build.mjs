import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root=path.dirname(fileURLToPath(import.meta.url));
const source=path.resolve(root,'../复习中心');
const base='/study-center/';
const version=`2026-10-22-${Date.now().toString(36)}`;
const out=path.join(root,'site');
const stage=path.join(root,'.site-building');
const privateDir=path.join(root,'.private');
await fs.mkdir(privateDir,{recursive:true});
let key;
try {key=Buffer.from((await fs.readFile(path.join(privateDir,'key.txt'),'utf8')).trim(),'base64url');}
catch(error){if(error.code!=='ENOENT')throw error;key=crypto.randomBytes(32);await fs.writeFile(path.join(privateDir,'key.txt'),key.toString('base64url')+'\n',{flag:'wx'});}
if(key.length!==32)throw new Error('Private access key must contain exactly 32 bytes.');
// Only public runtime files are copied; personal records and access keys never enter site/.
if(path.dirname(stage)!==root)throw new Error('Unsafe staging directory.');
await fs.rm(stage,{recursive:true,force:true});
await fs.mkdir(path.join(stage,'secrets'),{recursive:true});
async function files(dir){const entries=await fs.readdir(dir,{withFileTypes:true});const all=[];for(const e of entries){if(e.isSymbolicLink())throw new Error('Symbolic links are not allowed.');const p=path.join(dir,e.name);if(e.isDirectory())all.push(...await files(p));else if(e.isFile())all.push(p);}return all.sort();}
const rootURL=/(["'`(=])\/(assets|vendor|content|media|api)\//g;
const rebase=text=>text.replace(rootURL,(_,before,folder)=>`${before}${base}${folder}/`);
const publicText=new Set(['.css','.js','.mjs','.json','.html','.webmanifest','.svg']);
async function copyPublic(src,dst){await fs.mkdir(dst,{recursive:true});for(const full of await files(src)){const relative=path.relative(src,full),target=path.join(dst,relative);await fs.mkdir(path.dirname(target),{recursive:true});if(publicText.has(path.extname(full).toLowerCase()))await fs.writeFile(target,rebase(await fs.readFile(full,'utf8')));else await fs.copyFile(full,target);}}
await copyPublic(path.join(source,'web'),path.join(stage,'assets'));
await copyPublic(path.join(source,'vendor'),path.join(stage,'vendor'));
// The browser adapter owns browser-local notes and ZIPs, supplied separately.
await fs.copyFile(path.join(root,'client/browser-store.js'),path.join(stage,'assets/browser-store.js'));
try {await copyPublic(path.join(root,'vendor'),path.join(stage,'vendor'));}catch(error){if(error.code!=='ENOENT')throw error;}
const mime={'.json':'application/json; charset=utf-8','.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.svg':'image/svg+xml','.pdf':'application/pdf','.md':'text/markdown; charset=utf-8'};
const manifest={format:1,version,base,books:[],files:{},static:[]};
for(const full of await files(path.join(source,'content'))){
  const relative='content/'+path.relative(path.join(source,'content'),full).split(path.sep).join('/');
  const extension=path.extname(full).toLowerCase();
  let plaintext=await fs.readFile(full);
  if(['.json','.md','.svg'].includes(extension))plaintext=Buffer.from(rebase(plaintext.toString('utf8')));
  if(path.basename(full)==='book.json'){const book=JSON.parse(plaintext);manifest.books.push({id:book.id,path:relative});}
  const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
  cipher.setAAD(Buffer.from(relative));
  const ciphertext=Buffer.concat([iv,cipher.update(plaintext),cipher.final(),cipher.getAuthTag()]);
  const filename=crypto.createHash('sha256').update(relative).digest('hex')+'.bin';
  await fs.writeFile(path.join(stage,'secrets',filename),ciphertext);
  manifest.files[relative]={url:'secrets/'+filename,mime:mime[extension]||'application/octet-stream',size:plaintext.length,sha256:crypto.createHash('sha256').update(plaintext).digest('hex')};
}
manifest.books.sort((a,b)=>a.id.localeCompare(b.id));
let html=await fs.readFile(path.join(stage,'assets/index.html'),'utf8');
const scripts=[...html.matchAll(/<script\s+defer\s+src="([^"]+)"\s*><\/script>/g)].map(match=>match[1]);
html=html.replace(/\s*<script\s+defer\s+src="[^"]+"\s*><\/script>/g,'');
html=html.replace('</head>',`  <script defer src="${base}bootstrap.js"></script>\n</head>`);
html=html.replace('标记和笔记保存在这台电脑的文件中。关闭后，下次可以继续。','标记和笔记保存在当前浏览器。请定期备份，再更换手机或浏览器。');
html=html.replaceAll('磁盘中的记录','浏览器中的记录').replaceAll('可能来自 Obsidian 或另一个窗口。','可能来自另一个窗口或恢复的备份。');
const help=`<div class="help-body"><section><h3>手机与电脑都能复习</h3><p>点击「过河！过河！过河！」选择课程。每题可标记「还不会」「本轮已复习」，并单独或批量展开答案、笔记。</p><p>第一次在 iPhone 使用时，建议先添加到主屏幕，再从主屏幕开始记录。添加前，点下方「复制私有链接」，然后在 Safari 分享菜单选择「添加到主屏幕」。若新入口要求解锁，粘贴刚才复制的私有链接即可。</p></section><section><h3>笔记保存在当前浏览器</h3><p>文字、标记与图片保存在这台设备的当前浏览器中。确认显示「已保存」再关闭。手机、电脑、Safari 和主屏幕入口的记录不会自动同步。</p><p>添加截图请展开笔记，点「添加图片」并选择照片。也可以在输入框中粘贴图片。</p></section><section><h3>备份与迁移</h3><p>定期点「备份记录」下载 ZIP。换设备或浏览器后，用「恢复备份」导入；已有不同记录会保留并提示冲突。清除浏览器网站数据会删除本地记录，因此请先备份。此备份只含个人记录与图片，不含原来的电脑程序。</p></section><section><h3>缓存后离线复习</h3><p>已打开的资料会保存在本机缓存中。需要离线查看全部原图和 PDF，可联网时点击下面的按钮，等待下载完成。系统仍可能回收缓存；长期记录请另存备份。</p><button id="site-offline-download" class="button button-outline" type="button">下载全部资料供离线复习</button><p id="site-offline-status" role="status"></p></section><section><h3>私有链接与解锁</h3><p>题库以密文发布，私有链接含解锁密钥。请保留自己的完整链接。换浏览器或清除网站数据后，粘贴私有链接即可重新解锁。</p><button id="site-copy-private-link" class="button button-outline" type="button">复制私有链接</button><p id="site-copy-status" role="status"></p><textarea id="site-private-link-fallback" readonly hidden rows="3" aria-label="私有链接，长按可复制" style="width:100%;font-size:16px;padding:12px"></textarea><button id="site-show-unlock" class="button button-outline" type="button">重新输入私有链接</button></section></div>`;
html=html.replace(/<div class="help-body">[\s\S]*?<\/div>\s*<p class="help-draft-note">[\s\S]*?<\/p>/,help+'<p class="help-draft-note">未保存草稿与已保存记录都位于当前浏览器；请定期下载备份。</p>');
await fs.writeFile(path.join(stage,'index.html'),html);
await fs.rm(path.join(stage,'assets/index.html'));
const bootstrap=(await fs.readFile(path.join(root,'client/bootstrap.js'),'utf8')).replaceAll('__SITE_BASE__',base).replaceAll('__SITE_VERSION__',version).replace('__SITE_SCRIPTS__',JSON.stringify([scripts[0],scripts[1],base+'vendor/jszip/jszip.min.js',base+'assets/browser-store.js',...scripts.slice(2)]));
await fs.writeFile(path.join(stage,'bootstrap.js'),bootstrap);
const worker=(await fs.readFile(path.join(root,'client/sw.js'),'utf8')).replaceAll('__SITE_BASE__',base).replaceAll('__SITE_VERSION__',version);
await fs.writeFile(path.join(stage,'sw.js'),worker);
const webmanifest={id:base,name:'复习中心',short_name:'复习中心',lang:'zh-CN',start_url:base,scope:base,display:'standalone',background_color:'#f1ece2',theme_color:'#f1ece2',icons:[192,512].map(size=>({src:`${base}assets/assets/icons/app-icon-${size}.png`,sizes:`${size}x${size}`,type:'image/png'}))};
await fs.writeFile(path.join(stage,'assets/manifest.webmanifest'),JSON.stringify(webmanifest));
await fs.writeFile(path.join(stage,'.nojekyll'),'');
for(const full of await files(stage)){const relative=path.relative(stage,full).split(path.sep).join('/');if(!relative.startsWith('secrets/')&&!['sw.js','.nojekyll'].includes(relative))manifest.static.push(relative);}
manifest.static.push('manifest.json');
await fs.writeFile(path.join(stage,'manifest.json'),JSON.stringify(manifest));
// Generated error copy must describe this edition, not the Windows service.
const appFile=path.join(stage,'assets/app.js');
let app=await fs.readFile(appFile,'utf8');
app=app.replace('暂时无法读取课程，请确认复习中心已启动。','暂时无法读取课程，请检查连接后重试。').replace('本地服务没有响应。请先打开「启动复习中心」，然后重试。','暂时无法读取资料，请检查网络或重新打开私有链接。').replaceAll('磁盘中的记录','浏览器中的记录').replaceAll('可能来自 Obsidian 或另一个窗口。','可能来自另一个窗口或恢复的备份。');
await fs.writeFile(appFile,app);
if(path.dirname(out)!==root)throw new Error('Unsafe output directory.');
await fs.rm(out,{recursive:true,force:true});await fs.rename(stage,out);
console.log(JSON.stringify({output:'site',base,version,subjects:manifest.books.length,encrypted_files:Object.keys(manifest.files).length}));
