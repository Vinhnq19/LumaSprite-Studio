import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GenerationContext } from '../../studio/types.ts';
import type { ArtGuidanceSnapshot, ArtGuidanceInfo } from '../../studio/batch-types.ts';

export type ArtGuidanceMode = 'baseline' | 'skill-v1';
const resourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../skills/pxl-art/references');

export const isTerrainPrompt = (prompt: string): boolean => /\b(?:tileset|terrain|seamless|tile texture)\b|ô vật liệu|ô địa hình/iu.test(prompt);

export function isHumanoidSpritePrompt(prompt: string): boolean {
  const subject = prompt.trim()
    .replace(/^((?:create|draw|design)\s+)?(?:an?\s+)?(?:pixel(?: art)?\s+)?sprite\s+of\s+/iu, '')
    .split(/[,.!?;:\n]|\b(?:with|wearing|carrying|holding|for|of)\b|\s(?:cầm|mặc|đeo|cho|của)\s/iu, 1)[0];
  if (/\b(?:icon|sword|shield|helm(?:et)?|potion|weapon|item|portrait|bust|headshot)\b|kiếm|khiên|mũ giáp|vật phẩm|chân dung/iu.test(subject)) return false;
  return /\b(?:character|knight|travel(?:l)?er|warrior|adventurer|mage|wizard|rogue|ranger|humanoid)\b|nhân vật|hiệp sĩ|lữ khách|chiến binh|pháp sư/iu.test(subject);
}

/** Server-owned snapshot: never read a skill path or arbitrary text from HTTP. */
export function captureArtGuidance(mode: string = 'baseline', generation?: GenerationContext, prompt = '', root = resourceRoot): ArtGuidanceSnapshot {
  if (mode !== 'baseline' && mode !== 'skill-v1') throw new Error('PXL_ART_GUIDANCE chỉ nhận baseline hoặc skill-v1.');
  // Old viewer and source-only requests retain their original prompt contract.
  const id = generation ? mode : 'baseline';
  const topic = generation?.animation || generation?.clip ? 'animation'
    : isTerrainPrompt(prompt) ? 'terrain' : 'sprite';
  const text = id === 'baseline' ? '' : ['core', topic].map(name => {
    const content = readFileSync(resolve(root, name + '.md'), 'utf8').trim();
    if (!content || content.length > 12000) throw new Error(`Tài liệu skill ${name} rỗng hoặc quá dài.`);
    return content;
  }).join('\n\n');
  return Object.freeze({ id, topic, hash: createHash('sha256').update(id + '\n' + topic + '\n' + text).digest('hex'), text });
}

export function guidanceInfo(snapshot: ArtGuidanceSnapshot): ArtGuidanceInfo {
  return { id: snapshot.id, topic: snapshot.topic, hash: snapshot.hash };
}

export function withArtGuidance(prompt: string, snapshot: ArtGuidanceSnapshot): string {
  if (!snapshot.text) return prompt;
  return `${prompt}\nPIXEL CRAFT GUIDANCE (${snapshot.id}, ${snapshot.topic}):\nThese are craft suggestions. The explicit user request and resolved canvas, palette, light, mask, frame count, timing and frozen frames above take precedence. Do not change them to satisfy a suggestion. Keep the JSON-only proposal and existing tool/call limits.\n${snapshot.text}\nEND PIXEL CRAFT GUIDANCE`;
}
