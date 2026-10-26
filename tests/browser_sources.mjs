import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {chromium} from 'file:///C:/Users/ROG/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';

// Exercise only a generated copy and fresh browser profiles. No user note file
// or existing browser profile is read or written by this test.
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixture=path.join(root,'.runtime',`sources-browser-${Date.now()}`);
assert(fixture.startsWith(path.join(root,'.runtime')+path.sep));
const site=path.join(fixture,'site'),basePath='/study-center/';
const key=(await fs.readFile(path.join(root,'.private/key.txt'),'utf8')).trim();
const edge='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const checks=[],errors=[],externalRequests=[],badResponses=[],screenshots=[],measurements=[],adaptationMeasurements=[];
const originalImageRequests=new Set();
let server,browser,origin,base,currentPage;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const checked=text=>{checks.push(text);console.log('PASS: '+text);};
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.woff':'font/woff','.woff2':'font/woff2','.pdf':'application/pdf'};
async function serve(request,response){
  try{
    const pathname=new URL(request.url,'http://localhost').pathname;
    if(pathname===basePath.slice(0,-1)){response.writeHead(302,{Location:basePath});return response.end();}
    if(!pathname.startsWith(basePath)){response.writeHead(404);return response.end('Project path required');}
    const file=path.resolve(site,decodeURIComponent(pathname.slice(basePath.length))||'index.html');
    assert(file.startsWith(path.resolve(site)+path.sep));
    const content=await fs.readFile(file);
    response.writeHead(200,{'Content-Type':mime[path.extname(file).toLowerCase()]||'application/octet-stream','Cache-Control':'no-store'});response.end(content);
  }catch{response.writeHead(404);response.end('Not found');}
}
function watch(page){
  currentPage=page;page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
  page.on('request',request=>{
    if(!/^https?:/.test(request.url()))return;
    const url=new URL(request.url());
    if(url.origin!==origin)externalRequests.push(url.origin);
    if(url.origin===origin&&url.pathname.startsWith(basePath+'content/')&&/\.(png|jpe?g)$/i.test(url.pathname))originalImageRequests.add(url.pathname);
  });
  page.on('response',response=>{if(response.status()>=400)badResponses.push(`${response.status()} ${new URL(response.url()).pathname}`);});
}
async function until(check,message,timeout=30000){const start=Date.now();while(Date.now()-start<timeout){if(await check())return;await delay(70);}throw Error(message);}
async function unlock(page,forceTablet=false){
  await page.goto('about:blank');await page.goto(base+(forceTablet?'?layout=tablet':'')+'#key='+encodeURIComponent(key));
  await page.waitForSelector('.course-card',{state:'attached',timeout:60000});
  await page.waitForFunction(()=>Boolean(navigator.serviceWorker.controller));
  assert(!page.url().includes('key='));
}
async function openCourse(page,sid){
  if(await page.evaluate(()=>document.body.dataset.view==='reader')){await page.locator('#back-home').click();await page.waitForFunction(()=>document.body.dataset.view==='home');}
  await page.locator('#open-courses').click();await page.locator('#course-dialog').waitFor({state:'visible'});
  await page.locator(`.course-card[data-course-id="${sid}"]`).click();
  await page.waitForFunction(sid=>app.active?.id===sid&&document.querySelectorAll('.question-card').length>0,sid);
}
async function readStates(page){return page.evaluate(async()=>{
  const result={};for(const book of await ReviewSite.getBooks())result[book.id]=(await(await fetch('/api/state/'+book.id)).json()).records;return result;
});}
async function controlStates(page){return page.locator('.question-card').evaluateAll(cards=>cards.map(card=>({qid:card.dataset.questionId,source:card.querySelector('.source-details')?.open??null,answer:card.querySelector('.answer-details').open,notes:!card.querySelector('.notes-editor').hidden})));}
async function noOverflow(page,label){
  const size=await page.evaluate(()=>({viewport:innerWidth,html:document.documentElement.scrollWidth,body:document.body.scrollWidth}));
  assert(size.html<=size.viewport+1&&size.body<=size.viewport+1,`${label}: ${JSON.stringify(size)}`);
}
async function allImagesLoaded(details){
  const images=details.locator('img.inline-source-image');
  await until(async()=>await images.count()>0,'inline original image nodes did not appear');
  // Offscreen fragments may correctly remain lazy. Scroll each into view before
  // asking the browser to prove its decoded pixels are available.
  for(let index=0;index<await images.count();index++){
    const image=images.nth(index);await image.scrollIntoViewIfNeeded();
    await until(async()=>image.evaluate(element=>element.complete&&element.naturalWidth>0),'inline original image did not load after scrolling into view');
  }
}
async function assertInlineGeometry(details,expectedRotation){
  const geometry=await details.locator('.inline-source-frame').first().evaluate(frame=>{
    const image=frame.querySelector('img'),box=frame.getBoundingClientRect(),img=image.getBoundingClientRect();
    return {rotation:Number(frame.dataset.rotation)||0,frame:{x:box.x,y:box.y,width:box.width,height:box.height,right:box.right,bottom:box.bottom},image:{x:img.x,y:img.y,right:img.right,bottom:img.bottom},natural:{width:image.naturalWidth,height:image.naturalHeight}};
  });
  assert.equal(((geometry.rotation%360)+360)%360,((expectedRotation%360)+360)%360);
  const rotated=Math.abs(expectedRotation)%180===90;
  const expectedRatio=rotated?geometry.natural.height/geometry.natural.width:geometry.natural.width/geometry.natural.height;
  assert(Math.abs(geometry.frame.width/geometry.frame.height-expectedRatio)<.025,`rotation changed fit ratio: ${JSON.stringify(geometry)}`);
  assert(geometry.image.x>=geometry.frame.x-2&&geometry.image.y>=geometry.frame.y-2&&geometry.image.right<=geometry.frame.right+2&&geometry.image.bottom<=geometry.frame.bottom+2, 'rotated source image clips outside its fit frame');
}
async function screenshot(page,name){const file=path.join(fixture,name);await page.screenshot({path:file});screenshots.push(file);}
async function assertBulkLayout(page,{name,twoRows=false,threeEqual=false}){
  await page.locator('.bulk-fold-controls').scrollIntoViewIfNeeded();
  const layout=await page.evaluate(()=>{
    const group=document.querySelector('.bulk-fold-controls'),rect=group.getBoundingClientRect();
    const controls={};for(const id of ['toggle-all-sources','toggle-all-answers','toggle-all-notes']){
      const button=document.getElementById(id),box=button.getBoundingClientRect(),style=getComputedStyle(button);
      controls[id]={x:box.x,y:box.y,right:box.right,bottom:box.bottom,width:box.width,height:box.height,clientWidth:button.clientWidth,scrollWidth:button.scrollWidth,fontSize:parseFloat(style.fontSize)};
    }
    return{viewport:innerWidth,group:{x:rect.x,right:rect.right,width:rect.width},controls};
  });
  assert(layout.group.x>=-1&&layout.group.right<=layout.viewport+1,`${name}: bulk group escapes viewport`);
  for(const [id,box]of Object.entries(layout.controls)){
    assert(box.width>=47.5&&box.height>=47.5,`${name}: ${id} is smaller than a 48px touch target: ${JSON.stringify(box)}`);
    assert(box.x>=layout.group.x-1&&box.right<=layout.group.right+1,`${name}: ${id} escapes its control group`);
    assert(box.fontSize>=12.9,`${name}: ${id} is too small to read`);
    assert(box.scrollWidth<=box.clientWidth+1,`${name}: ${id} label clips horizontally`);
  }
  const source=layout.controls['toggle-all-sources'],answer=layout.controls['toggle-all-answers'],notes=layout.controls['toggle-all-notes'];
  if(twoRows){
    assert(Math.abs(source.width-layout.group.width)<2,`${name}: original picture button should occupy its own row`);
    assert(source.bottom<=answer.y+1&&Math.abs(answer.y-notes.y)<1.5,`${name}: answer and notes must share the row after originals`);
    assert(answer.right<=notes.x+1&&Math.abs(answer.width-notes.width)<2,`${name}: answer and notes must occupy non-overlapping equal halves`);
  }
  if(threeEqual){
    assert(Math.abs(source.y-answer.y)<1.5&&Math.abs(source.y-notes.y)<1.5,`${name}: three controls should share a row`);
    assert(Math.max(source.width,answer.width,notes.width)-Math.min(source.width,answer.width,notes.width)<2,`${name}: three controls should have equal width`);
  }
  adaptationMeasurements.push({name,...layout});
}
async function assertFooterCollapse(page,name){
  const card=page.locator('.question-card[data-question-id="A30"]'),source=card.locator('.source-details'),summary=source.locator('summary');
  const before=await card.evaluate(element=>({answer:element.querySelector('.answer-details').open,notes:element.querySelector('.notes-editor').hidden}));
  if(!await source.evaluate(element=>element.open))await summary.click();
  await allImagesLoaded(source);assert.equal(await source.locator('img.inline-source-image').count(),4);
  const count=await summary.evaluate(element=>({value:element.dataset.imageCount,aria:element.getAttribute('aria-label'),display:getComputedStyle(element,'::after').display,content:getComputedStyle(element,'::after').content}));
  assert.equal(count.value,'4');assert.match(count.aria,/4\s*张/,'source summary should expose its real count accessibly');
  assert(count.display!=='none'&&/4\s*张/.test(count.content),'source summary should visibly show its real image count');
  const summaryBox=await summary.boundingBox();assert(summaryBox.height>=51.5,`${name}: source summary is below 52px`);
  const footer=source.locator('button.inline-source-collapse');await footer.scrollIntoViewIfNeeded();
  assert(await footer.isVisible(),`${name}: bottom collapse control is not visible`);
  const box=await footer.boundingBox();assert(box.width>=47.5&&box.height>=47.5,`${name}: bottom collapse is below 48px`);
  assert(box.x>=-1&&box.x+box.width<=(await page.viewportSize()).width+1,`${name}: bottom collapse escapes viewport`);
  if(name==='手机393'||name==='平板540')await screenshot(page,name+'_长图底部收起.png');
  await footer.click();await until(async()=>!await source.evaluate(element=>element.open),`${name}: footer did not fold pictures`);
  await until(async()=>summary.evaluate(element=>document.activeElement===element),`${name}: folding did not focus the summary`);
  await until(async()=>summary.evaluate(element=>{
    const box=element.getBoundingClientRect(),bar=document.querySelector('.route-bar').getBoundingClientRect();
    return box.top>=Math.max(0,bar.bottom)-2&&box.bottom<=innerHeight+1;
  }),`${name}: folding did not return the source summary below the sticky navigation`);
  assert.deepEqual(await card.evaluate(element=>({answer:element.querySelector('.answer-details').open,notes:element.querySelector('.notes-editor').hidden})),before,`${name}: footer changed answer or notes folding`);
  await noOverflow(page,name);
  if(name==='手机393'||name==='平板540')await screenshot(page,name+'_收起后定位.png');
}

await fs.mkdir(fixture,{recursive:true});await fs.cp(path.join(root,'site'),site,{recursive:true});
try{
  server=http.createServer((request,response)=>{serve(request,response);});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  origin=`http://localhost:${server.address().port}`;base=origin+basePath;
  browser=await chromium.launch({executablePath:edge,headless:true});
  const context=await browser.newContext({viewport:{width:1400,height:984},screen:{width:1400,height:984},deviceScaleFactor:1.5,isMobile:true,hasTouch:true,reducedMotion:'reduce'});
  const page=await context.newPage();watch(page);await unlock(page);
  const before=await readStates(page),books=await page.evaluate(()=>ReviewSite.getBooks());
  await openCourse(page,'linear-algebra-2026-autumn');
  assert.equal(await page.locator('.source-details[open]').count(),0,'original images should start folded');
  assert.equal(originalImageRequests.size,0,'folded originals should not load the whole picture library');
  assert(await page.locator('#toggle-all-sources').isVisible());
  checked('原图默认折叠，打开课程没有预先加载原题照片，批量原图按钮可用');

  const card=page.locator('.question-card[data-question-id="A01"]'),details=card.locator('.source-details');
  const independentBefore=await controlStates(page);
  await details.locator('summary').click();await allImagesLoaded(details);
  assert.equal(await page.locator('#source-dialog').evaluate(dialog=>dialog.open),false,'inline source must not be a modal');
  assert(await details.evaluate(element=>Boolean(element.compareDocumentPosition(element.closest('.question-card').querySelector('.answer-details'))&Node.DOCUMENT_POSITION_FOLLOWING)),'inline originals must precede answer');
  assert.equal(await card.locator('.answer-details').evaluate(element=>element.open),independentBefore.find(row=>row.qid==='A01').answer);
  assert.equal(await card.locator('.notes-editor').evaluate(element=>element.hidden),true);
  await assertInlineGeometry(details,-90);
  await page.evaluate(()=>{const sources=document.querySelector('.question-card[data-question-id="A01"] .source-details');window.scrollTo({top:scrollY+sources.getBoundingClientRect().bottom-innerHeight*.55,behavior:'instant'});});
  await delay(150);await screenshot(page,'平板_原图与解析同页.png');
  const imageAndAnswer=await card.evaluate(element=>({image:element.querySelector('.inline-source-image').getBoundingClientRect().bottom,answer:element.querySelector('.answer-details').getBoundingClientRect().top,height:innerHeight}));
  assert(imageAndAnswer.image>150&&imageAndAnswer.answer<imageAndAnswer.height,'a scroll position must show original image and answer together');
  checked('单题展开后原图与解析位于同一页面，可继续往下阅读，−90°原图方向与完整比例正确');

  await card.locator('.source-link').first().click();await page.locator('#source-dialog').waitFor({state:'visible'});
  assert.equal(await page.locator('#source-dialog .source-frame').count(),1);
  await page.locator('#source-dialog .dialog-close').click();
  assert.equal(await details.evaluate(element=>element.open),true);
  await details.locator('summary').click();assert.equal(await details.evaluate(element=>element.open),false);
  checked('原有放大原图弹窗继续可用，关闭弹窗保留页内展开状态，单题可再次收起');

  const firstTitle=books.find(book=>book.id==='linear-algebra-2026-autumn').questions.find(question=>question.id==='A01').title;
  await page.locator('#search-input').fill(firstTitle);
  await until(async()=>page.locator('.question-card:not([hidden])').count().then(count=>count>0&&count<82),'search should produce a subset');
  const preBulk=await controlStates(page);
  await page.locator('#toggle-all-sources').click();
  const bulk=await page.locator('.question-card').evaluateAll(cards=>cards.map(card=>({hidden:card.hidden,open:card.querySelector('.source-details')?.open??null})));
  assert(bulk.filter(row=>!row.hidden&&row.open!==null).every(row=>row.open));
  assert(bulk.filter(row=>row.hidden&&row.open!==null).every(row=>!row.open),'bulk originals changed filtered-out questions');
  const afterSource=await controlStates(page);
  assert.deepEqual(afterSource.map(({answer,notes})=>({answer,notes})),preBulk.map(({answer,notes})=>({answer,notes})));
  await page.locator('#toggle-all-answers').click();await page.locator('#toggle-all-notes').click();
  assert.deepEqual((await controlStates(page)).map(row=>row.source),afterSource.map(row=>row.source),'answers/notes controls changed originals');
  await page.locator('#toggle-all-sources').click();
  assert.equal(await page.locator('.source-details[open]').count(),0);
  await page.locator('#search-input').fill('');await until(async()=>await page.locator('.question-card:not([hidden])').count()===82,'reset search');
  checked('原图批量开合只作用当前筛选题目，并与答案、笔记的开合完全独立');

  for(const sample of [{sid:'linear-algebra-2026-autumn',qid:'A30',count:4,rotation:null},{sid:'digital-electronics-2026-autumn',qid:'DE001',count:2,rotation:null},{sid:'theoretical-mechanics-2026-autumn',qid:'TM004',count:1,rotation:90}]){
    await openCourse(page,sample.sid);const source=page.locator(`.question-card[data-question-id="${sample.qid}"] .source-details`);
    await source.locator('summary').click();await allImagesLoaded(source);assert.equal(await source.locator('img.inline-source-image').count(),sample.count);
    const urls=await source.locator('img.inline-source-image').evaluateAll(images=>images.map(image=>image.src));assert.equal(new Set(urls).size,urls.length);
    if(sample.rotation!==null)await assertInlineGeometry(source,sample.rotation);
  }
  await openCourse(page,'linear-algebra-2026-autumn');
  for(const qid of ['D01','D02','D03'])assert.equal(await page.locator(`.question-card[data-question-id="${qid}"] .source-details`).count(),0,'text-only source should not become an empty image disclosure');
  checked('多页与分片原图全部展示且不重复，+90°旋转正确，无图片的文字来源不会显示空折叠区');

  const first=page.locator('.question-card[data-question-id="A01"] .source-details');if(!await first.evaluate(element=>element.open))await first.locator('summary').click();
  await allImagesLoaded(first);
  for(const viewport of [{width:1400,height:984},{width:984,height:1400},{width:700,height:900}]){
    await page.setViewportSize(viewport);await delay(200);await noOverflow(page,`tablet ${viewport.width}`);
    await first.locator('summary').scrollIntoViewIfNeeded();
    const box=await first.boundingBox();assert(box.width<=viewport.width+1);
    measurements.push({...viewport,sourceWidth:box.width});
  }
  await screenshot(page,'平板竖屏_页内原图.png');
  for(const device of [{name:'手机',viewport:{width:393,height:852},touch:true},{name:'桌面',viewport:{width:1440,height:1000},touch:false}]){
    const ctx=await browser.newContext({viewport:device.viewport,screen:device.viewport,isMobile:device.touch,hasTouch:device.touch,reducedMotion:'reduce'});
    const p=await ctx.newPage();watch(p);await unlock(p);await openCourse(p,'linear-algebra-2026-autumn');
    const source=p.locator('.question-card[data-question-id="A01"] .source-details');await source.locator('summary').click();await allImagesLoaded(source);await assertInlineGeometry(source,-90);await noOverflow(p,device.name);
    const controls=await p.locator('.bulk-fold-controls').evaluate(el=>{const box=el.getBoundingClientRect();return {x:box.x,right:box.right,width:innerWidth};});assert(controls.x>=-1&&controls.right<=controls.width+1);
    await screenshot(p,device.name+'_页内原图.png');await ctx.close();
  }
  const boundary=await browser.newContext({viewport:{width:1000,height:1100},reducedMotion:'reduce'}),boundaryPage=await boundary.newPage();watch(boundaryPage);await unlock(boundaryPage);
  // Mutate only this disposable page's in-memory book: the published files and
  // note database remain unchanged. Future imports can contain duplicate pages.
  await boundaryPage.evaluate(async()=>{const book=await ReviewSite.getBook('linear-algebra-2026-autumn');book.questions.find(question=>question.id==='A01').source_pages=[4,4,99999];});
  await openCourse(boundaryPage,'linear-algebra-2026-autumn');
  const boundaryCard=boundaryPage.locator('.question-card[data-question-id="A01"]'),boundarySources=boundaryCard.locator('.source-details');
  await boundarySources.locator('summary').click();await allImagesLoaded(boundarySources);
  assert.equal(await boundarySources.locator('img.inline-source-image').count(),1,'duplicate source page produced duplicate pictures');
  assert.equal(await boundaryCard.locator('.source-link:disabled').count(),1,'missing page metadata should be identified instead of an empty picture');
  await boundary.close();currentPage=page;
  assert.deepEqual(await readStates(page),before,'reading and folding original images must not change notes, flags, progress, or versions');
  checked('平板横竖屏、窄分屏、手机与桌面均无全局横溢出，重复或缺失页码安全处理，操作未改动任何复习记录');

  const phone=await browser.newContext({viewport:{width:393,height:852},screen:{width:393,height:852},isMobile:true,hasTouch:true,reducedMotion:'reduce'});
  const phonePage=await phone.newPage();watch(phonePage);await unlock(phonePage);await openCourse(phonePage,'linear-algebra-2026-autumn');
  const phoneBefore=await readStates(phonePage);
  for(const viewport of [{width:320,height:780},{width:360,height:820},{width:393,height:852}]){
    await phonePage.setViewportSize(viewport);await delay(150);
    const name='手机'+viewport.width;await assertBulkLayout(phonePage,{name,twoRows:true});
    if(viewport.width===393)await screenshot(phonePage,'手机393_两行批量按钮.png');
    await assertFooterCollapse(phonePage,name);
  }
  assert.deepEqual(await readStates(phonePage),phoneBefore,'phone folding changed a saved record');await phone.close();
  checked('320/360/393px手机原图按钮独占一行，答案笔记各半且至少48px，长图底部收起后焦点和位置回到图片标题');

  const adapted=await browser.newContext({viewport:{width:1400,height:984},screen:{width:1400,height:984},isMobile:true,hasTouch:true,reducedMotion:'reduce'});
  const adaptedPage=await adapted.newPage();watch(adaptedPage);await unlock(adaptedPage);await openCourse(adaptedPage,'linear-algebra-2026-autumn');
  const adaptedBefore=await readStates(adaptedPage);
  for(const viewport of [{width:1400,height:984},{width:984,height:1400},{width:700,height:900}]){
    await adaptedPage.setViewportSize(viewport);await delay(150);
    const name='平板'+viewport.width;await assertBulkLayout(adaptedPage,{name,twoRows:viewport.width<=760,threeEqual:viewport.width===1400});
    await assertFooterCollapse(adaptedPage,name);
  }
  assert.deepEqual(await readStates(adaptedPage),adaptedBefore,'tablet folding changed a saved record');await adapted.close();
  // A fresh narrow split window must work even when the Android browser sends
  // a desktop-like UA or reports a screen size different from its viewport.
  const split=await browser.newContext({viewport:{width:540,height:900},screen:{width:1400,height:984},isMobile:true,hasTouch:true,reducedMotion:'reduce'});
  const splitPage=await split.newPage();watch(splitPage);await unlock(splitPage,true);await openCourse(splitPage,'linear-algebra-2026-autumn');
  assert(await splitPage.evaluate(()=>document.documentElement.classList.contains('review-tablet')));
  const splitBefore=await readStates(splitPage);await assertBulkLayout(splitPage,{name:'平板540',twoRows:true});await screenshot(splitPage,'平板540_两行批量按钮.png');await assertFooterCollapse(splitPage,'平板540');
  assert.deepEqual(await readStates(splitPage),splitBefore,'narrow tablet folding changed a saved record');await split.close();currentPage=page;
  checked('平板1400px横屏三等份、984px竖屏及700/540px分屏控件不拥挤，48px触控与底部收起定位均正常且不改记录');

  assert.deepEqual(errors,[]);assert.deepEqual(externalRequests,[]);assert.deepEqual(badResponses,[]);
  const report={passed:true,engine:'Edge Chromium touch and desktop emulation',realDeviceVerified:false,checks,measurements,adaptationMeasurements,screenshots,pageErrors:errors,externalRequests,badResponses,fixture};
  await fs.writeFile(path.join(root,'.runtime/sources-browser-results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){if(currentPage)await currentPage.screenshot({path:path.join(fixture,'failure.png')}).catch(()=>{});throw error;}
finally{await browser?.close();await new Promise(resolve=>server?server.close(resolve):resolve());}
