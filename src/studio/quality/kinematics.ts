import { dataObject, dataNumber, invalidData } from './data.ts';
export interface Point { x: number; y: number }
export interface TwoBoneResult { root: Point; mid: Point; end: Point; rootAngle: number; midAngle: number; reachable: boolean; requestedTarget: Point }
function point(value: unknown): Point {
  const p = dataObject(value, ['x', 'y'], 'Điểm IK');
  return { x: dataNumber(p.x, -16384, 16384, 'Tọa độ IK'), y: dataNumber(p.y, -16384, 16384, 'Tọa độ IK') };
}
/** Canvas down-Y; positive bend is clockwise. Unreachable targets are reported, never reached by stretching. */
export function solveTwoBone(root: Point, target: Point, upperLength: number, lowerLength: number, bend: 1 | -1): TwoBoneResult {
  const start = point(root), requestedTarget = point(target);
  for (const length of [upperLength, lowerLength]) if (typeof length !== 'number' || !Number.isFinite(length) || length <= 0 || length > 8192) invalidData('IK', 'chiều dài phải >0 và ≤8192.');
  if (bend !== 1 && bend !== -1) invalidData('IK', 'hướng gập phải là 1 hoặc -1.');
  const dx = requestedTarget.x - start.x, dy = requestedTarget.y - start.y, requestedDistance = Math.hypot(dx, dy);
  const minimum = Math.abs(upperLength - lowerLength), maximum = upperLength + lowerLength;
  const distance = Math.max(minimum, Math.min(maximum, requestedDistance));
  const direction = requestedDistance === 0 ? 0 : Math.atan2(dy, dx);
  const scale = Math.max(upperLength, lowerLength), a = upperLength / scale, b = lowerLength / scale, d = distance / scale;
  const denominator = 2 * a * b;
  const cosine = denominator === 0 ? (distance <= minimum ? -1 : 1) : Math.max(-1, Math.min(1, (d * d - a * a - b * b) / denominator));
  const elbow = bend * Math.acos(cosine);
  // At the equal-length, coincident-target singularity both orientations are valid;
  // choose an upper segment along +X so the result is deterministic on both bends.
  const shoulder = distance === 0 ? 0 : direction - Math.atan2(lowerLength * Math.sin(elbow), upperLength + lowerLength * Math.cos(elbow));
  const mid = { x: start.x + upperLength * Math.cos(shoulder), y: start.y + upperLength * Math.sin(shoulder) };
  const end = { x: mid.x + lowerLength * Math.cos(shoulder + elbow), y: mid.y + lowerLength * Math.sin(shoulder + elbow) };
  return { root: start, mid, end, rootAngle: shoulder * 180 / Math.PI, midAngle: elbow * 180 / Math.PI, reachable: requestedDistance >= minimum && requestedDistance <= maximum, requestedTarget };
}
