export type Matrix = readonly [number, number, number, number, number, number];
export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
export function multiply(a: Matrix, b: Matrix): Matrix {
  return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
}
export function point(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}
/** Rigid matrices only; this module never creates scaling or shear. */
export function inverse(m: Matrix): Matrix {
  return [m[0], m[2], m[1], m[3], -m[0] * m[4] - m[1] * m[5], -m[2] * m[4] - m[3] * m[5]];
}
export function localMatrix(pivot: { x: number; y: number }, pose?: { dx: number; dy: number; rotation: number }): Matrix {
  if (!pose) return IDENTITY;
  const angle = pose.rotation * Math.PI / 180;
  const cos = Math.abs(Math.cos(angle)) < 1e-12 ? 0 : Math.cos(angle);
  const sin = Math.abs(Math.sin(angle)) < 1e-12 ? 0 : Math.sin(angle);
  return [cos, sin, -sin, cos, pivot.x + pose.dx - cos * pivot.x + sin * pivot.y,
    pivot.y + pose.dy - sin * pivot.x - cos * pivot.y];
}
