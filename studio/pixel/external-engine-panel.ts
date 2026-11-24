import type { EngineCapabilities } from '../../src/studio/engine-adapter.ts';
import type { PixelDocument } from '../../src/studio/pixel/model.ts';
import { api, type Session } from './session.ts';

interface Job {
  id: string; state: string; revision: number;
  progress?: { completed: number; total: number };
  version?: string; problem?: string;
}
interface Preview { w: number; h: number; rgba: Uint32Array; version: string; digest: string }
const active = (job?: Job) => !!job && ['submitting', 'queued', 'running', 'canceling'].includes(job.state);
const labels: Record<string, string> = {
  submitting: 'Đang gửi', queued: 'Đang xếp hàng', running: 'Đang chạy', ready: 'Sẵn sàng duyệt',
  failed: 'Lỗi', canceled: 'Đã hủy', timedout: 'Hết thời hạn', unknown: 'Chưa xác định',
  canceling: 'Đang hủy', rejected: 'Đã từ chối', applied: 'Đã áp dụng',
  character: 'Nhân vật', prop: 'Đồ vật', icon: 'Biểu tượng',
};

export class ExternalEnginePanel {
  private path = '';
  private caps?: EngineCapabilities;
  private job?: Job;
  private preview?: Preview;
  private timer?: ReturnType<typeof setTimeout>;
  private busy = false;
  private visible = false;
  private readonly host: HTMLElement;
  private readonly session: Session;
  private readonly prepare: () => Promise<void>;
  private readonly selection: () => Uint8Array | undefined;
  private readonly apply: (path: string, value: Record<string, unknown>) => Promise<PixelDocument>;
  private readonly applied: (saved: PixelDocument) => Promise<void>;
  private get checked() { return this.el<HTMLInputElement>('approved'); }

  constructor(
    host: HTMLElement, session: Session, prepare: () => Promise<void>, selection: () => Uint8Array | undefined,
    apply: (path: string, value: Record<string, unknown>) => Promise<PixelDocument>, applied: (saved: PixelDocument) => Promise<void>,
  ) {
    this.host = host;
    this.session = session;
    this.prepare = prepare;
    this.selection = selection;
    this.apply = apply;
    this.applied = applied;
    host.innerHTML = `
      <form class="external-engine-form">
        <p id="external-engine-connection" role="status"></p>
        <button id="external-engine-connect" type="button">Kiểm tra kết nối</button>
        <label>Loại asset <select id="external-engine-kind" required></select></label>
        <div class="row wrap">
          <label>Rộng <input id="external-engine-width" type="number" min="1" value="32" required></label>
          <label>Cao <input id="external-engine-height" type="number" min="1" value="32" required></label>
        </div>
        <label>Yêu cầu <textarea id="external-engine-brief" required maxlength="2000" rows="4"></textarea></label>
        <label id="external-engine-region-label" hidden><input type="checkbox" id="external-engine-region"> Chỉ sửa vùng chọn của frame hiện tại</label>
        <button class="primary" id="external-engine-submit" type="submit">Gửi job</button>
      </form>
      <section class="external-engine-results" aria-label="Kết quả External Engine">
        <label>Job gần đây <select id="external-engine-jobs"></select></label>
        <p id="external-engine-state" role="status"></p>
        <progress id="external-engine-progress" aria-label="Tiến độ engine" hidden></progress>
        <p id="external-engine-error" role="alert" hidden></p>
        <button id="external-engine-cancel" type="button" hidden>Hủy job</button>
        <div id="external-engine-review" hidden>
          <div class="row wrap">
            <h3>Candidate preview</h3>
            <label>Phóng <select id="external-engine-zoom"><option value="1">1×</option><option value="4">4×</option></select></label>
          </div>
          <div class="external-engine-preview"><canvas id="external-engine-canvas" role="img" aria-label="Ảnh xem trước engine"></canvas></div>
          <label><input type="checkbox" id="external-engine-approved"> Tôi duyệt ảnh đang xem</label>
          <button id="external-engine-apply" class="primary" type="button">Áp dụng thành asset mới</button>
        </div>
        <button id="external-engine-reject" type="button" hidden>Từ chối candidate</button>
      </section>`;
    host.querySelector('form')!.onsubmit = event => { event.preventDefault(); void this.run(() => this.submit()); };
    this.el('connect').onclick = () => void this.run(() => this.connect());
    this.el('cancel').onclick = () => void this.run(() => this.finish('cancel'));
    this.el('reject').onclick = () => void this.run(() => this.finish('reject'));
    this.el('apply').onclick = () => void this.run(() => this.accept());
    this.checked.onchange = () => this.render();
    this.el<HTMLSelectElement>('zoom').onchange = () => this.paint();
    this.el<HTMLSelectElement>('jobs').onchange = () => void this.run(async () => {
      const id = this.el<HTMLSelectElement>('jobs').value;
      this.setJob(id ? await api(`${this.path}/${id}`) : undefined);
      await this.poll(false);
    });
    this.el<HTMLInputElement>('region').onchange = event => {
      if (!(event.target as HTMLInputElement).checked || !this.session.asset) return;
      this.el<HTMLInputElement>('width').value = String(this.session.asset.w);
      this.el<HTMLInputElement>('height').value = String(this.session.asset.h);
    };
  }

  private el<T extends HTMLElement = HTMLElement>(id: string): T {
    return this.host.querySelector<T>(`#external-engine-${id}`)!;
  }

  async show() {
    const path = `${this.session.path}/external-engine`;
    if (this.path !== path) {
      this.path = path;
      this.host.querySelector('form')!.reset();
      this.setJob();
      this.caps = undefined;
    }
    this.visible = true;
    await this.run(async () => {
      this.el('connection').textContent = 'Đang kiểm tra kết nối…';
      const [engine] = await Promise.allSettled([this.connect(), this.loadJobs()]);
      if (this.job) await this.poll(false);
      if (engine.status === 'rejected') throw engine.reason;
    });
  }

  hide() {
    this.visible = false;
    clearTimeout(this.timer);
    this.checked.checked = false;
  }

  get isBusy() { return this.busy; }

  private async run(action: () => Promise<void>) {
    if (this.busy) return;
    this.busy = true;
    clearTimeout(this.timer);
    this.el('error').hidden = true;
    this.render();
    let completed = false;
    try { await action(); completed = true; }
    catch (error) {
      this.el('error').textContent = (error as Error).message;
      this.el('error').hidden = false;
    } finally {
      this.busy = false;
      this.render();
      if (completed && this.visible && active(this.job)) this.timer = setTimeout(() => void this.run(() => this.poll()), 350);
    }
  }

  private async connect() {
    this.caps = undefined;
    try {
      const { capabilities: caps, name }: { name: string; capabilities: EngineCapabilities } = await api(this.path);
      if (!caps.versions.includes(1) || !caps.features.includes('progress') || !caps.features.includes('previews')) throw Error('Engine thiếu protocol v1 hoặc capability bắt buộc.');
      this.caps = caps;
      this.el('connection').textContent = `${name} · v1 · tối đa ${caps.limits.width}×${caps.limits.height} · ${caps.limits.frames} frame · ${caps.features.join(', ')}`;
      const kind = this.el<HTMLSelectElement>('kind'), previous = kind.value;
      kind.replaceChildren(...caps.assetTypes.filter(type => Object.hasOwn(labels, type)).map(type => new Option(labels[type], type)));
      if (Array.from(kind.options).some(entry => entry.value === previous)) kind.value = previous;
      this.el<HTMLInputElement>('width').max = String(caps.limits.width);
      this.el<HTMLInputElement>('height').max = String(caps.limits.height);
    } catch (error) {
      this.el('connection').textContent = 'External Engine chưa kết nối được.';
      throw error;
    }
  }

  private setJob(job?: Job) {
    if (job?.id !== this.job?.id || job?.state !== 'ready') {
      this.preview = undefined;
      this.checked.checked = false;
    }
    this.job = job;
  }

  private async loadJobs() {
    const jobs: Job[] = await api(`${this.path}/jobs`);
    const select = this.el<HTMLSelectElement>('jobs');
    select.replaceChildren(new Option('Chọn job', ''), ...jobs.map(job => new Option(`${job.id.slice(0, 8)} · r${job.revision} · ${labels[job.state] ?? job.state}`, job.id)));
    if (!this.job && jobs.length) this.setJob(jobs[0]);
    select.value = this.job?.id ?? '';
  }

  private async submit() {
    await this.prepare();
    const region = this.el<HTMLInputElement>('region').checked;
    const mask = this.selection(), asset = this.session.asset;
    if (region && (!mask || !asset || mask.length !== asset.w * asset.h)) throw Error('Chọn vùng cần sửa trên canvas trước.');
    this.setJob(await api(`${this.path}/jobs`, 'POST', {
      revision: this.session.doc!.revision,
      assetType: this.el<HTMLSelectElement>('kind').value,
      brief: this.el<HTMLTextAreaElement>('brief').value,
      w: this.el<HTMLInputElement>('width').valueAsNumber, h: this.el<HTMLInputElement>('height').valueAsNumber,
      source: region && mask && asset ? { assetId: asset.id, frameId: this.session.frameId, mask: Array.from(mask) } : null,
    }));
    await this.loadJobs();
    await this.poll(false);
  }

  private async poll(refresh = true) {
    if (!this.job) return;
    if (refresh) this.setJob(await api(`${this.path}/${this.job.id}`));
    const job = this.job!;
    if (job.state === 'ready' && job.revision === this.session.doc?.revision && !this.preview) {
      try {
        this.preview = await api(`${this.path}/${job.id}/preview/${job.version}`);
        this.paint();
      } catch (error) {
        this.setJob(await api(`${this.path}/${job.id}`));
        throw error;
      }
    }
    const option = this.el<HTMLSelectElement>('jobs').selectedOptions[0];
    if (option) option.text = `${job.id.slice(0, 8)} · r${job.revision} · ${labels[job.state] ?? job.state}`;
  }

  private async finish(action: 'cancel' | 'reject') {
    if (!this.job) return;
    this.setJob(await api(`${this.path}/${this.job.id}/${action}`, 'POST', {}));
    await this.loadJobs();
  }

  private async accept() {
    const job = this.job, preview = this.preview;
    if (!job || !preview || !this.checked.checked) return;
    await this.prepare();
    await this.applied(await this.apply(`${this.path}/${job.id}/apply`, {
      approved: true, revision: job.revision, version: preview.version, digest: preview.digest,
    }));
    this.setJob({ ...job, state: 'applied' });
  }

  private paint() {
    const preview = this.preview;
    if (!preview) return;
    const canvas = this.el<HTMLCanvasElement>('canvas'), scale = Number(this.el<HTMLSelectElement>('zoom').value);
    canvas.width = preview.w;
    canvas.height = preview.h;
    canvas.style.width = `${preview.w * scale}px`;
    canvas.style.height = `${preview.h * scale}px`;
    const context = canvas.getContext('2d')!;
    const image = context.createImageData(preview.w, preview.h);
    preview.rgba.forEach((ink, i) => {
      image.data[i * 4] = ink >>> 24;
      image.data[i * 4 + 1] = (ink >>> 16) & 255;
      image.data[i * 4 + 2] = (ink >>> 8) & 255;
      image.data[i * 4 + 3] = ink & 255;
    });
    context.putImageData(image, 0, 0);
  }

  private render() {
    const job = this.job, stale = !!job && job.revision !== this.session.doc?.revision;
    const progress = this.el<HTMLProgressElement>('progress');
    progress.hidden = !job?.progress;
    if (job?.progress) { progress.max = job.progress.total; progress.value = job.progress.completed; }
    this.el('state').textContent = job ? [labels[job.state] ?? job.state, job.problem, stale && 'Revision đã thay đổi'].filter(Boolean).join(' · ') : 'Chưa chọn job.';
    this.el('review').hidden = !this.preview;
    this.el('cancel').hidden = !active(job) && job?.state !== 'unknown' && job?.state !== 'timedout';
    this.el('reject').hidden = job?.state !== 'ready';
    const region = this.el<HTMLInputElement>('region'), canEditRegion = !!this.caps?.features.includes('masks') && !!this.selection();
    this.el('region-label').hidden = !canEditRegion;
    if (!canEditRegion) region.checked = false;
    this.el<HTMLButtonElement>('submit').disabled = this.busy || !this.caps || !this.el<HTMLSelectElement>('kind').value || active(job);
    this.el<HTMLButtonElement>('apply').disabled = this.busy || stale || !this.preview || !this.checked.checked;
    for (const id of ['cancel', 'reject', 'jobs', 'connect']) this.el<HTMLButtonElement>(id).disabled = this.busy;
  }
}
