// Sans-IO MapLibre style renderer (2D, tile-based). See AGENTS.md for scope and constraints.
//
// Host loop: `new Renderer` → while `needs()` is non-empty { fetch each; `provide` } → `render`.
// Minimal use: `new Renderer(style, View.tile(z, x, y, 512))` → one XYZ tile image.

import {parseStyle, isHidden, type Layer as StyleLayer, type Style} from './style.ts';
import {asI32, asU8} from './util.ts';
import {geojsonIndex} from './geojson.ts';
import type {GeoJsonIndex} from './geojson.ts';
import {Image, Texture} from './image.ts';
import {Sprites} from './sprite.ts';
import {decode as decodeMvt, sliceLayer} from './mvt.ts';
import type {Layer as MvtLayer} from './mvt.ts';
import {TileId, Transform, type RenderTile, renderTileKey, mercatorX, mercatorY, mercatorLat, MAX_LAT, MIN_ZOOM, tileUrl} from './tile.ts';
import {Warp, type ProjectedView} from './reproject.ts';
import {Ctx, TileFeatures, type TileBuckets, EXTENT, num, drawBackground, drawFill, drawLine, drawCircle} from './render/mod.ts';
import {Target, Mask} from './render/raster.ts';
import {Dem, DemTile, HillshadeParams, ColorRamp, drawHillshadeTile, drawColorReliefTile} from './render/dem.ts';
import {drawHeatmap, blend as blendHeatmap, reapply as reapplyHeatmaps} from './render/heatmap.ts';
import {RasterParams, Quad, drawQuad} from './render/raster_layer.ts';
import {Glyphs} from './symbol/glyphs.ts';
import {Builder, glyphDependencies, type SymbolBucket} from './symbol/layout.ts';
import {place, type InstancePlacement, type LayerBuckets} from './symbol/placement.ts';
import {drawSymbolLayer} from './symbol/draw.ts';

export type {ProjectedView};

export type RenderErrorKind = 'Style' | 'ImageEncoding' | 'NotReady' | 'Unsupported';

/** Rust `Error`: `kind` is the variant; `message` is its `Display` text. */
export class RenderError extends Error {
    kind: RenderErrorKind;
    detail: string;
    constructor(kind: RenderErrorKind, detail = '') {
        super(
            kind === 'Style' ? `style error: ${detail}`
            : kind === 'ImageEncoding' ? `image encoding error: ${detail}`
            : kind === 'NotReady' ? 'render called with outstanding needs()'
            : `unsupported: ${detail}`,
        );
        this.name = 'RenderError';
        this.kind = kind;
        this.detail = detail;
    }
}

/** A resource the host must fetch and hand back via `Renderer.provide`. */
export interface Resource {
    /** URL as written in the style (or derived from it, e.g. a tile URL from a template). */
    url: string;
}

/** What to render: a Web Mercator camera plus output size. */
export class View {
    /** `[lng, lat]` in degrees. */
    center: [number, number];
    /** MapLibre zoom (world is `512 * 2^zoom` CSS pixels wide). */
    zoom: number;
    /** Degrees, clockwise. */
    bearing: number;
    /** CSS pixels; the output is `round(width*pixelRatio)` × `round(height*pixelRatio)`. */
    width: number;
    height: number;
    pixelRatio: number;
    /** CSS pixels rendered around the view before cropping to the requested output size. */
    margin: number;

    constructor(center: [number, number], zoom: number, bearing: number, width: number, height: number, pixelRatio: number, margin: number) {
        this.center = center;
        this.zoom = zoom;
        this.bearing = bearing;
        this.width = width;
        this.height = height;
        this.pixelRatio = pixelRatio;
        this.margin = margin;
    }

    /** The XYZ tile `z/x/y` rendered as a `tileSize`-pixel square image. */
    static tile(z: number, x: number, y: number, tileSize: number): View {
        const n = 2 ** z;
        const lng = ((x + 0.5) / n) * 360 - 180;
        const lat = mercatorLat((y + 0.5) / n);
        return new View([lng, lat], z + Math.log2(tileSize / 512), 0, tileSize, tileSize, 1, 0);
    }
}

const sameView = (a: View, b: View) =>
    a.center[0] === b.center[0] && a.center[1] === b.center[1] && a.zoom === b.zoom && a.bearing === b.bearing &&
    a.width === b.width && a.height === b.height && a.pixelRatio === b.pixelRatio && a.margin === b.margin;

const sameProjectedView = (a: ProjectedView, b: ProjectedView) =>
    a.projjson === b.projjson && a.bbox.every((v, i) => v === b.bbox[i]) && a.width === b.width && a.height === b.height &&
    a.pixelRatio === b.pixelRatio && a.margin === b.margin;

/** The decoded result of `render`: non-premultiplied RGBA8, row-major. */
export interface RenderOutput {
    width: number;
    height: number;
    data: Uint8Array;
}

interface TileJson {
    tiles: string[];
    minzoom: number;
    maxzoom: number;
    tms: boolean;
    bounds: [number, number, number, number] | undefined;
    tileSize: number;
    /** raster-dem `encoding`. */
    encoding: string | undefined;
}

type Data =
    /** Waiting for a TileJSON / GeoJSON document at this URL. */
    | {kind: 'Pending'; url: string}
    | {kind: 'Failed'}
    | {kind: 'Tiled'; tj: TileJson}
    | {kind: 'GeoJson'; index: GeoJsonIndex}
    /** Image source: URL, corner coordinates (tl, tr, br, bl) and the decoded image (`undefined`
     * = not provided yet, `null` = failed). */
    | {kind: 'Image'; url: string; coordinates: Corners; texture: Texture | null | undefined};

type Corners = [[number, number], [number, number], [number, number], [number, number]];

type TileData = {kind: 'Vector'; layers: MvtLayer[]} | {kind: 'Raster'; texture: Texture} | {kind: 'Dem'; dem: Dem};

interface Source {
    type: string;
    json: any;
    data: Data;
    /** Decoded tiles by `TileId.key()`; `null` when the host could not fetch (or decode) it. */
    tiles: Map<string, TileData | null>;
    /** GeoJSON tiles and overzoom slices shared by glyph discovery and all style layers, by
     * (data tile, canonical tile). Include the data tile so fallback parents cannot share the
     * wrong slice. */
    vectorLayers: Map<string, {data: string; layers: MvtLayer[]}>;
    /** Layer buckets by (data tile, canonical tile, overscaled zoom), kept across views. */
    buckets: Map<string, {data: string; buckets: TileBuckets}>;
    /** The latest `Renderer.clock` each data tile (GeoJSON: canonical tile) was needed or
     * provided at, by `TileId.key()`. */
    lastUsed: Map<string, {id: TileId; t: number}>;
}

/** Records that `id` is needed at `clock`: the latest clock wins, whatever the call order. */
function stamp(lastUsed: Map<string, {id: TileId; t: number}>, id: TileId, clock: number) {
    const e = lastUsed.get(id.key());
    if (e) e.t = Math.max(e.t, clock);
    else lastUsed.set(id.key(), {id, t: clock});
}

const ZOOM_LEVELS_TO_OVERSCALE = 4;
// ponytail: a tile count, not bytes. Dense low-zoom tiles cost far more; bound by size if
// memory becomes the constraint.
const MAX_CACHED_TILES = 8;

/** Rust `#[derive(Ord)]` on `TileId` (z, x, y). */
const cmpTile = (a: TileId, b: TileId) => a.z - b.z || a.x - b.x || a.y - b.y;
/** Rust `#[derive(Ord)]` on `RenderTile` (overscaled_z, wrap, canonical). */
const cmpRenderTile = (a: RenderTile, b: RenderTile) => a.overscaledZ - b.overscaledZ || a.wrap - b.wrap || cmpTile(a.canonical, b.canonical);
const sameTile = (a: TileId, b: TileId) => a.z === b.z && a.x === b.x && a.y === b.y;

const f64 = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const get = (v: any, k: string | number): any => (v !== null && typeof v === 'object' ? v[k] : undefined);
/** Rust `x as u32` from a float: truncates, saturates, NaN → 0. */
const asU32 = (x: number): number => (x !== x ? 0 : Math.max(0, Math.min(4294967295, Math.trunc(x))));

/** serde_json `Value` equality (object key order does not matter; absent ≠ null). */
function jsonEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
        const bb = b as unknown[];
        return a.length === bb.length && a.every((v, i) => jsonEqual(v, bb[i]));
    }
    const ka = Object.keys(a);
    const bo = b as Record<string, unknown>;
    return ka.length === Object.keys(bo).length && ka.every((k) => k in bo && jsonEqual((a as Record<string, unknown>)[k], bo[k]));
}

function tilejsonFrom(json: any, overrides: any): TileJson {
    const g = (k: string) => {
        const o = get(overrides, k);
        return o !== undefined && o !== null ? o : get(json, k);
    };
    const tiles = g('tiles');
    const b = g('bounds');
    const bounds: TileJson['bounds'] =
        Array.isArray(b) && b.length >= 4 && b.slice(0, 4).every((v) => typeof v === 'number') ? [b[0], b[1], b[2], b[3]] : undefined;
    return {
        tiles: Array.isArray(tiles) ? tiles.filter((t): t is string => typeof t === 'string') : [],
        minzoom: asU8(f64(g('minzoom')) ?? 0),
        maxzoom: asU8(f64(g('maxzoom')) ?? 22),
        tms: g('scheme') === 'tms',
        bounds,
        // Like MapLibre's `loadTileJSON`, `tileSize` and `encoding` may come from the TileJSON
        // too (the style's source options win).
        tileSize: f64(g('tileSize')) ?? 512,
        encoding: str(g('encoding')),
    };
}

/** `getCoordinatesCenterTileID`: the tile an image source is drawn in, and its corners in
 * that tile's units (rounded, like MapLibre). */
function imageTile(coordinates: Corners): [TileId, Corners] {
    const m = coordinates.map((c) => [mercatorX(c[0]), mercatorY(c[1])] as [number, number]);
    const minX = Math.min(...m.map((p) => p[0])), maxX = Math.max(...m.map((p) => p[0]));
    const minY = Math.min(...m.map((p) => p[1])), maxY = Math.max(...m.map((p) => p[1]));
    const d = Math.max(maxX - minX, maxY - minY);
    const z = asU8(Math.max(Math.floor(-Math.log(d) / Math.LN2), 0));
    const n = 2 ** z;
    const id = new TileId(z, asU32(Math.floor(((minX + maxX) / 2) * n)), asU32(Math.floor(((minY + maxY) / 2) * n)));
    const corners = m.map((p) => [Math.round((p[0] * n - id.x) * EXTENT), Math.round((p[1] * n - id.y) * EXTENT)]) as Corners;
    return [id, corners];
}

/** The image warp for the corners (`calculateImageWarp` with warp 'auto'). */
function imageWarp(c: Corners): [number, number, number] {
    const [tl, tr, br, bl] = c;
    if (tl[0] + br[0] === tr[0] + bl[0] && tl[1] + br[1] === tr[1] + bl[1]) return [0, 0, 1];
    const sum = [tl[0] - tr[0] + br[0] - bl[0], tl[1] - tr[1] + br[1] - bl[1]];
    const [rx, ry, dx, dy] = [tr[0] - br[0], tr[1] - br[1], bl[0] - br[0], bl[1] - br[1]];
    const det = rx * dy - dx * ry;
    const px = (sum[0] * dy - dx * sum[1]) / det;
    const py = (rx * sum[1] - sum[0] * ry) / det;
    const dens = [1, 1 + px, 1 + px + py, 1 + py];
    // Rust `fold(f64::max)` / `fold(f64::min)` skip NaN, unlike `Math.max`.
    const fore = dens.reduce((a, v) => (v > a || a !== a ? v : a), -Infinity) / dens.reduce((a, v) => (v < a || a !== a ? v : a), Infinity);
    const blend = Math.max((1 - 4 / fore) / (1 - 4 / 512), 0);
    if (!(fore >= 1 && fore <= 512) || blend >= 1) return [0, 0, 1];
    return [px, py, blend];
}

/** `rgba` (`w` pixels wide) without `margin` pixels on each side. */
function crop(rgba: Uint8Array, w: number, margin: number): RenderOutput {
    const fullH = w === 0 ? 0 : rgba.length / 4 / w;
    if (margin === 0) return {width: w, height: fullH, data: rgba};
    const [width, height] = [w - 2 * margin, fullH - 2 * margin];
    for (let row = 0; row < height; row++) {
        const start = ((row + margin) * w + margin) * 4;
        rgba.copyWithin(row * width * 4, start, start + width * 4);
    }
    return {width, height, data: rgba.slice(0, width * height * 4)};
}

/** Decode a raster-dem tile with the source's `encoding` (and custom factors). */
function demFrom(img: Image, src: any, encoding: string | undefined): Dem | undefined {
    const f = (k: string, d: number) => f64(get(src, k)) ?? d;
    const factors: [number, number, number, number] = [f('redFactor', 1), f('greenFactor', 1), f('blueFactor', 1), f('baseShift', 0)];
    return Dem.new(img, encoding ?? 'mapbox', factors);
}

type TileLayers = [RenderTile, MvtLayer[] | undefined, TileBuckets];

export class Renderer {
    style: Style;
    transform: Transform;
    sources: Map<string, Source>;
    sprites: Sprites;
    /** The style's `sprite`, to pick the sheet again when the pixel ratio changes. */
    sprite: any;
    glyphs: Glyphs;
    /** Glyph range URLs last returned by `needs()`, so `provide()` need not re-evaluate text. */
    glyphUrls = new Map<string, [string, number]>();
    /** Text dependencies depend on source data and camera, not on downloaded glyphs. */
    glyphDependencies: Map<string, [string, number]> | undefined;
    /** Tile URLs returned by `needs()` and not yet provided, with the (source, tile) they fill.
     * `provide` matches against these, so a view change in between does not lose them. */
    requested = new Map<string, [string, TileId][]>();
    /** Advances with every view change, or set by `setTicket`; orders tiles for eviction. */
    clock = 0;
    view: View;
    /** MapLibre map option `maxZoom` (default 22). */
    maxZoom = 22;
    /** MapLibre map option `crossSourceCollisions` (default true). */
    crossSourceCollisions = true;
    /** Whether fill, line, circle and heatmap buckets stay cached after a render, for later views
     * (`setView`). A host that renders once per renderer turns this off: each bucket is then dropped
     * as soon as the last layer using it is drawn, so a render holds few at a time. */
    keepBuckets = true;
    /** Set by `setProjectedView`: `view` is then the Mercator render of its rasters and DEMs,
     * warped into it. */
    projected: [ProjectedView, Warp] | undefined;

    /** The style's own `center`/`zoom`/`bearing` are ignored; `view` decides the camera. `style` is
     * JSON text or a parsed style, which the renderer takes over (and modifies). */
    constructor(style: string | object, view: View) {
        let json: any = style;
        if (typeof style === 'string') {
            try {
                json = JSON.parse(style);
            } catch (e) {
                throw new RenderError('Style', e instanceof Error ? e.message : String(e));
            }
        }
        if (json === null || typeof json !== 'object' || Array.isArray(json)) json = {};
        this.sources = new Map();
        // Moved out of the style, which keeps only what layers need; an inline GeoJSON `data`
        // (which can be large) is dropped once indexed.
        const sourcesJson = json.sources;
        json.sources = null;
        if (sourcesJson !== null && typeof sourcesJson === 'object' && !Array.isArray(sourcesJson)) {
            for (const [id, src] of Object.entries<any>(sourcesJson)) {
                let inline: any = null;
                if (src !== null && typeof src === 'object' && !Array.isArray(src) && 'data' in src) {
                    inline = src.data;
                    delete src.data;
                }
                const type = str(get(src, 'type')) ?? '';
                let data: Data;
                switch (type) {
                    case 'vector':
                    case 'raster':
                    case 'raster-dem': {
                        const url = str(get(src, 'url'));
                        data = url !== undefined && get(src, 'tiles') === undefined ? {kind: 'Pending', url} : {kind: 'Tiled', tj: tilejsonFrom(src, null)};
                        break;
                    }
                    case 'geojson':
                        data = typeof inline === 'string' ? {kind: 'Pending', url: inline} : {kind: 'GeoJson', index: geojsonIndex(inline ?? null, src)};
                        break;
                    case 'image': {
                        const c = (i: number): [number, number] => [f64(get(get(get(src, 'coordinates'), i), 0)) ?? 0, f64(get(get(get(src, 'coordinates'), i), 1)) ?? 0];
                        data = {kind: 'Image', url: str(get(src, 'url')) ?? '', coordinates: [c(0), c(1), c(2), c(3)], texture: undefined};
                        break;
                    }
                    default:
                        data = {kind: 'Failed'};
                }
                this.sources.set(id, {type, json: src, data, tiles: new Map(), vectorLayers: new Map(), buckets: new Map(), lastUsed: new Map()});
            }
        }
        this.sprite = json.sprite ?? null;
        this.sprites = new Sprites(this.sprite, view.pixelRatio);
        this.glyphs = new Glyphs(str(json.glyphs));
        this.style = parseStyle(json);
        this.transform = new Transform([0, 0], 0, 0, 1, 1, 1);
        this.view = view;
        this.setMaxZoom(22);
    }

    /** MapLibre's `maxZoom` map option: clamps the camera zoom and bounds tile slicing. */
    setMaxZoom(maxZoom: number) {
        this.glyphDependencies = undefined;
        this.maxZoom = maxZoom;
        const v = this.view;
        const zoom = Math.min(Math.max(v.zoom, MIN_ZOOM), maxZoom);
        this.transform = new Transform(v.center, zoom, v.bearing, v.width, v.height, v.pixelRatio);
        this.transform.setMargin(v.margin);
    }

    /** Moves the camera. Fetched resources and the layer buckets built from them are kept (up
     * to `MAX_CACHED_TILES` per source), so one renderer can draw many views of its style.
     * Call `needs()` again afterwards. A new pixel ratio refetches the sprite. */
    setView(view: View) {
        this.projected = undefined;
        if (sameView(view, this.view)) return;
        if (view.pixelRatio !== this.view.pixelRatio && this.sprite !== null) {
            this.sprites = new Sprites(this.sprite, view.pixelRatio);
        }
        this.view = view;
        this.clock += 1;
        this.setMaxZoom(this.maxZoom);
    }

    /** For hosts running overlapping renders on one renderer (each one's `setView`, `needs`,
     * `provide` rounds interleaved with the others'): tiles needed or provided from now on are
     * kept for render `ticket`. Give each render an increasing ticket, set it before each of its
     * calls (after `setView`, which advances the clock itself), and draw with
     * `renderRetaining` the oldest ticket still in progress, so that no render drops tiles
     * another one still has to draw (which it would fetch again). */
    setTicket(ticket: number) {
        this.clock = ticket;
    }

    /** Renders `view`, a box in a projected CRS, instead of a Mercator camera. Layers drawn from
     * vertices (background, fill, line, circle, heatmap, symbol) are drawn in the projected output
     * directly; rasters and DEMs are rendered in Mercator (like `setView`) and the picture is
     * warped. Call `needs()` again afterwards. Throws for an unsupported CRS. */
    setProjectedView(view: ProjectedView) {
        if (this.projected && sameProjectedView(this.projected[0], view)) return;
        const [warp, mercator] = Warp.new(view);
        if (mercator) this.setView(mercator);
        this.projected = [{...view, bbox: [...view.bbox] as ProjectedView['bbox']}, warp];
    }

    /** Drops the least recently needed tiles of each source beyond `MAX_CACHED_TILES`, with
     * everything built from them. Tiles needed at `keepSince` or later stay. */
    private evict(keepSince: number) {
        for (const src of this.sources.values()) {
            const excess = src.lastUsed.size - MAX_CACHED_TILES;
            if (excess <= 0) continue;
            const old = [...src.lastUsed.values()].filter((e) => e.t < keepSince);
            old.sort((a, b) => a.t - b.t || cmpTile(a.id, b.id));
            const evicted = new Set(old.slice(0, excess).map((e) => e.id.key()));
            for (const k of evicted) {
                src.lastUsed.delete(k);
                src.tiles.delete(k);
            }
            for (const [k, v] of src.vectorLayers) if (evicted.has(v.data)) src.vectorLayers.delete(k);
            for (const [k, v] of src.buckets) if (evicted.has(v.data)) src.buckets.delete(k);
        }
    }

    /** MapLibre's `crossSourceCollisions` map option: when off, symbols only collide with
     * symbols of the same source. */
    setCrossSourceCollisions(enabled: boolean) {
        this.crossSourceCollisions = enabled;
    }

    /** Sources referenced by layers visible at the current zoom, sorted. */
    private usedSources(): string[] {
        const out = new Set<string>();
        for (const l of this.style.layers) {
            if (!isHidden(l, this.transform.zoom) && l.source !== undefined) out.add(l.source);
        }
        return [...out].sort();
    }

    /** Ideal tiles of a tiled source for the current view (MapLibre `coveringTiles`). */
    private covering(src: Source): RenderTile[] {
        let tileSize: number, minzoom: number, maxzoom: number, bounds: TileJson['bounds'];
        if (src.data.kind === 'Tiled') {
            ({tileSize, minzoom, maxzoom, bounds} = src.data.tj);
        } else if (src.data.kind === 'GeoJson') {
            [tileSize, minzoom, maxzoom, bounds] = [512, 0, src.data.index.maxzoom(), undefined];
        } else {
            return [];
        }
        const raster = src.type === 'raster' || src.type === 'raster-dem';
        const z = this.transform.coveringZoom(tileSize, raster);
        if (z < minzoom) return [];
        // MapLibre's default `zoomLevelsToOverscale` (4) below the map maxZoom (22): vector
        // tiles up to that zoom are sliced out of the source's maxzoom tile.
        if (src.type === 'vector') maxzoom = Math.max(maxzoom, Math.max(asI32(this.maxZoom) - ZOOM_LEVELS_TO_OVERSCALE, 0) & 255);
        const out = new Map<string, RenderTile>();
        const insert = (t: RenderTile) => out.set(renderTileKey(t), t);
        for (const [x, y, wrap] of this.transform.coveringTiles(z)) {
            const id = new TileId(z, x, y);
            const canonical = z > maxzoom ? id.parentAt(maxzoom) : id;
            if (bounds) {
                const b = bounds;
                const n = 2 ** canonical.z;
                const [x0, x1] = [canonical.x / n, (canonical.x + 1) / n];
                const [y0, y1] = [canonical.y / n, (canonical.y + 1) / n];
                const [bx0, bx1] = [mercatorX(b[0]), mercatorX(b[2])];
                const [by0, by1] = [mercatorY(Math.min(b[3], MAX_LAT)), mercatorY(Math.max(b[1], -MAX_LAT))];
                if (x1 <= bx0 || x0 >= bx1 || y1 <= by0 || y0 >= by1) continue;
            }
            const tile: RenderTile = {overscaledZ: z, wrap, canonical};
            // In a projected view, also the world copies that land on the map across the
            // projection's antimeridian (drawn geometry is unwrapped around its central meridian).
            // Not for rasters and DEMs, drawn in the Mercator picture.
            if (this.projected && !raster) {
                const warp = this.projected[1];
                const n = 2 ** canonical.z;
                const x0 = (wrap * n + canonical.x) / n;
                for (const k of warp.branchShifts(x0, x0 + 1 / n)) insert({...tile, wrap: wrap + k});
            }
            insert(tile);
        }
        return [...out.values()].sort(cmpRenderTile);
    }

    /** The tile actually fetched for `id`: its ancestor at the source maxzoom when sliced. */
    private static dataTile(tj: TileJson, id: TileId): TileId {
        return id.z > tj.maxzoom ? id.parentAt(tj.maxzoom) : id;
    }

    /** Tiles to draw: each ideal tile, or for one that failed to load, its nearest loaded
     * ancestor (MapLibre retains parents for missing tiles). Also returns tiles still to fetch. */
    private resolve(src: Source): [[RenderTile, TileId][], TileId[]] {
        const draw = new Map<string, [RenderTile, TileId]>();
        const fetch = new Map<string, TileId>();
        if (src.data.kind !== 'Tiled') {
            const covering = this.covering(src);
            if (src.data.kind === 'GeoJson') {
                for (const t of covering) stamp(src.lastUsed, t.canonical, this.clock);
            }
            return [covering.map((t) => [t, t.canonical]), []];
        }
        const tj = src.data.tj;
        // `TileManager.maxUnderzooming`: parents are only sought this far below the ideal zoom.
        const covering = this.covering(src);
        const minZ = covering.length ? Math.max(covering[0].overscaledZ - 10, tj.minzoom) & 255 : 0;
        for (const t of covering) {
            let id = Renderer.dataTile(tj, t.canonical);
            for (;;) {
                const tile = src.tiles.get(id.key());
                if (tile === undefined) {
                    fetch.set(id.key(), id);
                    break;
                }
                stamp(src.lastUsed, id, this.clock);
                if (tile !== null) {
                    const canonical = sameTile(id, Renderer.dataTile(tj, t.canonical)) ? t.canonical : id;
                    const overscaledZ = sameTile(canonical, t.canonical) ? t.overscaledZ : canonical.z;
                    const rt: RenderTile = {overscaledZ, wrap: t.wrap, canonical};
                    draw.set(`${renderTileKey(rt)}|${id.key()}`, [rt, id]);
                    break;
                }
                if (id.z <= minZ) break;
                id = id.parentAt(id.z - 1);
            }
        }
        const drawn = [...draw.values()].sort((a, b) => cmpRenderTile(a[0], b[0]) || cmpTile(a[1], b[1]));
        return [drawn, [...fetch.values()].sort(cmpTile)];
    }

    /** Resources still required before `render` can run. May grow after `provide`
     * (tiles → glyph ranges → ...), so call it again after every round of `provide`. */
    needs(): Resource[] {
        if (this.projected && this.projected[1].isEmpty()) return [];
        const out = new Set<string>(this.sprites.needs());
        for (const id of this.usedSources()) {
            const src = this.sources.get(id);
            if (!src) continue;
            const data = src.data;
            if (data.kind === 'Pending') {
                out.add(data.url);
            } else if (data.kind === 'Tiled' && data.tj.tiles.length) {
                for (const t of this.resolve(src)[1]) {
                    const url = tileUrl(data.tj.tiles, t, data.tj.tms);
                    let targets = this.requested.get(url);
                    if (!targets) this.requested.set(url, (targets = []));
                    if (!targets.some(([s, u]) => s === id && sameTile(u, t))) targets.push([id, t]);
                    out.add(url);
                }
            } else if (data.kind === 'Image' && data.texture === undefined) {
                out.add(data.url);
            }
        }
        const glyphs = this.glyphNeeds();
        for (const [url, key] of glyphs) {
            out.add(url);
            this.glyphUrls.set(url, key);
        }
        return [...out].sort().map((url) => ({url}));
    }

    private ctx(): Ctx {
        return new Ctx(this.transform, this.style.globalState, this.sprites.images);
    }

    /** Glyph ranges still to fetch for the text of the loaded tiles. Text is only known once
     * its tiles are decoded, so this grows as tiles arrive. */
    private glyphNeeds(): [string, [string, number]][] {
        if (this.glyphs.url === undefined) return [];
        if (this.glyphDependencies) return this.glyphs.needs(this.glyphDependencies.values());
        const ctx = this.ctx();
        const deps = new Map<string, [string, number]>();
        const noMask = Mask.empty();
        for (const layer of this.style.layers) {
            if (layer.type !== 'symbol' || isHidden(layer, this.transform.zoom)) continue;
            const src = layer.source !== undefined ? this.sources.get(layer.source) : undefined;
            if (!src) continue;
            for (const [rt, tl] of this.tileLayers(src)) {
                const l = this.sourceLayer(src, layer, tl);
                if (!l) continue;
                const tf = new TileFeatures(rt, noMask, l, undefined);
                glyphDependencies(layer, ctx, tf, layer.json, deps);
            }
        }
        const needs = this.glyphs.needs(deps.values());
        this.glyphDependencies = deps;
        return needs;
    }

    /** Calls `f` with the source's resolved tiles: their clip masks and `layer`'s features.
     * Each also gets its bucket cache. */
    private withTiles<R>(ctx: Ctx, src: Source, layer: StyleLayer, w: number, h: number, f: (tiles: TileFeatures[]) => R): R {
        const empty: MvtLayer = {name: '', extent: 4096, features: []};
        const layersByTile = this.tileLayers(src);
        const masks = ctx.masks(layersByTile.map((r) => r[0]), w, h);
        const tiles = layersByTile.map(([rt, tl, buckets], i) => new TileFeatures(rt, masks[i], this.sourceLayer(src, layer, tl) ?? empty, buckets));
        return f(tiles);
    }

    /** `*-layer-opacity`, if the layer type has one. */
    private layerOpacity(layer: StyleLayer): number | undefined {
        const p = layer.paint.get(`${layer.type}-layer-opacity`);
        return p ? num(p.eval(this.transform.zoom)) : undefined;
    }

    /** Resolved tiles of a vector/GeoJSON source with their decoded layers (sliced when
     * overzoomed) and bucket caches. */
    private tileLayers(src: Source): TileLayers[] {
        return this.resolve(src)[0].map(([rt, dataId]): TileLayers => {
            let layers: MvtLayer[] | undefined;
            const data = src.data;
            if (data.kind === 'GeoJson') {
                const key = `${rt.canonical.key()}|${rt.canonical.key()}`;
                let e = src.vectorLayers.get(key);
                if (!e) src.vectorLayers.set(key, (e = {data: rt.canonical.key(), layers: [data.index.tile(rt.canonical.z, rt.canonical.x, rt.canonical.y)]}));
                layers = e.layers;
            } else if (data.kind === 'Tiled') {
                const t = src.tiles.get(dataId.key());
                if (t && t.kind === 'Vector') {
                    if (sameTile(dataId, rt.canonical)) {
                        layers = t.layers;
                    } else {
                        const key = `${dataId.key()}|${rt.canonical.key()}`;
                        let e = src.vectorLayers.get(key);
                        if (!e) src.vectorLayers.set(key, (e = {data: dataId.key(), layers: t.layers.map((l) => sliceLayer(l, dataId, rt.canonical))}));
                        layers = e.layers;
                    }
                }
            }
            const bkey = `${dataId.key()}|${rt.canonical.key()}|${rt.overscaledZ}`;
            let b = src.buckets.get(bkey);
            if (!b) src.buckets.set(bkey, (b = {data: dataId.key(), buckets: new Map()}));
            return [rt, layers, b.buckets];
        });
    }

    /** The style layer's source layer within a tile. */
    private sourceLayer(src: Source, layer: StyleLayer, layers: MvtLayer[] | undefined): MvtLayer | undefined {
        if (!layers) return undefined;
        if (src.data.kind === 'GeoJson') return layers[0];
        return layers.find((l) => layer.sourceLayer !== undefined && l.name === layer.sourceLayer);
    }

    /** Hand over fetched bytes for `url` (as returned by `needs()`). `undefined` means the host
     * could not fetch it (e.g. 404): a vector tile is then empty, a raster tile is replaced by an
     * ancestor, a glyph range leaves its glyphs missing. */
    provide(url: string, bytes: Uint8Array | undefined) {
        const imageCount = this.sprites.images.size;
        this.sprites.provide(url, bytes);
        let changed = this.sprites.images.size !== imageCount;
        // Glyph ranges are recognized from the last `needs()` (evaluating text is costly).
        const glyphKey = this.glyphUrls.get(url);
        if (glyphKey) {
            this.glyphUrls.delete(url);
            this.glyphs.provide(glyphKey, bytes);
        }
        const requested = this.requested.get(url) ?? [];
        this.requested.delete(url);
        for (const [id, src] of this.sources) {
            const data = src.data;
            if (data.kind === 'Pending' && data.url === url) {
                changed = true;
                let doc: any;
                if (bytes) {
                    try {
                        doc = JSON.parse(new TextDecoder().decode(bytes));
                    } catch {
                        doc = undefined;
                    }
                }
                src.data =
                    doc === undefined ? {kind: 'Failed'}
                    : src.type === 'geojson' ? {kind: 'GeoJson', index: geojsonIndex(doc, src.json)}
                    : {kind: 'Tiled', tj: tilejsonFrom(doc, src.json)};
            } else if (data.kind === 'Tiled') {
                for (const [s, t] of requested) {
                    if (s !== id || src.tiles.has(t.key())) continue;
                    changed = true;
                    // Like MapLibre: a missing vector tile is just empty; a missing raster
                    // tile lets a parent show through, while an empty raster response
                    // (HTTP 204) is a transparent tile.
                    // A DEM tile that fails to decode also lets a parent show through.
                    const raster = src.type === 'raster' || src.type === 'raster-dem';
                    let decoded: TileData | null;
                    if (raster && bytes && bytes.length === 0) {
                        decoded = {kind: 'Raster', texture: new Texture(new Image(1, 1, new Uint8Array(4)), true)};
                    } else if (src.type === 'raster' && bytes) {
                        const i = Image.decode(bytes);
                        decoded = i ? {kind: 'Raster', texture: new Texture(i, true)} : null;
                    } else if (src.type === 'raster-dem' && bytes) {
                        const i = Image.decode(bytes);
                        const d = i ? demFrom(i, src.json, data.tj.encoding) : undefined;
                        decoded = d ? {kind: 'Dem', dem: d} : null;
                    } else if (raster) {
                        decoded = null;
                    } else {
                        const used = (name: string) => this.style.layers.some((l) => l.source === id && l.sourceLayer === name);
                        decoded = {kind: 'Vector', layers: (bytes && decodeMvt(bytes, used)) || []};
                    }
                    src.tiles.set(t.key(), decoded);
                    stamp(src.lastUsed, t, this.clock);
                }
            } else if (data.kind === 'Image' && data.url === url && data.texture === undefined) {
                changed = true;
                // Image sources are uploaded without mipmaps.
                const i = bytes ? Image.decode(bytes) : undefined;
                data.texture = i ? new Texture(i, false) : null;
            }
        }
        if (changed) this.glyphDependencies = undefined;
    }

    /** Non-premultiplied RGBA8, row-major. Throws `RenderError` 'NotReady' while `needs()` is
     * non-empty. */
    render(): RenderOutput {
        return this.renderRetaining(this.clock);
    }

    /** `render`, keeping the cached tiles needed by tickets `oldest` and later (see `setTicket`). */
    renderRetaining(oldest: number): RenderOutput {
        if (this.needs().length) throw new RenderError('NotReady');
        if (this.projected && this.projected[1].isEmpty()) {
            const w = this.projected[1];
            const [width, height] = [w.size[0] - 2 * w.margin, w.size[1] - 2 * w.margin];
            return {width, height, data: new Uint8Array(width * height * 4)};
        }
        this.evict(Math.min(oldest, this.clock));
        const t = this.transform;
        const [w, h] = [Math.round(t.width * t.pixelRatio), Math.round(t.height * t.pixelRatio)];
        const layers = this.style.layers;
        const visible = layers.map((l) => !isHidden(l, t.zoom));
        // In a projected view the Mercator picture (rasters and DEMs) is warped into `out` before
        // each layer drawn directly (and at the end); those layers are drawn with `outCtx`.
        const warp = this.projected?.[1];
        const isDirect = (l: StyleLayer) => warp !== undefined && ['symbol', 'fill', 'line', 'circle', 'heatmap', 'background'].includes(l.type);
        // The Mercator picture, unless a projected view has no layer drawn in it.
        const mercatorDrawn = warp === undefined || layers.some((l, i) => visible[i] && !isDirect(l));
        const target = mercatorDrawn ? new Target(w, h) : new Target(0, 0);
        const ctx = this.ctx();
        const out = warp ? new Target(warp.size[0], warp.size[1]) : undefined;
        const outCtx = warp ? new Ctx(t.reprojected(warp), this.style.globalState, this.sprites.images) : ctx;
        const [symbolLayers, leaderOf, placements] = this.placeSymbols(outCtx);
        // Heatmaps drawn so far: MapLibre draws them without depth test, so they stay on top of
        // the opaque-pass pixels (opaque backgrounds and fill interiors) of layers above them.
        const heatmaps: Float32Array[] = [];
        // Opaque pass, top-down (see `Pass`). Not for a projected view: the warp blends
        // neighboring pixels, so occluded ones must still be drawn.
        const opaqueDrawn = warp ? layers.map(() => false) : this.opaquePass(target, ctx, visible);
        // In a projected view, layers drawn from vertices go straight into `out` (through `outCtx`).
        // Rasters and DEMs are drawn in Mercator into `target`, which is warped into
        // `out` before the next layer drawn directly, and at the end.
        let warpedPending = false;
        // The last layer drawing each layout group's buckets, when they are not kept.
        const lastUse = new Map<string, number>();
        if (!this.keepBuckets) layers.forEach((l, i) => visible[i] && ['fill', 'line', 'circle', 'heatmap'].includes(l.type) && lastUse.set(l.layoutGroup, i));
        for (const [i, layer] of layers.entries()) {
            if (!visible[i]) continue;
            const raw = layer.json;
            const direct = isDirect(layer);
            if (warp && out && direct && warpedPending) {
                warp.composite(target, t, out);
                warpedPending = false;
            }
            warpedPending ||= warp !== undefined && !direct;
            const [main, lctx] = out && direct ? [out, outCtx] : [target, ctx];
            const [lw, lh] = [main.w, main.h];
            main.layer = i + 1;
            if (heatmaps.length) {
                reapplyHeatmaps(main, heatmaps);
                main.opaque = new Uint8Array(lw * lh);
            }
            if (layer.type === 'background') {
                if (!opaqueDrawn[i]) drawBackground(main, layer, lctx, raw, 'All');
                continue;
            }
            if (layer.type === 'symbol') {
                const li = leaderOf.get(layer.id);
                if (li !== undefined) drawSymbolLayer(main, layer, lctx, raw, symbolLayers[li][2], placements[li]);
                continue;
            }
            if (layer.type === 'hillshade' || layer.type === 'color-relief') {
                const src = layer.source !== undefined ? this.sources.get(layer.source) : undefined;
                if (src) this.drawDemLayer(main, layer, lctx, src, lw, lh);
                continue;
            }
            if (!['fill', 'line', 'circle', 'raster', 'heatmap'].includes(layer.type)) continue;
            const src = layer.source !== undefined ? this.sources.get(layer.source) : undefined;
            if (!src) continue;
            if (layer.type === 'raster') {
                this.drawRaster(main, layer, lctx, src, lw, lh);
                continue;
            }
            // `*-layer-opacity`: the layer is drawn offscreen, then composited.
            const layerOpacity = this.layerOpacity(layer);
            if (layerOpacity === 0) continue;
            const offscreen = layerOpacity !== undefined && layerOpacity < 1 ? new Target(lw, lh) : undefined;
            const dest = offscreen ?? main;
            this.withTiles(lctx, src, layer, lw, lh, (tiles) => {
                switch (layer.type) {
                    case 'fill':
                        drawFill(dest, layer, lctx, tiles, raw, opaqueDrawn[i] ? 'Translucent' : 'All');
                        break;
                    case 'line': {
                        const sourceMaxzoom = src.data.kind === 'Tiled' ? src.data.tj.maxzoom : src.data.kind === 'GeoJson' ? src.data.index.maxzoom() : 22;
                        const hasGradient = get(raw.paint, 'line-gradient') !== undefined;
                        const hasPattern = get(raw.paint, 'line-pattern') !== undefined;
                        drawLine(dest, layer, lctx, tiles, sourceMaxzoom, this.maxZoom, hasGradient, hasPattern);
                        break;
                    }
                    case 'circle':
                        drawCircle(dest, layer, lctx, tiles);
                        break;
                    case 'heatmap': {
                        const colors = drawHeatmap(dest, layer, lctx, tiles);
                        blendHeatmap(dest, colors, undefined);
                        heatmaps.push(colors);
                        break;
                    }
                }
            });
            if (lastUse.get(layer.layoutGroup) === i) {
                for (const {buckets} of src.buckets.values()) {
                    buckets.delete(layer.layoutGroup);
                    buckets.delete(`${layer.layoutGroup}\0projected`);
                }
            }
            if (offscreen && layerOpacity !== undefined) {
                const px = offscreen.px;
                for (let p = 0; p < lw * lh; p++) {
                    const [r, g, b, a] = [px[p * 4], px[p * 4 + 1], px[p * 4 + 2], px[p * 4 + 3]];
                    if ((a !== 0 || r !== 0 || g !== 0 || b !== 0) && main.visible(p)) {
                        main.blend(p, [(r / 255) * layerOpacity, (g / 255) * layerOpacity, (b / 255) * layerOpacity, (a / 255) * layerOpacity]);
                    }
                }
            }
        }
        if (warp && out) {
            if (warpedPending) warp.composite(target, t, out);
            reapplyHeatmaps(out, heatmaps);
            return crop(out.intoUnpremultiplied(), warp.size[0], warp.margin);
        }
        reapplyHeatmaps(target, heatmaps);
        return crop(target.intoUnpremultiplied(), w, Math.round(this.view.margin * t.pixelRatio));
    }

    /** Lays out (or reuses) the symbol buckets of all symbol layers and places them, from the top
     * layer down. Layers with identical layout share their leader's buckets. */
    private placeSymbols(ctx: Ctx): [[StyleLayer, any, SymbolBucket[]][], Map<string, number>, InstancePlacement[][][]] {
        const t = ctx.transform;
        const empty: MvtLayer = {name: '', extent: 4096, features: []};
        // Symbols are laid out and placed for all layers before drawing (placement runs from
        // the top layer down).
        const noMask = Mask.empty();
        // Layers with identical layout share one bucket (`groupByLayout`): it is laid out and
        // placed once, for the first layer, and drawn by each with its own paint.
        const symbolLayers: [StyleLayer, any, SymbolBucket[]][] = [];
        const leaderOf = new Map<string, number>();
        const REF = ['type', 'source', 'source-layer', 'minzoom', 'maxzoom', 'filter', 'layout'];
        for (const layer of this.style.layers) {
            if (layer.type !== 'symbol' || isHidden(layer, t.zoom)) continue;
            const src = layer.source !== undefined ? this.sources.get(layer.source) : undefined;
            if (!src) continue;
            const raw = layer.json;
            const leader = symbolLayers.findIndex(([, r]) => REF.every((k) => jsonEqual(r[k], raw[k])));
            if (leader >= 0) {
                leaderOf.set(layer.id, leader);
                continue;
            }
            const builder = new Builder(layer, ctx, this.glyphs, raw);
            const buckets: SymbolBucket[] = [];
            for (const [rt, tl, tileBuckets] of this.tileLayers(src)) {
                const l = this.sourceLayer(src, layer, tl) ?? empty;
                const tf = new TileFeatures(rt, noMask, l, tileBuckets);
                // The layout is camera-independent except for the world copy (in its tile) and the
                // pixel ratio (icon scaling and the sprite); placement is redone each render.
                const key = `${layer.layoutGroup}\0${rt.wrap}\0${t.pixelRatio}`;
                buckets.push(tf.bucketKeyed(key, () => builder.build(tf)));
            }
            leaderOf.set(layer.id, symbolLayers.length);
            symbolLayers.push([layer, raw, buckets]);
        }
        const groups: string[] = [];
        const placementInput: LayerBuckets[] = symbolLayers.map(([layer, raw, buckets]) => {
            let group = 0;
            if (!this.crossSourceCollisions) {
                const src = layer.source ?? '';
                let g = groups.indexOf(src);
                if (g < 0) {
                    groups.push(src);
                    g = groups.length - 1;
                }
                group = g + 1;
            }
            return {layer, raw, buckets, group};
        });
        const placements = place(ctx, placementInput);
        return [symbolLayers, leaderOf, placements];
    }

    /** The opaque pass of a Mercator render, top-down (see `Pass`): records the pixels
     * hidden under opaque backgrounds and fill interiors. Returns which layers drew in it. */
    private opaquePass(target: Target, ctx: Ctx, visible: boolean[]): boolean[] {
        const layers = this.style.layers;
        const opaqueDrawn = layers.map(() => false);
        // Heatmaps stay on top of the opaque pixels of the layers above them, which the occlusion
        // buffer can't express, so they draw all layers in style order. Only a background or fill
        // above another visible layer can hide anything.
        const lowest = visible.indexOf(true);
        const occlusion =
            lowest >= 0 && layers.length < 65535 &&
            !layers.some((l, i) => visible[i] && l.type === 'heatmap') &&
            layers.some((l, i) => visible[i] && i > lowest && (l.type === 'background' || l.type === 'fill'));
        if (occlusion) {
            target.occ = new Uint16Array(target.w * target.h);
            target.cull = true;
            for (let i = layers.length - 1; i >= 0; i--) {
                if (!visible[i]) continue;
                const layer = layers[i];
                target.layer = i + 1;
                const raw = layer.json;
                if (layer.type === 'background') {
                    opaqueDrawn[i] = drawBackground(target, layer, ctx, raw, 'Opaque');
                } else if (layer.type === 'fill') {
                    const o = this.layerOpacity(layer);
                    if (o !== undefined && !(o >= 1)) continue;
                    const src = layer.source !== undefined ? this.sources.get(layer.source) : undefined;
                    if (!src) continue;
                    opaqueDrawn[i] = this.withTiles(ctx, src, layer, target.w, target.h, (tiles) => drawFill(target, layer, ctx, tiles, raw, 'Opaque'));
                }
            }
            target.cull = opaqueDrawn.lastIndexOf(true) > lowest;
        }
        return opaqueDrawn;
    }

    private drawRaster(target: Target, layer: StyleLayer, ctx: Ctx, src: Source, w: number, h: number) {
        const params = new RasterParams(layer, ctx);
        const data = src.data;
        if (data.kind === 'Image' && data.texture) {
            const tex = data.texture;
            const [id, corners] = imageTile(data.coordinates);
            const warp = imageWarp(corners);
            const [tl, tr, br, bl] = corners;
            const parallelogram = warp[0] === 0 && warp[1] === 0 && warp[2] === 1 && tl[0] + br[0] === tr[0] + bl[0] && tl[1] + br[1] === tr[1] + bl[1];
            // World copies of the image tile that may be visible.
            const cornersWorld = [[0, 0], [w, 0], [0, h], [w, h]].map((p) => ctx.transform.screenToWorld(p as [number, number]));
            const ws = ctx.transform.worldSize;
            const x0 = Math.min(...cornersWorld.map((p) => p[0]));
            const x1 = Math.max(...cornersWorld.map((p) => p[0]));
            for (let wrap = asI32(Math.floor(x0 / ws)) - 1; wrap <= asI32(Math.floor(x1 / ws)) + 1; wrap++) {
                const tile: RenderTile = {overscaledZ: id.z, wrap, canonical: id};
                const q = new Quad(tile, corners, warp, warp[2] > 0 && !parallelogram);
                drawQuad(target, ctx, q, tex, params, undefined);
            }
            return;
        }
        const resolved = this.resolve(src)[0];
        const tiles = resolved.map((r) => r[0]);
        // Same-zoom tiles abut and are drawn without stencil; mixed zooms (fallback parents) are
        // clipped so that the higher zoom wins.
        const mixed = tiles.some((t) => t.canonical.z !== tiles[0].canonical.z);
        const masks = mixed ? ctx.masks(tiles, w, h) : undefined;
        resolved.forEach(([rt, dataId], i) => {
            const t = src.tiles.get(dataId.key());
            if (t && t.kind === 'Raster') drawQuad(target, ctx, Quad.tile(rt), t.texture, params, masks?.[i]);
        });
    }

    /** Hillshade / color-relief: each drawn DEM tile takes its 2px border from the drawn tiles
     * around it (MapLibre's `backfillDEM` over the renderable tiles), then is drawn. */
    private drawDemLayer(target: Target, layer: StyleLayer, ctx: Ctx, src: Source, w: number, h: number) {
        const hillshade = layer.type === 'hillshade' ? new HillshadeParams(layer, ctx) : undefined;
        const ramp = layer.type === 'color-relief' ? new ColorRamp(layer, ctx) : undefined;
        const resolved = this.resolve(src)[0];
        const tiles = resolved.map((r) => r[0]);
        // The resolved tiles of a source are fixed for one render, so the source id keys them.
        const dems = ctx.demTiles(layer.source ?? '', () => {
            const raw = resolved.map(([, id]) => {
                const t = src.tiles.get(id.key());
                return t && t.kind === 'Dem' ? t.dem : undefined;
            });
            return tiles.map((t, i) => {
                const r = raw[i];
                if (!r) return undefined;
                const dem = r.clone();
                const n = 2 ** t.canonical.z;
                const worldX = (u: RenderTile) => u.wrap * n + u.canonical.x;
                tiles.forEach((u, j) => {
                    const [dx, dy] = [worldX(u) - worldX(t), u.canonical.y - t.canonical.y];
                    const neighbor = u.overscaledZ === t.overscaledZ && u.canonical.z === t.canonical.z && Math.abs(dx) <= 1 && Math.abs(dy) <= 1 && (dx !== 0 || dy !== 0);
                    const b = raw[j];
                    if (neighbor && b) dem.backfill(b, dx, dy);
                });
                return new DemTile(dem);
            });
        });
        const mixed = tiles.some((t) => t.canonical.z !== tiles[0].canonical.z);
        const masks = mixed ? ctx.masks(tiles, w, h) : undefined;
        tiles.forEach((t, i) => {
            const dem = dems[i];
            if (!dem) return;
            const mask = masks?.[i];
            if (hillshade) {
                // Raster sources are not reparsed when overzoomed: their tiles keep
                // `overscaledZ` = the canonical zoom.
                const tex = dem.slopes(t.canonical.z);
                drawHillshadeTile(target, ctx, t, tex, hillshade, mask);
            }
            if (ramp) drawColorReliefTile(target, ctx, t, dem.dem, ramp, mask);
        });
    }
}
