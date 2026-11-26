import { summarizeReviewScores } from './rubrics.ts';
import {
  ART_REVIEW_REPORT_KIND,
  ART_REVIEW_SCHEMA_VERSION,
  ART_REVIEW_TOOL_VERSION,
  type AlignmentConfig,
  type AssetFamily,
  type AssetReferenceSnapshot,
  type CriterionScore,
  type CriterionSeverity,
  type LoadedAsset,
  type RegionNote,
  type ReviewDecision,
  type ReviewSessionData,
  type RubricDefinition,
} from './types.ts';

const VALID_FAMILIES: ReadonlySet<string> = new Set([
  'character',
  'prop',
  'terrain',
  'environment',
  'animation',
  'ui',
  'vfx',
]);
const VALID_DECISIONS: ReadonlySet<string> = new Set(['undecided', 'baseline', 'candidate', 'neither']);
const VALID_SEVERITIES: ReadonlySet<string> = new Set(['none', 'minor', 'major', 'critical']);
const VALID_MODES: ReadonlySet<string> = new Set(['top-left', 'center', 'bottom-center', 'pivot', 'manual']);

export function createAssetReferenceSnapshot(asset?: LoadedAsset): AssetReferenceSnapshot | undefined {
  if (!asset) return undefined;
  return {
    slot: asset.slot,
    name: asset.name,
    fileName: asset.fileName,
    sourceSha256: asset.sourceSha256,
    metadataFileName: asset.metadataFileName,
    metadataSha256: asset.metadataSha256,
    frameWidth: asset.width,
    frameHeight: asset.height,
    sourceWidth: asset.sourceWidth,
    sourceHeight: asset.sourceHeight,
    frameCount: asset.frames.length,
    frameDurationsMs: asset.frames.map(f => f.durationMs),
    timingSource: asset.timingSource,
    pivot: asset.pivot ? { x: asset.pivot.x, y: asset.pivot.y } : undefined,
  };
}

export function createEmptyReviewSession(
  assetFamily: AssetFamily,
  rubric: RubricDefinition,
): ReviewSessionData {
  const scores: Record<string, CriterionScore> = {};
  for (const criterion of rubric.families[assetFamily]) {
    scores[criterion.id] = { score: null, severity: 'none', note: '' };
  }
  return {
    schemaVersion: ART_REVIEW_SCHEMA_VERSION,
    kind: ART_REVIEW_REPORT_KIND,
    toolVersion: ART_REVIEW_TOOL_VERSION,
    timestamp: new Date().toISOString(),
    assetFamily,
    rubricId: rubric.id,
    rubricName: rubric.name,
    rubricVersion: rubric.version,
    rubricIsWorkbenchDefault: rubric.isWorkbenchDefault,
    alignment: { mode: 'top-left', offsetX: 0, offsetY: 0, confirmed: false },
    decision: 'undecided',
    summaryNote: '',
    scores,
    regionNotes: [],
  };
}

export function serializeReviewJson(session: ReviewSessionData): string {
  const output: ReviewSessionData = {
    ...session,
    schemaVersion: ART_REVIEW_SCHEMA_VERSION,
    kind: ART_REVIEW_REPORT_KIND,
    toolVersion: ART_REVIEW_TOOL_VERSION,
    timestamp: session.timestamp || new Date().toISOString(),
  };
  return JSON.stringify(output, null, 2);
}

function validateAlignment(raw: unknown): AlignmentConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Review JSON có trường "alignment" không hợp lệ.');
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.mode !== 'string' || !VALID_MODES.has(obj.mode)) {
    throw new Error(`Chế độ căn chỉnh không hợp lệ: ${String(obj.mode)}.`);
  }
  if (typeof obj.offsetX !== 'number' || typeof obj.offsetY !== 'number' || !Number.isFinite(obj.offsetX) || !Number.isFinite(obj.offsetY)) {
    throw new Error('Tọa độ offset căn chỉnh phải là số hữu hạn.');
  }
  return {
    mode: obj.mode as AlignmentConfig['mode'],
    offsetX: Math.trunc(obj.offsetX),
    offsetY: Math.trunc(obj.offsetY),
    confirmed: Boolean(obj.confirmed),
  };
}

function validateRef(raw: unknown, expectedSlot: 'baseline' | 'candidate'): AssetReferenceSnapshot | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Review JSON có "${expectedSlot}Ref" không hợp lệ.`);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.fileName !== 'string' || !obj.fileName) {
    throw new Error(`"${expectedSlot}Ref" thiếu fileName.`);
  }
  if (
    typeof obj.frameWidth !== 'number' ||
    typeof obj.frameHeight !== 'number' ||
    !Number.isInteger(obj.frameWidth) ||
    !Number.isInteger(obj.frameHeight) ||
    obj.frameWidth < 1 ||
    obj.frameHeight < 1
  ) {
    throw new Error(`"${expectedSlot}Ref" có kích thước frame không hợp lệ.`);
  }
  if (!Array.isArray(obj.frameDurationsMs) || obj.frameDurationsMs.some(d => typeof d !== 'number' || !Number.isFinite(d) || d < 1)) {
    throw new Error(`"${expectedSlot}Ref" có frameDurationsMs không hợp lệ.`);
  }
  return {
    slot: expectedSlot,
    name: typeof obj.name === 'string' && obj.name ? obj.name : obj.fileName,
    fileName: obj.fileName,
    sourceSha256: typeof obj.sourceSha256 === 'string' ? obj.sourceSha256 : undefined,
    metadataFileName: typeof obj.metadataFileName === 'string' ? obj.metadataFileName : undefined,
    metadataSha256: typeof obj.metadataSha256 === 'string' ? obj.metadataSha256 : undefined,
    frameWidth: obj.frameWidth,
    frameHeight: obj.frameHeight,
    sourceWidth: typeof obj.sourceWidth === 'number' && obj.sourceWidth >= 1 ? obj.sourceWidth : obj.frameWidth,
    sourceHeight: typeof obj.sourceHeight === 'number' && obj.sourceHeight >= 1 ? obj.sourceHeight : obj.frameHeight,
    frameCount: typeof obj.frameCount === 'number' && obj.frameCount >= 1 ? obj.frameCount : obj.frameDurationsMs.length,
    frameDurationsMs: obj.frameDurationsMs.map(d => Math.round(d as number)),
    timingSource:
      obj.timingSource === 'metadata' || obj.timingSource === 'explicit-default' || obj.timingSource === 'single-frame'
        ? obj.timingSource
        : 'single-frame',
    pivot:
      obj.pivot && typeof obj.pivot === 'object' && typeof (obj.pivot as Record<string, unknown>).x === 'number' && typeof (obj.pivot as Record<string, unknown>).y === 'number'
        ? {
            x: Math.trunc((obj.pivot as Record<string, number>).x),
            y: Math.trunc((obj.pivot as Record<string, number>).y),
          }
        : undefined,
  };
}

/** Parse and validate an exported Review JSON file. Throws descriptive errors on invalid JSON/schema. */
export function parseReviewJson(text: string): ReviewSessionData {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`Review JSON không hợp lệ: ${(err as Error).message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Review JSON phải là object.');
  }
  const obj = raw as Record<string, unknown>;
  if (obj.kind !== ART_REVIEW_REPORT_KIND) {
    throw new Error(`Review JSON không đúng định dạng "${ART_REVIEW_REPORT_KIND}".`);
  }
  if (obj.schemaVersion !== ART_REVIEW_SCHEMA_VERSION) {
    throw new Error(`Phiên bản Review schema không được hỗ trợ: ${String(obj.schemaVersion)}.`);
  }
  if (typeof obj.assetFamily !== 'string' || !VALID_FAMILIES.has(obj.assetFamily)) {
    throw new Error(`Asset family không hợp lệ: ${String(obj.assetFamily)}.`);
  }
  if (typeof obj.decision !== 'string' || !VALID_DECISIONS.has(obj.decision)) {
    throw new Error(`Quyết định review không hợp lệ: ${String(obj.decision)}.`);
  }
  if (!obj.scores || typeof obj.scores !== 'object' || Array.isArray(obj.scores)) {
    throw new Error('Review JSON thiếu trường "scores".');
  }
  if (!Array.isArray(obj.regionNotes)) {
    throw new Error('Review JSON thiếu mảng "regionNotes".');
  }

  const scores: Record<string, CriterionScore> = {};
  for (const [id, entry] of Object.entries(obj.scores as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Điểm tiêu chí "${id}" không hợp lệ.`);
    }
    const item = entry as Record<string, unknown>;
    const score = item.score === null || item.score === undefined ? null : Number(item.score);
    if (score !== null && (!Number.isInteger(score) || score < 0 || score > 10)) {
      throw new Error(`Giá trị điểm "${id}" không hợp lệ.`);
    }
    const severity = typeof item.severity === 'string' && VALID_SEVERITIES.has(item.severity) ? item.severity : 'none';
    scores[id] = {
      score,
      severity: severity as CriterionSeverity,
      note: typeof item.note === 'string' ? item.note : '',
    };
  }

  const regionNotes: RegionNote[] = obj.regionNotes.map((entry, idx) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`regionNotes[${idx}] không hợp lệ.`);
    }
    const n = entry as Record<string, unknown>;
    if (typeof n.x !== 'number' || typeof n.y !== 'number' || !Number.isFinite(n.x) || !Number.isFinite(n.y)) {
      throw new Error(`regionNotes[${idx}] thiếu tọa độ x/y hợp lệ.`);
    }
    const slot = n.slot === 'baseline' || n.slot === 'candidate' || n.slot === 'diff' ? n.slot : 'candidate';
    const severity = typeof n.severity === 'string' && VALID_SEVERITIES.has(n.severity) ? n.severity : 'minor';
    return {
      id: typeof n.id === 'string' && n.id ? n.id : `note-${idx + 1}`,
      slot,
      frameIndex: typeof n.frameIndex === 'number' && Number.isInteger(n.frameIndex) && n.frameIndex >= 0 ? n.frameIndex : 0,
      x: Math.trunc(n.x),
      y: Math.trunc(n.y),
      width: typeof n.width === 'number' && n.width >= 1 ? Math.trunc(n.width) : 1,
      height: typeof n.height === 'number' && n.height >= 1 ? Math.trunc(n.height) : 1,
      criterionId: typeof n.criterionId === 'string' ? n.criterionId : undefined,
      severity: severity as CriterionSeverity,
      note: typeof n.note === 'string' ? n.note : '',
    };
  });

  return {
    schemaVersion: ART_REVIEW_SCHEMA_VERSION,
    kind: ART_REVIEW_REPORT_KIND,
    toolVersion: typeof obj.toolVersion === 'string' ? obj.toolVersion : ART_REVIEW_TOOL_VERSION,
    timestamp: typeof obj.timestamp === 'string' ? obj.timestamp : new Date().toISOString(),
    assetFamily: obj.assetFamily as AssetFamily,
    rubricId: typeof obj.rubricId === 'string' ? obj.rubricId : 'imported',
    rubricName: typeof obj.rubricName === 'string' ? obj.rubricName : 'Imported Rubric',
    rubricVersion: typeof obj.rubricVersion === 'string' ? obj.rubricVersion : '1.0.0',
    rubricIsWorkbenchDefault: Boolean(obj.rubricIsWorkbenchDefault),
    baselineRef: validateRef(obj.baselineRef, 'baseline'),
    candidateRef: validateRef(obj.candidateRef, 'candidate'),
    alignment: obj.alignment ? validateAlignment(obj.alignment) : { mode: 'top-left', offsetX: 0, offsetY: 0, confirmed: false },
    decision: obj.decision as ReviewDecision,
    summaryNote: typeof obj.summaryNote === 'string' ? obj.summaryNote : '',
    scores,
    regionNotes,
    diffStats:
      obj.diffStats && typeof obj.diffStats === 'object' && !Array.isArray(obj.diffStats)
        ? (obj.diffStats as ReviewSessionData['diffStats'])
        : undefined,
  };
}

function decisionLabel(decision: ReviewDecision): string {
  switch (decision) {
    case 'baseline':
      return 'A — Baseline (Chọn bản A)';
    case 'candidate':
      return 'B — Candidate (Chọn bản B)';
    case 'neither':
      return 'Neither (Không đạt — yêu cầu làm lại / chỉnh sửa)';
    case 'undecided':
      return 'Undecided (Chưa kết luận — Human decision pending)';
  }
}

function formatAssetRefMarkdown(title: string, ref?: AssetReferenceSnapshot): string {
  if (!ref) return `- **${title}:** *(Chưa nạp)*`;
  const parts = [
    `**File:** \`${ref.fileName}\``,
    `**Frame:** ${ref.frameWidth}×${ref.frameHeight} (${ref.frameCount} frame, nguồn ${ref.sourceWidth}×${ref.sourceHeight})`,
    `**Timing:** [${ref.frameDurationsMs.join(', ')}] ms (${ref.timingSource})`,
  ];
  if (ref.pivot) parts.push(`**Pivot:** (${ref.pivot.x}, ${ref.pivot.y})`);
  if (ref.sourceSha256) parts.push(`**SHA-256:** \`${ref.sourceSha256}\``);
  if (ref.metadataFileName) {
    parts.push(
      `**Metadata:** \`${ref.metadataFileName}\`${ref.metadataSha256 ? ` (\`${ref.metadataSha256}\`)` : ''}`,
    );
  }
  return `- **${title} (${ref.name}):** ${parts.join(' · ')}`;
}

/** Export human-readable Markdown report without automatic PASS or average-score masking. */
export function renderReviewMarkdown(session: ReviewSessionData, rubric: RubricDefinition): string {
  const criteria = rubric.families[session.assetFamily] ?? [];
  const summary = summarizeReviewScores(criteria, session.scores, session.regionNotes);
  const lines: string[] = [
    `# Art Review Report — ${session.assetFamily}`,
    '',
    `- **Timestamp:** ${session.timestamp}`,
    `- **Tool Version:** LumaSprite Studio Art Review Workbench v${session.toolVersion}`,
    `- **Asset Family:** \`${session.assetFamily}\``,
    `- **Rubric:** ${session.rubricName} (\`${session.rubricId}\` v${session.rubricVersion})${session.rubricIsWorkbenchDefault ? ' — Workbench default (không phải E7 Universal Quality Contract v1)' : ''}`,
    `- **Human Decision:** **${decisionLabel(session.decision)}**`,
    `- **Critical Defects:** ${summary.hasCriticalDefect ? `YES (${summary.criticalCriteriaIds.length} tiêu chí, ${summary.criticalRegionCount} ghim vùng)` : 'None recorded'}`,
    `- **Score Range:** ${summary.scoredCount}/${summary.totalCount} tiêu chí đã chấm${summary.minScore !== null ? ` · Min ${summary.minScore}, Max ${summary.maxScore} (không dùng điểm trung bình để che lỗi)` : ''}`,
    '',
    '## Asset References',
    formatAssetRefMarkdown('A — Baseline', session.baselineRef),
    formatAssetRefMarkdown('B — Candidate', session.candidateRef),
    '',
    '## Alignment & Pixel Diff Summary',
    `- **Alignment:** mode=\`${session.alignment.mode}\`, offset=(${session.alignment.offsetX}, ${session.alignment.offsetY}), confirmed=${session.alignment.confirmed ? 'yes' : 'no'}`,
  ];

  if (session.diffStats) {
    const d = session.diffStats;
    lines.push(
      `- **Pixel Diff:** changed=${d.changedPixels}/${d.totalUnionPixels} px (RGB diff=${d.rgbDiffPixels}, Alpha-only diff=${d.alphaDiffPixels}, Only-A=${d.onlyAPixels}, Only-B=${d.onlyBPixels}, max Δ=${d.maxChannelDelta})`,
    );
  } else {
    lines.push('- **Pixel Diff:** *(Chưa tính hoặc chưa đối chiếu hai ảnh)*');
  }

  lines.push('', '## Human Score Sheet', '| Tiêu chí | Điểm | Mức độ lỗi | Nhận xét |', '| --- | --- | --- | --- |');
  for (const c of criteria) {
    const s = session.scores[c.id] ?? { score: null, severity: 'none', note: '' };
    const scoreText = s.score === null ? '—' : `${s.score}/${c.maxScore}`;
    const safeNote = (s.note || '—').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
    lines.push(`| ${c.label} | ${scoreText} | ${s.severity} | ${safeNote} |`);
  }

  lines.push('', '## Region Notes');
  if (!session.regionNotes.length) {
    lines.push('*(Không có ghim vùng)*');
  } else {
    lines.push('| # | Slot | Frame | Tọa độ | Tiêu chí | Mức độ | Ghi chú |', '| --- | --- | --- | --- | --- | --- | --- |');
    session.regionNotes.forEach((note, index) => {
      const safeNote = note.note.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
      lines.push(
        `| ${index + 1} | ${note.slot} | #${note.frameIndex + 1} | (${note.x}, ${note.y}) ${note.width}×${note.height} | ${note.criterionId ?? '—'} | ${note.severity} | ${safeNote} |`,
      );
    });
  }

  lines.push('', '## Reviewer Summary Notes', session.summaryNote.trim() ? session.summaryNote.trim() : '*(Không có ghi chú tổng kết)*', '');
  return lines.join('\n');
}
