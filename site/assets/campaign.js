/* Geography stays fixed; reclaimed visible area follows saved / total. */
(() => {
  'use strict';
  const $=id=>document.getElementById(id), NS='http://www.w3.org/2000/svg';
  const dialog=$('campaign-dialog');if(!dialog||!$('campaign-open'))return;
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  let data=null,snapshot=window.reviewProgressSnapshot||{total:0,savedReviewed:0,pendingReviewed:0};
  let previousFocus,openingView,feedbackTimer=0,feedbackAnimation,sealAnimation;
  let frame=0,shownRatio=0,targetRatio=0,drag=null,dragged=false,pinch=null;
  let crossedMilestones=[];
  const drawings=[],earnedThisVisit=new Set(),pointers=new Map();
  const atlas={x:0,y:0,width:960,height:760,zoom:1};
  const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
  const total=()=>Math.max(0,Number(snapshot.total)||0), committed=()=>Math.max(0,Number(snapshot.savedReviewed)||0);
  const ratio=()=>total()>0?clamp(committed()/total(),0,1):0;
  const percent=v=>`${(v*100).toFixed(1)}%`;
  const needed=m=>Math.ceil(total()*m.threshold-1e-10);
  const unlocked=m=>total()>0&&m.threshold<=ratio()+1e-12;
  function svgNode(tag,attrs={},value){
    const n=document.createElementNS(NS,tag);for(const[k,v]of Object.entries(attrs))n.setAttribute(k,String(v));
    if(value!==undefined)n.textContent=value;return n;
  }
  function polygonArea(poly){
    let sum=0;for(let i=0,j=poly.length-1;i<poly.length;j=i++)sum+=poly[j][0]*poly[i][1]-poly[i][0]*poly[j][1];return Math.abs(sum)/2;
  }
  // Every supplied piece is convex and hole-free, so a half-plane clip is exact.
  function areaBelow(cell,y){
    let sum=0;
    for(const poly of cell.pieces){
      const points=[];let prev=poly[poly.length-1];
      for(const curr of poly){
        if((prev[1]>=y)!==(curr[1]>=y)){const t=(y-prev[1])/(curr[1]-prev[1]);points.push([prev[0]+t*(curr[0]-prev[0]),y]);}
        if(curr[1]>=y)points.push(curr);prev=curr;
      }
      if(points.length>2)sum+=polygonArea(points);
    }return sum;
  }
  function frontier(cell,wanted){
    let low=cell.minY,high=cell.maxY;
    for(let i=0;i<42;i++){const mid=(low+high)/2;if(areaBelow(cell,mid)>wanted)low=mid;else high=mid;}
    const y=(low+high)/2;return{y,area:areaBelow(cell,y)};
  }
  function buildMap(svg,mini){
    svg.replaceChildren();svg.setAttribute('viewBox',data.viewBox);
    const defs=svgNode('defs'),clipId=`${svg.id}-land`,partialId=`${svg.id}-frontier`;
    const clip=svgNode('clipPath',{id:clipId});clip.append(svgNode('path',{d:data.landPath}));
    const partial=svgNode('clipPath',{id:partialId,clipPathUnits:'userSpaceOnUse'});
    const partialRect=svgNode('rect',{x:0,y:760,width:960,height:0});partial.append(partialRect);defs.append(clip,partial);svg.append(defs);
    const content=svgNode('g',{'clip-path':`url(#${clipId})`});content.append(svgNode('path',{d:data.landPath,class:'campaign-land-outline'}));
    const territories=svgNode('g'),fills=svgNode('g',{'pointer-events':'none'}),outlines=svgNode('g',{'pointer-events':'none',class:'campaign-cell-outlines'}),labels=svgNode('g',{'pointer-events':'none',class:'campaign-place-labels'});
    const cells=data.cells.map(cell=>{
      const path=svgNode('path',{d:cell.path,class:'campaign-territory','data-cell-index':cell.ordinal-1,'data-place-id':cell.id,'fill-rule':'evenodd'});
      path.append(svgNode('title',{},`${cell.name} · 1080 年治所\n${cell.lon.toFixed(3)}°E，${cell.lat.toFixed(3)}°N`));territories.append(path);
      const fill=svgNode('path',{d:cell.path,class:'campaign-reclaimed','fill-rule':'evenodd',display:'none'});fills.append(fill);
      const outline=svgNode('path',{d:cell.path,'fill-rule':'evenodd'});outlines.append(outline);
      const label=svgNode('g',{class:'campaign-place','data-place-label':cell.id});label.append(svgNode('circle',{cx:cell.x,cy:cell.y,r:1.8}),svgNode('text',{x:cell.x+4,y:cell.y-4},cell.name));labels.append(label);
      return{path,fill,outline,label,cell,state:''};
    });
    content.append(territories,fills,outlines,svgNode('path',{d:data.basePath,class:'campaign-base','pointer-events':'none'}));
    const rivers=svgNode('g',{class:'campaign-rivers','pointer-events':'none'});for(const r of data.rivers||[])rivers.append(svgNode('path',{d:r.path}));
    content.append(rivers);svg.append(content,labels);
    const compass=svgNode('g',{class:'campaign-compass','aria-hidden':'true','pointer-events':'none'});
    compass.append(svgNode('path',{d:'M860 116V63M848 78L860 62L872 78'}),svgNode('text',{x:860,y:48,'text-anchor':'middle'},'北'));svg.append(compass);
    drawings.push({svg,cells,partialRect,partialId,mini});
  }
  function labelLayout(drawing){
    const zoom=drawing.mini?1:atlas.zoom,font=drawing.mini?24:17/Math.sqrt(zoom),occupied=[];
    const candidates=[...drawing.cells].sort((a,b)=>(a.cell.priority??9)-(b.cell.priority??9)||b.cell.area-a.cell.area);let visible=0;
    for(const{cell,label}of candidates){
      const box={x:cell.x+3,y:cell.y-font-4,w:cell.name.length*font+8,h:font+7};
      const inView=drawing.mini||(box.x+box.w>=atlas.x&&box.x<=atlas.x+atlas.width&&box.y+box.h>=atlas.y&&box.y<=atlas.y+atlas.height);
      const collision=occupied.some(b=>box.x<b.x+b.w&&box.x+box.w>b.x&&box.y<b.y+b.h&&box.y+box.h>b.y);
      const show=inView&&(zoom>=4||!collision)&&(!drawing.mini||visible<9);
      label.style.display=show?'':'none';label.querySelector('text').style.fontSize=`${font}px`;label.querySelector('circle').setAttribute('r',String(1.8/Math.sqrt(zoom)));
      if(show){occupied.push(box);visible++;}
    }
  }
  function paint(value){
    if(!data)return;
    const target=value*data.totalLostArea;let covered=0,partialCell=null,boundary=null;
    for(const cell of data.cells){
      if(target>=covered+cell.area-1e-9)covered+=cell.area;
      else{if(target>covered+1e-9){partialCell=cell;boundary=frontier(cell,target-covered);covered+=boundary.area;}break;}
    }
    for(const drawing of drawings){
      let cumulative=0;
      for(const entry of drawing.cells){
        const{cell,path,fill,label}=entry;
        const state=target>=cumulative+cell.area-1e-9?'full':cell===partialCell?'partial':'empty';
        if(state!==entry.state){
          path.classList.toggle('is-recovered',state==='full');path.classList.toggle('is-frontier',state==='partial');label.classList.toggle('is-opened',state!=='empty');
          fill.setAttribute('display',state==='empty'?'none':'inline');if(state==='partial')fill.setAttribute('clip-path',`url(#${drawing.partialId})`);else fill.removeAttribute('clip-path');entry.state=state;
        }cumulative+=cell.area;
      }
      if(boundary){drawing.partialRect.setAttribute('y',String(boundary.y));drawing.partialRect.setAttribute('height',String(760-boundary.y));}
      drawing.svg.dataset.progress=String(value);drawing.svg.dataset.recoveredArea=String(covered);drawing.svg.dataset.totalLostArea=String(data.totalLostArea);
      drawing.svg.setAttribute('aria-label',`山河复归示意图：已保存复习 ${committed()} / ${total()} 题，收复初始失土的 ${percent(value)}；地名为1080年历史治所。`);
    }
  }
  function updateArea(value,immediate=false){
    if(!data||value===targetRatio&&!immediate)return;
    cancelAnimationFrame(frame);targetRatio=value;
    if(immediate||reduced.matches||!dialog.open){shownRatio=value;paint(value);return;}
    const from=shownRatio,start=performance.now();
    const step=now=>{const t=clamp((now-start)/480,0,1);shownRatio=from+(value-from)*(1-Math.pow(1-t,3));paint(shownRatio);if(t<1)frame=requestAnimationFrame(step);};frame=requestAnimationFrame(step);
  }
  function buildMilestones(){
    $('campaign-milestones').replaceChildren();
    for(const m of data.milestones){
      const item=document.createElement('li');item.className='campaign-milestone';item.dataset.threshold=String(m.threshold);
      const seal=document.createElement('span');seal.className='campaign-milestone-seal';seal.textContent=m.seal||'捷';seal.setAttribute('aria-hidden','true');
      const copy=document.createElement('div');copy.className='campaign-milestone-copy';
      const threshold=document.createElement('span');threshold.className='campaign-milestone-threshold';
      const title=document.createElement('h4');title.textContent=m.title;
      const verse=document.createElement('blockquote');verse.className='campaign-milestone-verse';verse.textContent=m.poem||'';
      copy.append(threshold,title,verse);item.append(seal,copy);$('campaign-milestones').append(item);
      Object.assign(m,{element:item,thresholdElement:threshold,verseElement:verse});
    }
  }
  function render(){
    const count=committed(),p=ratio();$('campaign-reviewed-count').textContent=String(count);$('campaign-large-count').textContent=String(count);
    $('campaign-territory-count').textContent=`${count} / ${total()} 题 · 收复 ${percent(p)}`;
    const pending=Number(snapshot.pendingReviewed)||0;$('campaign-pending-status').textContent=pending?`${pending} 题完成状态待保存，保存后更新疆图。`:'';
    const next=data?.milestones.find(m=>!unlocked(m));
    $('campaign-next-milestone').textContent=!data?'正在展开地图':!total()?'添加课程后启程':next?`${percent(p)} · 下封军报还差 ${Math.max(0,needed(next)-count)} 题`:'100% · 山河已复';
    $('campaign-reader-label').textContent=`全科已复习 ${count} / ${total()} 题 · ${percent(p)}${next?` · 下封军报还差 ${Math.max(0,needed(next)-count)} 题`:''}`;
    $('campaign-reader-fill').style.width=`${p*100}%`;
    if(data){updateArea(p);for(const m of data.milestones){const open=unlocked(m);m.element.classList.toggle('is-unlocked',open);
      m.thresholdElement.textContent=`${Math.round(m.threshold*100)}% · ${total()?`当前 ${needed(m)} 题`:'待添加课程'}`;
      m.verseElement.hidden=!open;
    }}
  }
  function selectPlace(cell){
    for(const drawing of drawings)for(const entry of drawing.cells){entry.path.classList.toggle('is-selected',entry.cell.id===cell.id);entry.outline.classList.toggle('is-selected',entry.cell.id===cell.id);}
    const info=$('campaign-place-info');info.replaceChildren();const name=document.createElement('strong');name.textContent=cell.name;
    info.append(name,document.createTextNode(` · 1080 年治所 · ${cell.lon.toFixed(3)}°E，${cell.lat.toFixed(3)}°N `));
    const link=document.createElement('a');link.textContent='CHGIS 记录 ↗';link.href=cell.source_url||'https://chgis.fas.harvard.edu/';link.target='_blank';link.rel='noopener';info.append(link);
  }
  function syncViewport(){
    atlas.width=960/atlas.zoom;atlas.height=760/atlas.zoom;atlas.x=clamp(atlas.x,0,960-atlas.width);atlas.y=clamp(atlas.y,0,760-atlas.height);
    $('campaign-map').setAttribute('viewBox',`${atlas.x} ${atlas.y} ${atlas.width} ${atlas.height}`);$('campaign-zoom-value').textContent=`${Math.round(atlas.zoom*100)}%`;
    $('campaign-zoom-out').disabled=atlas.zoom<=1;$('campaign-zoom-in').disabled=atlas.zoom>=5;const large=drawings.find(d=>!d.mini);if(large)labelLayout(large);
  }
  function zoomTo(value,anchor={x:atlas.x+atlas.width/2,y:atlas.y+atlas.height/2}){
    const z=clamp(value,1,5),factor=atlas.zoom/z;atlas.x=anchor.x-(anchor.x-atlas.x)*factor;atlas.y=anchor.y-(anchor.y-atlas.y)*factor;atlas.zoom=z;syncViewport();
  }
  const map=$('campaign-map');
  const mapPoint=event=>{const m=map.getScreenCTM();return m?new DOMPoint(event.clientX,event.clientY).matrixTransform(m.inverse()):{x:480,y:380};};
  $('campaign-zoom-in').addEventListener('click',()=>zoomTo(atlas.zoom*1.5));$('campaign-zoom-out').addEventListener('click',()=>zoomTo(atlas.zoom/1.5));
  $('campaign-zoom-reset').addEventListener('click',()=>{Object.assign(atlas,{x:0,y:0,zoom:1});syncViewport();});map.setAttribute('tabindex','0');
  map.addEventListener('keydown',e=>{
    if(e.key==='+'||e.key==='='){e.preventDefault();zoomTo(atlas.zoom*1.5);}else if(e.key==='-'){e.preventDefault();zoomTo(atlas.zoom/1.5);}
    else if(e.key==='0'){Object.assign(atlas,{x:0,y:0,zoom:1});syncViewport();}
    else if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();atlas.x+=(e.key==='ArrowLeft'?-1:e.key==='ArrowRight'?1:0)*atlas.width*.12;atlas.y+=(e.key==='ArrowUp'?-1:e.key==='ArrowDown'?1:0)*atlas.height*.12;syncViewport();}
  });
  map.addEventListener('wheel',e=>{if(e.ctrlKey||e.metaKey){e.preventDefault();zoomTo(atlas.zoom*Math.exp(-e.deltaY*.002),mapPoint(e));}},{passive:false});
  map.addEventListener('pointerdown',e=>{
    if(e.button!==0)return;if(!pointers.size)dragged=false;pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
    drag={id:e.pointerId,x:e.clientX,y:e.clientY,startX:atlas.x,startY:atlas.y};
    if(pointers.size===2){const[a,b]=[...pointers.values()];pinch={distance:Math.hypot(a.x-b.x,a.y-b.y),zoom:atlas.zoom,anchor:mapPoint({clientX:(a.x+b.x)/2,clientY:(a.y+b.y)/2})};}
    map.setPointerCapture(e.pointerId);
  });
  map.addEventListener('pointermove',e=>{
    if(!pointers.has(e.pointerId))return;pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(pinch&&pointers.size===2){const[a,b]=[...pointers.values()];dragged=true;zoomTo(pinch.zoom*Math.hypot(a.x-b.x,a.y-b.y)/pinch.distance,pinch.anchor);return;}
    if(drag&&drag.id===e.pointerId&&atlas.zoom>1){const dx=e.clientX-drag.x,dy=e.clientY-drag.y;if(Math.hypot(dx,dy)>4)dragged=true;const scale=map.getScreenCTM()?.a||1;atlas.x=drag.startX-dx/scale;atlas.y=drag.startY-dy/scale;syncViewport();map.classList.toggle('is-dragging',dragged);}
  });
  const endPointer=e=>{
    pointers.delete(e.pointerId);const wasPinching=!!pinch;pinch=null;
    if(wasPinching)dragged=true;
    if(pointers.size===1){const[id,point]=[...pointers.entries()][0];drag={id,x:point.x,y:point.y,startX:atlas.x,startY:atlas.y};}
    else if(!pointers.size)drag=null;map.classList.remove('is-dragging');
    if(e.type==='pointerup'&&!dragged){const el=document.elementFromPoint(e.clientX,e.clientY)?.closest('[data-place-id]'),cell=data?.cells.find(c=>c.id===el?.dataset.placeId);if(cell)selectPlace(cell);}
    setTimeout(()=>{if(!pointers.size)dragged=false;},0);
  };map.addEventListener('pointerup',endPointer);map.addEventListener('pointercancel',endPointer);
  function openMap(){
    if(dialog.open)return;previousFocus=document.activeElement;openingView=document.body.dataset.view;dialog.showModal();document.body.classList.add('campaign-is-open');
    $('campaign-open').setAttribute('aria-expanded','true');$('campaign-reader-open').setAttribute('aria-expanded','true');$('campaign-close').focus({preventScroll:true});document.dispatchEvent(new CustomEvent('review:overlay-change'));
  }
  function closeMap(){if(dialog.open)dialog.close();}
  $('campaign-open').addEventListener('click',openMap);$('campaign-reader-open').addEventListener('click',openMap);$('campaign-close').addEventListener('click',closeMap);
  dialog.addEventListener('close',()=>{
    document.body.classList.remove('campaign-is-open');pointers.clear();drag=null;pinch=null;$('campaign-open').setAttribute('aria-expanded','false');$('campaign-reader-open').setAttribute('aria-expanded','false');
    if(document.body.dataset.view===openingView&&previousFocus?.isConnected&&previousFocus.getBoundingClientRect().width)previousFocus.focus({preventScroll:true});document.dispatchEvent(new CustomEvent('review:overlay-change'));
  });
  function hideFeedback(){clearTimeout(feedbackTimer);feedbackAnimation?.cancel();sealAnimation?.cancel();$('campaign-feedback').hidden=true;}
  $('campaign-feedback-close').addEventListener('click',hideFeedback);$('campaign-feedback-open').addEventListener('click',()=>{hideFeedback();openMap();});
  function celebrate(){
    if(!data||!total()||!committed())return;const newly=crossedMilestones.filter(m=>unlocked(m)&&!earnedThisVisit.has(m.id));newly.forEach(m=>earnedThisVisit.add(m.id));crossedMilestones=[];const milestone=newly[newly.length-1];
    $('campaign-feedback').classList.toggle('is-milestone',!!milestone);$('campaign-feedback-seal').textContent=milestone?.seal||'复';$('campaign-feedback-title').textContent=milestone?`军报 · ${milestone.title}`:`又进一步 · ${percent(ratio())}`;
    $('campaign-feedback-text').textContent=milestone?milestone.poem||milestone.text:`本题已归档，全科已复习 ${committed()} / ${total()} 题。`;
    const feedback=$('campaign-feedback'),wasHidden=feedback.hidden,style=wasHidden?null:getComputedStyle(feedback),opacity=wasHidden?0:parseFloat(style.opacity),translate=wasHidden?'0 12px':style.translate==='none'?'0 0':style.translate;
    feedbackAnimation?.cancel();sealAnimation?.cancel();feedback.hidden=false;
    if(!reduced.matches){feedbackAnimation=feedback.animate([{opacity,translate},{opacity:1,translate:'0 0'}],{duration:240,easing:'cubic-bezier(.2,.8,.2,1)'});feedbackAnimation.finished.catch(()=>{});if(milestone){sealAnimation=$('campaign-feedback-seal').animate([{opacity:.4,scale:'1.16'},{opacity:1,scale:'1'}],{duration:320,easing:'cubic-bezier(.22,1,.36,1)'});sealAnimation.finished.catch(()=>{});}}
    clearTimeout(feedbackTimer);feedbackTimer=setTimeout(hideFeedback,milestone?8500:4500);
  }
  document.addEventListener('review:progress',e=>{const before=ratio();snapshot=e.detail;crossedMilestones=data?data.milestones.filter(m=>m.threshold>before+1e-12&&unlocked(m)):[];render();});document.addEventListener('review:question-completed',celebrate);
  document.addEventListener('review:view-change',()=>{if(dialog.open)closeMap();hideFeedback();});reduced.addEventListener('change',()=>updateArea(ratio(),true));
  fetch('/study-center/assets/campaign-data.json',{cache:'no-cache'}).then(r=>{if(!r.ok)throw Error('map-unavailable');return r.json();}).then(source=>{
    if(source.version!==2||!source.cells?.length||!source.totalLostArea||!source.milestones?.length)throw Error('map-invalid');data=source;
    for(const cell of data.cells){const ys=cell.pieces.flatMap(p=>p.map(pt=>pt[1]));cell.minY=Math.min(...ys);cell.maxY=Math.max(...ys);}
    buildMap($('campaign-mini-map'),true);buildMap(map,false);buildMilestones();drawings.forEach(labelLayout);syncViewport();updateArea(ratio(),true);
    for(const m of data.milestones)if(unlocked(m))earnedThisVisit.add(m.id);render();
  }).catch(()=>{$('campaign-next-milestone').textContent='地图暂未载入，刷新后再试';$('campaign-pending-status').textContent='复习记录仍保存在本机文件中。';});render();
})();
