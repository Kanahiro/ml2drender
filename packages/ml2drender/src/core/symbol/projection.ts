//! Placing glyphs along lines (`projection.ts`) for an unpitched camera: the label plane is the
//! screen (CSS px), which at pitch 0 gives the same result for both pitch alignments.

import type {P} from './anchors.ts';
import {int16, type PlacedSymbol, type SymbolBucket} from './layout.ts';
import {EXTENT, type Ctx} from '../render/mod.ts';
import type {Transform} from '../tile.ts';

/** A placed glyph: label-plane point, rotation and the path walked to reach it. */
export interface PlacedGlyph {
  point: P;
  angle: number;
  path: P[];
}

/** `projectionCache`, per symbol. */
export interface Cache {
  projections: Map<number, P>;
  offsets: Map<number, P>;
  anchor: P | undefined;
}

export const newCache = (): Cache => ({projections: new Map(), offsets: new Map(), anchor: undefined});

function sub(a: P, b: P): P {
  return [a[0] - b[0], a[1] - b[1]];
}

function mag(a: P): number {
  return Math.sqrt(a[0] * a[0] + a[1] * a[1]);
}

/** `transformToOffsetNormal`: `segment._unit()._perp()._mult(offset * direction)`. */
function offsetNormal(v: P, offset: number, direction: number): P {
  const m = mag(v);
  const u = [v[0] / m, v[1] / m];
  return [-u[1] * offset * direction, u[0] * offset * direction];
}

/** `findLineIntersection`. */
function lineIntersection(a1: P, a2: P, b1: P, b2: P): P | undefined {
  const aDx = a2[0] - a1[0];
  const aDy = a2[1] - a1[1];
  const bDx = b2[0] - b1[0];
  const bDy = b2[1] - b1[1];
  const denom = bDy * aDx - bDx * aDy;
  if (denom === 0.0) return undefined;
  const ua = (bDx * (a1[1] - b1[1]) - bDy * (a1[0] - b1[0])) / denom;
  return [a1[0] + ua * aDx, a1[1] + ua * aDy];
}

export type LinePlacement =
  | {kind: 'Placed'; positions: [P, number][]}
  /** Too steep for horizontal text: the vertical shaping is drawn instead. */
  | {kind: 'UseVertical'}
  | {kind: 'Hidden'};

type Change = 'Flip' | 'Vertical' | 'NoRoom';

/** Int16 anchor of a placed symbol. */
function symAnchor(sym: PlacedSymbol): P {
  return [int16(sym.anchor[0]), int16(sym.anchor[1])];
}

export class LineProjector {
  private bucket: SymbolBucket;
  private origin: P;
  private scale: number;
  private transform: Transform;
  private translation: P;

  /** `translation` in tile units. */
  constructor(ctx: Ctx, bucket: SymbolBucket, translation: P) {
    this.bucket = bucket;
    this.origin = ctx.tileOrigin(bucket.tile);
    this.scale = ctx.tilePx(bucket.tile) / EXTENT;
    this.transform = ctx.transform;
    this.translation = translation;
  }

  /** Tile units → label plane (CSS px). */
  project(p: P): P {
    const x = p[0] + this.translation[0];
    const y = p[1] + this.translation[1];
    const s = this.transform.worldToScreen([this.origin[0] + x * this.scale, this.origin[1] + y * this.scale]);
    return [s[0] / this.transform.pixelRatio, s[1] / this.transform.pixelRatio];
  }

  private vertex(i: number, cache: Cache): P {
    const c = cache.projections.get(i);
    if (c !== undefined) return c;
    const p = this.project(this.bucket.lineVertices[i][0]);
    cache.projections.set(i, p);
    return p;
  }

  private offsetIntersection(
    index: number,
    normal: P,
    current: P,
    start: number,
    end: number,
    offsetPrev: P,
    lineOffsetY: number,
    direction: number,
    cache: Cache,
  ): P {
    const c = cache.offsets.get(index);
    if (c !== undefined) return c;
    const offsetCurrent: P = [current[0] + normal[0], current[1] + normal[1]];
    const nextIndex = index + direction;
    if (nextIndex < start || nextIndex >= end) {
      cache.offsets.set(index, offsetCurrent);
      return offsetCurrent;
    }
    const next = this.vertex(nextIndex, cache);
    const n = offsetNormal(sub(next, current), lineOffsetY, direction);
    const r = lineIntersection(offsetPrev, offsetCurrent, [current[0] + n[0], current[1] + n[1]], [next[0] + n[0], next[1] + n[1]]) ?? offsetCurrent;
    cache.offsets.set(index, r);
    return r;
  }

  /** `placeGlyphAlongLine`. */
  placeGlyph(
    sym: PlacedSymbol,
    offsetX: number,
    lineOffsetX: number,
    lineOffsetY: number,
    flip: boolean,
    rotateToLine: boolean,
    cache: Cache,
  ): PlacedGlyph | undefined {
    if (sym.segment === undefined) return undefined;
    const segment = sym.segment;
    const start = sym.lineStart;
    const end = sym.lineStart + sym.lineLength;
    const combined = flip ? offsetX - lineOffsetX : offsetX + lineOffsetX;
    let direction = combined > 0.0 ? 1 : -1;
    let angle = 0.0;
    if (flip) {
      direction *= -1;
      angle = Math.PI;
    }
    if (direction < 0) angle += Math.PI;
    let index = direction > 0 ? start + segment : start + segment + 1;
    if (cache.anchor === undefined) cache.anchor = this.project(symAnchor(sym));
    const anchor = cache.anchor;
    let current = anchor;
    let previous = anchor;
    let offsetIntersection: P | undefined;
    let offsetPrevious: P | undefined;
    let distance = 0.0;
    let segmentDistance = 0.0;
    const absOffset = Math.abs(combined);
    const path: P[] = [];
    let segmentVec: P = [0.0, 0.0];
    while (distance + segmentDistance <= absOffset) {
      index += direction;
      if (index < start || index >= end) return undefined;
      distance += segmentDistance;
      previous = current;
      offsetPrevious = offsetIntersection;
      current = this.vertex(index, cache);
      if (lineOffsetY === 0.0) {
        path.push(previous);
        segmentVec = sub(current, previous);
      } else {
        const prevToCurrent = sub(current, previous);
        const normal =
          mag(prevToCurrent) === 0.0
            ? offsetNormal(sub(this.vertex(index + direction, cache), current), lineOffsetY, direction)
            : offsetNormal(prevToCurrent, lineOffsetY, direction);
        if (offsetPrevious === undefined) offsetPrevious = [previous[0] + normal[0], previous[1] + normal[1]];
        const op = offsetPrevious;
        const oi = this.offsetIntersection(index, normal, current, start, end, op, lineOffsetY, direction, cache);
        offsetIntersection = oi;
        path.push(op);
        segmentVec = sub(oi, op);
      }
      segmentDistance = mag(segmentVec);
    }
    const t = (absOffset - distance) / segmentDistance;
    const base = offsetPrevious ?? previous;
    const p: P = [segmentVec[0] * t + base[0], segmentVec[1] * t + base[1]];
    const segmentAngle = angle + Math.atan2(current[1] - previous[1], current[0] - previous[0]);
    path.push(p);
    return {point: p, angle: rotateToLine ? segmentAngle : 0.0, path};
  }

  /**
   * `placeGlyphsAlongLine` + the keep-upright retry of `updateLineLabels`: per-quad
   * (point, angle).
   */
  placeSymbol(sym: PlacedSymbol, fontSize: number, keepUpright: boolean, rotateToLine: boolean): LinePlacement {
    const cache = newCache();
    const r = this.placeGlyphs(sym, fontSize, false, keepUpright, rotateToLine, cache);
    if (typeof r !== 'string') return {kind: 'Placed', positions: r};
    if (r === 'Flip') {
      const f = this.placeGlyphs(sym, fontSize, true, keepUpright, rotateToLine, cache);
      return typeof f !== 'string' ? {kind: 'Placed', positions: f} : {kind: 'Hidden'};
    }
    return r === 'Vertical' ? {kind: 'UseVertical'} : {kind: 'Hidden'};
  }

  private placeGlyphs(
    sym: PlacedSymbol,
    fontSize: number,
    flip: boolean,
    keepUpright: boolean,
    rotateToLine: boolean,
    cache: Cache,
  ): [P, number][] | Change {
    const fontScale = fontSize / 24.0;
    const lox = sym.lineOffset[0] * fontScale;
    const loy = sym.lineOffset[1] * fontScale;
    // Upstream stores glyph offsets in a Float32Array.
    const offsets = sym.quads.map((q) => Math.fround(q.glyphOffset[0]));
    const n = offsets.length;
    // `requiresOrientationChange` (screen y grows downwards).
    const orientationChange = (a: P, b: P): Change | undefined => {
      if (sym.writingMode === 'Horizontal' && Math.abs(b[1] - a[1]) > Math.abs(b[0] - a[0])) return 'Vertical';
      const flip = sym.writingMode === 'Vertical' ? a[1] > b[1] : a[0] > b[0];
      return flip ? 'Flip' : undefined;
    };
    if (n > 1) {
      const first = this.placeGlyph(sym, fontScale * offsets[0], lox, loy, flip, rotateToLine, cache);
      if (first === undefined) return 'NoRoom';
      const last = this.placeGlyph(sym, fontScale * offsets[n - 1], lox, loy, flip, rotateToLine, cache);
      if (last === undefined) return 'NoRoom';
      if (keepUpright && !flip) {
        const c = orientationChange(first.point, last.point);
        if (c !== undefined) return c;
      }
      const out: [P, number][] = [[first.point, first.angle]];
      for (let k = 1; k < n - 1; k++) {
        const g = this.placeGlyph(sym, fontScale * offsets[k], lox, loy, flip, rotateToLine, cache);
        if (g === undefined) return 'NoRoom';
        out.push([g.point, g.angle]);
      }
      out.push([last.point, last.angle]);
      return out;
    }
    if (keepUpright && !flip) {
      const a = this.project(symAnchor(sym));
      const i = sym.lineStart + (sym.segment ?? 0) + 1;
      const b = this.project(this.bucket.lineVertices[i][0]);
      const c = orientationChange(a, b);
      if (c !== undefined) return c;
    }
    const g = this.placeGlyph(sym, fontScale * (offsets[0] ?? 0.0), lox, loy, flip, rotateToLine, cache);
    if (g === undefined) return 'NoRoom';
    return Array.from({length: Math.max(n, 1)}, (): [P, number] => [g.point, g.angle]);
  }
}

/** `placeFirstAndLastGlyph` path for collision circles (label plane, unflipped). */
export function labelPath(ctx: Ctx, bucket: SymbolBucket, sym: PlacedSymbol, fontSize: number, translation: P): P[] | undefined {
  const proj = new LineProjector(ctx, bucket, translation);
  const fontScale = fontSize / 24.0;
  const lox = sym.lineOffset[0] * fontScale;
  const loy = sym.lineOffset[1] * fontScale;
  if (sym.quads.length === 0) return undefined;
  const firstOff = Math.fround(sym.quads[0].glyphOffset[0]);
  const lastOff = Math.fround(sym.quads[sym.quads.length - 1].glyphOffset[0]);
  const cache = newCache();
  const first = proj.placeGlyph(sym, fontScale * firstOff, lox, loy, false, false, cache);
  if (first === undefined) return undefined;
  const last = proj.placeGlyph(sym, fontScale * lastOff, lox, loy, false, false, cache);
  if (last === undefined) return undefined;
  const path = first.path.slice(1).reverse();
  for (const p of last.path.slice(1)) path.push(p);
  return path;
}
