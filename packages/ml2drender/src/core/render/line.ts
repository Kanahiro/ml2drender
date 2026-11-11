// Line layers: port of MapLibre's `LineBucket.addLine` geometry and the `line` shader.

import {Color} from '@maplibre/maplibre-gl-style-spec';
import {type Layer, layout as layoutProp, paint as paintProp} from '../style.ts';
import {CLIP_END, CLIP_START} from '../geojson.ts';
import type {StyleImage} from '../sprite.ts';
import {asU8, roundAway, wrapI8} from '../util.ts';
import * as raster from './raster.ts';
import type {Rgba, Target} from './raster.ts';
import * as pattern from './pattern.ts';
import {type BucketFeature, Ctx, EXTENT, NO_GEOMETRY, type TileFeatures, bent, color, drawnGeometry, num} from './mod.ts';

const EXTRUDE_SCALE = 63;
const COS_HALF_SHARP_CORNER = 0.7933533402912352; // cos(75° / 2)
const SHARP_CORNER_OFFSET = 15;
const DEG_PER_TRIANGLE = 20;
const MAX_OFFSET_MITER_LENGTH = 2;
const OFFSET_FALLBACK_START = 3;
const OFFSET_FALLBACK_END = 8;
const MAX_LINE_DISTANCE = 32768; // 2^(15 - 1) / LINE_DISTANCE_SCALE (1/2)
const LINE_ATLAS_WIDTH = 256;
const MAX_TEXTURE_SIZE = 16384;

type P = [number, number];

const sub = (a: P, b: P): P => [a[0] - b[0], a[1] - b[1]];
const add = (a: P, b: P): P => [a[0] + b[0], a[1] + b[1]];
const mult = (a: P, k: number): P => [a[0] * k, a[1] * k];
const mag = (a: P) => Math.sqrt(a[0] * a[0] + a[1] * a[1]);
const unit = (a: P): P => {
    const m = mag(a);
    return [a[0] / m, a[1] / m];
};
const perp = (a: P): P => [-a[1], a[0]];
const dist = (a: P, b: P) => mag(sub(a, b));
const eq = (a: P, b: P) => a[0] === b[0] && a[1] === b[1];

/** `Math.round(63 * v)` as stored in the vertex attributes: the extrude bytes go into a
 * `Uint8Array` offset by 128 (decoded as `byte - 128`), `a_offset_normal` into an `Int8Array`.
 * Both wrap to the same signed byte; the shader divides it by 63 again. (The Rust port goes
 * through a saturating `as i64`, emulated for the non-finite cases.) */
function quantize(v: number): number {
    const r = Math.round(EXTRUDE_SCALE * v);
    if (r !== r) return 0;
    if (r >= 9223372036854775807) return -1; // i64::MAX ≡ 255 (mod 256)
    if (r <= -9223372036854775808) return 0;
    return wrapI8(r);
}

/** Rust `x as i64 as f64` (truncating, saturating; NaN → 0). */
const truncI64 = (x: number) => (x !== x ? 0 : Math.trunc(x));

/** A built line feature (`Builder.compact`): the `Builder` fields it draws from. */
interface LineGeometry {
    x: ArrayLike<number>;
    y: ArrayLike<number>;
    ext: Int8Array;
    flags: Uint8Array;
    linesofar: Float64Array;
    uvX: Float64Array;
    split: Uint32Array;
    lineStarts: number[];
    triangles: Uint32Array;
}

/** Vertices are held field by field (dense tiles have millions): vertex `i` is at (`x[i]`, `y[i]`),
 * with the extrude vector and offset normal `ext[4i .. 4i + 4]`, quantized like the byte attributes
 * (`quantize`), `round` and `up` in `flags[i]` (bits 0, 1), `linesofar`, and the gradient texture
 * coordinates: `uvX` (progress within the clip) and `split` (its row, 1-based). */
class Builder {
    x: number[] = [];
    y: number[] = [];
    ext: number[] = [];
    flags: number[] = [];
    linesofar: number[] = [];
    uvX: number[] = [];
    split: number[] = [];
    /** Index of each line's first vertex. */
    lineStarts: number[] = [];
    /** Triangles as vertex index triples, flattened. */
    triangles: number[] = [];
    e1: number | undefined = undefined;
    e2: number | undefined = undefined;
    distance = 0;
    /** `lineMetrics` clip of the current feature (geojson-vt start/end fractions). */
    clip: [number, number] | undefined = undefined;
    clips: [number, number][] = [];
    totalDistance = 0;
    scaledDistance = 0;
    maxLineLength = 0;

    addHalfVertex(p: P, ex: number, ey: number, ox: number, oy: number, round: boolean, up: boolean): void {
        const total = this.clip ? this.scaledDistance * (MAX_LINE_DISTANCE - 1) : this.scaledDistance;
        // Stored as an integer of half the distance (LINE_DISTANCE_SCALE), decoded times two.
        const linesofar = truncI64(total * 0.5) * 2;
        const uvX = this.clip ? (this.scaledDistance - this.clip[0]) / (this.clip[1] - this.clip[0]) : 0;
        const split = this.clips.length;
        this.x.push(p[0]);
        this.y.push(p[1]);
        this.ext.push(quantize(ex), quantize(ey), quantize(ox), quantize(oy));
        this.flags.push((round ? 1 : 0) | (up ? 2 : 0));
        this.linesofar.push(linesofar);
        this.uvX.push(uvX);
        this.split.push(split);
        const e = this.x.length - 1;
        if (this.e1 !== undefined && this.e2 !== undefined) this.triangles.push(this.e1, e, this.e2);
        if (up) this.e2 = e;
        else this.e1 = e;
    }

    addCurrentVertex(p: P, normal: P, endLeft: number, endRight: number, round: boolean, offsetNormal: P | undefined, fallback: number): void {
        const on = offsetNormal ?? normal;
        const lx = normal[0] + normal[1] * endLeft;
        const ly = normal[1] - normal[0] * endLeft;
        const rx = -normal[0] + normal[1] * endRight;
        const ry = -normal[1] - normal[0] * endRight;
        const ox = on[0] + (normal[0] - on[0]) * fallback;
        const oy = on[1] + (normal[1] - on[1]) * fallback;
        this.addHalfVertex(p, lx, ly, ox, oy, round, false);
        this.addHalfVertex(p, rx, ry, -ox, -oy, round, true);
        // The distance attribute has limited bits; restart it on long lines.
        if (this.distance > MAX_LINE_DISTANCE / 2 && this.totalDistance === 0) {
            this.distance = 0;
            this.updateScaledDistance();
            this.addCurrentVertex(p, normal, endLeft, endRight, round, offsetNormal, fallback);
        }
    }

    /** The built vertices in exact-size typed arrays. */
    compact(): LineGeometry {
        // Int32 when that keeps every value (-0 included).
        const int32 = (v: number) => (v | 0) === v && !Object.is(v, -0);
        const integral = this.x.every(int32) && this.y.every(int32);
        const pos = integral ? Int32Array : Float64Array;
        return {
            x: pos.from(this.x),
            y: pos.from(this.y),
            ext: Int8Array.from(this.ext),
            flags: Uint8Array.from(this.flags),
            linesofar: Float64Array.from(this.linesofar),
            uvX: Float64Array.from(this.uvX),
            split: Uint32Array.from(this.split),
            lineStarts: this.lineStarts,
            triangles: Uint32Array.from(this.triangles),
        };
    }

    updateScaledDistance(): void {
        this.scaledDistance = this.clip ? this.clip[0] + (this.clip[1] - this.clip[0]) * this.distance / this.totalDistance : this.distance;
    }

    updateDistance(a: P, b: P): void {
        this.distance += dist(a, b);
        this.updateScaledDistance();
    }

    addLine(vertices: P[], isPolygon: boolean, join: string, cap: string, miterLimit: number, roundLimit: number, overscaling: number): void {
        this.lineStarts.push(this.x.length);
        this.distance = 0;
        this.scaledDistance = 0;
        this.totalDistance = 0;
        if (this.clip) {
            this.clips.push(this.clip);
            let total = 0;
            for (let i = 1; i < vertices.length; i++) total += dist(vertices[i - 1], vertices[i]);
            this.totalDistance = total;
            this.updateScaledDistance();
            this.maxLineLength = Math.max(this.maxLineLength, this.totalDistance);
        }
        let len = vertices.length;
        while (len >= 2 && eq(vertices[len - 1], vertices[len - 2])) len--;
        let first = 0;
        while (first < Math.max(len - 1, 0) && eq(vertices[first], vertices[first + 1])) first++;
        if (len < first + (isPolygon ? 3 : 2)) return;
        if (join === 'bevel') miterLimit = 1.05;
        const sharpCornerOffset = overscaling <= 16 ? SHARP_CORNER_OFFSET * EXTENT / (512 * overscaling) : 0;
        this.e1 = undefined;
        this.e2 = undefined;
        let current: P | undefined;
        let prevVertex: P | undefined;
        let prevNormal: P | undefined;
        let nextNormal: P | undefined;
        if (isPolygon) {
            current = vertices[len - 2];
            nextNormal = perp(unit(sub(vertices[first], vertices[len - 2])));
        }
        let prev: P | undefined;
        for (let i = first; i < len; i++) {
            const nextVertex = i === len - 1 ? (isPolygon ? vertices[first + 1] : undefined) : vertices[i + 1];
            if (nextVertex && eq(nextVertex, vertices[i])) continue;
            if (nextNormal) prevNormal = nextNormal;
            if (current) prev = current;
            prevVertex = prev;
            let cur = vertices[i];
            nextNormal = nextVertex ? perp(unit(sub(nextVertex, cur))) : prevNormal;
            const pn: P = prevNormal ?? nextNormal!;
            prevNormal = pn;
            const nn: P = nextNormal!;
            let joinNormal = add(pn, nn);
            if (joinNormal[0] !== 0 || joinNormal[1] !== 0) joinNormal = unit(joinNormal);
            const cosAngle = pn[0] * nn[0] + pn[1] * nn[1];
            const cosHalf = joinNormal[0] * nn[0] + joinNormal[1] * nn[1];
            const miterLength = cosHalf !== 0 ? 1 / cosHalf : Infinity;
            const approxAngle = 2 * Math.sqrt(2 - 2 * cosHalf);
            const isSharp = cosHalf < COS_HALF_SHARP_CORNER && prevVertex !== undefined && nextVertex !== undefined;
            const turnsLeft = pn[0] * nn[1] - pn[1] * nn[0] > 0;
            const offsetNormal = mult(joinNormal, Math.min(miterLength, MAX_OFFSET_MITER_LENGTH));
            const fallback = Math.min(Math.max((miterLength - OFFSET_FALLBACK_START) / (OFFSET_FALLBACK_END - OFFSET_FALLBACK_START), 0), 1);

            if (isSharp && i > first) {
                const pv = prevVertex!;
                const l = dist(cur, pv);
                if (l > 2 * sharpCornerOffset) {
                    const d = mult(sub(cur, pv), sharpCornerOffset / l);
                    const newPrev = sub(cur, [roundAway(d[0]), roundAway(d[1])]);
                    this.updateDistance(pv, newPrev);
                    this.addCurrentVertex(newPrev, pn, 0, 0, false, undefined, 0);
                    prevVertex = newPrev;
                }
            }
            const middle = prevVertex !== undefined && nextVertex !== undefined;
            let cj = middle ? join : isPolygon ? 'butt' : cap;
            if (middle && cj === 'round') {
                if (miterLength < roundLimit) cj = 'miter';
                else if (miterLength <= 2) cj = 'fakeround';
            }
            if (cj === 'miter' && miterLength > miterLimit) cj = 'bevel';
            if (cj === 'bevel') {
                if (miterLength > 2) cj = 'flipbevel';
                if (miterLength < miterLimit) cj = 'miter';
            }
            if (prevVertex) this.updateDistance(prevVertex, cur);
            const on = offsetNormal;
            switch (cj) {
                case 'miter':
                    joinNormal = mult(joinNormal, miterLength);
                    this.addCurrentVertex(cur, joinNormal, 0, 0, false, on, 0);
                    break;
                case 'flipbevel': {
                    if (miterLength > 100) {
                        joinNormal = mult(nn, -1);
                    } else {
                        const bevelLength = miterLength * mag(add(pn, nn)) / mag(sub(pn, nn));
                        joinNormal = mult(perp(joinNormal), bevelLength * (turnsLeft ? -1 : 1));
                    }
                    this.addCurrentVertex(cur, joinNormal, 0, 0, false, on, fallback);
                    this.addCurrentVertex(cur, mult(joinNormal, -1), 0, 0, false, on, fallback);
                    break;
                }
                case 'bevel':
                case 'fakeround': {
                    const offset = -Math.sqrt(miterLength * miterLength - 1);
                    const [oa, ob] = turnsLeft ? [offset, 0] : [0, offset];
                    if (prevVertex) this.addCurrentVertex(cur, pn, oa, ob, false, on, 0);
                    if (cj === 'fakeround') {
                        const n = truncI64(roundAway((approxAngle * 180 / Math.PI) / DEG_PER_TRIANGLE));
                        for (let m = 1; m < n; m++) {
                            let t = m / n;
                            if (t !== 0.5) {
                                const t2 = t - 0.5;
                                const a = 1.0904 + cosAngle * (-3.2452 + cosAngle * (3.55645 - cosAngle * 1.43519));
                                const b = 0.848013 + cosAngle * (-1.06021 + cosAngle * 0.215638);
                                t += t * t2 * (t - 1) * (a * t2 * t2 + b);
                            }
                            const e = mult(unit(add(mult(sub(nn, pn), t), pn)), turnsLeft ? -1 : 1);
                            const [ox, oy] = turnsLeft ? [-offsetNormal[0], -offsetNormal[1]] : [offsetNormal[0], offsetNormal[1]];
                            this.addHalfVertex(cur, e[0], e[1], ox, oy, false, turnsLeft);
                        }
                    }
                    if (nextVertex) this.addCurrentVertex(cur, nn, -oa, -ob, false, on, 0);
                    break;
                }
                case 'butt':
                    this.addCurrentVertex(cur, joinNormal, 0, 0, false, on, 0);
                    break;
                case 'square': {
                    const o = prevVertex ? 1 : -1;
                    this.addCurrentVertex(cur, joinNormal, o, o, false, on, 0);
                    break;
                }
                case 'round':
                    if (prevVertex) {
                        this.addCurrentVertex(cur, pn, 0, 0, false, on, fallback);
                        this.addCurrentVertex(cur, pn, 1, 1, true, on, fallback);
                    }
                    if (nextVertex) {
                        this.addCurrentVertex(cur, nn, -1, -1, true, on, fallback);
                        this.addCurrentVertex(cur, nn, 0, 0, false, on, fallback);
                    }
                    break;
            }
            if (isSharp && i < len - 1) {
                const nv = nextVertex!;
                const l = dist(cur, nv);
                if (l > 2 * sharpCornerOffset) {
                    const d = mult(sub(nv, cur), sharpCornerOffset / l);
                    const newCur = add(cur, [roundAway(d[0]), roundAway(d[1])]);
                    this.updateDistance(cur, newCur);
                    this.addCurrentVertex(newCur, nn, 0, 0, false, undefined, 0);
                    cur = newCur;
                }
            }
            current = cur;
        }
    }
}

/** One line-atlas entry (`LineAtlas.addDash`): a signed-distance row (or 2n+1 rows for
 * round caps) of `LINE_ATLAS_WIDTH` texels, values offset by 128. */
interface Dash {
    rows: Uint8Array[];
    n: number;
    /** Sum of the dasharray, in line widths. */
    length: number;
}

interface Range {
    left: number;
    right: number;
    isDash: boolean;
    zeroLength: boolean;
}

function dashRanges(dasharray: number[], stretch: number): Range[] {
    const odd = dasharray.length % 2 === 1;
    const ranges: Range[] = [{
        left: odd ? -dasharray[dasharray.length - 1] * stretch : 0,
        right: dasharray[0] * stretch,
        isDash: true,
        zeroLength: dasharray[0] === 0,
    }];
    let current = dasharray[0];
    let isDash = true;
    for (const d of dasharray.slice(1)) {
        isDash = !isDash;
        const left = current * stretch;
        current += d;
        ranges.push({left, right: current * stretch, isDash, zeroLength: d === 0});
    }
    return ranges;
}

function makeDash(dasharray: number[], round: boolean): Dash {
    const n = round ? 7 : 0;
    let length = 0;
    for (const d of dasharray) length += d;
    const w = LINE_ATLAS_WIDTH;
    const rows = Array.from({length: 2 * n + 1}, () => new Uint8Array(w));
    if (length !== 0 && dasharray.length > 0) {
        const stretch = w / length;
        const ranges = dashRanges(dasharray, stretch);
        if (round) {
            const half = stretch / 2;
            for (let y = -n; y <= n; y++) {
                const row = rows[n + y];
                let ci = 0;
                for (let x = 0; x < w; x++) {
                    if (x / ranges[ci].right > 1 && ci + 1 < ranges.length) ci++;
                    const r = ranges[ci];
                    const minDist = Math.min(Math.abs(x - r.left), Math.abs(x - r.right));
                    const distMiddle = y / n * (half + 1);
                    let sd: number;
                    if (r.isDash) {
                        const edge = half - Math.abs(distMiddle);
                        sd = Math.sqrt(minDist * minDist + edge * edge);
                    } else {
                        sd = half - Math.sqrt(minDist * minDist + distMiddle * distMiddle);
                    }
                    row[x] = asU8(sd + 128);
                }
            }
        } else {
            let i = ranges.length;
            while (i > 0) {
                i--;
                if (ranges[i].zeroLength) {
                    ranges.splice(i, 1);
                } else if (i + 1 < ranges.length && ranges[i + 1].isDash === ranges[i].isDash) {
                    ranges[i + 1].left = ranges[i].left;
                    ranges.splice(i, 1);
                }
            }
            if (ranges.length > 0 && ranges[0].isDash === ranges[ranges.length - 1].isDash) {
                const fl = ranges[ranges.length - 1].left - w;
                const lr = ranges[0].right + w;
                ranges[0].left = fl;
                ranges[ranges.length - 1].right = lr;
            }
            let ci = 0;
            const row = rows[0];
            for (let x = 0; x < w; x++) {
                if (x / ranges[ci].right > 1 && ci + 1 < ranges.length) ci++;
                const r = ranges[ci];
                const minDist = Math.min(Math.abs(x - r.left), Math.abs(x - r.right));
                row[x] = asU8((r.isDash ? minDist : -minDist) + 128);
            }
        }
    }
    return {rows, n, length};
}

/** Bilinear `REPEAT` sample at texture x `u` (0..1 per period) and row offset `r` in
 * 0..=2n, returning 0..1. */
function sampleDash(d: Dash, u: number, r: number): number {
    const w = LINE_ATLAS_WIDTH;
    const tx = u * w - 0.5;
    const x0 = Math.floor(tx);
    const fx = tx - x0;
    const xi = (x: number) => (((truncI64(x) % w) + w) % w);
    const a = xi(x0);
    const b = xi(x0 + 1);
    const rc = Math.min(Math.max(r, 0), 2 * d.n);
    const y0 = rc !== rc ? 0 : Math.floor(rc);
    const y1 = Math.min(y0 + 1, 2 * d.n);
    const fy = rc - y0;
    const row = (y: number) => d.rows[y][a] * (1 - fx) + d.rows[y][b] * fx;
    return (row(y0) * (1 - fy) + row(y1) * fy) / 255;
}

/** A color ramp row per line clip (`renderColorRamp`), stored like MapLibre's texture:
 * unpremultiplied bytes, premultiplied with rounding on upload. */
interface Gradient {
    width: number;
    /** RGBA bytes, `width` texels per row. */
    rows: Uint8Array[];
    nearest: boolean;
}

function newGradient(layer: Layer, clips: [number, number][], width: number): Gradient {
    const prop = paintProp(layer, 'line-gradient');
    const nearest = prop.isStep;
    const rows = clips.map(([start, end]) => {
        const row = new Uint8Array(width * 4);
        for (let i = 0; i < width; i++) {
            const t = i / (width - 1);
            const v = prop.evalLineProgress(start * (1 - t) + end * t);
            const c: Color = v instanceof Color ? v : Color.transparent;
            const a = roundAway(c.a * 255);
            const un = (v: number) => (c.a === 0 ? 0 : Math.min(Math.max(roundAway(v * 255 / c.a), 0), 255));
            const pm = (v: number) => asU8(roundAway(un(v) * a / 255));
            row.set([pm(c.r), pm(c.g), pm(c.b), asU8(a)], i * 4);
        }
        return row;
    });
    return {width, rows, nearest};
}

/** `CLAMP_TO_EDGE` sample of row `split` (1-based) at `u`. */
function sampleGradient(g: Gradient, u: number, split: number): Rgba {
    const row = split >= 1 ? g.rows[split - 1] : undefined;
    if (!row) return [0, 0, 0, 0];
    const w = g.width;
    const texel = (i: number): Rgba => {
        const k = Math.min(Math.max(i, 0), w - 1) * 4;
        return [row[k] / 255, row[k + 1] / 255, row[k + 2] / 255, row[k + 3] / 255];
    };
    if (g.nearest) return texel(truncI64(Math.floor(u * w)));
    const t = u * w - 0.5;
    const i0 = Math.floor(t);
    const f = t - i0;
    const a = texel(truncI64(i0));
    const b = texel(truncI64(i0) + 1);
    return [a[0] * (1 - f) + b[0] * f, a[1] * (1 - f) + b[1] * f, a[2] * (1 - f) + b[2] * f, a[3] * (1 - f) + b[3] * f];
}

/** A line layer's tessellated features in one tile (`LineBucket`). */
interface LineBucket {
    features: BucketFeature[];
    /** Built lines, by index into `features`. */
    lines: [number, LineGeometry][];
    /** `lineMetrics` clips of all lines; the gradient texture covers the whole tile bucket. */
    clips: [number, number][];
    maxLineLength: number;
}

function newLineBucket(layer: Layer, ctx: Ctx, tf: TileFeatures): LineBucket {
    const features = ctx.bucketFeatures(layer, tf, 'line-sort-key');
    const overscaling = 2 ** (tf.tile.overscaledZ - tf.tile.canonical.z);
    let clips: [number, number][] = [];
    let maxLineLength = 0;
    const lines: [number, LineGeometry][] = [];
    features.forEach((f, i) => {
        if (f.ty !== 2 && f.ty !== 3) return;
        const l = (name: string) => ctx.layout(layer, name, f, tf.tile);
        const b = new Builder();
        b.clips = clips;
        const props = f.feature.properties;
        const s = props[CLIP_START];
        const e = props[CLIP_END];
        b.clip = s !== undefined && e !== undefined ? [num(s), num(e)] : undefined;
        const join = l('line-join');
        const cap = l('line-cap');
        for (const line of drawnGeometry(ctx, f.geometry)) {
            b.addLine(
                line,
                f.ty === 3,
                typeof join === 'string' ? join : 'miter',
                typeof cap === 'string' ? cap : 'butt',
                num(l('line-miter-limit')),
                num(l('line-round-limit')),
                overscaling,
            );
        }
        clips = b.clips;
        maxLineLength = Math.max(maxLineLength, b.maxLineLength);
        lines.push([i, b.compact()]);
    });
    for (const f of features) f.geometry = NO_GEOMETRY;
    return {features, lines, clips, maxLineLength};
}

/** Rust `u64::next_power_of_two` of `x as u64` (wrapping to 0 on overflow, as in release builds). */
function nextPowerOfTwo(x: number): number {
    const v = x !== x ? 0 : Math.trunc(x);
    if (v >= 2 ** 63) return 0;
    let p = 1;
    while (p < v) p *= 2;
    return p;
}

export function drawLine(target: Target, layer: Layer, ctx: Ctx, tiles: TileFeatures[], sourceMaxzoom: number, mapMaxZoom: number, hasGradient: boolean, hasPattern: boolean): void {
    const dpr = ctx.transform.pixelRatio;
    // Dash textures by dasharray and cap (MapLibre's LineAtlas).
    const dashes: [number[], boolean, Dash][] = [];
    for (const tf of tiles) {
        const bucket = tf.bucket(layer, ctx, () => newLineBucket(layer, ctx, tf));
        const toWorld = ctx.tileToWorld(tf.tile);
        const tr = ctx.translate(layer, 'line', tf.tile);
        let gradient: Gradient | undefined;
        if (hasGradient) {
            const step = paintProp(layer, 'line-gradient').isStep;
            let width = 256;
            if (step) {
                const overzoom = tf.tile.canonical.z === sourceMaxzoom ? Math.ceil(2 ** (mapMaxZoom - tf.tile.canonical.z)) : 1;
                const coverage = bucket.maxLineLength / EXTENT * 1024 * overzoom;
                width = Math.min(Math.max(nextPowerOfTwo(Math.max(coverage, 1)), 256), MAX_TEXTURE_SIZE);
            }
            gradient = newGradient(layer, bucket.clips, width);
        }
        for (const [i, b] of bucket.lines) {
            drawFeature(target, layer, ctx, tf, bucket.features[i], b, toWorld, tr, dpr, gradient, hasPattern, dashes);
        }
    }
}

interface LinePoint {
    pos: P;
    screen: P;
    d: number;
}

function drawFeature(
    target: Target,
    layer: Layer,
    ctx: Ctx,
    tf: TileFeatures,
    f: BucketFeature,
    b: LineGeometry,
    toWorld: (p: P) => P,
    tr: P,
    dpr: number,
    gradient: Gradient | undefined,
    hasPattern: boolean,
    dashes: [number[], boolean, Dash][],
): void {
    const p = (name: string) => ctx.paint(layer, name, f, tf.tile);
    const l = (name: string) => ctx.layout(layer, name, f, tf.tile);
    const opacity = num(p('line-opacity'));
    if (opacity < 0.01) return;
    const floorZoom = Math.floor(ctx.transform.zoom);
    const canonical = Ctx.canonical(tf.tile);
    // `line-pattern` takes over the whole layer (the pattern program ignores dashes).
    let img: StyleImage | undefined;
    if (hasPattern) {
        const prop = paintProp(layer, 'line-pattern');
        const v = prop.isFeatureConstant() ? prop.eval(floorZoom, undefined, canonical) : prop.eval(tf.tile.overscaledZ, f.feature, canonical);
        const name = pattern.imageName(v);
        img = name !== undefined ? ctx.images.get(name) : undefined;
        if (!img) return;
    }
    let dash: Dash | undefined;
    const dv = img ? null : paintProp(layer, 'line-dasharray').eval(floorZoom, f.feature, canonical);
    if (Array.isArray(dv) && dv.length > 0) {
        const d: number[] = dv.map(num);
        // A non-data-driven dasharray uses the layer's cap only if that is constant too.
        const capProp = layoutProp(layer, 'line-cap');
        const round = paintProp(layer, 'line-dasharray').isFeatureConstant()
            ? capProp.isFeatureConstant() && l('line-cap') === 'round'
            : l('line-cap') === 'round';
        let entry = dashes.find(([k, r]) => r === round && k.length === d.length && k.every((x, j) => x === d[j]));
        if (!entry) {
            entry = [d, round, makeDash(d, round)];
            dashes.push(entry);
        }
        dash = entry[2];
    }
    const width = num(p('line-width'));
    const gap = num(p('line-gap-width'));
    const offset = -num(p('line-offset'));
    const blur = num(p('line-blur'));
    const c: Rgba = color(p('line-color'), opacity);
    // Vertex shader.
    const aa = 1 / dpr / 2;
    const gapwidth = gap / 2;
    const halfwidth = width / 2;
    const inset = gapwidth + (gapwidth > 0 ? aa : 0);
    const outset = gapwidth + halfwidth * (gapwidth > 0 ? 2 : 1) + (halfwidth === 0 ? 0 : aa);
    const rotations = ctx.transform.isProjected() ? ctx.rotations(tf.tile) : undefined;
    // Vertices come in pairs on the same point: its projection and rotation.
    let frame: {pos: P; screen: P; rot: [number, number]} | undefined;
    // Projected: each line's points (tile position, screen position, distance along the projected
    // line in device pixels), for dashes and patterns to repeat evenly on the output (`linesofar` is
    // along the line in tile units), and each vertex's point.
    const points: LinePoint[] = [];
    const starts: number[] = [];
    const pointOf: number[] = [];
    let ls = 0;
    const screen: P[] = Array.from({length: b.x.length}, (_, i): P => {
        const pos: P = [b.x[i], b.y[i]];
        const normalY = b.flags[i] & 2 ? 1 : -1;
        const w = toWorld(pos);
        const ex = b.ext[4 * i] / EXTRUDE_SCALE;
        const ey = b.ext[4 * i + 1] / EXTRUDE_SCALE;
        const nx = b.ext[4 * i + 2] / EXTRUDE_SCALE;
        const ny = b.ext[4 * i + 3] / EXTRUDE_SCALE;
        let ox = offset * nx * normalY + outset * ex;
        let oy = offset * ny * normalY + outset * ey;
        if (!rotations) return ctx.transform.worldToScreen([w[0] + ox + tr[0], w[1] + oy + tr[1]]);
        // Projected: the point is projected and the width extruded in screen pixels.
        // Vertices run along each line from its start (which may be the previous line's end).
        // (Lines that added no vertices start at the same index as the next.)
        let lineStart = false;
        while (ls < b.lineStarts.length && b.lineStarts[ls] <= i) {
            ls++;
            lineStart = true;
        }
        let fr: {pos: P; screen: P; rot: [number, number]};
        if (frame && eq(frame.pos, pos) && !lineStart) {
            fr = frame;
        } else {
            fr = {pos, screen: ctx.transform.worldToScreen(w), rot: rotations.at(pos)};
            frame = fr;
            const last = points[points.length - 1];
            let d: number;
            if (last && !lineStart) {
                d = last.d + Math.sqrt((fr.screen[0] - last.screen[0]) ** 2 + (fr.screen[1] - last.screen[1]) ** 2);
            } else {
                starts.push(points.length);
                d = 0;
            }
            points.push({pos, screen: fr.screen, d});
        }
        pointOf.push(points.length - 1);
        const [sin, cos] = fr.rot;
        ox += tr[0];
        oy += tr[1];
        return [fr.screen[0] + (ox * cos - oy * sin) * dpr, fr.screen[1] + (ox * sin + oy * cos) * dpr];
    });
    const blur2 = blur + 1 / dpr;
    // Dash texture x per vertex: distance in pixels at the integer tile zoom, in dash periods.
    const floorwidth = num(paintProp(layer, 'line-width').eval(floorZoom, f.feature, canonical));
    const tileratio = 512 * 2 ** (Math.max(floorZoom, 0) - tf.tile.canonical.z) / EXTENT;
    let sdfgamma = 0;
    let scaleX = 0;
    if (dash) {
        // The gradient variant of the shader omits the device pixel ratio.
        sdfgamma = (gradient ? 1 : 1 / dpr) / dash.length;
        scaleX = tileratio / dash.length / floorwidth;
    } else if (img) {
        // Pattern: x = linesofar / pattern_size.x * aspect (in pattern repeats).
        const ds = pattern.displaySize(img);
        const patternSizeX = ds[0] / tileratio;
        const aspect = ds[1] / floorwidth;
        scaleX = aspect / patternSizeX;
    }
    // Projected: the distance on the output, in pixels of the integer zoom like `linesofar * tileratio`.
    const along =
        rotations && scaleX !== 0
            ? edgeAnchored(points, starts, scaleX / tileratio / dpr / 2 ** (ctx.transform.zoom - Math.max(floorZoom, 0)))
            : undefined;
    // Projected: segments across a singularity of the projection are left out (see `bent`).
    const broken: boolean[] = [];
    if (rotations) {
        const toScreen = (q: P) => ctx.transform.worldToScreen(toWorld(q));
        for (let k = 1; k < points.length; k++) broken.push(bent(toScreen, points[k - 1].pos, points[k].pos, points[k - 1].screen, points[k].screen));
    }
    const pimg = img;
    const tris = b.triangles;
    // The fragment shader; its result is reused by the next fragment.
    const out: Rgba = [0, 0, 0, 0];
    const scaled = (col: ArrayLike<number>, k: number): Rgba => {
        for (let j = 0; j < 4; j++) out[j] = col[j] * k;
        return out;
    };
    // All three vertices of a triangle share the split row.
    let split = 0;
    const shade = (v: ArrayLike<number>): Rgba | undefined => {
        const d = Math.sqrt(v[0] * v[0] + v[1] * v[1]) * outset;
        let alpha = Math.min(Math.max(Math.min(d - (inset - blur2), outset - d) / blur2, 0), 1);
        if (dash) {
            const r = dash.n * (1 - v[1]);
            const sdf = sampleDash(dash, v[2], r);
            alpha *= raster.smoothstep(0.5 - sdfgamma / floorwidth, 0.5 + sdfgamma / floorwidth, sdf);
        }
        if (pimg) {
            const x = v[2] - Math.floor(v[2]);
            return scaled(pattern.sampleLine(pimg, x, 0.5 * v[1] + 0.5), alpha * opacity);
        }
        if (gradient) return scaled(sampleGradient(gradient, v[3], split), alpha * opacity);
        return scaled(c, alpha);
    };
    const plain = !dash && !pimg && !gradient;
    for (let k = 0; k + 2 < tris.length; k += 3) {
        const t: [number, number, number] = [tris[k], tris[k + 1], tris[k + 2]];
        if (rotations) {
            const kk = t.map((i) => pointOf[i]);
            const lo = Math.min(kk[0], kk[1], kk[2]);
            const hi = Math.max(kk[0], kk[1], kk[2]);
            if (hi > lo && broken[lo]) continue;
        }
        split = b.split[t[0]];
        const vary = t.map((i) => {
            const x = along ? along[pointOf[i]] : b.linesofar[i] * scaleX;
            return [b.flags[i] & 1, b.flags[i] & 2 ? 1 : -1, x, b.uvX[i]];
        });
        const tri = [screen[t[0]], screen[t[1]], screen[t[2]]];
        if (plain) {
            // `shade` without dashes, patterns or gradients, inlined.
            raster.triangleRuns(target, tf.mask, tri, vary, (i0, x0, x1, row, gx, p0x) => {
                for (let x = x0; x < x1; x++) {
                    const dx = x + 0.5 - p0x;
                    const v0 = row[0] + gx[0] * dx;
                    const v1 = row[1] + gx[1] * dx;
                    const d = Math.sqrt(v0 * v0 + v1 * v1) * outset;
                    const alpha = Math.min(Math.max(Math.min(d - (inset - blur2), outset - d) / blur2, 0), 1);
                    for (let j = 0; j < 4; j++) out[j] = c[j] * alpha;
                    target.blend(i0 + x, out);
                }
            });
            continue;
        }
        raster.triangle(target, tf.mask, tri, vary, shade);
    }
}

/** Projected: the dash / pattern position (in repeats, `k` per device pixel) of each line point.
 * Tiles clip lines at their own buffer, so counting from the clipped start would break the pattern
 * at tile edges: instead it starts at each crossing of the tile edge, stretched to a whole number
 * of repeats between crossings. Lines without crossings count from their start as usual. */
export function edgeAnchored(points: LinePoint[], starts: number[], k: number): number[] {
    const inside = (p: P) => p[0] >= 0 && p[0] <= EXTENT && p[1] >= 0 && p[1] <= EXTENT;
    // Where a → b (one inside the tile, one outside) crosses the tile edge, as a fraction of a → b.
    const crossing = (a: P, b: P) => {
        let t0 = 0;
        let t1 = 1;
        for (let i = 0; i < 2; i++) {
            const d = b[i] - a[i];
            if (d !== 0) {
                const u = -a[i] / d;
                const v = (EXTENT - a[i]) / d;
                t0 = Math.max(t0, Math.min(u, v));
                t1 = Math.min(t1, Math.max(u, v));
            }
        }
        return inside(a) ? t1 : t0;
    };
    const out: number[] = [];
    starts.forEach((s, l) => {
        const line = points.slice(s, l + 1 < starts.length ? starts[l + 1] : points.length);
        const anchors: number[] = [];
        for (let i = 1; i < line.length; i++) {
            const [a, b] = [line[i - 1], line[i]];
            if (inside(a.pos) !== inside(b.pos)) anchors.push((a.d + (b.d - a.d) * crossing(a.pos, b.pos)) * k);
        }
        if (anchors.length === 0) {
            for (const p of line) out.push(p.d * k);
            return;
        }
        // Repeats from anchor i to i + 1, and the stretch that makes them whole.
        const span = (i: number): [number, number] => {
            const len = anchors[i + 1] - anchors[i];
            if (len > 0) {
                const n = Math.max(roundAway(len), 1);
                return [n, n / len];
            }
            return [0, 1];
        };
        let i = 0;
        let base = 0;
        for (const p of line) {
            const x = p.d * k;
            while (i + 1 < anchors.length && x >= anchors[i + 1]) {
                base += span(i)[0];
                i++;
            }
            const stretch = x < anchors[i] || i + 1 === anchors.length ? 1 : span(i)[1];
            out.push(base + (x - anchors[i]) * stretch);
        }
    });
    return out;
}
