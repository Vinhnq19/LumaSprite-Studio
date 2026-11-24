import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { VariantStore } from './variant-store.ts';
import { StudioError } from './store.ts';
import type { PixelStore } from './pixel-store.ts';
import type { WorkerRequest } from './runner.ts';
import type { ExportResult } from './render.ts';
import { wireParse, type PixelAsset } from '../../studio/pixel/model.ts';
import type { GenerationContext, ProjectDocument, AnimationOptions } from '../../studio/types.ts';
import type { VariantInfo, VariantPreview, ProcessingJob, VariantFrame } from '../../studio/variants.ts';
import type { ClipSnapshotResult } from './clip-snapshot.ts';
import type { ClipCaptureResult, ClipVerifyResult } from './clip-worker.ts';
import { validateClipReference, resolveClipDifferenceComparison, cloneForClipApply } from './clip-proposals.ts';

interface Proposal { id: string; projectId: string; revision: number; variants: VariantInfo[]; generation?: GenerationContext; referenceId?: string; jobId?: string }
type Run = (id:string,request:WorkerRequest)=>Promise<any>;

export class Proposals {
  readonly repo=new VariantStore(); readonly records=new Map<string,Proposal>(); readonly jobs=new Map<string,ProcessingJob>();
  readonly references=new Map<string,{id:string;projectId:string}>();
  private owned=new Map<string,Set<string>>();private cache=new Map<string,VariantFrame>();private bytes=0;
  private epochs=new Map<string,number>();private disposed=false;
  private store:PixelStore;private run:Run;private emit:(event:unknown)=>void;

  constructor(store:PixelStore,run:Run,emit:(event:unknown)=>void){this.store=store;this.run=run;this.emit=emit;}

  private own(project:string,id:string):void{let set=this.owned.get(project);if(!set)this.owned.set(project,set=new Set());set.add(id);}

  private async work(project:string,request:Omit<Extract<WorkerRequest,{mode:'pixel-process'}>,'root'|'mode'>):Promise<any>{
    const out=await this.run(project,{...request,mode:'pixel-process',root:this.repo.root}) as ExportResult;
    return wireParse(Buffer.from(out.data).toString('utf8'));
  }

  async reference(projectId:string,revision:number,source:PixelAsset,frameId:string,generation:GenerationContext,animation?:AnimationOptions):Promise<{info:VariantInfo;palette:number[];problems:string[];source:string;preview:string;maskPreview?:string}>{
    if (this.disposed) throw new StudioError('Instance đã đóng hoặc đã giải phóng (disposed).', 409);
    const result=await this.work(projectId,{operation:'reference',source,frameId,generation,animation,revision});
    this.own(projectId,result.info.id);
    return result;
  }

  async clipReference(
    projectId: string,
    revision: number,
    clipId: string,
    paletteMode?: 'asset' | 'auto16',
    targetPalette?: number[]
  ): Promise<ClipSnapshotResult> {
    if (this.disposed) throw new StudioError('Instance đã đóng hoặc đã giải phóng (disposed).', 409);
    if (this.store.load(projectId).revision !== revision) throw new StudioError('Revision đã thay đổi.', 409);
    const epoch = this.epochs.get(projectId) ?? 0;

    const snapshot = await this.work(projectId, {
      operation: 'clip-prepare',
      projectRoot: this.store.root,
      projectId,
      revision,
      clipId,
      paletteMode,
      targetPalette,
    }) as ClipSnapshotResult;

    try {
      if (this.disposed || (this.epochs.get(projectId) ?? 0) !== epoch) {
        throw new StudioError('Dự án đã đóng hoặc phiên làm việc đã hết hạn.', 409);
      }
      if (this.store.load(projectId).revision !== revision) {
        throw new StudioError('Revision đã thay đổi khi chuẩn bị mẫu clip.', 409);
      }
      this.own(projectId, snapshot.referenceId);
      return snapshot;
    } catch (err) {
      this.repo.remove(snapshot.referenceId);
      throw err;
    }
  }

  rememberReference(jobId:string,projectId:string,id:string):void{this.references.set(jobId,{id,projectId});}
  discardReference(projectId:string,id:string):void{this.remove(projectId,id);}

  private add(projectId:string,revision:number,variants:VariantInfo[],generation?:GenerationContext,jobId?:string,referenceId?:string):VariantPreview {
    const p:Proposal={id:randomUUID(),projectId,revision,variants:structuredClone(variants),generation:generation?structuredClone(generation):undefined,jobId,referenceId};
    this.records.set(p.id,p);
    for(const v of variants)this.own(projectId,v.id);
    while(this.records.size>20){const old=this.records.values().next().value!;this.records.delete(old.id);for(const v of old.variants)this.remove(old.projectId,v.id);}
    return this.preview(p);
  }

  get(projectId:string,id:string,revision:number):Proposal {
    if (this.disposed) throw new StudioError('Instance đã đóng hoặc đã giải phóng (disposed).', 409);
    const p=this.records.get(id);
    if(!p||p.projectId!==projectId||p.revision!==revision||this.store.load(projectId).revision!==revision)throw new StudioError('Đề xuất đã cũ hoặc hết hạn. Tạo lại trên revision hiện tại.',409);
    return p;
  }

  private preview(p:Proposal):VariantPreview{
    const isClip = Boolean(p.generation?.clip);
    const selectedVariantId = isClip
      ? (p.variants.slice().reverse().find(v => v.kind === 'normalized' || v.kind === 'protected')?.id ?? p.variants[0].id)
      : (p.variants.find(v => v.kind === 'protected')?.id ?? p.variants[0].id);

    return {
      proposalId: p.id,
      variants: structuredClone(p.variants),
      selectedVariantId,
      generation: p.generation ? structuredClone(p.generation) : undefined,
      referenceVariantId: p.referenceId,
      reference: p.referenceId && existsSync(join(this.repo.store.dir(p.referenceId), 'variant.json')) ? structuredClone(this.repo.info(p.referenceId)) : undefined
    };
  }

  describe(projectId:string,id:string,revision:number):VariantPreview{return this.preview(this.get(projectId,id,revision));}

  async capture(projectId:string,revision:number,document:ProjectDocument,generation?:GenerationContext,jobId?:string):Promise<VariantPreview>{
    if (this.disposed) throw new StudioError('Instance đã đóng hoặc đã giải phóng (disposed).', 409);
    if (this.store.load(projectId).revision !== revision) throw new StudioError('Revision đã thay đổi khi dựng đề xuất.', 409);
    const epoch = this.epochs.get(projectId) ?? 0;

    // Clone inputs BEFORE awaiting any worker to prevent caller mutation decoupling signature from pixels
    const clonedGeneration = generation ? structuredClone(generation) : undefined;
    const clonedDocument = structuredClone(document);

    const refEntry = jobId ? this.references.get(jobId) : undefined;
    if (refEntry && refEntry.projectId !== projectId) {
      throw new StudioError('Mẫu tham chiếu không thuộc dự án.', 403);
    }
    // No undocumented jobId-as-reference fallback: require actual project-owned remembered reference
    const referenceId = refEntry?.id;

    const isClip = Boolean(clonedGeneration?.operation === 'clip-regenerate' || clonedGeneration?.clip);
    if (isClip) {
      if (!clonedGeneration?.clip?.context) {
        throw new StudioError('Thiếu cấu hình ngữ cảnh clip trong GenerationContext.', 400);
      }
      if (!referenceId) {
        throw new StudioError('Thiếu mẫu tham chiếu cho clip.', 409);
      }
      validateClipReference(this.owned.get(projectId), this.repo, referenceId, clonedGeneration.clip.context, projectId);

      const captureResult = await this.work(projectId, {
        operation: 'clip-capture',
        context: clonedGeneration.clip.context,
        referenceId,
        document: clonedDocument,
        revision,
      }) as ClipCaptureResult;

      if (!captureResult.raw) {
        const msg = captureResult.quality?.errors.join('\n') || 'Không thể tạo raw variant cho clip.';
        throw new StudioError(msg, 422);
      }

      const variants: VariantInfo[] = [captureResult.raw];
      this.own(projectId, captureResult.raw.id);

      if (captureResult.protected) {
        variants.push(captureResult.protected);
        this.own(projectId, captureResult.protected.id);
      }

      try {
        if (this.disposed || (this.epochs.get(projectId) ?? 0) !== epoch) {
          throw new StudioError('Dự án đã đóng hoặc phiên làm việc đã hết hạn.', 409);
        }
        if (this.store.load(projectId).revision !== revision) {
          throw new StudioError('Revision đã thay đổi khi dựng đề xuất.', 409);
        }
        validateClipReference(this.owned.get(projectId), this.repo, referenceId, clonedGeneration.clip.context, projectId);
        return this.add(projectId, revision, variants, clonedGeneration, jobId, referenceId);
      } catch (e) {
        for (const v of variants) this.remove(projectId, v.id);
        throw e;
      }
    }

    const raw:VariantInfo=await this.work(projectId,{operation:'capture',document:clonedDocument,generation:clonedGeneration,referenceId});this.own(projectId,raw.id);
    const variants=[raw];
    try{
      if(clonedGeneration?.animation?.mode==='region'&&!raw.quality?.errors.length){if(!referenceId)throw new StudioError('Mẫu khóa vùng đã hết hạn.',409);const protectedVariant=await this.work(projectId,{operation:'protect',variantId:raw.id,referenceId,generation:clonedGeneration,revision});variants.push(protectedVariant);this.own(projectId,protectedVariant.id);}
      if(this.disposed || (this.epochs.get(projectId) ?? 0) !== epoch) throw new StudioError('Dự án đã đóng hoặc phiên làm việc đã hết hạn.', 409);
      if(this.store.load(projectId).revision!==revision)throw new StudioError('Revision đã thay đổi khi dựng đề xuất.',409);
      return this.add(projectId,revision,variants,clonedGeneration,jobId,referenceId);
    }catch(e){for(const v of variants)this.remove(projectId,v.id);throw e;}
  }

  addReference(projectId:string,revision:number,info:VariantInfo,generation:GenerationContext):VariantPreview{return this.add(projectId,revision,[info],generation);}

  private validateFrameAccess(
    projectId: string,
    proposalId: string,
    revision: number,
    variantId: string,
    epoch: number,
    compare?: { variantId: string; assetId: string; frameId: string }
  ): Proposal {
    if (this.disposed || (this.epochs.get(projectId) ?? 0) !== epoch) {
      throw new StudioError('Dự án đã đóng hoặc phiên làm việc đã hết hạn.', 409);
    }
    const p = this.get(projectId, proposalId, revision);
    if (!p.variants.some(v => v.id === variantId) && p.referenceId !== variantId) {
      throw new StudioError('Biến thể không thuộc đề xuất.', 404);
    }
    if (!this.owned.get(projectId)?.has(variantId) || !existsSync(join(this.repo.store.dir(variantId), 'variant.json'))) {
      throw new StudioError('Biến thể đã bị giải phóng.', 404);
    }
    if (p.referenceId && (!this.owned.get(projectId)?.has(p.referenceId) || !existsSync(join(this.repo.store.dir(p.referenceId), 'variant.json')))) {
      throw new StudioError('Mẫu tham chiếu không thuộc dự án hoặc đã bị giải phóng.', 403);
    }
    if (compare && (!this.owned.get(projectId)?.has(compare.variantId) || !existsSync(join(this.repo.store.dir(compare.variantId), 'variant.json')))) {
      throw new StudioError('Biến thể so sánh đã bị giải phóng.', 404);
    }
    return p;
  }

  async frame(projectId:string,proposalId:string,variantId:string,assetId:string,frameId:string,revision:number,overlay?:string,against='raw'):Promise<VariantFrame>{
    const epoch = this.epochs.get(projectId) ?? 0;
    const p = this.validateFrameAccess(projectId, proposalId, revision, variantId, epoch);

    const info=this.repo.info(variantId);
    const currentAsset=info.assets.find(a=>a.id===assetId);
    if(!currentAsset||!currentAsset.frames.some(f=>f.id===frameId))throw new StudioError('Frame không tồn tại.',404);

    const isClip = Boolean(info.clip || (p.referenceId && existsSync(join(this.repo.store.dir(p.referenceId), 'variant.json')) && this.repo.info(p.referenceId).clip));

    let compare:{variantId:string;assetId:string;frameId:string}|undefined;
    if(overlay==='difference'){
      if (isClip) {
        const refInfo = p.referenceId && existsSync(join(this.repo.store.dir(p.referenceId), 'variant.json')) ? this.repo.info(p.referenceId) : undefined;
        compare = resolveClipDifferenceComparison({
          info,
          reference: refInfo,
          variants: p.variants,
          assetId,
          frameId,
          against,
        });
      } else {
        const target=against==='reference'&&p.referenceId?this.repo.info(p.referenceId):p.variants[0],index=info.assets.findIndex(a=>a.id===assetId),a=target.assets[index]??target.assets[0],frameIndex=info.assets[index].frames.findIndex(f=>f.id===frameId);
        compare={variantId:target.id,assetId:a.id,frameId:a.frames[against==='reference'?0:frameIndex]?.id??a.frames[0].id};
      }
    }

    const compareKey = compare ? `:${compare.variantId}:${compare.assetId}:${compare.frameId}` : '';
    const key=`${variantId}:${assetId}:${frameId}:${overlay??''}:${against}${compareKey}`;
    const cached=this.cache.get(key);
    if(cached){
      this.validateFrameAccess(projectId, proposalId, revision, variantId, epoch, compare);
      this.cache.delete(key);
      this.cache.set(key,cached);
      return cached;
    }

    const out=await this.run(projectId,{mode:'variant-frame',root:this.repo.root,variantId,assetId,frameId,overlay,referenceId:p.referenceId,compare}) as ExportResult;
    const value:VariantFrame=wireParse(Buffer.from(out.data).toString('utf8'));

    this.validateFrameAccess(projectId, proposalId, revision, variantId, epoch, compare);

    while(this.bytes+value.data.byteLength>128*1024*1024&&this.cache.size){const first=this.cache.keys().next().value!,old=this.cache.get(first)!;this.bytes-=old.data.byteLength;this.cache.delete(first);}
    if(value.data.byteLength<=128*1024*1024){this.cache.set(key,value);this.bytes+=value.data.byteLength;}
    return value;
  }

  startNormalize(projectId:string,proposalId:string,revision:number,threshold:number):ProcessingJob {
    if (this.disposed) throw new StudioError('Instance đã đóng hoặc đã giải phóng (disposed).', 409);
    const p=this.get(projectId,proposalId,revision);if(!p.generation)throw new StudioError('Đề xuất này chưa có cấu hình palette. Tạo bằng AI hoặc Chuẩn hóa mẫu.');
    if(!Number.isInteger(threshold)||threshold<1||threshold>255)throw new StudioError('Ngưỡng alpha cần 1–255.');
    if([...this.jobs.values()].some(j=>j.projectId===projectId&&j.status==='running'))throw new StudioError('Đang xử lý cục bộ. Chờ tác vụ hiện tại hoàn tất.',409);

    const isClip = Boolean(p.generation.clip);
    const job:ProcessingJob={
      id:randomUUID(),
      projectId,
      proposalId,
      revision,
      status:'running',
      message: isClip ? 'Đang chuẩn hóa palette clip trong worker…' : 'Đang chuẩn hóa palette trong worker…'
    };
    this.jobs.set(job.id,job);
    while(this.jobs.size>100){const old=[...this.jobs.values()].find(j=>j.status!=='running');if(!old)break;this.jobs.delete(old.id);}
    this.emit({type:'pixel-processing',job});

    const epoch = this.epochs.get(projectId) ?? 0;
    if (isClip) {
      const rawVariant = p.variants.find(v => v.kind === 'raw');
      if (!rawVariant) {
        job.status = 'failed';
        job.message = 'Không tìm thấy bản AI gốc để chuẩn hóa.';
        this.emit({ type: 'pixel-processing', job });
        throw new StudioError('Không tìm thấy bản AI gốc để chuẩn hóa.', 404);
      }
      if (!p.referenceId || !existsSync(join(this.repo.store.dir(p.referenceId), 'variant.json'))) {
        job.status = 'failed';
        job.message = 'Mẫu tham chiếu đã hết hạn hoặc không tồn tại.';
        this.emit({ type: 'pixel-processing', job });
        throw new StudioError('Mẫu tham chiếu đã hết hạn hoặc không tồn tại.', 409);
      }

      void this.work(projectId, {
        operation: 'clip-normalize',
        context: p.generation.clip!.context,
        referenceId: p.referenceId,
        rawVariantId: rawVariant.id,
        alphaThreshold: threshold,
        revision,
      }).then((result: { info: VariantInfo }) => {
        const variant = result.info;
        if (job.status === 'canceled' || this.disposed || (this.epochs.get(projectId) ?? 0) !== epoch) {
          this.remove(projectId, variant.id);
          if (job.status === 'running') {
            job.status = 'canceled';
            job.message = 'Đã hủy tác vụ.';
            this.emit({ type: 'pixel-processing', job });
          }
          return;
        }
        try {
          this.get(projectId, proposalId, revision);
        } catch (err) {
          this.remove(projectId, variant.id);
          if (job.status === 'running') {
            job.status = 'failed';
            job.message = (err as Error).message || 'Đề xuất đã cũ hoặc hết hạn.';
            this.emit({ type: 'pixel-processing', job });
          }
          return;
        }
        if (p.referenceId && (!this.owned.get(projectId)?.has(p.referenceId) || !existsSync(join(this.repo.store.dir(p.referenceId), 'variant.json')))) {
          this.remove(projectId, variant.id);
          if (job.status === 'running') {
            job.status = 'failed';
            job.message = 'Mẫu tham chiếu đã bị giải phóng.';
            this.emit({ type: 'pixel-processing', job });
          }
          return;
        }
        this.own(projectId, variant.id);
        p.variants.push(variant);
        while (p.variants.length > 8) {
          const index = p.variants.findIndex(v => v.kind === 'normalized');
          if (index !== -1) {
            const [old] = p.variants.splice(index, 1);
            this.remove(projectId, old.id);
          } else {
            break;
          }
        }
        job.status = 'ready';
        job.variantId = variant.id;
        job.message = 'Đã chuẩn hóa; chọn bản xem trước rồi Áp dụng.';
        this.emit({ type: 'pixel-processing', job });
      }).catch(e => {
        if (job.status === 'canceled') return;
        job.status = (this.disposed || (this.epochs.get(projectId) ?? 0) !== epoch) ? 'canceled' : 'failed';
        job.message = (e as Error).message;
        this.emit({ type: 'pixel-processing', job });
      });
      return job;
    }

    void this.work(projectId,{operation:'normalize',variantId:p.variants[0].id,referenceId:p.referenceId,generation:p.generation,alphaThreshold:threshold,revision}).then((variant:VariantInfo)=>{
      if(job.status==='canceled'||this.disposed||(this.epochs.get(projectId)??0)!==epoch){
        this.remove(projectId,variant.id);
        if(job.status==='running'){job.status='canceled';job.message='Đã hủy tác vụ.';this.emit({type:'pixel-processing',job});}
        return;
      }
      try{
        this.get(projectId,proposalId,revision);
      }catch(err){
        this.remove(projectId,variant.id);
        if(job.status==='running'){job.status='failed';job.message=(err as Error).message||'Đề xuất đã cũ hoặc hết hạn.';this.emit({type:'pixel-processing',job});}
        return;
      }
      this.own(projectId,variant.id);
      p.variants.push(variant);while(p.variants.length>8){const index=p.variants.findIndex(v=>v.kind==='normalized');const [old]=p.variants.splice(index,1);this.remove(projectId,old.id);}
      job.status='ready';job.variantId=variant.id;job.message='Đã chuẩn hóa; chọn bản xem trước rồi Áp dụng.';this.emit({type:'pixel-processing',job});
    }).catch(e=>{
      if(job.status==='canceled')return;
      job.status=(this.disposed||(this.epochs.get(projectId)??0)!==epoch)?'canceled':'failed';
      job.message=(e as Error).message;
      this.emit({type:'pixel-processing',job});
    });
    return job;
  }

  async forApply(projectId:string,proposalId:string,revision:number,variantId?:string):Promise<{assets:PixelAsset[];jobId?:string}>{
    if (this.disposed) throw new StudioError('Instance đã đóng hoặc đã giải phóng (disposed).', 409);
    const epoch = this.epochs.get(projectId) ?? 0;
    const p=this.get(projectId,proposalId,revision);
    const isClip = Boolean(p.generation?.clip);

    if (isClip) {
      let variant: VariantInfo | undefined;
      if (variantId) {
        variant = p.variants.find(v => v.id === variantId);
        if (!variant) throw new StudioError('Biến thể không thuộc đề xuất.', 404);
      } else {
        variant = p.variants.slice().reverse().find(v => v.kind === 'normalized') ?? p.variants.find(v => v.kind === 'protected');
      }
      if (!variant) throw new StudioError('Không tìm thấy biến thể hợp lệ để áp dụng.', 404);
      if (variant.kind === 'raw' || variant.kind === 'reference') {
        throw new StudioError('Không thể áp dụng biến thể raw hoặc mẫu tham chiếu.', 422);
      }
      if (!variant.canApply) {
        throw new StudioError('Biến thể chưa thể áp dụng. Chọn bản đã bảo vệ/chuẩn hóa.', 422);
      }

      const verifyResult = await this.work(projectId, {
        operation: 'clip-verify',
        context: p.generation!.clip!.context,
        referenceId: p.referenceId!,
        variantId: variant.id,
        revision,
      }) as ClipVerifyResult;

      this.validateApplyClip(projectId, proposalId, revision, epoch, variant.id, p.referenceId);

      if (!verifyResult.valid || verifyResult.quality.errors.length) {
        throw new StudioError(verifyResult.quality.errors.join('\n') || 'Xác thực clip thất bại.', 422);
      }

      const loadedAssets: PixelAsset[] = await this.work(projectId, {
        operation: 'load',
        variantId: variant.id,
      });

      this.validateApplyClip(projectId, proposalId, revision, epoch, variant.id, p.referenceId);

      const tempSnapshot = await this.work(projectId, {
        operation: 'clip-prepare',
        projectRoot: this.store.root,
        projectId,
        revision,
        clipId: p.generation!.clip!.context.clipId,
        paletteMode: p.generation!.clip!.context.paletteMode,
        targetPalette: p.generation!.clip!.context.palette,
      }) as ClipSnapshotResult;

      try {
        this.validateApplyClip(projectId, proposalId, revision, epoch, variant.id, p.referenceId);
        const originalRef = this.repo.info(p.referenceId!);
        if (
          tempSnapshot.referenceInfo.clip?.contextDigest !== originalRef.clip?.contextDigest ||
          tempSnapshot.referenceInfo.clip?.maskDigest !== originalRef.clip?.maskDigest
        ) {
          throw new StudioError('Nguồn nhân vật, profile hoặc clip đã thay đổi sau khi tạo đề xuất.', 409);
        }
      } finally {
        this.remove(projectId, tempSnapshot.referenceId);
      }

      const current = this.validateApplyClip(projectId, proposalId, revision, epoch, variant.id, p.referenceId);
      const freshAssets = cloneForClipApply(loadedAssets);
      return { assets: freshAssets, jobId: current.jobId };
    }

    const variant=p.variants.find(v=>v.id===(variantId??p.variants[0].id));if(!variant||!variant.canApply)throw new StudioError('Biến thể chưa thể áp dụng. Chọn bản đã khóa vùng/hợp lệ.',422);
    if(p.generation){const result=await this.work(projectId,{operation:'verify',variantId:variant.id,referenceId:p.referenceId,generation:p.generation,revision});if(result.quality.errors.length)throw new StudioError(result.quality.errors.join('\n'),422);}
    const assets=await this.work(projectId,{operation:'load',variantId:variant.id});this.get(projectId,proposalId,revision);return{assets,jobId:p.jobId};
  }

  private validateApplyClip(projectId: string, proposalId: string, revision: number, epoch: number, variantId: string, referenceId?: string): Proposal {
    if (this.disposed || (this.epochs.get(projectId) ?? 0) !== epoch) {
      throw new StudioError('Instance đã đóng hoặc phiên làm việc đã hết hạn.', 409);
    }
    const current = this.get(projectId, proposalId, revision);
    if (!this.owned.get(projectId)?.has(variantId) || !existsSync(join(this.repo.store.dir(variantId), 'variant.json'))) {
      throw new StudioError('Biến thể đã bị giải phóng.', 404);
    }
    if (referenceId && (!this.owned.get(projectId)?.has(referenceId) || !existsSync(join(this.repo.store.dir(referenceId), 'variant.json')))) {
      throw new StudioError('Mẫu tham chiếu không thuộc dự án hoặc đã bị giải phóng.', 403);
    }
    return current;
  }

  private remove(projectId:string,id:string):void{this.repo.remove(id);this.owned.get(projectId)?.delete(id);for(const [key,f]of this.cache)if(key.startsWith(id+':')){this.bytes-=f.data.byteLength;this.cache.delete(key);}}

  releaseProposal(projectId: string, id: string): void {
    const p = this.records.get(id);
    if (!p || p.projectId !== projectId) return;
    this.records.delete(id);
    for (const v of p.variants) this.remove(projectId, v.id);
  }

  closeProject(projectId:string):void{
    this.epochs.set(projectId,(this.epochs.get(projectId)??0)+1);
    for(const job of this.jobs.values())if(job.projectId===projectId&&job.status==='running'){job.status='canceled';job.message='Đã đóng dự án.';this.emit({type:'pixel-processing',job});}
    for(const [id,p]of this.records)if(p.projectId===projectId)this.records.delete(id);
    for(const [id,r]of this.references)if(r.projectId===projectId)this.references.delete(id);
    for(const id of [...this.owned.get(projectId)??[]])this.remove(projectId,id);
    this.owned.delete(projectId);
  }

  close():void{
    this.disposed=true;
    for(const [projectId] of this.epochs){
      this.closeProject(projectId);
    }
    for(const projectId of [...this.owned.keys()]){
      this.closeProject(projectId);
    }
    this.repo.close();
  }
}
