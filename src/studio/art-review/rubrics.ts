import type {
  AssetFamily,
  CriterionScore,
  RegionNote,
  RubricCriterion,
  RubricDefinition,
} from './types.ts';

export const DEFAULT_WORKBENCH_RUBRIC: RubricDefinition = {
  id: 'workbench-default-v1',
  name: 'Workbench Default Rubric',
  version: '1.0.0',
  isWorkbenchDefault: true,
  disclaimer:
    'Rubric mặc định của Art Review Workbench (độc lập, không phải Universal Quality Contract v1 chính thức của E7).',
  families: {
    character: [
      { id: 'silhouette', label: 'Silhouette (Hình bóng)', description: 'Độ nhận diện ngay ở 1× và trên ảnh silhouette.', maxScore: 5 },
      { id: 'proportions', label: 'Proportions (Tỉ lệ)', description: 'Tỉ lệ đầu, thân, chi và phụ kiện cân đối.', maxScore: 5 },
      { id: 'anatomy', label: 'Anatomy (Giải phẫu)', description: 'Cấu trúc khớp, vai, hông và hướng khối hợp lý.', maxScore: 5 },
      { id: 'pose', label: 'Pose (Tư thế)', description: 'Đường hành động rõ, không gượng hoặc bẹt.', maxScore: 5 },
      { id: 'materials', label: 'Materials (Vật liệu)', description: 'Tách biệt da, vải, kim loại, độ phản chiếu rõ.', maxScore: 5 },
      { id: 'pixel_clusters', label: 'Pixel clusters (Cụm pixel)', description: 'Cụm sạch, hạn chế nhiễu đơn pixel/jaggies.', maxScore: 5 },
    ],
    prop: [
      { id: 'recognition', label: 'Recognition (Nhận diện)', description: 'Đọc ra vật thể tức thì ở kích thước 1×.', maxScore: 5 },
      { id: 'volume', label: 'Volume (Khối)', description: 'Cảm giác 3D, sáng tối và độ dày hình khối.', maxScore: 5 },
      { id: 'perspective', label: 'Perspective (Phối cảnh)', description: 'Khớp góc nhìn dự án và trục đối xứng.', maxScore: 5 },
      { id: 'material_separation', label: 'Material separation (Tách chất liệu)', description: 'Phân biệt gỗ, kim loại, đá, kính bằng giá trị & hue.', maxScore: 5 },
      { id: 'contour', label: 'Contour (Đường viền)', description: 'Outline/sel-out mượt, không gãy bậc.', maxScore: 5 },
    ],
    terrain: [
      { id: 'tile_continuity', label: 'Tile continuity (Liền mạch ô)', description: 'Các ô nối không lộ đường cắt lặp cứng.', maxScore: 5 },
      { id: 'seam_quality', label: 'Seam quality (Chất lượng mép)', description: 'Mép góc/cạnh chuyển tiếp tự nhiên.', maxScore: 5 },
      { id: 'material_readability', label: 'Material readability (Độ đọc bề mặt)', description: 'Đất, đá, cỏ, nước rõ chất liệu và không rối.', maxScore: 5 },
      { id: 'depth_contrast', label: 'Depth & contrast (Chiều sâu & tương phản)', description: 'Không tranh nền với nhân vật gameplay.', maxScore: 5 },
      { id: 'grid_rhythm', label: 'Grid rhythm (Nhịp lưới)', description: 'Không tạo sọc lặp khó chịu khi lát diện tích lớn.', maxScore: 5 },
    ],
    environment: [
      { id: 'structure', label: 'Structure (Cấu trúc)', description: 'Kiến trúc/cảnh quan có kết cấu logic.', maxScore: 5 },
      { id: 'perspective', label: 'Perspective (Phối cảnh)', description: 'Đường chân trời, góc nghiêng đồng nhất.', maxScore: 5 },
      { id: 'depth', label: 'Depth (Chiều sâu)', description: 'Phân lớp tiền cảnh, trung cảnh, hậu cảnh rõ.', maxScore: 5 },
      { id: 'lighting', label: 'Lighting (Ánh sáng)', description: 'Hướng sáng thống nhất và đổ bóng hợp lý.', maxScore: 5 },
      { id: 'composition', label: 'Composition (Bố cục)', description: 'Điểm nhấn và khoảng thở cân bằng.', maxScore: 5 },
    ],
    animation: [
      { id: 'motion_clarity', label: 'Motion clarity (Độ rõ chuyển động)', description: 'Hành động đọc rõ ở tốc độ phát thật 1×.', maxScore: 5 },
      { id: 'weight', label: 'Weight (Trọng lượng)', description: 'Có dự bị, lực nhấn, theo đà tự nhiên.', maxScore: 5 },
      { id: 'frame_consistency', label: 'Frame consistency (Nhất quán frame)', description: 'Giữ thể tích, tỉ lệ và chi tiết giữa các frame.', maxScore: 5 },
      { id: 'timing', label: 'Timing (Nhịp thời gian)', description: 'Duration từng frame tạo nhịp đúng ý đồ.', maxScore: 5 },
      { id: 'loop_quality', label: 'Loop quality (Chất lượng vòng lặp)', description: 'Chuyển tiếp frame cuối về frame đầu mượt, không giật.', maxScore: 5 },
    ],
    ui: [
      { id: 'icon_recognition', label: 'Icon recognition (Nhận diện icon)', description: 'Biểu tượng dễ hiểu ở kích thước hiển thị thật.', maxScore: 5 },
      { id: 'readability', label: 'Readability (Độ rõ đọc)', description: 'Tương phản tốt trên nền sáng lẫn tối.', maxScore: 5 },
      { id: 'state_distinction', label: 'State distinction (Phân biệt trạng thái)', description: 'Normal/Hover/Pressed/Disabled khác biệt rõ.', maxScore: 5 },
      { id: 'style_consistency', label: 'Style consistency (Đồng bộ phong cách)', description: 'Độ dày nét, góc bo và bảng màu thống nhất.', maxScore: 5 },
    ],
    vfx: [
      { id: 'motion_intent', label: 'Motion intent (Ý đồ chuyển động)', description: 'Hướng lực, quỹ đạo va chạm hoặc tan biến rõ.', maxScore: 5 },
      { id: 'energy_progression', label: 'Energy progression (Diễn biến năng lượng)', description: 'Khởi phát, đỉnh điểm và tàn dư mạch lạc.', maxScore: 5 },
      { id: 'timing', label: 'Timing (Nhịp)', description: 'Impact frame đủ nhanh/dứt khoát, tan mượt.', maxScore: 5 },
      { id: 'pixel_cluster_continuity', label: 'Pixel cluster continuity (Mạch cụm pixel)', description: 'Hạt và dải năng lượng không vỡ vụn ngẫu nhiên.', maxScore: 5 },
      { id: 'gameplay_readability', label: 'Gameplay readability (Đọc trong gameplay)', description: 'Nổi bật nhưng không che khuất hitbox/nhân vật.', maxScore: 5 },
    ],
  },
};

const FAMILY_IDS: readonly AssetFamily[] = [
  'character',
  'prop',
  'terrain',
  'environment',
  'animation',
  'ui',
  'vfx',
];

/** Parse and validate an imported custom rubric JSON without treating it as E7 universal contract. */
export function parseRubricJson(text: string): RubricDefinition {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`Rubric JSON không hợp lệ: ${(err as Error).message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Rubric JSON phải là object.');
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== 'string' || !obj.id.trim()) throw new Error('Rubric thiếu trường "id".');
  if (typeof obj.name !== 'string' || !obj.name.trim()) throw new Error('Rubric thiếu trường "name".');
  if (typeof obj.version !== 'string' || !obj.version.trim()) throw new Error('Rubric thiếu trường "version".');
  if (!obj.families || typeof obj.families !== 'object' || Array.isArray(obj.families)) {
    throw new Error('Rubric thiếu đối tượng "families".');
  }

  const rawFamilies = obj.families as Record<string, unknown>;
  const families = {} as Record<AssetFamily, readonly RubricCriterion[]>;

  for (const family of FAMILY_IDS) {
    const list = rawFamilies[family];
    if (!Array.isArray(list) || !list.length) {
      throw new Error(`Rubric thiếu hoặc rỗng danh sách tiêu chí cho nhóm "${family}".`);
    }
    const seen = new Set<string>();
    families[family] = list.map((item, idx) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error(`Tiêu chí ${family}[${idx}] không hợp lệ.`);
      }
      const c = item as Record<string, unknown>;
      if (typeof c.id !== 'string' || !c.id.trim()) {
        throw new Error(`Tiêu chí ${family}[${idx}] thiếu "id".`);
      }
      if (seen.has(c.id)) {
        throw new Error(`Trùng criterion id "${c.id}" trong nhóm "${family}".`);
      }
      seen.add(c.id);
      if (typeof c.label !== 'string' || !c.label.trim()) {
        throw new Error(`Tiêu chí "${c.id}" thiếu "label".`);
      }
      const maxScore = typeof c.maxScore === 'number' ? c.maxScore : 5;
      if (!Number.isInteger(maxScore) || maxScore < 1 || maxScore > 10) {
        throw new Error(`Tiêu chí "${c.id}" có maxScore không hợp lệ (1–10).`);
      }
      return {
        id: c.id.trim(),
        label: c.label.trim(),
        description: typeof c.description === 'string' ? c.description.trim() : '',
        maxScore,
      };
    });
  }

  return {
    id: obj.id.trim(),
    name: obj.name.trim(),
    version: obj.version.trim(),
    isWorkbenchDefault: false,
    disclaimer:
      typeof obj.disclaimer === 'string' && obj.disclaimer.trim()
        ? obj.disclaimer.trim()
        : 'Rubric tùy chỉnh được nạp cục bộ cho Art Review Workbench.',
    families,
  };
}

export interface ReviewScoreSummary {
  scoredCount: number;
  totalCount: number;
  minScore: number | null;
  maxScore: number | null;
  criticalCriteriaIds: string[];
  criticalRegionCount: number;
  hasCriticalDefect: boolean;
}

/**
 * Summarize human review scores without computing an average score or automatic PASS verdict,
 * ensuring critical defects are always surfaced prominently.
 */
export function summarizeReviewScores(
  criteria: readonly RubricCriterion[],
  scores: Record<string, CriterionScore>,
  regionNotes: readonly RegionNote[],
): ReviewScoreSummary {
  let scoredCount = 0;
  let minScore: number | null = null;
  let maxScore: number | null = null;
  const criticalCriteriaIds: string[] = [];

  for (const c of criteria) {
    const entry = scores[c.id];
    if (!entry) continue;
    if (entry.score !== null) {
      scoredCount++;
      minScore = minScore === null ? entry.score : Math.min(minScore, entry.score);
      maxScore = maxScore === null ? entry.score : Math.max(maxScore, entry.score);
    }
    if (entry.severity === 'critical') {
      criticalCriteriaIds.push(c.id);
    }
  }

  const criticalRegionCount = regionNotes.filter(n => n.severity === 'critical').length;
  return {
    scoredCount,
    totalCount: criteria.length,
    minScore,
    maxScore,
    criticalCriteriaIds,
    criticalRegionCount,
    hasCriticalDefect: criticalCriteriaIds.length > 0 || criticalRegionCount > 0,
  };
}
