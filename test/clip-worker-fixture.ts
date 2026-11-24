// Parent-owned temporary inputs for independent actual-thread clip acceptance.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { clipProcessingFixture } from './clip-processing-fixture.ts';
import { PixelStore } from '../src/node/studio/pixel-store.ts';
import { celFor, duplicateFrame } from '../src/studio/pixel/model.ts';
import { recaptureCharacterProfile, approveCharacterProfile } from '../src/studio/character-commands.ts';

export function savedClipFixture(mode: 'region' | 'whole' = 'region', nonfirstSource = false) {
  const root = mkdtempSync(join(tmpdir(), 'pxl-clip-worker-independent-'));
  const store = new PixelStore(root), f = clipProcessingFixture(mode);
  try {
    if (nonfirstSource) {
      const sourceFrame = duplicateFrame(f.source, f.source.frames[0].id, 'copy');
      const image = celFor(f.source, f.source.layers[0].id, sourceFrame)!.data!;
      image[0] = 0xffffffff; image[9] = 0x000000ff;
      f.source.metadata.events = [{ frame: 0, name: 'ngoài nguồn' }, { frame: 1, name: 'từ frame 2' }];
      f.character.source.frameId = sourceFrame;
      recaptureCharacterProfile(f.document, f.character.id);
      approveCharacterProfile(f.document, f.character.id);
    }
    const saved = store.create(f.document.name, 4, 3, 0, f.document);
    const manifest = join(store.dir(saved.id), 'pxl.project.json'), originalManifest = readFileSync(manifest);
    return { ...f, root, store, saved, manifest, originalManifest, close: () => {
      store.releaseResources();
      if (resolve(dirname(root)) !== resolve(tmpdir()) || !root.split(/[\\/]/).at(-1)!.startsWith('pxl-clip-worker-independent-')) throw new Error('Unexpected test root');
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    } };
  } catch (error) {
    if (resolve(dirname(root)) === resolve(tmpdir()) && root.split(/[\\/]/).at(-1)!.startsWith('pxl-clip-worker-independent-')) rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    throw error;
  }
}
