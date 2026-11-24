import { api, type Session } from './session.ts';
import type { ArtDirectionFormController } from './art-direction-form.ts';
import type { FigureSample, FigureStage } from '../../src/studio/pixel/figure-review.ts';
import { exampleCharacterPose, poseGuide, validateCharacterPose } from '../../src/studio/pixel/character-pose.ts';

export async function openFigureReview(session:Session, form:ArtDirectionFormController, brief:string) {
  await session.flush();
  if(!session.doc||!session.asset) throw Error('Chọn asset làm khung vẽ.');
  const project=session.doc.id, revision=session.doc.revision, assetId=session.asset.id, path=session.path;
  const {w:canvasW,h:canvasH}=session.asset;
  const poseSupported=Math.min(canvasW,canvasH)>=32&&Math.max(canvasW,canvasH)<=128;
  const options=form.getGenerationOptions(), art=form.getArtDirection();
  const dialog=document.createElement('dialog');
  dialog.style.cssText='max-width:92vw;max-height:90vh;overflow:auto';
  dialog.innerHTML=`<h2>Duyệt dáng nhân vật</h2>
  <label>Đề bài <textarea data-brief></textarea></label>
  <label>Dáng và thế chịu lực <input data-pose maxlength="300" placeholder="Theo đề bài"></label>
  <label>Tỷ lệ nhân vật <input data-proportions maxlength="300" placeholder="Theo đề bài hoặc mẫu"></label>
  <details data-planning><summary>Lập kế hoạch bằng mốc dáng</summary>
    <label><input type="checkbox" data-use-pose> Dùng PoseSpec cho lượt dựng mới</label>
    <p>Mốc dùng tọa độ pixel gốc. Đổi mốc và tạo phác mới để thay kế hoạch.</p>
    <button data-example>Dùng mẫu có đạo cụ</button>
    <button data-example-empty>Dùng mẫu tay không</button>
    <label>PoseSpec (JSON) <textarea data-spec rows="6" spellcheck="false"></textarea></label>
  </details>
  <button data-start>Tạo bản màu phẳng bằng Codex</button>
  <label>Bản đã lưu <select data-history><option value="">Chọn phiên bản</option></select></label>
  <label>Phóng <select data-scale><option selected>1</option><option>4</option><option>8</option></select>×</label>
  <div style="display:flex;flex-wrap:wrap;gap:12px"><figure hidden><figcaption>Phác đã duyệt</figcaption><canvas data-original></canvas></figure><figure hidden><figcaption>Trước khi sửa</figcaption><canvas data-before></canvas></figure><figure><figcaption>Bóng dáng</figcaption><canvas data-shadow></canvas></figure><figure><figcaption>Bản đang xem</figcaption><canvas data-color></canvas></figure></div>
  <label><input type="checkbox" data-marks> Đánh dấu vị trí cảnh báo trên ảnh màu</label>
  <label data-overlay-control hidden><input type="checkbox" data-overlay> Hiện mốc dáng (vàng), đế trụ (xanh) và điểm nắm (hồng)</label>
  <div data-translate hidden>
    <label>Bộ phận <select data-part></select></label>
    <label>Dịch ngang (px) <input type="number" step="1" data-dx value="0"></label>
    <label>Dịch dọc (px) <input type="number" step="1" data-dy value="0"></label>
    <button data-move>Lưu bản dịch bộ phận</button>
  </div>
  <label>Cọ chỉnh phác <select data-ink></select></label>
  <button data-save-shape>Lưu phác để xem lại</button>
  <label>Chỉ dẫn tô vật liệu <input data-finish-notes maxlength="1800"></label>
  <button data-approve>Duyệt dáng và tô vật liệu</button>
  <label>Yêu cầu sửa vùng <input data-note></label>
  <button data-repair>Sửa vùng đã đánh dấu</button>
  <button data-apply>Áp dụng bản đang xem</button>
  <button data-stop>Hủy lượt Codex</button><button data-close>Đóng</button>
  <p data-status role="status"></p><p data-diagnostics></p><ul data-shape-findings aria-label="Cảnh báo hình học"></ul>`;
  const el=<T extends HTMLElement>(name:string)=>dialog.querySelector<T>('[data-'+name+']')!;
  const status=el('status'), history=el<HTMLSelectElement>('history'), ink=el<HTMLSelectElement>('ink');
  el<HTMLTextAreaElement>('brief').value=brief;
  el('planning').hidden=!poseSupported;
  const partSelect=el<HTMLSelectElement>('part');
  const edits=new Map<number,number>(), mask=new Set<number>();
  let current:FigureSample|undefined, job='', busy=false, previous:Uint32Array|undefined;
  let warningPixels=new Set<number>();
  function paint(name:string,pixels:Uint32Array,w:number,h:number,silhouette=false){
    const canvas=el<HTMLCanvasElement>(name), scale=Number(el<HTMLSelectElement>('scale').value);
    canvas.width=w;canvas.height=h;canvas.style.cssText='image-rendering:pixelated;background:#aab0b7;touch-action:none;width:'+w*scale+'px;height:'+h*scale+'px';
    const ctx=canvas.getContext('2d')!, image=ctx.createImageData(w,h);
    const drawWarnings=name==='color'&&el<HTMLInputElement>('marks').checked;
    pixels.forEach((p,i)=>{
      const marked=(name==='color'&&mask.has(i))||(drawWarnings&&warningPixels.has(i));
      image.data.set(marked?[255,0,135,255]:silhouette?[32,36,48,p&255]:[p>>>24,p>>>16&255,p>>>8&255,p&255],i*4);
    });ctx.putImageData(image,0,0);
    const spec=current?.plan.poseSpec;
    if(spec && (name==='color'||name==='shadow') && el<HTMLInputElement>('overlay').checked){
      poseGuide(spec,w,h).data.forEach((p,i)=>{
        if(!(p&255))return;
        ctx.fillStyle='#'+(p>>>8).toString(16).padStart(6,'0');
        ctx.fillRect(i%w,Math.floor(i/w),1,1);
      });
    }
    if(drawWarnings){
      ctx.strokeStyle='#d93633';
      for(const {region:r} of current?.shapeFindings??[])
        ctx.strokeRect(r.x+.5,r.y+.5,Math.max(1,r.w-1),Math.max(1,r.h-1));
    }
  }
  function render(){
    const fresh=current?.revision===revision;
    const structured=Boolean(current?.plan.poseSpec);
    const canMove=fresh&&current?.stage==='shape'&&structured&&!!current.shapeParts&&!current.errors.length;
    for(const name of ['history','start','brief','pose','proportions','ink','note','finish-notes']) (el(name) as HTMLInputElement).disabled=busy;
    for(const name of ['use-pose','spec','example','example-empty','part','dx','dy','move'])
      (el(name) as HTMLInputElement).disabled=busy;
    ink.disabled=busy||structured;
    el('overlay-control').hidden=!structured;
    el('translate').hidden=!canMove;
    el<HTMLButtonElement>('approve').disabled=busy||!fresh||current?.stage!=='shape'||(structured&&!!current?.errors.length);
    el<HTMLButtonElement>('save-shape').disabled=busy||!fresh||current?.stage!=='shape'||!edits.size;
    el<HTMLButtonElement>('apply').disabled=busy||!fresh||current?.stage==='shape'||!!current?.errors.length;
    el<HTMLButtonElement>('repair').disabled=busy||!fresh||current?.stage!=='finish'||!mask.size;
    el<HTMLButtonElement>('close').disabled=busy;
    el<HTMLButtonElement>('stop').disabled=!job;
    if(!current)return;
    const {w,h}=current.plan.generation, pixels=current.pixels.slice();
    for(const [i,c] of edits)pixels[i]=c;
    paint('color',pixels,w,h);paint('shadow',pixels,w,h,true);
    el('original').parentElement!.hidden=!previous;
    if(previous)paint('original',previous,w,h);
    el('before').parentElement!.hidden=current.stage!=='repair';
    if(current.stage==='repair'&&current.approved)paint('before',current.approved,w,h);
    const notes = new Map<string, string[]>();
    for (const warning of current.warnings) {
      const points = notes.get(warning.reason) ?? [];
      points.push('(' + warning.index % w + ', ' + Math.floor(warning.index / w) + ')');
      notes.set(warning.reason, points);
    }
    el('diagnostics').textContent=[
      ...current.errors,
      ...(current.restored ? ['Studio đã khôi phục '+current.restored+' pixel theo ràng buộc.'] : []),
      ...Array.from(notes, ([reason, points]) => reason+' '+points.join(', ')),
    ].join(' · ');
    el('shape-findings').replaceChildren(...(current.shapeFindings??[]).map(f=>{
      const li=document.createElement('li'),r=f.region;
      const severity=f.severity==='major'?'Cần xem kỹ':'Lưu ý';
      const confidence=f.confidence==='high'?'cao':'trung bình';
      li.textContent=`${severity} · (${r.x}, ${r.y}) ${r.w}×${r.h} px · ${f.evidence} ${f.action} Độ chắc chắn ${confidence}.`;
      return li;
    }));
  }
  async function show(s:FigureSample){
    const parent = s.stage !== 'finish' && s.parent ? await api(path+'/figure-review/'+s.parent) : undefined;
    const original = s.stage === 'shape' ? parent?.pixels : s.stage === 'repair' ? parent?.approved : s.approved;
    el('original').previousElementSibling!.textContent=s.stage==='shape'?'Phác trước khi chỉnh':'Phác đã duyệt';
    current=s; previous=original; edits.clear();mask.clear();
    warningPixels=new Set(s.warnings.map(w=>w.index));
    el<HTMLInputElement>('marks').checked=false;
    el<HTMLInputElement>('overlay').checked=false;
    el<HTMLTextAreaElement>('brief').value=s.plan.brief;
    if(s.plan.poseSpec){
      el<HTMLTextAreaElement>('spec').value=JSON.stringify(s.plan.poseSpec,null,2);
      partSelect.replaceChildren(...s.plan.poseSpec.order.map(p=>new Option(p,p)));
    }
    ink.replaceChildren(new Option('Xóa pixel','0'));
    for(const c of new Set([...s.plan.generation.palette,...new Set(s.pixels)])){
      if(c&255)ink.add(new Option('#'+c.toString(16).padStart(8,'0'),String(c)));
    }
    if(!Array.from(history.options).some(o=>o.value===s.id))history.add(new Option(s.stage+' · '+s.id.slice(0,8),s.id));
    history.value=s.id;render();
  }
  async function action(fn:()=>Promise<void>){
    if(busy)return;
    busy=true;render();
    try{await fn();}catch(e){status.textContent=String(e);}finally{job='';busy=false;render();}
  }
  async function generate(stage:FigureStage){
    if(session.doc?.id!==project||session.doc.revision!==revision)throw Error('Mở lại trên revision hiện tại.');
    const prompt=stage==='finish'?current!.plan.brief:stage==='repair'?el<HTMLInputElement>('note').value.trim():el<HTMLTextAreaElement>('brief').value.trim();
    if(!prompt)throw Error('Nhập yêu cầu.');
    let spec;
    if(stage==='shape'&&poseSupported&&el<HTMLInputElement>('use-pose').checked){
      let parsed:unknown;
      try{parsed=JSON.parse(el<HTMLTextAreaElement>('spec').value);}
      catch{el('spec').focus();throw Error('Nhập PoseSpec JSON hợp lệ hoặc chọn mẫu.');}
      spec=validateCharacterPose(parsed,canvasW,canvasH);
    }
    status.textContent='Đang gửi yêu cầu cho Codex…';
    const j=await api(path+'/ai','POST',{revision,assetId:stage==='shape'?assetId:current!.plan.generation.assetId,provider:'codex',prompt,figureStage:stage,
      pose:el<HTMLInputElement>('pose').value, proportions:el<HTMLInputElement>('proportions').value,
      ...(stage==='finish'?{finishNotes:el<HTMLInputElement>('finish-notes').value}:{}),
      ...(spec?{poseSpec:spec}:{}),
      generationOptions:options,artDirection:art,parentId:current?.id,edits:[...edits],mask:[...mask]});
    job=j.id;render();status.textContent='Codex đang dựng '+stage+'…';
    let state=j;
    while(['preparing','queued','running','validating','canceling'].includes(state.status)){
      await new Promise(done=>setTimeout(done,800));state=await api(path+'/ai/'+job);
    }
    if(state.status!=='ready')throw Error(state.diagnostic?.code.startsWith('PXL_') ? state.message+' · '+state.diagnostic.message : state.message);
    await show(await api(path+'/ai/'+job+'/preview','POST',{revision}));
    if(spec&&current?.errors.length)status.textContent='Xem lỗi kỹ thuật bên dưới rồi tạo lại bản phác.';
    else if(stage==='shape')status.textContent=spec?'Xem mốc và dịch bộ phận trước khi duyệt dáng.':'Xem dáng, chọn màu cọ để chỉnh pixel rồi duyệt.';
    else status.textContent='Chọn bản để áp dụng. Bấm hoặc kéo trên ảnh màu để đánh dấu vùng sửa.';
  }
  for(const [name,stage] of [['start','shape'],['approve','finish'],['repair','repair']] as const)
    el(name).onclick=()=>void action(()=>generate(stage));
  el('scale').onchange=render;
  el('overlay').onchange=render;
  for(const [name,prop] of [['example',true],['example-empty',false]] as const)
    el(name).onclick=()=>{
      el<HTMLInputElement>('use-pose').checked=true;
      el<HTMLTextAreaElement>('spec').value=JSON.stringify(exampleCharacterPose(canvasW,canvasH,prop),null,2);
    };
  el('move').onclick=()=>void action(async()=>{
    const dx=el<HTMLInputElement>('dx'),dy=el<HTMLInputElement>('dy');
    await show(await api(path+'/figure-review/'+current!.id+'/revise','POST',{revision,
      move:{part:partSelect.value,dx:dx.valueAsNumber,dy:dy.valueAsNumber}}));
    dx.value=dy.value='0';
    status.textContent='Đã lưu vị trí mới. Bản trước vẫn mở được trong lịch sử.';
  });
  el('save-shape').onclick=()=>void action(async()=>{
    await show(await api(path+'/figure-review/'+current!.id+'/revise','POST',{revision,edits:[...edits]}));
    status.textContent='Đã lưu bản phác. Bạn có thể mở lại bản trước trong danh sách.';
  });
  el('marks').onchange=render;
  history.onchange=()=>void action(async()=>{if(history.value)await show(await api(path+'/figure-review/'+history.value));});
  el('stop').onclick=()=>{if(job)void api(path+'/ai/'+job+'/cancel','POST',{}).catch(e=>status.textContent=String(e));};
  el('apply').onclick=()=>void action(async()=>{
    const p=await api(path+'/figure-review/'+current!.id+'/select','POST',{revision});
    await api(path+'/apply-proposal','POST',{revision,proposalId:p.proposalId});
    await session.open(project);dialog.close();
  });
  const canvas=el<HTMLCanvasElement>('color');
  function brush(e:PointerEvent){
    if(busy||!current||!(e.buttons&1))return;
    const box=canvas.getBoundingClientRect(),x=Math.floor((e.clientX-box.left)*canvas.width/box.width),y=Math.floor((e.clientY-box.top)*canvas.height/box.height);
    if(x<0||y<0||x>=canvas.width||y>=canvas.height)return;
    const i=y*canvas.width+x;
    if(current.stage==='shape'&&!current.plan.poseSpec)edits.set(i,Number(ink.value));
    if(current.stage==='finish')mask.add(i);
    render();
  }
  canvas.onpointerdown=brush;canvas.onpointermove=brush;
  el('close').onclick=()=>dialog.close(); dialog.oncancel=e=>{if(busy)e.preventDefault();};
  dialog.onclose=()=>dialog.remove();
  document.body.append(dialog); dialog.showModal();render();
  await action(async()=>{
    const ids:string[]=await api(path+'/figure-review');
    for(const id of ids)history.add(new Option(id.slice(0,8),id));
  });
}
