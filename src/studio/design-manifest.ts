export interface ManifestColorRamp {
  name: string;
  colors: string[];
}

export interface ManifestPalette {
  name?: string;
  colors: string[];
  ramps?: ManifestColorRamp[];
}

export interface ManifestMaterial {
  name: string;
  colors: string[];
}

export interface ManifestPart {
  name: string;
  box: { x: number; y: number; w: number; h: number };
}

export interface ManifestLandmark {
  name: string;
  x: number;
  y: number;
}

export interface DesignManifest {
  version: 1;
  palette?: ManifestPalette;
  materials?: ManifestMaterial[];
  parts?: ManifestPart[];
  landmarks?: ManifestLandmark[];
}

const hexColorPattern = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export function validateDesignManifest(value: unknown, canvasW?: number, canvasH?: number): { valid: boolean; manifest?: DesignManifest; errors: string[] } {
  const errors: string[] = [];
  if (value === null || value === undefined) {
    return { valid: true, manifest: undefined, errors: [] };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, errors: ['Design manifest phải là một object.'] };
  }

  const v = value as Record<string, unknown>;
  if (v.version !== 1) {
    errors.push('Phiên bản design manifest phải là 1.');
  }

  const allowed = ['version', 'palette', 'materials', 'parts', 'landmarks'];
  for (const k of Object.keys(v)) {
    if (!allowed.includes(k)) errors.push(`Thuộc tính manifest '${k}' không được hỗ trợ.`);
  }

  let cleanPalette: ManifestPalette | undefined;
  if (v.palette !== undefined && v.palette !== null) {
    if (typeof v.palette !== 'object' || Array.isArray(v.palette)) {
      errors.push('Manifest palette phải là một object.');
    } else {
      const p = v.palette as Record<string, unknown>;
      if (p.name !== undefined && p.name !== null && (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 100)) {
        errors.push('Tên palette manifest không hợp lệ.');
      }
      if (!Array.isArray(p.colors) || p.colors.some(c => typeof c !== 'string' || !hexColorPattern.test(c))) {
        errors.push('Màu trong palette manifest phải là mảng mã màu hex (#RGB, #RRGGBB, #RRGGBBAA).');
      }
      let cleanRamps: ManifestColorRamp[] | undefined;
      if (p.ramps !== undefined && p.ramps !== null) {
        if (!Array.isArray(p.ramps)) {
          errors.push('Palette ramps phải là một mảng.');
        } else {
          cleanRamps = [];
          for (let i = 0; i < p.ramps.length; i++) {
            const r = p.ramps[i];
            if (!r || typeof r !== 'object' || Array.isArray(r) || typeof (r as any).name !== 'string' || !(r as any).name.trim() || !Array.isArray((r as any).colors) || (r as any).colors.some((c: unknown) => typeof c !== 'string' || !hexColorPattern.test(c))) {
              errors.push(`Ramp thứ ${i + 1} trong palette không hợp lệ.`);
            } else {
              cleanRamps.push({ name: (r as any).name.trim(), colors: [...(r as any).colors] });
            }
          }
        }
      }
      if (Array.isArray(p.colors)) {
        cleanPalette = {
          name: typeof p.name === 'string' ? p.name.trim() : undefined,
          colors: [...p.colors],
          ...(cleanRamps ? { ramps: cleanRamps } : {}),
        };
      }
    }
  }

  let cleanMaterials: ManifestMaterial[] | undefined;
  if (v.materials !== undefined && v.materials !== null) {
    if (!Array.isArray(v.materials)) {
      errors.push('Manifest materials phải là một mảng.');
    } else {
      cleanMaterials = [];
      for (let i = 0; i < v.materials.length; i++) {
        const m = v.materials[i];
        if (!m || typeof m !== 'object' || Array.isArray(m) || typeof (m as any).name !== 'string' || !(m as any).name.trim() || !Array.isArray((m as any).colors) || (m as any).colors.some((c: unknown) => typeof c !== 'string' || !hexColorPattern.test(c))) {
          errors.push(`Material thứ ${i + 1} không hợp lệ.`);
        } else {
          cleanMaterials.push({ name: (m as any).name.trim(), colors: [...(m as any).colors] });
        }
      }
    }
  }

  let cleanParts: ManifestPart[] | undefined;
  if (v.parts !== undefined && v.parts !== null) {
    if (!Array.isArray(v.parts)) {
      errors.push('Manifest parts phải là một mảng.');
    } else {
      cleanParts = [];
      for (let i = 0; i < v.parts.length; i++) {
        const pt = v.parts[i];
        if (!pt || typeof pt !== 'object' || Array.isArray(pt) || typeof (pt as any).name !== 'string' || !(pt as any).name.trim()) {
          errors.push(`Part thứ ${i + 1} thiếu tên hợp lệ.`);
        } else {
          const b = (pt as any).box;
          if (!b || typeof b !== 'object' || ![b.x, b.y, b.w, b.h].every(n => typeof n === 'number' && Number.isFinite(n)) || b.w <= 0 || b.h <= 0) {
            errors.push(`Part '${(pt as any).name}' có tọa độ bounding box không hợp lệ.`);
          } else {
            if (canvasW !== undefined && canvasH !== undefined) {
              if (b.x < 0 || b.y < 0 || b.x + b.w > canvasW || b.y + b.h > canvasH) {
                errors.push(`Part '${(pt as any).name}' nằm ngoài kích thước canvas ${canvasW}×${canvasH}.`);
              }
            }
            cleanParts.push({ name: (pt as any).name.trim(), box: { x: b.x, y: b.y, w: b.w, h: b.h } });
          }
        }
      }
    }
  }

  let cleanLandmarks: ManifestLandmark[] | undefined;
  if (v.landmarks !== undefined && v.landmarks !== null) {
    if (!Array.isArray(v.landmarks)) {
      errors.push('Manifest landmarks phải là một mảng.');
    } else {
      cleanLandmarks = [];
      for (let i = 0; i < v.landmarks.length; i++) {
        const lm = v.landmarks[i];
        if (!lm || typeof lm !== 'object' || Array.isArray(lm) || typeof (lm as any).name !== 'string' || !(lm as any).name.trim() || typeof (lm as any).x !== 'number' || typeof (lm as any).y !== 'number' || !Number.isFinite((lm as any).x) || !Number.isFinite((lm as any).y)) {
          errors.push(`Landmark thứ ${i + 1} không hợp lệ.`);
        } else {
          const x = (lm as any).x, y = (lm as any).y;
          if (canvasW !== undefined && canvasH !== undefined) {
            if (x < 0 || x > canvasW || y < 0 || y > canvasH) {
              errors.push(`Landmark '${(lm as any).name}' (${x}, ${y}) nằm ngoài kích thước canvas ${canvasW}×${canvasH}.`);
            }
          }
          cleanLandmarks.push({ name: (lm as any).name.trim(), x, y });
        }
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const manifest: DesignManifest = {
    version: 1,
    ...(cleanPalette ? { palette: cleanPalette } : {}),
    ...(cleanMaterials ? { materials: cleanMaterials } : {}),
    ...(cleanParts ? { parts: cleanParts } : {}),
    ...(cleanLandmarks ? { landmarks: cleanLandmarks } : {}),
  };

  return { valid: true, manifest, errors: [] };
}
