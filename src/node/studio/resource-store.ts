import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import { safePath, StudioError } from './store.ts';
import {
  type ResourceKind,
  type StudioResource,
  type ResourceRef,
  validateResource,
  validateResourceRef,
  validateResourceMap,
  resourceBytes,
  resourcePixels,
} from '../../studio/resources.ts';

export function resourceRefKey(kind: ResourceKind, digest: string): string {
  return `${kind}:${digest}`;
}

export function parseResourceRefKey(key: string): { kind: ResourceKind; digest: string } {
  const idx = key.indexOf(':');
  if (idx === -1) throw new StudioError('Khóa tài nguyên không hợp lệ.', 400);
  const kind = key.slice(0, idx) as ResourceKind;
  const digest = key.slice(idx + 1);
  if (kind !== 'rgba' && kind !== 'mask' && kind !== 'tile-index') {
    throw new StudioError('Loại tài nguyên không hợp lệ.', 400);
  }
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new StudioError('Digest blob không hợp lệ.', 400);
  }
  return { kind, digest };
}

const RECOGNIZED_KEY_GRAMMAR = /^(([a-f0-9]{64})|(rgba|mask|tile-index):([a-f0-9]{64})|([a-f0-9]{64})\.(rgba|mask|tile-index)(\.z)?)$/;

export class ResourceBlobStore {
  readonly projectDir: string;
  private readonly checksumCache = new Map<string, string>();
  private readonly validationCache = new Map<string, string>();

  constructor(projectDir: string) {
    if (!projectDir || typeof projectDir !== 'string') {
      throw new StudioError('Đường dẫn thư mục dự án không hợp lệ.', 400);
    }
    this.projectDir = existsSync(projectDir) ? realpathSync(projectDir) : resolve(projectDir);
  }

  private setCache(cache: Map<string, string>, key: string, value: string): void {
    cache.set(key, value);
    if (cache.size > 8192) {
      cache.delete(cache.keys().next().value!);
    }
  }

  refKey(resource: { kind: ResourceKind; blob?: string }): string {
    if (!resource.blob) throw new StudioError('Tài nguyên thiếu blob.', 400);
    return resourceRefKey(resource.kind, resource.blob);
  }

  private blobPath(kind: ResourceKind, digest: string): string {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new StudioError('Blob digest không hợp lệ.', 400);
    if (kind !== 'rgba' && kind !== 'mask' && kind !== 'tile-index') {
      throw new StudioError('Loại tài nguyên không hợp lệ.', 400);
    }
    return safePath(this.projectDir, join('.pxl', 'resources', `${digest}.${kind}.z`));
  }

  private atomicWrite(path: string, data: Uint8Array): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  }

  private verifyChecksum(kind: ResourceKind, digest: string): { path: string; data: Buffer } {
    const path = this.blobPath(kind, digest);
    if (!existsSync(path)) throw new StudioError('Tài nguyên bị thiếu hoặc bị xóa.', 404);
    const s = statSync(path);
    const signature = `${s.mtimeMs}:${s.ctimeMs}:${s.size}`;
    const cacheKey = `${kind}:${path}`;

    if (this.checksumCache.get(cacheKey) === signature) {
      return { path, data: readFileSync(path) };
    }

    const data = readFileSync(path);
    const computed = createHash('sha256').update(data).digest('hex');
    if (computed !== digest) {
      throw new StudioError('Tài nguyên bị sai checksum hoặc hỏng.', 409);
    }

    this.setCache(this.checksumCache, cacheKey, signature);
    return { path, data };
  }

  private verifyShape(reference: ResourceRef): Buffer {
    validateResourceRef(reference);
    const { path, data } = this.verifyChecksum(reference.kind, reference.blob);
    const total = reference.w * reference.h;
    const s = statSync(path);
    const signature = `${s.mtimeMs}:${s.ctimeMs}:${s.size}`;
    const cacheKey = `${reference.kind}:${reference.blob}:${total}`;

    if (this.validationCache.get(cacheKey) === signature) {
      return data;
    }

    let decompressed: Buffer;
    try {
      decompressed = inflateSync(data, { maxOutputLength: total * 4 });
    } catch {
      throw new StudioError('Giải nén tài nguyên thất bại hoặc vượt quá kích thước cho phép.', 400);
    }
    if (decompressed.length !== total * 4) {
      throw new StudioError('Kích thước tài nguyên giải nén không khớp.', 400);
    }
    if (reference.kind === 'mask') {
      const pixels = resourcePixels(decompressed);
      for (let i = 0; i < pixels.length; i++) {
        if (pixels[i] !== 0 && pixels[i] !== 1) {
          throw new StudioError('Mặt nạ chứa giá trị không phải 0 hoặc 1.', 400);
        }
      }
    }

    this.setCache(this.validationCache, cacheKey, signature);
    return data;
  }

  verify(kind: ResourceKind, digest: string, totalPixels?: number): string {
    const { path, data } = this.verifyChecksum(kind, digest);
    if (totalPixels !== undefined) {
      if (typeof totalPixels !== 'number' || !Number.isInteger(totalPixels) || totalPixels < 1 || totalPixels > 16_777_216) {
        throw new StudioError('Số lượng điểm ảnh dự kiến không hợp lệ.', 400);
      }
      const s = statSync(path);
      const signature = `${s.mtimeMs}:${s.ctimeMs}:${s.size}`;
      const cacheKey = `${kind}:${digest}:${totalPixels}`;

      if (this.validationCache.get(cacheKey) !== signature) {
        let decompressed: Buffer;
        try {
          decompressed = inflateSync(data, { maxOutputLength: totalPixels * 4 });
        } catch {
          throw new StudioError('Giải nén tài nguyên thất bại hoặc vượt quá kích thước cho phép.', 400);
        }
        if (decompressed.length !== totalPixels * 4) {
          throw new StudioError('Kích thước tài nguyên giải nén không khớp.', 400);
        }
        if (kind === 'mask') {
          const pixels = resourcePixels(decompressed);
          for (let i = 0; i < pixels.length; i++) {
            if (pixels[i] !== 0 && pixels[i] !== 1) {
              throw new StudioError('Mặt nạ chứa giá trị không phải 0 hoặc 1.', 400);
            }
          }
        }
        this.setCache(this.validationCache, cacheKey, signature);
      }
    }
    return path;
  }

  put(resource: StudioResource): { version: 1; kind: ResourceKind; w: number; h: number; blob: string } {
    validateResource(resource);
    let digest: string;

    if (resource.data) {
      const rawBytes = resourceBytes(resource.data);
      const compressed = deflateSync(rawBytes);
      digest = createHash('sha256').update(compressed).digest('hex');
      if (resource.blob && resource.blob !== digest) {
        throw new StudioError('Blob digest không khớp với dữ liệu được cung cấp.', 400);
      }
      const path = this.blobPath(resource.kind, digest);
      if (existsSync(path)) {
        // Verify existing on-disk file before trusting or caching to prevent cache poisoning
        const existingData = readFileSync(path);
        const existingDigest = createHash('sha256').update(existingData).digest('hex');
        if (existingDigest !== digest) {
          throw new StudioError('File tài nguyên đã tồn tại trên đĩa bị hỏng hoặc sai checksum.', 409);
        }
      } else {
        this.atomicWrite(path, compressed);
      }
      const s = statSync(path);
      const signature = `${s.mtimeMs}:${s.ctimeMs}:${s.size}`;
      this.setCache(this.checksumCache, `${resource.kind}:${path}`, signature);
      this.setCache(this.validationCache, `${resource.kind}:${digest}:${resource.w * resource.h}`, signature);
    } else if (resource.blob) {
      digest = resource.blob;
      // Blob-only put must strictly verify shape and contents
      this.verifyShape({
        version: 1,
        kind: resource.kind,
        w: resource.w,
        h: resource.h,
        blob: digest,
      });
    } else {
      throw new StudioError('Tài nguyên phải có ít nhất data hoặc blob.', 400);
    }

    return {
      version: 1,
      kind: resource.kind,
      w: resource.w,
      h: resource.h,
      blob: digest,
    };
  }

  read(reference: unknown): Uint32Array {
    validateResourceRef(reference);
    const compressed = this.verifyShape(reference);
    const total = reference.w * reference.h;
    let decompressed: Buffer;
    try {
      decompressed = inflateSync(compressed, { maxOutputLength: total * 4 });
    } catch {
      throw new StudioError('Giải nén tài nguyên thất bại hoặc vượt quá kích thước cho phép.', 400);
    }
    return resourcePixels(decompressed);
  }

  compressed(reference: unknown): Buffer {
    validateResourceRef(reference);
    return this.verifyShape(reference);
  }

  import(
    reference: { version?: number; kind: ResourceKind; w: number; h: number; blob?: string },
    compressedData: unknown
  ): { version: 1; kind: ResourceKind; w: number; h: number; blob: string } {
    if (!reference || typeof reference !== 'object' || Array.isArray(reference)) {
      throw new StudioError('Tham chiếu tài nguyên nhập không hợp lệ.', 400);
    }
    if (reference.blob !== undefined) {
      validateResourceRef(reference as ResourceRef);
    } else {
      validateResourceRef({ ...reference, blob: '0'.repeat(64) });
    }
    if (!compressedData || !(compressedData instanceof Uint8Array)) {
      throw new StudioError('Dữ liệu nén không hợp lệ.', 400);
    }

    const digest = createHash('sha256').update(compressedData).digest('hex');
    if (reference.blob && reference.blob !== digest) {
      throw new StudioError('Checksum dữ liệu nén không khớp với blob tham chiếu.', 400);
    }

    const total = reference.w * reference.h;
    let decompressed: Buffer;
    try {
      decompressed = inflateSync(compressedData, { maxOutputLength: total * 4 });
    } catch {
      throw new StudioError('Giải nén dữ liệu nhập thất bại hoặc vượt quá kích thước cho phép.', 400);
    }
    if (decompressed.length !== total * 4) {
      throw new StudioError('Kích thước giải nén không khớp w*h.', 400);
    }
    if (reference.kind === 'mask') {
      const pixels = resourcePixels(decompressed);
      for (let i = 0; i < pixels.length; i++) {
        if (pixels[i] !== 0 && pixels[i] !== 1) {
          throw new StudioError('Mặt nạ chứa giá trị không phải 0 hoặc 1.', 400);
        }
      }
    }

    const path = this.blobPath(reference.kind, digest);
    if (existsSync(path)) {
      // Verify existing file before trusting or caching to prevent cache poisoning
      const existingData = readFileSync(path);
      const existingDigest = createHash('sha256').update(existingData).digest('hex');
      if (existingDigest !== digest) {
        throw new StudioError('File tài nguyên đã tồn tại trên đĩa bị hỏng hoặc sai checksum.', 409);
      }
    } else {
      this.atomicWrite(path, compressedData);
    }

    const s = statSync(path);
    const signature = `${s.mtimeMs}:${s.ctimeMs}:${s.size}`;
    this.setCache(this.checksumCache, `${reference.kind}:${path}`, signature);
    this.setCache(this.validationCache, `${reference.kind}:${digest}:${total}`, signature);

    return {
      version: 1,
      kind: reference.kind,
      w: reference.w,
      h: reference.h,
      blob: digest,
    };
  }

  collect(
    usedKeys: unknown,
    olderThan?: unknown
  ): { retained: number; deleted: number; errors: number } {
    if (!usedKeys || typeof usedKeys !== 'object') {
      throw new StudioError('usedKeys không hợp lệ: phải là Set, mảng hoặc danh sách tài nguyên.', 400);
    }

    const usedSet = new Set<string>();

    if (usedKeys instanceof Set || Array.isArray(usedKeys)) {
      for (const k of usedKeys) {
        if (typeof k !== 'string' || !RECOGNIZED_KEY_GRAMMAR.test(k)) {
          throw new StudioError(`Khóa tài nguyên trong usedKeys không hợp lệ: "${String(k)}".`, 400);
        }
        usedSet.add(k);
        const m1 = /^([a-f0-9]{64})$/.exec(k);
        if (m1) {
          usedSet.add(m1[1]);
        } else {
          const m2 = /^(rgba|mask|tile-index):([a-f0-9]{64})$/.exec(k);
          if (m2) {
            usedSet.add(m2[2]);
            usedSet.add(`${m2[2]}.${m2[1]}.z`);
            usedSet.add(`${m2[2]}.${m2[1]}`);
          } else {
            const m3 = /^([a-f0-9]{64})\.(rgba|mask|tile-index)(\.z)?$/.exec(k);
            if (m3) {
              usedSet.add(m3[1]);
              usedSet.add(`${m3[2]}:${m3[1]}`);
              usedSet.add(`${m3[1]}.${m3[2]}.z`);
              usedSet.add(`${m3[1]}.${m3[2]}`);
            }
          }
        }
      }
    } else {
      const proto = Object.getPrototypeOf(usedKeys);
      if (proto !== Object.prototype && proto !== null) {
        throw new StudioError('usedKeys không hợp lệ: chỉ chấp nhận Set, Array hoặc plain object resource map.', 400);
      }
      try {
        validateResourceMap(usedKeys);
      } catch (err) {
        throw new StudioError((err as Error).message, 400);
      }
      for (const res of Object.values(usedKeys as Record<string, StudioResource>)) {
        if (res && res.blob) {
          usedSet.add(res.blob);
          usedSet.add(`${res.kind}:${res.blob}`);
          usedSet.add(`${res.blob}.${res.kind}.z`);
          usedSet.add(`${res.blob}.${res.kind}`);
        }
      }
    }

    let cutoff: number;
    if (olderThan === undefined) {
      cutoff = Date.now() - 24 * 3600 * 1000;
    } else if (olderThan instanceof Date) {
      const time = olderThan.getTime();
      if (!Number.isFinite(time)) {
        throw new StudioError('Thời gian olderThan không hợp lệ (Invalid Date).', 400);
      }
      cutoff = time;
    } else if (typeof olderThan === 'number') {
      if (!Number.isFinite(olderThan) || olderThan < 0) {
        throw new StudioError('Thời gian olderThan phải là số hữu hạn không âm.', 400);
      }
      cutoff = olderThan > 1_000_000_000_000 ? olderThan : Date.now() - olderThan;
    } else {
      throw new StudioError('olderThan không hợp lệ.', 400);
    }

    if (!Number.isFinite(cutoff)) {
      throw new StudioError('Thời điểm cutoff không hợp lệ.', 400);
    }

    const pxlDir = safePath(this.projectDir, '.pxl');
    if (existsSync(pxlDir) && lstatSync(pxlDir).isSymbolicLink()) {
      throw new StudioError('Không theo junction/symlink tài nguyên.', 403);
    }
    const dir = safePath(this.projectDir, join('.pxl', 'resources'));
    if (!existsSync(dir)) return { retained: 0, deleted: 0, errors: 0 };
    if (lstatSync(dir).isSymbolicLink()) {
      throw new StudioError('Không theo junction/symlink tài nguyên.', 403);
    }

    let retained = 0;
    let deleted = 0;
    let errors = 0;

    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      let lstat;
      try {
        lstat = lstatSync(fullPath);
      } catch {
        errors++;
        continue;
      }

      // Preserve symlinks: do not follow, do not delete
      if (lstat.isSymbolicLink()) {
        retained++;
        continue;
      }

      // Only delete regular files
      if (!lstat.isFile()) {
        retained++;
        continue;
      }

      // Strictly match owned pattern: <64-hex>.<kind>.z
      const match = /^([a-f0-9]{64})\.(rgba|mask|tile-index)\.z$/.exec(entry.name);
      if (!match) {
        retained++;
        continue;
      }

      const digest = match[1];
      const kind = match[2];
      const refKey = `${kind}:${digest}`;

      if (
        usedSet.has(entry.name) ||
        usedSet.has(refKey) ||
        usedSet.has(digest) ||
        usedSet.has(`${digest}.${kind}`)
      ) {
        retained++;
        continue;
      }

      if (lstat.mtimeMs >= cutoff) {
        retained++;
        continue;
      }

      try {
        unlinkSync(fullPath);
        deleted++;
      } catch {
        errors++;
      }
    }

    return { retained, deleted, errors };
  }
}
