// Layer drawing: background, fill, line, circle, emulating MapLibre's buckets and shaders.

import {Color} from '@maplibre/maplibre-gl-style-spec';
import earcut from 'earcut';
import {type CanonicalTileId, type Feature, type Layer, type Properties, type PropValue, type Value, layout as layoutProp, paint as paintProp} from '../style.ts';
import {type Feature as MvtFeature, type GeomType, type Layer as MvtLayer, geomTypeName} from '../mvt.ts';
import {type RenderTile, TileId, type Transform, renderTileKey} from '../tile.ts';
import type {StyleImage} from '../sprite.ts';
import {roundAway} from '../util.ts';
import * as raster from './raster.ts';
import {Mask, type Rgba, type Target} from './raster.ts';
import * as pattern from './pattern.ts';
import type {DemTile} from './dem.ts';

export {drawLine} from './line.ts';

export const EXTENT = 8192;

type P = [number, number];

/** Longest segment (tile units) of lines and polygon rings drawn into a projected output, where
 * projected segments curve. */
const PROJECTED_SEGMENT = EXTENT / 32;

/** `line` with segments longer than `max` split evenly. */
export function densify(line: P[], max: number): P[] {
    const out: P[] = [];
    for (let i = 0; i < line.length; i++) {
        const p = line[i];
        if (i > 0) {
            const a = line[i - 1];
            const n = usize(Math.ceil(Math.sqrt((p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2) / max));
            for (let k = 1; k < n; k++) {
                const t = k / n;
                out.push([a[0] + (p[0] - a[0]) * t, a[1] + (p[1] - a[1]) * t]);
            }
        }
        out.push(p);
    }
    return out;
}

/** Rust `x as usize` from a float (truncating, saturating at 0, NaN → 0). */
function usize(x: number): number {
    return x !== x || x <= 0 ? 0 : Math.trunc(x);
}

/** Splits every triangle edge longer than `max` at its midpoint (appended to `xy`) until none
 * is, for projections that curve them. An edge is split the same way in both of its triangles, so
 * the mesh stays free of T-junctions (and of cracks between triangles). */
function subdivide(xy: number[], triangles: number[], max: number): number[] {
    const mids = new Map<number, number>();
    const out: number[] = [];
    const todo: [number, number, number][] = [];
    for (let i = 0; i + 2 < triangles.length; i += 3) todo.push([triangles[i], triangles[i + 1], triangles[i + 2]]);
    const long = (a: number, b: number) => (xy[2 * a] - xy[2 * b]) ** 2 + (xy[2 * a + 1] - xy[2 * b + 1]) ** 2 > max * max;
    const mid = (a: number, b: number) => {
        // ponytail: numeric key assumes < 2^26 points per polygon.
        const key = Math.min(a, b) * 67108864 + Math.max(a, b);
        let m = mids.get(key);
        if (m === undefined) {
            xy.push((xy[2 * a] + xy[2 * b]) / 2, (xy[2 * a + 1] + xy[2 * b + 1]) / 2);
            m = xy.length / 2 - 1;
            mids.set(key, m);
        }
        return m;
    };
    let t: [number, number, number] | undefined;
    while ((t = todo.pop()) !== undefined) {
        // Edge i runs from t[i] to t[(i + 1) % 3].
        const split: number[] = [];
        for (let i = 0; i < 3; i++) {
            if (long(t[i], t[(i + 1) % 3])) split.push(i);
        }
        if (split.length === 0) {
            out.push(t[0], t[1], t[2]);
            continue;
        }
        // Rotate so that the split edges come first: (a, b) and, then, (b, c).
        const r = split.length === 2 && split[0] === 0 && split[1] === 2 ? 2 : split[0];
        const [a, b, c] = [t[r], t[(r + 1) % 3], t[(r + 2) % 3]];
        const mab = mid(a, b);
        if (split.length === 1) {
            todo.push([a, mab, c], [mab, b, c]);
        } else if (split.length === 2) {
            const mbc = mid(b, c);
            todo.push([mab, b, mbc], [a, mab, mbc], [a, mbc, c]);
        } else {
            const mbc = mid(b, c);
            const mca = mid(c, a);
            todo.push([a, mab, mca], [mab, b, mbc], [mca, mbc, c], [mab, mbc, mca]);
        }
    }
    return out;
}

/** A feature's lines or rings as drawn with `ctx`: split for a projected output. */
export function drawnGeometry(ctx: Ctx, geometry: P[][]): P[][] {
    return ctx.transform.isProjected() ? geometry.map((l) => densify(l, PROJECTED_SEGMENT)) : geometry;
}

export class Ctx {
    transform: Transform;
    globalState: Properties;
    images: Map<string, StyleImage>;
    // A context borrows one immutable transform and lives for one render. Keeping the
    // cache here avoids stale masks after a camera clamp or a change in resolved tiles.
    private maskCache = new Map<string, Mask[]>();
    /** Backfilled DEM tiles by source id, aligned with the source's resolved tiles. */
    private demCache = new Map<string, (DemTile | undefined)[]>();
    /** `rotations` by tile. */
    private rotationCache = new Map<string, RotationGrid>();
    /** The expression feature (without geometry) of each source feature, shared by the layers. */
    private features = new Map<MvtFeature, Feature>();

    constructor(transform: Transform, globalState: Properties, images: Map<string, StyleImage>) {
        this.transform = transform;
        this.globalState = globalState;
        this.images = images;
    }

    /** `Transform::local_frame`'s rotations over a tile (see `RotationGrid`), built once per render. */
    rotations(tile: RenderTile): RotationGrid {
        const key = renderTileKey(tile);
        let grid = this.rotationCache.get(key);
        if (!grid) {
            const toWorld = this.tileToWorld(tile);
            const n = RotationGrid.N;
            const step = EXTENT / n;
            const rot: [number, number][] = [];
            for (let j = 0; j <= n; j++) {
                for (let i = 0; i <= n; i++) rot.push(this.transform.localFrame(toWorld([i * step, j * step]))[1]);
            }
            grid = new RotationGrid(rot);
            this.rotationCache.set(key, grid);
        }
        return grid;
    }

    /** The DEM tiles of `source`, built once per render and shared by its hillshade and
     * color-relief layers. */
    demTiles(source: string, build: () => (DemTile | undefined)[]): (DemTile | undefined)[] {
        let tiles = this.demCache.get(source);
        if (!tiles) {
            tiles = build();
            this.demCache.set(source, tiles);
        }
        return tiles;
    }

    tilePx(tile: RenderTile): number {
        return this.transform.worldSize / 2 ** tile.canonical.z;
    }

    /** World CSS-pixel origin of a tile. */
    tileOrigin(tile: RenderTile): P {
        const s = this.tilePx(tile);
        return [tile.canonical.x * s + tile.wrap * this.transform.worldSize, tile.canonical.y * s];
    }

    /** Tile units (EXTENT) → world CSS pixels. */
    tileToWorld(tile: RenderTile): (p: P) => P {
        const o = this.tileOrigin(tile);
        const s = this.tilePx(tile) / EXTENT;
        return (p) => [o[0] + p[0] * s, o[1] + p[1] * s];
    }

    tileMask(tile: RenderTile, w: number, h: number): Mask {
        const f = this.tileToWorld(tile);
        const c: P[] = [[0, 0], [EXTENT, 0], [EXTENT, EXTENT], [0, EXTENT]];
        const q = c.map((p) => this.transform.worldToScreen(f(p))) as [P, P, P, P];
        return Mask.fromQuad(w, h, q);
    }

    /** A tile owns its quad except where a higher-zoom child covers it. The whole
     * ordered tile set matters: layers can share masks only for the same coverage. */
    masks(tiles: RenderTile[], w: number, h: number): Mask[] {
        const key = `${w},${h},${tiles.map(renderTileKey).join(';')}`;
        const cached = this.maskCache.get(key);
        if (cached) return cached;
        const world = this.transform.pixelWorld();
        if (world && world.length === w * h) {
            const masks = projectedMasks(tiles, w, h, world, this.transform.centralX());
            this.maskCache.set(key, masks);
            return masks;
        }
        const quads = tiles.map((t) => this.tileMask(t, w, h));
        const masks = tiles.map((t, i) => {
            const children: number[] = [];
            tiles.forEach((u, j) => {
                if (u.canonical.z > t.canonical.z && u.wrap === t.wrap) {
                    const p = u.canonical.parentAt(t.canonical.z);
                    if (p.x === t.canonical.x && p.y === t.canonical.y && p.z === t.canonical.z) children.push(j);
                }
            });
            if (children.length === 0) return quads[i];
            // A fresh copy of the quad (`quads[i]` stays intact for subtracting from parents).
            const m = this.tileMask(t, w, h);
            for (const j of children) m.subtract(quads[j]);
            return m;
        });
        this.maskCache.set(key, masks);
        return masks;
    }

    /** The tile's canonical ID (expressions only read `z`, `x`, `y`). */
    static canonical(tile: RenderTile): CanonicalTileId {
        return tile.canonical;
    }

    /** Filter and prepare a tile layer's features (MapLibre `populate`): geometry scaled to
     * EXTENT, filter evaluated at the tile's zoom, sorted by `sortKeyProp` if set. */
    bucketFeatures(layer: Layer, tf: TileFeatures, sortKeyProp: string | undefined): BucketFeature[] {
        return this.filteredFeatures(layer, tf, sortKeyProp, true);
    }

    /** `bucketFeatures`, with empty `BucketFeature.geometry` unless `withGeometry`. */
    filteredFeatures(layer: Layer, tf: TileFeatures, sortKeyProp: string | undefined, withGeometry: boolean): BucketFeature[] {
        const zoom = tf.tile.overscaledZ;
        const scale = EXTENT / tf.layer.extent;
        const canonical = Ctx.canonical(tf.tile);
        const sortProp = sortKeyProp !== undefined ? layoutProp(layer, sortKeyProp) : undefined;
        const sorted = sortProp !== undefined && !sortProp.isConstant();
        const out: BucketFeature[] = [];
        tf.layer.features.forEach((f, index) => {
            const scaleGeometry = (): P[][] => {
                const {xy, ends} = f.geometry;
                const out: P[][] = [];
                let i = 0;
                for (const end of ends) {
                    const line: P[] = [];
                    for (; i < end; i++) line.push([roundAway(xy[2 * i] * scale), roundAway(xy[2 * i + 1] * scale)]);
                    out.push(line);
                }
                return out;
            };
            // Most filters only inspect properties. Avoid allocating and transforming
            // geometry for rejected features; geometry expressions still see EXTENT units.
            const geometry = layer.needsGeometry ? scaleGeometry() : undefined;
            // Without geometry, the layers of a tile share one feature (and its converted form).
            let feature = geometry ? undefined : this.features.get(f);
            if (!feature) {
                feature = {id: f.id, geomType: geomTypeName(f.type), properties: f.properties, geometry};
                if (!geometry) this.features.set(f, feature);
            }
            if (layer.filter && !layer.filter(zoom, feature, canonical)) return;
            const g = withGeometry ? (geometry ?? scaleGeometry()) : NO_GEOMETRY;
            const sortKey = sorted ? num(sortProp!.eval(zoom, feature, canonical)) : 0;
            out.push({feature, ty: f.type, geometry: g, sortKey, index});
        });
        if (sorted) out.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
        return out;
    }

    /** Evaluate a paint property for a feature at the current zoom. */
    paint(layer: Layer, name: string, f: BucketFeature | undefined, tile: RenderTile): Value {
        return this.eval(paintProp(layer, name), f, tile, this.transform.zoom);
    }

    layout(layer: Layer, name: string, f: BucketFeature | undefined, tile: RenderTile): Value {
        return this.eval(layoutProp(layer, name), f, tile, tile.overscaledZ);
    }

    private eval(p: PropValue, f: BucketFeature | undefined, tile: RenderTile, zoom: number): Value {
        return p.eval(zoom, f?.feature, Ctx.canonical(tile));
    }

    /** `translatePosition` as a world-space (CSS px) offset. */
    translate(layer: Layer, prefix: string, tile: RenderTile): P {
        const t = num2(this.paint(layer, `${prefix}-translate`, undefined, tile));
        const anchor = this.paint(layer, `${prefix}-translate-anchor`, undefined, tile);
        if (anchor === 'viewport') {
            // Screen-aligned: undo the map rotation.
            const a = -this.transform.bearingRad;
            const s = Math.sin(a);
            const c = Math.cos(a);
            return [t[0] * c - t[1] * s, t[0] * s + t[1] * c];
        }
        return t;
    }
}

/** Camera-independent bucket data of one tile, by layout group. It lives as long as the tile's
 * data stays cached, so later renders of other views reuse it. */
export type TileBuckets = Map<string, unknown>;

/** A tile's features for one style layer, with its clip mask. */
export class TileFeatures {
    tile: RenderTile;
    mask: Mask;
    layer: MvtLayer;
    /** Where `bucket` keeps its results; `undefined` builds them afresh. */
    buckets: TileBuckets | undefined;

    constructor(tile: RenderTile, mask: Mask, layer: MvtLayer, buckets: TileBuckets | undefined) {
        this.tile = tile;
        this.mask = mask;
        this.layer = layer;
        this.buckets = buckets;
    }

    /** `build`'s result for `layer` in this tile, shared by its layout group. It must depend
     * only on the tile, the layer's source data and layout, and whether `ctx` is projected
     * (geometry is split then), not on paint or the camera: it is reused across layers and renders. */
    bucket<T>(layer: Layer, ctx: Ctx, build: () => T): T {
        if (ctx.transform.isProjected()) return this.bucketKeyed(`${layer.layoutGroup}\0projected`, build);
        return this.bucketKeyed(layer.layoutGroup, build);
    }

    /** `bucket` under an explicit key, for buckets that also depend on more than the tile's data
     * region and layout (e.g. the world copy or the pixel ratio). */
    bucketKeyed<T>(key: string, build: () => T): T {
        const cache = this.buckets;
        if (!cache) return build();
        if (cache.has(key)) return cache.get(key) as T;
        const b = build();
        cache.set(key, b);
        return b;
    }
}

/** The rotations (sin, cos) of `Transform.localFrame` on a grid over a tile, interpolated in
 * between: they vary slowly, and each costs two extra projections. */
export class RotationGrid {
    static readonly N = 8;
    grid: [number, number][];

    constructor(grid: [number, number][]) {
        this.grid = grid;
    }

    /** At tile point `p` (tile units). */
    at(p: P): [number, number] {
        const n = RotationGrid.N;
        const g = (v: number) => Math.min(Math.max(v / EXTENT * n, 0), n - 1e-9);
        const gx = g(p[0]);
        const gy = g(p[1]);
        const i = Math.trunc(gx);
        const j = Math.trunc(gy);
        const fx = gx - i;
        const fy = gy - j;
        const at = (i: number, j: number) => this.grid[j * (n + 1) + i];
        const lerp = (k: 0 | 1) =>
            (at(i, j)[k] * (1 - fx) + at(i + 1, j)[k] * fx) * (1 - fy) + (at(i, j + 1)[k] * (1 - fx) + at(i + 1, j + 1)[k] * fx) * fy;
        const s = lerp(0);
        const c = lerp(1);
        const len = Math.sqrt(s * s + c * c);
        return len > 0 ? [s / len, c / len] : [0, 1];
    }
}

/** A fill layer's polygons in one tile, triangulated. */
interface FillBucket {
    features: BucketFeature[];
    /** Per polygon feature (by index into `features`): its polygons. */
    polygons: [number, FillPolygon[]][];
}

interface FillPolygon {
    /** Ring vertices, concatenated (exterior first), as x, y pairs in tile units. */
    xy: number[];
    ringLens: number[];
    /** `earcut` indices into `points`. */
    triangles: number[];
}

function newFillBucket(layer: Layer, ctx: Ctx, tf: TileFeatures): FillBucket {
    const features = ctx.bucketFeatures(layer, tf, 'fill-sort-key');
    const polygons: [number, FillPolygon[]][] = [];
    features.forEach((f, i) => {
        if (f.ty !== 3) return;
        const polys = classifyRings(drawnGeometry(ctx, f.geometry), 500).map((polygon): FillPolygon => {
            const flat: number[] = [];
            const holes: number[] = [];
            polygon.forEach((ring, i) => {
                if (i > 0) holes.push(flat.length / 2);
                for (const p of ring) flat.push(p[0], p[1]);
            });
            // npm `earcut` (v3, as MapLibre uses) where Rust used `earcutr` (a port of earcut 2.x):
            // triangulations can differ, their coverage of a valid polygon cannot.
            let triangles = earcut(flat, holes, 2);
            // Long interior edges curve in a projected output too (after the rings' points).
            if (ctx.transform.isProjected()) triangles = subdivide(flat, triangles, PROJECTED_SEGMENT);
            return {xy: flat, ringLens: polygon.map((r) => r.length), triangles};
        });
        polygons.push([i, polys]);
    });
    // Only the triangulated polygons are drawn.
    for (const f of features) f.geometry = NO_GEOMETRY;
    return {features, polygons};
}

/** `BucketFeature.geometry` once a bucket no longer needs it. Never modified. */
export const NO_GEOMETRY = Object.freeze([]) as unknown as P[][];

/** A feature ready for bucket building: geometry in EXTENT (8192) units. */
export interface BucketFeature {
    feature: Feature;
    ty: GeomType;
    geometry: P[][];
    sortKey: number;
    /** Index of the feature in its source layer. */
    index: number;
}

export function num(v: Value): number {
    return typeof v === 'number' ? v : 0;
}

export function num2(v: Value): P {
    return Array.isArray(v) && v.length >= 2 ? [num(v[0]), num(v[1])] : [0, 0];
}

/** Premultiplied color times opacity. */
export function color(v: Value, opacity: number): Rgba {
    return v instanceof Color ? [v.r * opacity, v.g * opacity, v.b * opacity, v.a * opacity] : [0, 0, 0, 0];
}

/** Rust `Value::truthy`. */
export function truthy(v: Value): boolean {
    if (v === null || v === undefined) return false;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0 && v === v;
    if (typeof v === 'string') return v.length > 0;
    return true;
}

/** Whether a raw layer JSON's `paint` has `key` (serde `raw["paint"].get(key).is_some()`). */
export function hasPaint(raw: any, key: string): boolean {
    const p = raw?.paint;
    return p !== null && typeof p === 'object' && !Array.isArray(p) && Object.hasOwn(p, key);
}

const mul4 = (c: ArrayLike<number>, k: number): Rgba => [c[0] * k, c[1] * k, c[2] * k, c[3] * k];

/** Which part of a layer to draw. MapLibre draws opaque backgrounds and fill interiors in a
 * top-down opaque pass, then everything else bottom-up (`Target.occ` stands in for the depth
 * buffer that lets the opaque pass skip what it hides).
 * - `All`: everything, in style order (no occlusion buffer).
 * - `Opaque`: only the opaque-pass part; the draw function returns whether there was one.
 * - `Translucent`: everything but the opaque-pass part, which was drawn already. */
export type Pass = 'All' | 'Opaque' | 'Translucent';

/** Returns whether anything was drawn in `'Opaque'`. */
export function drawBackground(target: Target, layer: Layer, ctx: Ctx, raw: any, pass: Pass): boolean {
    const tile = dummyTile();
    const opacity = num(ctx.paint(layer, 'background-opacity', undefined, tile));
    if (opacity === 0) return false;
    const t = ctx.transform;
    // A set pattern is cross-faded (evaluated at the integer zoom); with no resolvable image
    // MapLibre skips the layer.
    let img: StyleImage | undefined;
    if (hasPaint(raw, 'background-pattern')) {
        const v = paintProp(layer, 'background-pattern').eval(Math.floor(t.zoom));
        const name = pattern.imageName(v);
        img = name !== undefined ? ctx.images.get(name) : undefined;
        if (!img) return false;
    }
    if (!img) {
        const c = color(ctx.paint(layer, 'background-color', undefined, tile), opacity);
        if (pass === 'Opaque' && c[3] !== 1) return false;
        // In a projected output: wherever the projection has Mercator coordinates.
        const world = t.pixelWorld();
        if (world && world.length === target.w * target.h) {
            const cover = c[3] === 1 ? target.coverer(c) : undefined;
            for (let i = 0; i < world.length; i++) {
                if (Number.isFinite(world[i][0])) {
                    if (cover) cover(i);
                    else if (target.visible(i)) target.blend(i, c);
                }
            }
            return true;
        }
        // Drawn over the covering tiles, i.e. only within the world's vertical extent.
        // `t.screenToWorld([x + 0.5, y + 0.5])[1]`, inlined: one call per pixel dominated large views.
        const [s, co] = t.rot[1];
        const cover = c[3] === 1 ? target.coverer(c) : undefined;
        // `wy` is monotone along a row, so the covered pixels are an interval: a row whose ends are
        // both covered is covered entirely.
        const rowY = (x: number, sy: number) => ((x + 0.5) / t.pixelRatio - t.width / 2) * s + sy * co + t.center[1];
        const inWorld = (wy: number) => wy >= 0 && wy < t.worldSize;
        for (let y = 0; y < target.h; y++) {
            const sy = (y + 0.5) / t.pixelRatio - t.height / 2;
            const whole = inWorld(rowY(0, sy)) && inWorld(rowY(target.w - 1, sy));
            if (whole && cover) {
                cover.run(y * target.w, (y + 1) * target.w);
                continue;
            }
            for (let x = 0; x < target.w; x++) {
                if (whole || inWorld(rowY(x, sy))) {
                    const i = y * target.w + x;
                    if (cover) cover(i);
                    else if (target.visible(i)) target.blend(i, c);
                }
            }
        }
        return true;
    }
    if (pass === 'Opaque') return false;
    const pimg = img;
    const size = pattern.displaySize(pimg);
    // In a projected output: the pattern on the output's pixels, wherever there is map.
    const world = t.pixelWorld();
    if (world && world.length === target.w * target.h) {
        const tp = new pattern.TilePattern(ctx, tile);
        for (let i = 0; i < world.length; i++) {
            if (Number.isFinite(world[i][0]) && target.visible(i)) {
                const screen: P = [(i % target.w) + 0.5, Math.floor(i / target.w) + 0.5];
                const v = tp.pos(size, [0, 0], screen);
                target.blend(i, mul4(pattern.sampleFill(pimg, v), opacity));
            }
        }
        return true;
    }
    // Pattern: one quad per covering tile at the integer zoom.
    const z = Math.max(Math.floor(t.zoom), 0);
    for (const [x, y, wrap] of t.coveringTiles(z)) {
        const rt: RenderTile = {overscaledZ: z, wrap, canonical: new TileId(z, x, y)};
        const tp = new pattern.TilePattern(ctx, rt);
        const toWorld = ctx.tileToWorld(rt);
        const corners: P[] = [[0, 0], [EXTENT, 0], [0, EXTENT], [EXTENT, EXTENT]];
        const screen = corners.map((p) => t.worldToScreen(toWorld(p)));
        const vary = corners.map((p) => tp.patternPos(size, p));
        for (const tri of [[1, 0, 2], [1, 2, 3]]) {
            raster.triangle(
                target,
                undefined,
                [screen[tri[0]], screen[tri[1]], screen[tri[2]]],
                [vary[tri[0]], vary[tri[1]], vary[tri[2]]],
                (v: ArrayLike<number>) => mul4(pattern.sampleFill(pimg, [v[0], v[1]]), opacity),
            );
        }
    }
    return true;
}

/** How a fill feature is painted: plain color, or an image pattern (optionally SDF, tinted
 * with the fill color). */
type FillPaint = {kind: 'Color'; c: Rgba} | {kind: 'Pattern'; img: StyleImage; tint: Rgba; opacity: number};

/** Fragment color for pattern position `v` with screen gradients `g` (for `fwidth`). */
function shadeFill(paint: FillPaint, v: ArrayLike<number>, g: ArrayLike<ArrayLike<number>>): Rgba {
    if (paint.kind === 'Color') return paint.c;
    const {img, tint, opacity} = paint;
    const c = pattern.sampleFill(img, [v[0], v[1]]);
    if (img.sdf) {
        const a = (d: ArrayLike<number>) => pattern.sampleFill(img, [v[0] + d[0], v[1] + d[1]])[3];
        const fwidth = Math.abs(a(g[0]) - c[3]) + Math.abs(a(g[1]) - c[3]);
        const edge = (256 - 64) / 256;
        const gamma = Math.max(fwidth * 0.5, 1 / 255 / 16);
        const alpha = raster.smoothstep(edge - gamma, edge + gamma, c[3]);
        return mul4(tint, alpha * opacity);
    }
    return mul4(c, opacity);
}

type Outline = [P, P, [number, number], [number, number], FillPaint];

/** Returns whether anything was drawn in `'Opaque'`. */
export function drawFill(target: Target, layer: Layer, ctx: Ctx, tiles: TileFeatures[], raw: any, pass: Pass): boolean {
    const hasOutlineColor = hasPaint(raw, 'fill-outline-color');
    const hasPattern = hasPaint(raw, 'fill-pattern');
    const first = tiles[0];
    const fc = !hasPattern ? ctx.paint(layer, 'fill-color', undefined, first ? first.tile : dummyTile()) : undefined;
    const constantOpaque =
        !hasPattern &&
        paintProp(layer, 'fill-color').isConstant() &&
        paintProp(layer, 'fill-opacity').isConstant() &&
        fc instanceof Color &&
        fc.a === 1 &&
        first !== undefined &&
        num(ctx.paint(layer, 'fill-opacity', undefined, first.tile)) === 1;
    if (pass === 'Opaque' && !constantOpaque) return false;
    const antialias = pass !== 'Opaque' && first !== undefined && truthy(ctx.paint(layer, 'fill-antialias', undefined, first.tile));
    // The layer's opaque interior hides its own outline (the depth test). In `'All'`,
    // `covered` records the interior (tile masks are disjoint, so one buffer serves all tiles);
    // in `'Translucent'`, the opaque pass recorded it in `Target.occ` as this layer.
    const outlineHidden = constantOpaque && antialias && !hasOutlineColor;
    const covered = new Uint8Array(outlineHidden && pass === 'All' ? target.w * target.h : 0);
    const patternProp = paintProp(layer, 'fill-pattern');
    const prepared: [TileFeatures, Outline[]][] = [];
    const projected = ctx.transform.isProjected();
    for (const tf of tiles) {
        const bucket = tf.bucket(layer, ctx, () => newFillBucket(layer, ctx, tf));
        const toWorld = ctx.tileToWorld(tf.tile);
        const tr = ctx.translate(layer, 'fill', tf.tile);
        const toScreen = (p: P): P => {
            const w = toWorld(p);
            return ctx.transform.worldToScreen([w[0] + tr[0], w[1] + tr[1]]);
        };
        const tp = new pattern.TilePattern(ctx, tf.tile);
        const outlines: Outline[] = [];
        for (const [i, polygons] of bucket.polygons) {
            const f = bucket.features[i];
            const opacity = num(ctx.paint(layer, 'fill-opacity', f, tf.tile));
            const fillColor = color(ctx.paint(layer, 'fill-color', f, tf.tile), opacity);
            let coverFill: raster.Coverer | undefined;
            let blendFill: raster.Coverer | undefined;
            let paint: FillPaint;
            if (hasPattern) {
                // Cross-faded "to" image: the integer zoom, or the tile zoom when data-driven.
                const v = patternProp.isFeatureConstant()
                    ? patternProp.eval(Math.floor(ctx.transform.zoom), undefined, Ctx.canonical(tf.tile))
                    : patternProp.eval(tf.tile.overscaledZ, f.feature, Ctx.canonical(tf.tile));
                const name = pattern.imageName(v);
                const img = name !== undefined ? ctx.images.get(name) : undefined;
                if (!img) continue;
                paint = {kind: 'Pattern', img, tint: color(ctx.paint(layer, 'fill-color', f, tf.tile), 1), opacity};
            } else {
                paint = {kind: 'Color', c: fillColor};
            }
            const size: [number, number] = paint.kind === 'Pattern' ? pattern.displaySize(paint.img) : [1, 1];
            const outlinePaint: FillPaint = hasOutlineColor
                ? {kind: 'Color', c: color(ctx.paint(layer, 'fill-outline-color', f, tf.tile), opacity)}
                : paint;
            for (const polygon of polygons) {
                const points: P[] = [];
                for (let k = 0; k < polygon.xy.length; k += 2) points.push([polygon.xy[k], polygon.xy[k + 1]]);
                const screen = points.map(toScreen);
                // Only patterns read the varying (outlines too: theirs is a color or this pattern).
                const vary: [number, number][] =
                    paint.kind === 'Pattern'
                        ? points.map((p, k) => tp.pos(size, p, screen[k]) as [number, number])
                        : screen.map((): [number, number] => [0, 0]);
                if (opacity >= 0.01 && pass !== 'Translucent') {
                    const tris = polygon.triangles;
                    for (let k = 0; k + 2 < tris.length; k += 3) {
                        const t0 = tris[k];
                        const t1 = tris[k + 1];
                        const t2 = tris[k + 2];
                        const p: [P, P, P] = [screen[t0], screen[t1], screen[t2]];
                        // Projections keep orientation and bend edges gently, except across a
                        // singularity (e.g. near the antipode of an azimuthal projection, which spreads
                        // a triangle's corners around the rim): its chord triangle would cover the map.
                        if (projected) {
                            const tri = [points[t0], points[t1], points[t2]];
                            if ([0, 1, 2].some((j) => bent(toScreen, tri[j], tri[(j + 1) % 3], p[j], p[(j + 1) % 3]))) continue;
                        }
                        if (constantOpaque) {
                            const w = target.w;
                            const cover = (coverFill ??= target.coverer(fillColor));
                            const rect = tf.mask.coverage.kind === 'Rectangle' ? tf.mask.coverage : undefined;
                            raster.forEachRun(target.w, target.h, p, (y, x0, x1) => {
                                // A rectangle mask clips the run (`mask.get` per pixel otherwise).
                                if (rect && covered.length === 0) {
                                    if (y >= rect.y[0] && y < rect.y[1]) cover.run(y * w + Math.max(x0, rect.x[0]), y * w + Math.min(x1, rect.x[1]));
                                    return;
                                }
                                for (let x = x0; x < x1; x++) {
                                    if (tf.mask.get(x, y)) {
                                        if (covered.length > 0) covered[y * w + x] = 1;
                                        cover(y * w + x);
                                    }
                                }
                            });
                            continue;
                        }
                        if (paint.kind === 'Color') {
                            // `triangle` with `shadeFill`, which returns the color whatever the varyings.
                            const w = target.w;
                            const fill = (blendFill ??= target.blender(paint.c));
                            const mask = tf.mask;
                            const rect = mask.coverage.kind === 'Rectangle' ? mask.coverage : undefined;
                            raster.forEachRun(w, target.h, p, (y, x0, x1) => {
                                if (rect) {
                                    if (y >= rect.y[0] && y < rect.y[1]) fill.run(y * w + Math.max(x0, rect.x[0]), y * w + Math.min(x1, rect.x[1]));
                                    return;
                                }
                                for (let x = x0; x < x1; x++) if (mask.get(x, y)) fill(y * w + x);
                            });
                            continue;
                        }
                        const v: [number[], number[], number[]] = [vary[t0], vary[t1], vary[t2]];
                        const g = raster.varyingGradients(p, v);
                        const pt = paint;
                        raster.triangle(target, tf.mask, p, v, (vv: ArrayLike<number>) => shadeFill(pt, vv, g));
                    }
                }
                if (antialias && opacity >= 0.01) {
                    let start = 0;
                    for (const len of polygon.ringLens) {
                        for (let i = 1; i < len; i++) {
                            const a = start + i - 1;
                            const b = start + i;
                            if (projected && bent(toScreen, points[a], points[b], screen[a], screen[b])) continue;
                            outlines.push([screen[a], screen[b], vary[a], vary[b], outlinePaint]);
                        }
                        start += len;
                    }
                }
            }
        }
        prepared.push([tf, outlines]);
    }
    // Outlines are drawn after all fills (MapLibre's separate outline pass). The occlusion buffer
    // is read here instead of by the target, so the target's culling is off while drawing them.
    const w = target.w;
    const layerIndex = target.layer;
    const useOcc = outlineHidden && pass === 'Translucent';
    const occ = target.occ;
    const cull = target.cull;
    target.cull = cull && (!useOcc || occ.length === 0);
    const visible = (i: number): boolean => {
        if (!outlineHidden) return true;
        if (pass === 'All') return !covered[i];
        return occ[i] < layerIndex || (!cull && occ[i] !== layerIndex);
    };
    const none = [[0, 0], [0, 0]];
    for (const [tf, outlines] of prepared) {
        for (const [a, b, va, vb, paint] of outlines) {
            raster.line(target, (x: number, y: number) => tf.mask.get(x, y) && visible(y * w + x), a, b, (dist: number, t: number) => {
                const alpha = 1 - raster.smoothstep(0, 1, dist);
                const v = [va[0] + (vb[0] - va[0]) * t, va[1] + (vb[1] - va[1]) * t];
                return mul4(shadeFill(paint, v, none), alpha);
            });
        }
    }
    target.cull = cull;
    return pass === 'Opaque';
}

/** Tile masks of a projected output: each pixel belongs to the highest-zoom tile containing its
 * Mercator position (tile boundaries curve there, so they are not drawn as quads), unwrapped
 * to within 0.5 of `centralX` like the drawn geometry. */
function projectedMasks(tiles: RenderTile[], w: number, h: number, world: ArrayLike<ArrayLike<number>>, centralX: number | undefined): Mask[] {
    const zooms = [...new Set(tiles.map((t) => t.canonical.z))].sort((a, b) => b - a);
    // (z, x across world copies, y) → tile index.
    const index = new Map<string, number>();
    tiles.forEach((t, i) => index.set(`${t.canonical.z},${t.wrap * 2 ** t.canonical.z + t.canonical.x},${t.canonical.y}`, i));
    const owners = new Uint32Array(w * h).fill(0xffffffff);
    // Neighboring pixels mostly fall in the same tiles: the last lookup per zoom.
    const last: ({k0: number; k1: number; i: number | undefined} | undefined)[] = zooms.map(() => undefined);
    const asI64 = (v: number) => (v !== v ? 0 : v);
    for (let p = 0; p < world.length; p++) {
        const m = world[p];
        if (Number.isNaN(m[0])) continue;
        const x = centralX === undefined ? m[0] : m[0] - roundAway(m[0] - centralX);
        let found: number | undefined;
        for (let zi = 0; zi < zooms.length; zi++) {
            const z = zooms[zi];
            const n = 2 ** z;
            const k0 = asI64(Math.floor(x * n));
            const k1 = asI64(Math.floor(m[1] * n));
            const l = last[zi];
            let i: number | undefined;
            if (l && l.k0 === k0 && l.k1 === k1) {
                i = l.i;
            } else {
                i = index.get(`${z},${k0},${k1}`);
                last[zi] = {k0, k1, i};
            }
            if (i !== undefined) {
                found = i;
                break;
            }
        }
        if (found !== undefined) owners[p] = found;
    }
    return Mask.fromOwners(w, h, owners, tiles.length);
}

export function dummyTile(): RenderTile {
    return {overscaledZ: 0, wrap: 0, canonical: new TileId(0, 0, 0)};
}

export function drawCircle(target: Target, layer: Layer, ctx: Ctx, tiles: TileFeatures[]): void {
    const dpr = ctx.transform.pixelRatio;
    for (const tf of tiles) {
        const features = ctx.bucketFeatures(layer, tf, 'circle-sort-key');
        const toWorld = ctx.tileToWorld(tf.tile);
        const tr = ctx.translate(layer, 'circle', tf.tile);
        for (const f of features) {
            const p = (name: string) => ctx.paint(layer, name, f, tf.tile);
            const radius = num(p('circle-radius'));
            const blur = num(p('circle-blur'));
            const opacity = num(p('circle-opacity'));
            const strokeWidth = num(p('circle-stroke-width'));
            const fill = color(p('circle-color'), opacity);
            const stroke = color(p('circle-stroke-color'), num(p('circle-stroke-opacity')));
            const size = (radius + strokeWidth) * dpr;
            const aaBlur = -Math.max(1 / dpr / (radius + strokeWidth), blur);
            const shade = (e: ArrayLike<number>): Rgba | undefined => {
                const len = Math.sqrt(e[0] * e[0] + e[1] * e[1]);
                const opacityT = raster.smoothstep(0, aaBlur, len - 1);
                const colorT = strokeWidth < 0.01 ? 0 : raster.smoothstep(aaBlur, 0, len - radius / (radius + strokeWidth));
                const c: Rgba = [0, 1, 2, 3].map((k) => opacityT * (fill[k] + (stroke[k] - fill[k]) * colorT)) as Rgba;
                return c.some((x) => x >= 0.5 / 255) ? c : undefined;
            };
            for (const line of f.geometry) {
                for (const pt of line) {
                    if (pt[0] < 0 || pt[0] >= EXTENT || pt[1] < 0 || pt[1] >= EXTENT) continue;
                    const w = toWorld(pt);
                    let c = ctx.transform.onMap(w);
                    if (!c) continue;
                    if (tr[0] !== 0 || tr[1] !== 0) c = ctx.transform.worldToScreen([w[0] + tr[0], w[1] + tr[1]]);
                    const q: P[] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
                    const cc = c;
                    const pos = q.map((e): P => [cc[0] + e[0] * size, cc[1] + e[1] * size]);
                    raster.triangle(target, undefined, [pos[0], pos[1], pos[2]], [q[0], q[1], q[2]], shade);
                    raster.triangle(target, undefined, [pos[0], pos[2], pos[3]], [q[0], q[2], q[3]], shade);
                }
            }
        }
    }
}

/** Whether the projected segment `a`–`b` (tile units, drawn from `sa` to `sb`) strays from its chord by
 * over a quarter of the chord's length at its midpoint: it passes a singularity of the projection,
 * and its chord cuts across the map. Chords under `BENT_MIN` device pixels are not checked: they can
 * only misdraw that much, and they are most edges. */
export function bent(toScreen: (p: P) => P, a: P, b: P, sa: P, sb: P): boolean {
    const BENT_MIN = 32;
    const len2 = (sb[0] - sa[0]) ** 2 + (sb[1] - sa[1]) ** 2;
    if (len2 < BENT_MIN * BENT_MIN) return false;
    const m = toScreen([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
    const d = [(sa[0] + sb[0]) / 2 - m[0], (sa[1] + sb[1]) / 2 - m[1]];
    return 16 * (d[0] * d[0] + d[1] * d[1]) > len2;
}

function signedArea(ring: P[]): number {
    let sum = 0;
    const len = ring.length;
    for (let i = 0; i < len; i++) {
        const j = i === 0 ? len - 1 : i - 1;
        sum += (ring[j][0] - ring[i][0]) * (ring[i][1] + ring[j][1]);
    }
    return sum;
}

/** Group rings into polygons by winding (first ring's winding = outer), keeping at most
 * `maxRings` rings per polygon (largest holes first), like MapLibre's `classifyRings`. */
export function classifyRings(rings: P[][], maxRings: number): P[][][] {
    if (rings.length <= 1) return [rings.slice()];
    const polygons: {area: number; ring: P[]}[][] = [];
    let ccw: boolean | undefined;
    for (const ring of rings) {
        const area = signedArea(ring);
        if (area === 0) continue;
        if (ccw === undefined) ccw = area < 0;
        if (ccw === area < 0 || polygons.length === 0) polygons.push([{area: Math.abs(area), ring}]);
        else polygons[polygons.length - 1].push({area: Math.abs(area), ring});
    }
    return polygons.map((p) => {
        if (maxRings > 1 && p.length > maxRings) {
            const holes = p.slice(1).sort((a, b) => (b.area < a.area ? -1 : b.area > a.area ? 1 : 0));
            p = [p[0], ...holes].slice(0, maxRings);
        }
        return p.map((r) => r.ring);
    });
}
