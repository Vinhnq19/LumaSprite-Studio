import { randomUUID } from 'node:crypto';
import { luma8 } from '../../core/color.ts';
import { dataId, dataNumber } from '../../studio/quality/data.ts';
import { QUALITY_ROLE_LIMITS, QUALITY_TOTAL_LIMIT, QUALITY_STOP_RESERVE, QUALITY_MAX_CLI_CALLS, QUALITY_PROVIDERS, type QualityRun, type QualityRole, type QualityCall, type QualityVariantSummary } from '../../studio/quality/run.ts';
import type { QualityDirector } from '../../studio/quality/protocol.ts';
import type { QualityPorts, QualityOwnedTask, QualityPrepared, QualityLease, QualityStartInput, QualityValidated, QualityImage, CharacterToneComparison } from './quality-ports.ts';
import { isHumanoidSpritePrompt } from './art-guidance.ts';
import { characterBlockoutGuide } from './quality-character-blockout.ts';
import { characterMaterialGuide } from './quality-character-material-guide.ts';

/** Only this error class permits the one shared JSON/schema/render repair. */
export class QualityTechnicalError extends Error {}
class Aborted extends Error {}
interface RecordState {
  run: QualityRun; input: QualityStartInput; lease: QualityLease; released: boolean;
  startedTick: number; deadlineTick: number; endedTick?: number; callTicks: Map<string, { start: number; end?: number }>;
  prepared?: QualityPrepared; director?: QualityDirector; candidate?: QualityVariantSummary; toneComparison?: CharacterToneComparison;
  active?: QualityOwnedTask<unknown>; abort?: (reason: Error) => void; cancelRequested: boolean;
  lateCleanup: (() => void)[];
  terminalIntent: 'failed' | 'canceled'; cancellation?: Promise<void>; background?: Promise<void>;
  cancelReason?: string;
}
export interface QualityEngineOptions {
  /** Server/test-only bounds; never accepted from HTTP and can only shorten defaults. */
  limits?: Partial<Record<QualityRole | 'total' | 'local' | 'stop', number>>;
  emit?: (run: QualityRun) => void;
  characterFinishStudy?: boolean;
}
function bound(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isFinite(value) || value < 1) throw new Error('Ngân sách chất lượng không hợp lệ.');
  return Math.min(maximum, Math.floor(value));
}
function images(values: QualityImage[]): QualityImage[] {
  if (!Array.isArray(values) || values.length > 8) throw new Error('Ảnh tham chiếu vượt ngân sách.');
  let bytes = 0;
  return values.map(i => {
    if (!/^[A-Za-z0-9_-]{1,80}\.png$/.test(i.name) || !(i.data instanceof Uint8Array)) throw new Error('Ảnh tham chiếu không hợp lệ.');
    bytes += i.data.byteLength; if (bytes > 32 * 1024 * 1024) throw new Error('Ảnh tham chiếu vượt ngân sách.');
    return { name: i.name, data: i.data.slice() };
  });
}
function compactVariant(v: QualityVariantSummary): QualityVariantSummary {
  dataId(v.id, 'Biến thể chất lượng'); dataNumber(v.w, 1, 4096, 'Chiều rộng', true); dataNumber(v.h, 1, 4096, 'Chiều cao', true);
  if (!['builder', 'reviewed', 'edited'].includes(v.kind) || typeof v.description !== 'string' || v.description.length > 4000 || typeof v.loop !== 'boolean' || !Array.isArray(v.frames) || !v.frames.length || v.frames.length > 600) throw new Error('Metadata biến thể không hợp lệ.');
  const compact: QualityVariantSummary = { id: v.id, kind: v.kind, description: v.description, w: v.w, h: v.h, loop: v.loop, frames: v.frames.map(f => {
    dataId(f.id, 'Frame biến thể'); dataNumber(f.durationMs, 1, 60000, 'Timing biến thể', true);
    if (!/^[a-f0-9]{64}$/.test(f.rgbaSha256)) throw new Error('Hash frame biến thể không hợp lệ.');
    return { id: f.id, durationMs: f.durationMs, rgbaSha256: f.rgbaSha256 };
  }) };
  if (v.kind === 'edited') {
    const parentVariantId = v.parentVariantId;
    if (typeof parentVariantId !== 'string') throw new Error('Biến thể chỉnh pixel cần biến thể cha.');
    dataId(parentVariantId, 'Biến thể cha');
    compact.parentVariantId = parentVariantId;
  }
  return compact;
}

/** Orchestration only: rendering, JSON validation and CLI I/O run through owned, bounded ports. */
export class QualityEngine {
  private records = new Map<string, RecordState>();
  private closed = false;
  private closingProjects = new Map<string, Promise<void>>();
  private limits: Record<QualityRole | 'total' | 'local' | 'stop', number>;
  private ports: QualityPorts;
  private options: QualityEngineOptions;
  constructor(ports: QualityPorts, options: QualityEngineOptions = {}) {
    this.ports = ports; this.options = options;
    this.limits = { director: bound(options.limits?.director, QUALITY_ROLE_LIMITS.director), builder: bound(options.limits?.builder, QUALITY_ROLE_LIMITS.builder), reviewer: bound(options.limits?.reviewer, QUALITY_ROLE_LIMITS.reviewer), total: bound(options.limits?.total, QUALITY_TOTAL_LIMIT), local: bound(options.limits?.local, 30_000), stop: bound(options.limits?.stop, QUALITY_STOP_RESERVE) };
    if (this.limits.total <= this.limits.stop) throw new Error('Tổng ngân sách phải lớn hơn dự phòng dừng.');
  }
  private state(id: string): RecordState { const s = this.records.get(id); if (!s) throw new Error('Không tìm thấy lượt tạo chất lượng.'); return s; }
  get(id: string): QualityRun {
    const s = this.state(id), value = structuredClone(s.run), now = performance.now();
    value.elapsedMs = Math.max(0, (value.status === 'unknown' ? now : s.endedTick ?? now) - s.startedTick);
    value.calls.forEach(call => { const t = s.callTicks.get(call.id); call.elapsedMs = t ? Math.max(0, (t.end ?? now) - t.start) : 0; });
    return value;
  }
  list(projectId: string): QualityRun[] { return [...this.records.values()].filter(s => s.run.projectId === projectId).map(s => this.get(s.run.id)); }
  addRetouchVariant(id: string, variant: QualityVariantSummary): QualityRun {
    const s = this.state(id);
    if (this.closed || this.closingProjects.has(s.run.projectId) || s.run.status !== 'ready' || !s.released) throw new Error('Chưa thể lưu biến thể chỉnh pixel cho lượt tạo này.');
    this.ports.assertCurrent(s.run.projectId, s.run.revision);
    const v = compactVariant(variant);
    if (v.kind !== 'edited') throw new Error('Chỉ nhận biến thể chỉnh pixel.');
    const parent = s.run.variants.find(x => x.id === v.parentVariantId);
    if (!parent) throw new Error('Không tìm thấy biến thể cha.');
    if (s.run.variants.some(x => x.id === v.id)) throw new Error('Mã biến thể đã tồn tại.');
    if (s.run.variants.length >= 20) throw new Error('Đã đạt giới hạn 20 biến thể.');
    if (v.w !== parent.w || v.h !== parent.h || v.loop !== parent.loop || JSON.stringify(v.frames.map(f => [f.id, f.durationMs])) !== JSON.stringify(parent.frames.map(f => [f.id, f.durationMs]))) throw new Error('Biến thể chỉnh pixel phải giữ nguyên khung, kích thước và timing của biến thể cha.');
    s.run.variants.push(v); s.run.selectedVariantId = v.id;
    s.run.message = 'Đã lưu biến thể chỉnh pixel. Xem trước rồi áp dụng thành asset mới.';
    this.emit(s); return this.get(id);
  }
  private emit(s: RecordState): void { try { this.options.emit?.(this.get(s.run.id)); } catch { /* A disconnected SSE consumer cannot break lifecycle ownership. */ } }
  private release(s: RecordState): void {
    if (!s.released) { s.released = true; s.lease.release(); }
    const pending = s.lateCleanup.splice(0);
    for (const cleanup of pending) { try { cleanup(); } catch { s.lateCleanup.push(cleanup); } }
  }
  private check(s: RecordState): void {
    if (s.cancelRequested || this.closed) throw new Aborted();
    if (performance.now() >= s.deadlineTick - this.limits.stop) throw new Error('Hết tổng ngân sách tạo chất lượng.');
    s.lease.check(); this.ports.assertCurrent(s.run.projectId, s.run.revision);
  }
  start(input: QualityStartInput): QualityRun {
    if (this.closed || this.closingProjects.has(input.projectId)) throw new Error('Bộ tạo chất lượng hoặc dự án đang đóng.');
    dataId(input.projectId, 'Dự án chất lượng'); dataNumber(input.revision, 0, Number.MAX_SAFE_INTEGER, 'Revision chất lượng', true);
    if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 12000 || typeof input.style !== 'string' || input.style.length > 4000) throw new Error('Yêu cầu cần 1–12.000 ký tự; hồ sơ mỹ thuật tối đa 4.000 ký tự.');
    const frozen = structuredClone(input), lease = this.ports.acquire(input.projectId);
    try {
      this.ports.assertCurrent(input.projectId, input.revision);
      while (this.records.size >= 20) {
        const old = [...this.records.values()].find(s => s.released && !['running', 'canceling', 'unknown'].includes(s.run.status));
        if (!old) throw new Error('Đã có 20 lượt tạo đang được giữ; đóng lượt cũ trước khi tạo tiếp.');
        this.dispose(old.run.id);
      }
      const started = Date.now();
      const run: QualityRun = { version: 1, id: randomUUID(), projectId: input.projectId, revision: input.revision, status: 'running', stage: 'preparing', started, deadline: started + this.limits.total, cliCalls: 0, technicalRepairs: 0, message: 'Đang chụp và kiểm tra ngữ cảnh…', calls: [], variants: [] };
      const startedTick = performance.now();
      const state: RecordState = { run, input: frozen, lease, released: false, startedTick, deadlineTick: startedTick + this.limits.total, callTicks: new Map(), cancelRequested: false, terminalIntent: 'canceled', lateCleanup: [] };
      this.records.set(run.id, state); this.emit(state);
      state.background = this.run(state); return this.get(run.id);
    } catch (e) { lease.release(); throw e; }
  }
  private async work<T>(s: RecordState, task: QualityOwnedTask<T>, deadline: number, timeoutMessage: string, late?: (value: T) => () => void): Promise<T> {
    s.active = task;
    let abort!: (reason: Error) => void;
    const aborted = new Promise<never>((_, reject) => { abort = reject; }); s.abort = abort;
    const timer = setTimeout(() => { void this.cancel(s.run.id, timeoutMessage, 'failed'); }, Math.max(0, deadline - performance.now()));
    const watched = task.promise.then(value => {
      if (s.cancelRequested) {
        const cleanup = late?.(value);
        if (cleanup) { if (s.released) cleanup(); else s.lateCleanup.push(cleanup); }
        throw new Aborted();
      }
      return value;
    });
    try {
      const value = await Promise.race([watched, aborted]);
      if (performance.now() >= deadline) { await this.cancel(s.run.id, timeoutMessage, 'failed'); throw new Aborted(); }
      return value;
    }
    finally { clearTimeout(timer); if (!s.cancelRequested) s.active = undefined; if (s.abort === abort) s.abort = undefined; }
  }
  private instruction(s: RecordState, role: QualityRole, repair: string): string {
    const p = s.prepared!, base = p.base;
    if (p.templateScope) {
      const task = role === 'director' ? 'Xem ảnh nguồn và lập chỉ đạo theo các layer đã chọn. Đưa tọa độ và mảng màu cần sửa vào description. Cho phép raster nếu cần thay nét raster của layer đã chọn.'
        : role === 'builder' ? 'Sửa nét của layer đã chọn trong vùng bằng patches theo partId. Mỗi patch thay toàn bộ paint của layer đó; giữ các lệnh cần giữ. Trả decision patch và ít nhất một thay đổi nhìn thấy.'
          : 'Đối chiếu ảnh nguồn và ảnh dựng ở 1×. Nếu cần chỉnh, chỉ patch paint của layer đã chọn theo partId. Giữ các chỉnh sửa tốt đã có. Trả keep nếu đã đúng.';
      return `${task} Giữ nguyên layer khác, frame, palette và pixel ngoài vùng. Dùng tọa độ canvas gốc, giá trị màu là chỉ số palette. Phạm vi đã duyệt: ${JSON.stringify(p.templateScope)}\nPhong cách: ${s.input.style}\nYêu cầu: ${s.input.prompt}\n${repair}`;
    }
    if (p.characterFinishStudy && role === 'builder') {
      if (!s.toneComparison) throw new Error('Thiếu so sánh sắc độ đã dựng.');
      return `Choose a colour finish for this pixel character. A softens small highlights, B joins small interior shadow colours, C preserves the draft values. All keep the silhouette and A or B can have zero changes when no safe small adjustment exists. Rendered measurements (luma 0–255; strong difference means at least 32 from the original): ${JSON.stringify(s.toneComparison)}. Use these counts to choose a restrained finish. Prefer C if a change has no clear value. Art style: ${s.input.style.slice(0, 180)}. Return exactly {"finish":"A"}, {"finish":"B"}, or {"finish":"C"}. ${repair ? 'The previous answer was invalid; use only the allowed JSON object.' : ''}`;
    }
    if (p.characterFinishStudy && role === 'director') {
      const palette = base.palette.map(rgba => '#' + rgba.toString(16).padStart(8, '0'));
      const side = Math.max(base.canvas.w, base.canvas.h);
      const proportions = side <= 32 ? 'At 1× the helm, shoulder armour and two boots should read as distinct masses. Keep visible gaps between the legs and between the arm and torso. Make room for the main equipment when blocking the figure: if drawing a sword, distinguish the hand, guard and blade, with more than one pixel across its broadest visible section. If drawing a shield, show its face and a held edge without masking the torso and legs. Give the face one compact value cluster under the brim.'
        : 'Block out the head, shoulders, waist, hips and supporting heel before painting. For a grounded RPG human build, aim for five to six head heights from the skull to the soles, excluding hat or plume. Start the legs near mid-height and place the hip of the loaded leg above its planted foot. Shape thigh, knee and shin separately; show the ankle with a short boot toe in the same perspective. Give the weight-bearing knee and forearm an overlapping joint instead of a gap. Keep the face readable under the brow and reserve broad highlight clusters for metal planes.';
      const drawing = `Canvas ${base.canvas.w}×${base.canvas.h}, origin top left. Palette by index: ${palette.join(' ')}.
Style: ${s.input.style}\nSubject: ${s.input.prompt}
${proportions} Connect neck into collar and grip into the hand with visible overlap. Put thin outlines on the outer silhouette and at necessary overlaps; join inner surfaces by color masses instead of outlining each part. Use upper-left light, no dithering. Keep steel blue-grey, red cloth muted, and face warm but restrained where the palette permits. Put each part's main material first and list only the ramp colors used, with at least three visible steps in a main material.
${repair}`;
      if (drawing.length > 250_000) throw new Error('Ngữ cảnh chất lượng quá lớn; giảm mô tả.');
      return drawing;
    }
    const side = Math.max(base.canvas.w, base.canvas.h);
    const staticDetail = !p.structureLocked && !p.terrainReview && base.frames.length === 1 && side <= 128;
    const materialStudy = staticDetail && !p.characterStudy && side <= 64;
    const metadata = { name: base.name, canvas: base.canvas, pivot: base.pivot, loop: base.loop, frames: base.frames.map(({ id, durationMs }) => ({ id, durationMs })),
      palette: base.palette.map((rgba, index) => ({ index, rgba, hex: '#' + rgba.toString(16).padStart(8, '0'), ...(materialStudy ? { luma: luma8(rgba) } : {}) })), parts: base.parts.map(({ paint: _, ...part }) => part), materials: base.materials, resources: p.context, structureLocked: p.structureLocked };
    const craft = `Dựng trực tiếp theo lưới pixel gốc; không resize, blur, gradient, dithering hoặc thêm màu ngoài palette. ${p.terrainReview ? 'Ưu tiên các mảng bề mặt liền nhau và giữ ánh sáng nhất quán từ trên trái.' : 'Ưu tiên silhouette, cluster rõ; viền mảnh, ánh sáng trên trái và 2–3 sắc độ mỗi vật liệu.'} Cấu hình canvas/palette/frame/timing là bắt buộc; mô tả chỉ bổ sung nội dung. Nguồn raster chỉ dùng qua ID/mask được cung cấp, không đoán lại từng pixel nguồn. Không sửa dự án thật hay tạo mã JavaScript.`;
    const task = role === 'director' ? p.structureLocked
      ? 'Xem ảnh nguồn và lập chỉ đạo ngắn về nơi cần chỉnh nét hoặc khớp. Trả version, description và allowedOperations. Studio giữ sẵn cấu trúc bộ phận/vật liệu. Cấp quyền pixels nếu cần dùng frame.pixelEdits sau khi render chuyển động.'
      : 'Lập cấu trúc bộ phận/vật liệu và các thao tác paint được phép, trả đúng JSON chỉ đạo. Không tự duyệt rig hay thay cấu trúc đã khóa. Cấp quyền pixels nếu cần dọn pixel cục bộ trên frame sau khi render chuyển động.'
      : role === 'builder' ? p.structureLocked
        ? 'Giữ nguồn chuyển động đã duyệt. Trả quyết định giữ nguyên hoặc các bản sửa paint/pixelEdits cần thiết, dùng ID bộ phận hoặc frame hiện có. Mỗi bản sửa thay toàn bộ danh sách paint hoặc pixelEdits tương ứng. Giữ rig, pose, timing và mọi phần không cần sửa.'
        : p.characterStudy ? 'Dựng nhân vật ở tư thế đứng qua các lệnh paint theo partId. Studio tự ghép part theo thứ tự đã chốt từ sau ra trước. Tất cả tọa độ theo lưới canvas chung.'
          : 'Dựng một AssetRecipe theo đúng chỉ đạo và cấu hình; trả JSON đề xuất. Mọi part dùng tọa độ nghỉ chung. Nếu đã có rig, pose nền neutral; MotionPlan đã duyệt quyết định chuyển động. Sau render chuyển động có thể dùng frame.pixelEdits ({x,y là số nguyên tọa độ canvas, color là INDEX palette hoặc null}) mà không đổi pose neutral; mỗi frame thay toàn bộ danh sách sửa hiện có nên giữ lại các sửa cũ không liên quan.'
        : p.characterFinishStudy ? 'BẮT BUỘC xem ảnh PNG thực được đính kèm. Ở 1× kiểm tra dáng chịu lực, vùng hở giữa hai chân và điểm nắm. Nếu chỉ lệch vị trí một cụm nối với thân, dùng shift thay vì vẽ lại trang bị cùng cụm. Dùng tối đa 8 patch shift, paint hoặc touchups trên partId hiện có. Giữ canvas, palette, quan hệ lớp, frame và timing. Nếu các khối đã rõ ở 1×, trả keep. Không cần đọc file.'
          : 'BẮT BUỘC xem ảnh PNG/frame thực được đính kèm. So với nguồn và cấu hình. Xác nhận giữ hoặc thay part paint HOẶC frame pixelEdits, tối đa 8 patch cộng lại, một lần. Frame pixelEdits chỉ khi chỉ đạo đã cấp quyền pixels; mỗi patch thay toàn bộ danh sách sửa của frame nên giữ các sửa cũ không liên quan. Đọc ngữ cảnh và xem movement-mask/protected-frame PNG khi có. Không thay rig/pose/timing/palette, không chấm điểm đẹp, không lặp đánh giá. Có thể đọc candidate-recipe.json trong bản sao ngữ cảnh để giữ phần không sửa.';
    const staticArt = !staticDetail || p.characterStudy ? '' : role === 'director'
      ? 'Chốt dáng tổng thể, các mảng sáng tối tạo thể tích và dấu hiệu nhận diện từng vật liệu trước khi đặt chi tiết. Nếu có nhãn/ký hiệu, chừa đủ diện tích để vật liệu chính vẫn đọc rõ ở 1×, trừ khi yêu cầu nói rõ nhãn là chủ thể.'
      : role === 'builder'
        ? 'Dựng các mảng vật liệu chính đủ lớn để đọc ở 1×. Giữ các bước sáng–gốc–bóng liền mảng đúng hướng sáng; dùng điểm sáng và ký hiệu như điểm nhấn theo tỷ lệ đã chốt.'
        : `Xem bản 1× và review-detail-${side <= 64 ? 4 : 2}x.png. Bản phóng giữ từng pixel; mọi tọa độ patch vẫn theo canvas gốc. Kiểm tra cụ thể dáng, thể tích, vật liệu chính và chi tiết có lấn át vật liệu hay không. Nếu có lỗi thấy rõ ở 1× và sửa được trong cấu trúc đã duyệt, trả patch cục bộ. Mô tả chi tiết nhìn thấy đã kiểm tra và lỗi còn lại nếu giữ bản dựng.`;
    const materialArt = !materialStudy ? '' : role === 'director'
      ? 'Chốt dấu hiệu nhận diện vật liệu chính. Với lọ kính, xác định vai lọ, vùng kính phía trên mặt chất lỏng và vị trí nhãn. Chọn sắc độ kính từ palette cho phía bắt sáng và mép phía khuất sáng để phần trên vẫn đọc là kính ở 1×. Với khiên, ghi tỷ lệ rộng/cao cùng tọa độ vai, mũi và độ dày mép vát trong mô tả chỉ đạo để builder giữ đúng dáng. Khi hai mặt kim loại cần tách rõ ở 1×, chọn hai màu palette có luma (độ sáng xám 0–255) cách nhau đủ để mỗi mặt đọc thành một mảng. Dành sắc độ riêng cho mép vát nếu palette cho phép. Cấp quyền pixels khi cần vẽ cụm mép hoặc mảng sáng theo lưới gốc.'
      : role === 'builder'
        ? 'Dựng độ dày và hướng mặt bằng những mảng liền đủ rõ ở 1×. Với lọ kính, nối một vệt phản sáng hẹp từ vai theo mép trên trái. Giữ mép phải tối hơn và phân biệt mảng kính phía trên với mặt chất lỏng; tránh phủ cả vai bằng một màu phẳng. Với khiên, dựng vai và mép vát có độ dày theo dáng đã chốt; nối đường bao liên tục tới mũi, kiểm tra các bậc pixel ở phần thuôn. Với kim loại có hai mặt, để hai mảng sáng tối có thể phân biệt qua màu của chính hai mảng; giữ họa tiết hay đinh tán ở vai trò điểm nhấn.'
        : 'Xem review-shape-value.png để tách kiểm tra đường bao ở trái và mảng sáng tối ở phải. Nếu khối chính còn phẳng hoặc chi tiết che vật liệu, ưu tiên sửa paint của phần chính trước nhãn/họa tiết/đinh tán. Với lọ kính, kiểm tra ở 1× phần trên mặt chất lỏng có đọc là kính hay thành một khối xám phẳng. Nếu phẳng, chỉnh cục bộ mảng bắt sáng phía trái và mép khuất sáng theo vai lọ; giữ mặt chất lỏng và rune đã rõ. Với khiên, đối chiếu vai, tỷ lệ rộng/cao và độ dày mép với dáng đã chốt. Kiểm tra đường bao ở phần thuôn và mũi trên cả ảnh màu và silhouette; sửa khe hở, pixel thừa hoặc bậc gãy làm mũi lệch. Trước khi sửa đường gờ giữa hai mặt kim loại, đối chiếu luma của hai mảng. Khi độ sáng gần nhau khiến hai mặt khó tách, chỉnh sắc độ một mảng bằng palette đã duyệt rồi xử lý đường gờ. Đối chiếu lại với ảnh màu. Hai ảnh chẩn đoán phóng 2×, dùng bản gốc để lấy tọa độ và màu.';
    const characterArt = !p.characterStudy ? '' : role === 'director'
      ? `Trong description, chốt góc nhìn theo yêu cầu và các mốc theo pixel gốc: đỉnh đầu, cằm, vai, eo, hông, gối, đế giày và chỗ tay cầm đồ. Tách phần đầu, thân, chân và đạo cụ thành các part để chỉnh được từng cụm. Xếp danh sách parts theo thứ tự che khuất từ sau ra trước, vì Studio sẽ dựng theo thứ tự này. Vẽ cổ áo chồng rõ với cằm và vai. Đặt hông trên điểm chống và dành khoảng âm rõ giữa hai chân cũng như quanh tay cầm. Chọn ramp riêng cho da, giáp, vải khi có. ${side <= 32 ? 'Dành pixel cho dáng đứng gọn và trang bị dễ đọc. Nếu có khiên, chừa phần ngực và chân nhìn rõ. Nếu có thép, ưu tiên xanh xám và điểm sáng có chủ ý khi palette cho phép.' : 'Giữ tỷ lệ đầu–thân–chân tự nhiên, vị trí cổ áo và độ dày tay chân nhất quán với góc nhìn.'} Cấp quyền pixels cho cụm chi tiết ở kích thước gốc.`
      : role === 'builder'
        ? `Dựng dáng theo mốc đã chốt. Cho cổ chồng vào vai, tay nối đúng khuỷu/cổ tay, cán đồ chồng qua bàn tay, hai ủng đọc riêng. Tạo chuyển sắc từ cằm xuống cổ giáp để đầu nối rõ với thân ở 1×. Giữ viền ngoài mảnh phía sáng. Chia giáp thành mặt bắt sáng và mặt khuất sáng bằng mảng liền. Giữ khe chân và vùng quanh chuôi sạch khi chồng các lớp. ${side <= 32 ? 'Gom cụm lớn, giảm điểm sáng lẻ trên mặt, khiên và giày.' : side <= 64 && base.palette.length <= 16 ? 'Dùng hàng pixel ngắn để nắn đường bao, mặt và chỗ nối giáp.' : 'Dùng polygon gọn cho mặt giáp, nếp vải và nét mặt đơn giản. Dành điểm nhấn cho cụm vật liệu chính.'} Polygon cần ít nhất ba điểm. Với nét hai đầu, dùng line hoặc pixels nếu chỉ đạo cho phép. Trả JSON gọn, ưu tiên mảng màu lớn và cụm sửa nhỏ.`
        : `Xem ảnh 1×, review-detail-${side <= 64 ? 4 : 2}x.png và review-shape-value.png. Kiểm tra cổ–vai liền mạch trên cả silhouette lẫn mảng sáng tối. Kiểm tra chân chịu lực, tay bám đạo cụ, khoảng âm và màu thừa ở các mép chồng. ${p.characterFinishStudy ? 'Bắt đầu từ tỷ lệ và tư thế. Xem các crop thực tế nếu có. Nếu mặt, tay hoặc khớp còn dính thành một mảng ở 1×, dùng touchups để tách lại các khối đó trước khi thêm điểm sáng. Sửa lại cả paint của bộ phận nếu đường viền hoặc tỷ lệ của nó cần thay đổi. Giữ các phần đã rõ và dùng tọa độ gốc của canvas.' : 'Chọn một hoặc hai lỗi thị giác lớn nhất còn sửa được rồi trả patch tối thiểu theo tọa độ gốc. Giữ các chi tiết đã rõ.'}`;
    const outline = !staticDetail || p.characterStudy || side <= 64 ? '' : role === 'director'
      ? 'Phân biệt viền ngoài với đường tiếp giáp vật liệu. Chỉ tăng độ đậm ở chỗ khuất sáng hoặc cần phân tách hình.'
      : role === 'builder'
        ? 'Giữ viền ngoài mảnh tại chỗ bắt sáng. Dùng mảng bóng theo vật liệu cho khớp và chi tiết trong hình để tránh đường đen dày bao quanh từng bộ phận.'
        : 'Kiểm tra riêng viền ngoài ở phía sáng và đường tối giữa các bộ phận. Sửa chỗ viền dày nuốt mảng sáng hoặc chia vụn vật liệu; giữ các mép cần thiết để đọc dáng.';
    const motionArt = p.structureLocked && role === 'reviewer' ? 'Đối chiếu frame liên tiếp theo thứ tự trái sang phải, trên xuống dưới. Với clip loop, xem cả chuyển tiếp cuối–đầu. Kiểm tra chân trôi, khớp đứt và bàn tay rời đạo cụ trên ảnh gốc. Khi có review-motion-guide.png, xanh lá đánh dấu điểm chống dự kiến, vàng là điểm chống theo rig đã dựng, xanh lam là socket gắn bộ phận. Đối chiếu các dấu với pixel thực. Màu dấu chỉ để xem; mọi patch vẫn theo canvas gốc, góc trên trái mỗi frame là (0,0).' : '';
    const terrainArt = !p.terrainReview ? '' : role === 'reviewer'
      ? 'Xem review-terrain-repeat.png (ô lặp 3×3, phóng 2×) và review-terrain-map.png (bản đồ mẫu autotile ở 1×). Kiểm tra đường nối ngang, dọc và giao điểm bốn ô. Với đá, xem các phiến có tiếp tục xuyên biên và khe ghép có đổi hướng tự nhiên qua chỗ lặp. Sửa dải viền sáng/tối hoặc khung chữ nhật chạy theo lưới ô; giữ độ tương phản khe ghép vừa phải để đá đọc thành một bề mặt liền. Trên bản đồ, phân biệt khoảng trống từ bố cục với mảng tối bên trong vật liệu. Nếu ô đá trông như có một miệng hang, hốc tối lặp lại hoặc sọc đen, chỉnh mảng đó thành khối đá hay đường ghép phiến. Với cỏ–đất, nếu dải cỏ rộng hết ô lặp thành vạch qua từng hàng bản đồ, chia dải thành các cụm so le nối với rễ. Giữ đường cỏ thẳng nếu người dùng yêu cầu một ô mép bệ như vậy. Giữ độ trong suốt và màu theo yêu cầu. Toạ độ patch thuộc ô gốc.'
      : 'Thiết kế một ô vật liệu phủ bề mặt liền mạch. Cho cụm đất, đá hoặc cỏ nối tự nhiên qua mép. Với đá–hang, dựng nhiều phiến đá bất quy tắc với đường ghép có độ tương phản vừa; đường bao và lòng hang do bố cục autotile tạo. Một số phiến và khe ghép phải chạy xuyên biên ô để ảnh lặp thành bề mặt liên tục. Phân bố mảng bắt sáng theo từng phiến, dọn các dải sáng/tối tạo thành khung ô. Tránh vẽ miệng hang, sọc đen hoặc một hốc tối lớn trong ô vật liệu. Với bề mặt cỏ–đất, dùng cụm cỏ ở độ cao so le, nối rễ với chân cụm và chừa các mảng đất liền. Chỉ kéo một dải cỏ thẳng hết chiều rộng khi mô tả yêu cầu ô mép bệ thẳng. Giữ yêu cầu về mép và độ trong suốt trong mô tả.';
    const artNotes = [staticArt, materialArt, characterArt, outline, motionArt, terrainArt].filter(Boolean).join('\n');
    const { construction: _construction, ...approvedDirection } = s.director ?? {};
    const text = `${craft}\nVai: ${role}. ${task}${artNotes ? '\n' + artNotes : ''}\nHồ sơ mỹ thuật: ${s.input.style}\nYêu cầu: ${s.input.prompt}\nCấu hình/nguồn: ${JSON.stringify(metadata)}\n${s.director ? 'Chỉ đạo đã chốt: ' + JSON.stringify(approvedDirection) : ''}\n${repair}`;
    if (text.length > 250_000) throw new Error('Ngữ cảnh chất lượng quá lớn; giảm bộ phận hoặc số frame.');
    return text;
  }
  private async role(s: RecordState, role: QualityRole, reviewImages: QualityImage[] = [], reviewNotes = ''): Promise<QualityValidated> {
    const deadlineTick = Math.min(performance.now() + this.limits[role], s.deadlineTick - this.limits.stop);
    const characterReview = s.prepared!.characterStudy && role === 'reviewer';
    const characterFinishStep = s.prepared!.characterFinishStudy
      ? role === 'director' ? 'construction' : role === 'builder' ? 'choice' : 'touchups'
      : undefined;
    const canvas = s.prepared!.base.canvas;
    const blockout = characterFinishStep === 'construction' ? characterBlockoutGuide(canvas.w, canvas.h) : undefined;
    const materialGuide = blockout && (canvas.w === 64 || canvas.w === 128) ? characterMaterialGuide(canvas.w) : undefined;
    const constructionImages = [blockout, materialGuide].filter(image => image !== undefined);
    // The reviewed recipe still has to pass local validation and rasterization within the same stage.
    const workerReserve = characterReview ? Math.min(10_000, this.limits.local, (deadlineTick - performance.now()) / 20) : 0;
    const providerDeadlineTick = deadlineTick - Math.max(0, workerReserve);
    const deadline = Date.now() + Math.max(0, providerDeadlineTick - performance.now());
    let repair = '';
    for (;;) {
      this.check(s);
      if (s.run.cliCalls >= QUALITY_MAX_CLI_CALLS || performance.now() >= providerDeadlineTick) throw new Error(`Hết số lượt hoặc ngân sách vai ${role}.`);
      const provider = QUALITY_PROVIDERS[role];
      const call: QualityCall = { id: randomUUID(), role, provider, transport: provider === 'deepseek' ? 'http' : 'cli', repair: Boolean(repair), started: Date.now(), deadline, status: 'running' };
      if (role === 'builder' && (s.prepared!.terrainReview || s.prepared!.characterStudy)) call.reasoningEffort = 'low';
      const tick = { start: performance.now(), end: undefined as number | undefined }; s.callTicks.set(call.id, tick);
      s.run.calls.push(call); s.run.cliCalls++; s.run.stage = role; s.run.message = repair ? `Đang sửa lỗi kỹ thuật của ${role} (lượt cuối)…` : `Đang chạy vai ${role}…`; this.emit(s);
      let output: string;
      try {
        const volumeNote = blockout ? '\nSee construction-volumes.png for large connected volumes, a supporting heel under the torso, and separate near/far and hand masses. This neutral diagram is drawn on the requested native grid. It has no character design or equipment. Use its principles to develop an original silhouette for the brief and its camera angle. Start each main part with one outer shape. Separate brow/face/neck, thigh/knee/boot and hand/grip so changes to those forms need not repaint the whole limb. Where an arm or boot crosses a cloak, give it a readable silhouette with a gap or distinct connected value mass. Paint large material planes before specular accents.' : '';
        const materialNote = materialGuide ? '\nSee construction-materials.png for two native material studies. Left: curved steel with a small bright plane and connected midtones that wrap toward the shadow. Right: cloth folds grouped into tapered clusters.'
          + (canvas.w === 64 ? ' The small steel piece at the right tests an open gap next to cloth. Use one connected mass for the breastplate, a narrower bright plane at its upper edge and a distinct shadow as it wraps toward the far side. Keep the far forearm a real volume with room for the wrist and hand.' : '')
          + ' Use those lighting ideas with the required palette, drawing new shapes for this subject. Keep specular accents smaller than the midtone areas. Use a few small planes at the collar, shoulder and knee, where the metal actually changes direction. Keep the largest area of each material coherent.' : '';
        const instruction = this.instruction(s, role, repair) + volumeNote + materialNote + (reviewNotes ? '\nChẩn đoán worker\n' + reviewNotes : '');
        const roleImages = images(characterFinishStep === 'construction' ? constructionImages : [...s.prepared!.sourceImages, ...reviewImages]);
        const result = await this.work(s, this.ports.execute({ role, provider: call.provider, callId: call.id, deadline, budgetMs: Math.max(0, Math.floor(providerDeadlineTick - performance.now())), instruction, snapshotId: s.prepared!.snapshotId, director: s.director ? structuredClone(s.director) : undefined, candidateId: s.candidate?.id, images: roleImages, ...(call.reasoningEffort ? { reasoningEffort: call.reasoningEffort } : {}), ...(s.prepared!.characterStudy && role === 'builder' ? { staticCharacterBuilder: true } : {}), ...(characterReview ? { staticCharacterReview: true } : {}), ...(characterFinishStep ? { characterFinishStep } : {}) }), providerDeadlineTick, `Vai ${role} vượt thời gian cho phép.`);
        output = result.output;
        const counters = Object.fromEntries(['input', 'output', 'cached'].flatMap(key => {
          const value = result.usage?.[key as 'input' | 'output' | 'cached'];
          return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? [[key, value]] : [];
        }));
        // The provider fixes the expected transport; a conflicting result fails this
        // call before validation instead of silently switching transports.
        if (result.transport !== undefined && result.transport !== call.transport) throw new QualityTechnicalError('Transport của kết quả không khớp provider đã chọn.');
        call.usage = Object.keys(counters).length ? counters : { unavailable: true };
        // Optional safe metadata only: bounded, printable model name; absent on old results.
        if (typeof result.model === 'string' && result.model.length > 0 && result.model.length <= 200 && !/[\u0000-\u001f\u007f-\u009f]/.test(result.model)) call.model = result.model;
        this.check(s); s.run.stage = 'validating'; s.run.message = `Đang kiểm tra dữ liệu và dựng ảnh của ${role}…`; this.emit(s);
      } catch (e) { if (s.cancelRequested) await s.cancellation; call.status = s.cancelRequested ? s.run.status === 'unknown' ? 'unknown' : s.terminalIntent === 'failed' ? 'failed' : 'canceled' : 'failed'; call.message = (s.cancelRequested ? s.run.message : (e as Error).message).slice(0, 2000); call.ended = Date.now(); tick.end = performance.now(); throw e; }
      try {
        const validated = await this.work(s, this.ports.validate(role, output, s.prepared!, s.director, s.candidate?.id), Math.min(deadlineTick, performance.now() + this.limits.local), `Dựng/kiểm tra vai ${role} vượt thời gian cho phép.`);
        this.check(s); call.status = 'succeeded'; call.ended = Date.now(); tick.end = performance.now(); this.emit(s); return validated;
      } catch (e) {
        if (s.cancelRequested) await s.cancellation;
        call.status = s.cancelRequested ? s.run.status === 'unknown' ? 'unknown' : s.terminalIntent === 'failed' ? 'failed' : 'canceled' : 'invalid'; call.message = (s.cancelRequested ? s.run.message : (e as Error).message).slice(0, 2000); call.ended = Date.now(); tick.end = performance.now();
        if (s.cancelRequested || !(e instanceof QualityTechnicalError) || s.run.technicalRepairs >= 1 || s.run.cliCalls >= QUALITY_MAX_CLI_CALLS || performance.now() >= deadlineTick) throw e;
        s.run.technicalRepairs++; repair = `Chỉ sửa JSON/lỗi dựng đã báo; giữ ý định trước, không đánh giá mỹ thuật thêm. Lỗi: ${(e as Error).message.slice(0, 3000)}\nKết quả trước: ${output.slice(0, 12000)}\nTrả kết quả hoàn chỉnh đúng schema một lần.`;
        this.emit(s);
      }
    }
  }
  private async run(s: RecordState): Promise<void> {
    try {
      this.check(s);
      s.prepared = await this.work(s, this.ports.prepare(s.input), Math.min(performance.now() + this.limits.local, s.deadlineTick - this.limits.stop), 'Chuẩn bị ngữ cảnh vượt thời gian.', value => { const id = value.snapshotId; return () => this.ports.drop(id); });
      // The canonical buffers now live in the immutable artifact store, not every retained job.
      s.input.context = null;
      this.check(s); dataId(s.prepared.snapshotId, 'Snapshot chất lượng');
      s.prepared.sourceImages = images(s.prepared.sourceImages);
      const { base, structureLocked, terrainReview } = s.prepared;
      s.prepared.characterStudy = !structureLocked && !s.prepared.templateScope && !terrainReview && base.frames.length === 1
        && !base.frames[0].poses.length && !base.frames[0].pixelEdits?.length
        && Math.max(base.canvas.w, base.canvas.h) <= 128 && base.parts.every(part => !part.paint.length) && isHumanoidSpritePrompt(s.input.prompt);
      s.prepared.characterFinishStudy = this.options.characterFinishStudy === true && s.prepared.characterStudy && base.palette.length >= 4;
      const director = await this.role(s, 'director');
      if (director.kind !== 'director') throw new Error('Kết quả chỉ đạo sai loại.');
      s.director = director.director; s.toneComparison = director.toneComparison;
      const builder = await this.role(s, 'builder');
      if (builder.kind !== 'variant' || builder.variant.kind !== 'builder') throw new Error('Kết quả dựng sai loại.');
      s.candidate = compactVariant(builder.variant); s.run.variants.push(structuredClone(s.candidate)); this.emit(s);
      const reviewed = await this.role(s, 'reviewer', builder.images, builder.reviewNotes);
      if (reviewed.kind !== 'variant' || reviewed.variant.kind !== 'reviewed') throw new Error('Kết quả kiểm tra ảnh sai loại.');
      this.check(s); const reviewedSummary = compactVariant(reviewed.variant); s.run.variants.push(reviewedSummary); s.run.selectedVariantId = reviewedSummary.id;
      s.run.status = 'ready'; s.run.stage = 'done'; s.run.message = 'Đã dựng và kiểm tra ảnh. Xem trước rồi áp dụng thành asset mới.';
    } catch (e) {
      if (s.cancelRequested) await s.cancellation;
      else { s.run.status = 'failed'; s.run.stage = 'done'; s.run.message = (e as Error).message.slice(0, 4000); }
    } finally {
      if (s.run.status !== 'unknown') this.release(s);
      if (s.run.status !== 'unknown') s.input.context = null;
      s.run.ended ??= Date.now(); s.endedTick ??= performance.now(); if (s.prepared) s.prepared.sourceImages = []; this.emit(s);
    }
  }
  async wait(id: string): Promise<QualityRun> { const s = this.state(id); await s.background; return this.get(id); }
  async cancel(id: string, reason = 'Đã hủy lượt tạo chất lượng.', intent: 'failed' | 'canceled' = 'canceled'): Promise<QualityRun> {
    const s = this.state(id);
    if (!['running', 'canceling', 'unknown'].includes(s.run.status)) return this.get(id);
    if (s.cancellation) { await s.cancellation; return this.get(id); }
    // A second cancellation follows stage=done while its HTTP call is still unknown.
    const latest = s.run.calls.at(-1);
    const pendingHttpBuilder = latest?.provider === 'deepseek' && latest.transport === 'http' && (latest.status === 'running' || latest.status === 'unknown');
    const pendingCodex = latest?.provider === 'codex' && (latest.status === 'running' || latest.status === 'unknown');
    if (!s.cancelRequested) { s.terminalIntent = intent; s.cancelReason = reason; }
    s.cancelRequested = true; s.run.status = 'canceling'; s.run.message = 'Đang dừng đúng tác vụ đang sở hữu…'; this.emit(s);
    const active = s.active, abort = s.abort;
    s.cancellation = (async () => {
      const stopMs = Math.max(0, Math.min(this.limits.stop, s.deadlineTick - performance.now())), deadline = Date.now() + stopMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let confirmed = !active;
      if (active) {
        try { confirmed = await Promise.race([active.stop(deadline), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), stopMs); })]); }
        catch { confirmed = false; } finally { clearTimeout(timer); }
      }
      s.run.status = confirmed ? s.terminalIntent : 'unknown'; s.run.stage = 'done'; s.run.ended = Date.now(); s.endedTick = performance.now();
      const diagnosis = active?.diagnostic?.().slice(0, 1500);
      s.run.message = confirmed
        ? pendingHttpBuilder
          ? `${s.cancelReason!.slice(0, 2000)} ${diagnosis || 'Yêu cầu cục bộ đã dừng; nếu yêu cầu đã gửi thì chưa xác nhận được DeepSeek đã ngừng xử lý/tính phí.'}`
          : pendingCodex && s.terminalIntent === 'failed' && diagnosis ? `${s.cancelReason} ${diagnosis}` : s.cancelReason!
        : `${s.cancelReason!.slice(0, 2000)} Chưa xác nhận tác vụ/tiến trình con đã dừng; khóa dự án vẫn được giữ. ${diagnosis ?? ''}`;
      for (const call of s.run.calls) if (call.status === 'running' || call.status === 'unknown') { call.status = confirmed ? s.terminalIntent === 'failed' ? 'failed' : 'canceled' : 'unknown'; call.ended = Date.now(); const t = s.callTicks.get(call.id); if (t) t.end = performance.now(); }
      if (confirmed) { s.active = undefined; s.input.context = null; this.release(s); }
      abort?.(new Aborted()); this.emit(s);
    })();
    try { await s.cancellation; } finally { s.cancellation = undefined; }
    return this.get(id);
  }
  dispose(id: string): void {
    const s = this.state(id); if (!s.released || ['running', 'canceling', 'unknown'].includes(s.run.status)) throw new Error('Chưa thể giải phóng lượt tạo đang chạy/chưa xác nhận dừng.');
    if (s.prepared) this.ports.drop(s.prepared.snapshotId);
    for (const cleanup of s.lateCleanup) cleanup();
    s.lateCleanup = []; this.records.delete(id);
  }
  async closeProject(projectId: string): Promise<void> {
    const existing = this.closingProjects.get(projectId); if (existing) return existing;
    const promise = Promise.resolve().then(async () => {
      for (const run of this.list(projectId)) {
        await this.cancel(run.id);
        const state = this.state(run.id);
        if (state.run.status !== 'unknown') {
          if (state.prepared && this.ports.drain) {
            const deadline = Date.now() + this.limits.stop;
            let timer: ReturnType<typeof setTimeout> | undefined;
            let confirmed = false;
            try { confirmed = await Promise.race([this.ports.drain(state.prepared.snapshotId, deadline), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), this.limits.stop); })]); }
            finally { clearTimeout(timer); }
            if (!confirmed) throw new Error('Chưa xác nhận worker xem trước đã dừng; giữ snapshot.');
          }
          this.dispose(run.id);
        }
      }
    });
    this.closingProjects.set(projectId, promise);
    try { await promise; } finally { this.closingProjects.delete(projectId); }
  }
  async close(): Promise<void> { this.closed = true; for (const project of new Set([...this.records.values()].map(s => s.run.projectId))) await this.closeProject(project); }
}
