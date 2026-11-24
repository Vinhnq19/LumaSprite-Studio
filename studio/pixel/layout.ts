/** View-only splitters. Sizes persist on this machine, never in project revisions. */
export function setupLayout():void {
  const main=document.querySelector('main')!,workspace=document.querySelector<HTMLElement>('.workspace')!,timeline=document.getElementById('timeline')!;
  const horizontal=document.getElementById('timeline-splitter')!,vertical=document.getElementById('sidebar-splitter')!;
  const width=document.getElementById('sidebar-width')! as HTMLInputElement;
  const inspector = document.getElementById('properties')!, toggle = document.getElementById('inspector-toggle')!;
  toggle.addEventListener('click', () => {
    inspector.hidden = !inspector.hidden;
    vertical.hidden = inspector.hidden;
    workspace.classList.toggle('inspector-collapsed', inspector.hidden);
    toggle.setAttribute('aria-expanded', String(!inspector.hidden));
  });
  const storage='pxl.pixel.timeline-height';let requested=210;
  try{const saved=Number(localStorage.getItem(storage));if(Number.isFinite(saved)&&saved>=64)requested=saved;}catch{/* Defaults also work without storage. */}
  const clamp=(n:number,min:number,max:number)=>Math.max(min,Math.min(max,n));
  const timelineMax=()=>Math.max(64,main.clientHeight-160-horizontal.offsetHeight-['.canvas-toolbar','.timeline-toolbar','footer'].reduce((h,s)=>h+(main.querySelector<HTMLElement>(s)?.offsetHeight??0),0));
  const sidebarMax=()=>Math.max(280,Math.min(Number(width.max),workspace.clientWidth-document.querySelector<HTMLElement>('.tools-panel')!.offsetWidth-(innerWidth<=1100?300:360)-vertical.offsetWidth));
  function aria(handle:HTMLElement,min:number,max:number,value:number):void{handle.setAttribute('aria-valuemin',String(min));handle.setAttribute('aria-valuemax',String(Math.round(max)));handle.setAttribute('aria-valuenow',String(Math.round(value)));handle.setAttribute('aria-valuetext',`${Math.round(value)} pixel`);}
  function apply():void{const size=clamp(requested,64,timelineMax());timeline.style.height=`${size}px`;aria(horizontal,64,timelineMax(),size);aria(vertical,280,sidebarMax(),document.querySelector<HTMLElement>('.properties')!.offsetWidth);}
  function save():void{try{localStorage.setItem(storage,String(requested));}catch{/* Optional preference. */}}
  function setTimeline(value:number):void{requested=clamp(value,64,timelineMax());apply();}
  function setSidebar(value:number):void{width.value=String(clamp(Math.round(value/10)*10,280,sidebarMax()));width.dispatchEvent(new Event('input',{bubbles:true}));apply();}
  function splitter(handle:HTMLElement,axis:'x'|'y',get:()=>number,set:(n:number)=>void,max:()=>number,min:number,reset:number):void {
    let drag:{id:number;start:number;size:number}|undefined;
    const finish=()=>{if(!drag)return;const id=drag.id;drag=undefined;if(handle.hasPointerCapture(id))handle.releasePointerCapture(id);delete document.body.dataset.resizing;handle.classList.remove('dragging');save();};
    handle.addEventListener('pointerdown',e=>{if(e.button!==0)return;e.preventDefault();handle.focus();drag={id:e.pointerId,start:axis==='x'?e.clientX:e.clientY,size:get()};handle.setPointerCapture(e.pointerId);document.body.dataset.resizing=axis;handle.classList.add('dragging');});
    handle.addEventListener('pointermove',e=>{if(drag&&e.pointerId===drag.id)set(drag.size+drag.start-(axis==='x'?e.clientX:e.clientY));});
    handle.addEventListener('pointerup',finish);handle.addEventListener('pointercancel',finish);handle.addEventListener('lostpointercapture',finish);window.addEventListener('blur',finish);
    document.addEventListener('visibilitychange',()=>{if(document.hidden)finish();});
    handle.addEventListener('dblclick',()=>{set(reset);save();});
    handle.addEventListener('keydown',e=>{
      const increase=axis==='x'?'ArrowLeft':'ArrowUp',decrease=axis==='x'?'ArrowRight':'ArrowDown';let value:number;
      if(e.key===increase)value=get()+(e.shiftKey?50:10);else if(e.key===decrease)value=get()-(e.shiftKey?50:10);else if(e.key==='Home')value=min;else if(e.key==='End')value=max();else if(e.key==='Enter')value=reset;else return;
      e.preventDefault();e.stopPropagation();set(value);save();
    });
  }
  splitter(horizontal,'y',()=>timeline.offsetHeight,setTimeline,timelineMax,64,210);
  splitter(vertical,'x',()=>document.querySelector<HTMLElement>('.properties')!.offsetWidth,setSidebar,sidebarMax,280,360);
  width.addEventListener('input',apply);document.getElementById('appearance-reset')!.addEventListener('click',()=>{requested=210;apply();save();});
  new ResizeObserver(apply).observe(main);apply();
}
