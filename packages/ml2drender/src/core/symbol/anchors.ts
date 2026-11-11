//! Symbol anchor geometry: line clipping, anchors along lines (`get_anchors.ts`,
//! `check_max_angle.ts`, `clip_line.ts`), line merging and the pole of inaccessibility.

export type P = [number, number];

export interface Anchor {
  x: number;
  y: number;
  /** Index of the line segment the anchor is on (line placement). */
  segment: number | undefined;
}

/** Rust `f64::max` / `f64::min`: a NaN operand yields the other one. */
const fmin = (a: number, b: number): number => (a !== a ? b : b !== b ? a : Math.min(a, b));
const fmax = (a: number, b: number): number => (a !== a ? b : b !== b ? a : Math.max(a, b));

export function dist(a: P, b: P): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2);
}

/** `Point.angleTo`. */
function angleTo(a: P, b: P): number {
  return Math.atan2(a[1] - b[1], a[0] - b[0]);
}

function round(p: P): P {
  return [Math.round(p[0]), Math.round(p[1])];
}

const atX = (p0: P, p1: P, x: number): P => round([x, p0[1] + (p1[1] - p0[1]) * ((x - p0[0]) / (p1[0] - p0[0]))]);
const atY = (p0: P, p1: P, y: number): P => round([p0[0] + (p1[0] - p0[0]) * ((y - p0[1]) / (p1[1] - p0[1])), y]);

/** `clipLine`: clip lines to `[x1, x2) x [y1, y2)`, rounding the cut points. */
export function clipLine(lines: P[][], x1: number, y1: number, x2: number, y2: number): P[][] {
  const out: P[][] = [];
  for (const line of lines) {
    let current: P[] | undefined;
    for (let i = 0; i + 1 < line.length; i++) {
      let p0 = line[i];
      let p1 = line[i + 1];
      if (p0[0] < x1 && p1[0] < x1) continue;
      else if (p0[0] < x1) p0 = atX(p0, p1, x1);
      else if (p1[0] < x1) p1 = atX(p0, p1, x1);
      if (p0[1] < y1 && p1[1] < y1) continue;
      else if (p0[1] < y1) p0 = atY(p0, p1, y1);
      else if (p1[1] < y1) p1 = atY(p0, p1, y1);
      if (p0[0] >= x2 && p1[0] >= x2) continue;
      else if (p0[0] >= x2) p0 = atX(p0, p1, x2);
      else if (p1[0] >= x2) p1 = atX(p0, p1, x2);
      if (p0[1] >= y2 && p1[1] >= y2) continue;
      else if (p0[1] >= y2) p0 = atY(p0, p1, y2);
      else if (p1[1] >= y2) p1 = atY(p0, p1, y2);
      const last = current?.[current.length - 1];
      if (current === undefined || last![0] !== p0[0] || last![1] !== p0[1]) {
        current = [p0];
        out.push(current);
      }
      current.push(p1);
    }
  }
  return out;
}

function lineLength(line: P[]): number {
  let sum = 0;
  for (let i = 0; i + 1 < line.length; i++) sum += dist(line[i], line[i + 1]);
  return sum;
}

/** `checkMaxAngle`: whether the label fits along the line without bending too sharply. */
export function checkMaxAngle(line: P[], anchor: Anchor, labelLength: number, windowSize: number, maxAngle: number): boolean {
  const segment = anchor.segment;
  if (segment === undefined) return true;
  if (labelLength === 0.0) return true;
  let p: P = [anchor.x, anchor.y];
  let index = segment + 1;
  let anchorDistance = 0.0;
  while (anchorDistance > -labelLength / 2.0) {
    index -= 1;
    if (index < 0) return false;
    anchorDistance -= dist(line[index], p);
    p = line[index];
  }
  anchorDistance += dist(line[index], line[index + 1]);
  index += 1;
  const recent: [number, number][] = [];
  let head = 0;
  let recentDelta = 0.0;
  while (anchorDistance < labelLength / 2.0) {
    const prev = line[index - 1];
    const current = line[index];
    const next = line[index + 1];
    if (next === undefined) return false;
    let delta = angleTo(prev, current) - angleTo(current, next);
    delta = Math.abs(((delta + 3.0 * Math.PI) % (Math.PI * 2.0)) - Math.PI);
    recent.push([anchorDistance, delta]);
    recentDelta += delta;
    while (anchorDistance - recent[head][0] > windowSize) {
      recentDelta -= recent[head][1];
      head += 1;
    }
    if (recentDelta > maxAngle) return false;
    index += 1;
    anchorDistance += dist(current, next);
  }
  return true;
}

/** `getCenterAnchor` (`symbol-placement: line-center`). */
export function centerAnchor(line: P[], maxAngle: number, angleWindowSize: number, labelLength: number): Anchor | undefined {
  const center = lineLength(line) / 2.0;
  let prev = 0.0;
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i];
    const b = line[i + 1];
    const d = dist(a, b);
    if (prev + d > center) {
      const t = (center - prev) / d;
      const p = round([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      const anchor: Anchor = {x: p[0], y: p[1], segment: i};
      return angleWindowSize === 0.0 || checkMaxAngle(line, anchor, labelLength, angleWindowSize, maxAngle) ? anchor : undefined;
    }
    prev += d;
  }
  return undefined;
}

/** `getAnchors` (`symbol-placement: line`). */
export function lineAnchors(
  line: P[],
  spacing: number,
  maxAngle: number,
  angleWindowSize: number,
  shapedLabelLength: number,
  boxScale: number,
  overscaling: number,
  extent: number,
): Anchor[] {
  const labelLength = shapedLabelLength * boxScale;
  const continued = line[0][0] === 0.0 || line[0][0] === extent || line[0][1] === 0.0 || line[0][1] === extent;
  if (spacing - labelLength < spacing / 4.0) spacing = labelLength + spacing / 4.0;
  const fixedExtraOffset = 24.0 * 2.0;
  const offset = !continued
    ? ((shapedLabelLength / 2.0 + fixedExtraOffset) * boxScale * overscaling) % spacing
    : ((spacing / 2.0) * overscaling) % spacing;
  return resample(line, offset, spacing, angleWindowSize, maxAngle, labelLength, continued, false, extent);
}

function resample(
  line: P[],
  offset: number,
  spacing: number,
  window: number,
  maxAngle: number,
  labelLength: number,
  continued: boolean,
  middle: boolean,
  extent: number,
): Anchor[] {
  const half = labelLength / 2.0;
  const length = lineLength(line);
  let distance = 0.0;
  let marked = offset - spacing;
  let anchors: Anchor[] = [];
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i];
    const b = line[i + 1];
    const d = dist(a, b);
    while (marked + spacing < distance + d) {
      marked += spacing;
      const t = (marked - distance) / d;
      const x = a[0] + (b[0] - a[0]) * t;
      const y = a[1] + (b[1] - a[1]) * t;
      if (x >= 0.0 && x < extent && y >= 0.0 && y < extent && marked - half >= 0.0 && marked + half <= length) {
        const p = round([x, y]);
        const anchor: Anchor = {x: p[0], y: p[1], segment: i};
        if (window === 0.0 || checkMaxAngle(line, anchor, labelLength, window, maxAngle)) anchors.push(anchor);
      }
    }
    distance += d;
  }
  if (!middle && anchors.length === 0 && !continued) {
    anchors = resample(line, distance / 2.0, spacing, window, maxAngle, labelLength, continued, true, extent);
  }
  return anchors;
}

/**
 * `mergeLines`: join lines with the same text that share endpoints. Takes `[text, line]` per
 * feature and returns, per feature, its merged line (`undefined` = merged into another).
 */
export function mergeLines(items: [string | undefined, P[]][]): (P[] | undefined)[] {
  const key = (text: string, p: P) => `${text}:${p[0]}:${p[1]}`;
  // Each merged line: owning feature, chunks (feature indices) in order.
  const merged: [number, number[]][] = [];
  const alive: boolean[] = [];
  const left = new Map<string, number>();
  const right = new Map<string, number>();
  const lastPt = (m: [number, number[]]): P => {
    const l = items[m[1][m[1].length - 1]][1];
    return l[l.length - 1];
  };
  for (let fi = 0; fi < items.length; fi++) {
    const [text, line] = items[fi];
    if (text === undefined || text === '' || line.length === 0) {
      merged.push([fi, [fi]]);
      alive.push(true);
      continue;
    }
    const lk = key(text, line[0]);
    const rk = key(text, line[line.length - 1]);
    const ri = right.get(lk);
    const li = left.get(rk);
    if (ri !== undefined && li !== undefined && ri !== li) {
      // mergeFromLeft: this line goes in front of `li`.
      left.delete(rk);
      left.set(lk, li);
      merged[li][1].unshift(fi);
      // mergeFromRight: `li` (now starting with this line) goes after `ri`.
      right.delete(lk);
      right.set(rk, ri);
      const chunks = merged[li][1];
      merged[li][1] = [];
      merged[ri][1].push(...chunks);
      left.delete(lk);
      right.delete(rk);
      right.set(key(text, lastPt(merged[ri])), ri);
      alive[li] = false;
    } else if (ri !== undefined) {
      right.delete(lk);
      right.set(rk, ri);
      merged[ri][1].push(fi);
    } else if (li !== undefined) {
      left.delete(rk);
      left.set(lk, li);
      merged[li][1].unshift(fi);
    } else {
      merged.push([fi, [fi]]);
      alive.push(true);
      left.set(lk, merged.length - 1);
      right.set(rk, merged.length - 1);
    }
  }
  const out: (P[] | undefined)[] = new Array(items.length).fill(undefined);
  for (let k = 0; k < merged.length; k++) {
    if (!alive[k]) continue;
    const m = merged[k];
    const pts = items[m[1][0]][1].slice();
    for (const c of m[1].slice(1)) {
      const l = items[c][1];
      for (let j = 1; j < l.length; j++) pts.push(l[j]);
    }
    out[m[0]] = pts;
  }
  return out;
}

function distToSegmentSq(p: P, a: P, b: P): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  let q = a;
  if (dx !== 0.0 || dy !== 0.0) {
    const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy);
    if (t > 1.0) q = b;
    else if (t > 0.0) q = [a[0] + dx * t, a[1] + dy * t];
  }
  return (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2;
}

function pointToPolygonDist(p: P, polygon: P[][]): number {
  let inside = false;
  let min = Infinity;
  for (const ring of polygon) {
    const n = ring.length;
    let j = n - 1;
    for (let i = 0; i < n; i++) {
      const a = ring[i];
      const b = ring[j];
      if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
      min = fmin(min, distToSegmentSq(p, a, b));
      j = i;
    }
  }
  return (inside ? 1.0 : -1.0) * Math.sqrt(min);
}

interface Cell {
  p: P;
  h: number;
  d: number;
  max: number;
}

/** `findPoleOfInaccessibility` (polylabel). */
export function poleOfInaccessibility(polygon: P[][], precision: number): P {
  const cell = (x: number, y: number, h: number): Cell => {
    const d = pointToPolygonDist([x, y], polygon);
    return {p: [x, y], h, d, max: d + h * Math.SQRT2};
  };
  const ring = polygon[0];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of ring) {
    minX = fmin(minX, p[0]);
    minY = fmin(minY, p[1]);
    maxX = fmax(maxX, p[0]);
    maxY = fmax(maxY, p[1]);
  }
  const size = fmin(maxX - minX, maxY - minY);
  if (size === 0.0) return [minX, minY];
  const h = size / 2.0;
  // ponytail: linear-scan max queue; a binary heap if polygons get huge.
  const queue: Cell[] = [];
  for (let x = minX; x < maxX; x += size) {
    for (let y = minY; y < maxY; y += size) queue.push(cell(x + h, y + h, h));
  }
  // getCentroidCell
  let area = 0.0;
  let cx = 0.0;
  let cy = 0.0;
  const n = ring.length;
  let j = n - 1;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[j];
    const f = a[0] * b[1] - b[0] * a[1];
    cx += (a[0] + b[0]) * f;
    cy += (a[1] + b[1]) * f;
    area += f * 3.0;
    j = i;
  }
  const centroid = cell(cx / area, cy / area, 0.0);
  let best = centroid;
  const centroidD = centroid.d;
  const centroidP = centroid.p;
  while (queue.length > 0) {
    // tinyqueue pops the max `max` (ties: heap order; first found here).
    let bi = 0;
    for (let i = 0; i < queue.length; i++) if (queue[i].max > queue[bi].max) bi = i;
    // swap_remove
    const c = queue[bi];
    const lastCell = queue.pop()!;
    if (bi < queue.length) queue[bi] = lastCell;
    if (c.d > best.d || best.d === 0.0 || best.d !== best.d) best = c;
    if (c.max - best.d <= precision) continue;
    const h = c.h / 2.0;
    queue.push(cell(c.p[0] - h, c.p[1] - h, h));
    queue.push(cell(c.p[0] + h, c.p[1] - h, h));
    queue.push(cell(c.p[0] - h, c.p[1] + h, h));
    queue.push(cell(c.p[0] + h, c.p[1] + h, h));
  }
  if (centroidD > 0.0 && best.d - centroidD <= precision) return centroidP;
  return best.p;
}

/** `PathInterpolator`. */
export class PathInterpolator {
  private points: P[];
  private distances: number[];
  length: number;
  paddedLength: number;
  private padding: number;

  constructor(points: P[], padding: number) {
    const distances = [0.0];
    for (let i = 1; i < points.length; i++) distances.push(distances[i - 1] + dist(points[i], points[i - 1]));
    const length = distances[distances.length - 1];
    padding = fmin(padding, length * 0.5);
    this.points = points;
    this.distances = distances;
    this.length = length;
    this.paddedLength = length - padding * 2.0;
    this.padding = padding;
  }

  lerp(t: number): P {
    if (this.points.length === 1) return this.points[0];
    t = Math.min(Math.max(t, 0.0), 1.0);
    let i = 1;
    const target = t * this.paddedLength + this.padding;
    while (i < this.distances.length - 1 && this.distances[i] < target) i += 1;
    const d0 = this.distances[i - 1];
    const d1 = this.distances[i];
    const len = d1 - d0;
    const st = len > 0.0 ? (target - d0) / len : 0.0;
    const a = this.points[i - 1];
    const b = this.points[i];
    return [a[0] * (1.0 - st) + b[0] * st, a[1] * (1.0 - st) + b[1] * st];
  }
}
