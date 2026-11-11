// raster-dem layers: `DEMData` (2px padded, backfilled from neighbors); hillshade (the
// `hillshadePrepare` pass into an 8-bit slope texture, and the `hillshade` shader with its five
// methods); color-relief (elevation stops and color ramp textures).

import {Color, ColorArray, NumberArray} from '@maplibre/maplibre-gl-style-spec';
import {type Filter, Image, Texture} from '../image.ts';
import {type Layer, type Value, paint as paintProp} from '../style.ts';
import {type RenderTile, mercatorLat} from '../tile.ts';
import {asU8, roundAway} from '../util.ts';
import * as raster from './raster.ts';
import type {Mask, Rgba, Target} from './raster.ts';
import {type Ctx, EXTENT, color, dummyTile, num} from './mod.ts';

const PI = Math.PI;
const toRadians = (deg: number) => deg * (PI / 180);

/** Decoded DEM tile: RGB texels with a 2px border (edge-replicated until backfilled). */
export class Dem {
    dim: number;
    stride: number;
    /** RGBA bytes, `stride` texels per row. */
    data: Uint8Array;
    /** red, green, blue factors and base shift. */
    unpack: [number, number, number, number];

    constructor(dim: number, stride: number, data: Uint8Array, unpack: [number, number, number, number]) {
        this.dim = dim;
        this.stride = stride;
        this.data = data;
        this.unpack = unpack;
    }

    /** `encoding`: "mapbox" (default), "terrarium" or "custom" with `factors`
     * (red, green, blue, baseShift). (Rust `Dem::new`, which returns an `Option`.) */
    static new(img: Image, encoding: string, factors: [number, number, number, number]): Dem | undefined {
        if (img.w !== img.h || img.w === 0) return undefined;
        const unpack: [number, number, number, number] =
            encoding === 'terrarium' ? [256, 1, 1 / 256, 32768] : encoding === 'custom' ? [...factors] : [6553.6, 25.6, 0.1, 10000];
        const dim = img.w;
        const stride = dim + 4;
        const data = new Uint8Array(stride * stride * 4);
        let o = 0;
        for (let y = 0; y < stride; y++) {
            for (let x = 0; x < stride; x++) {
                const sx = Math.min(Math.max(x - 2, 0), dim - 1);
                const sy = Math.min(Math.max(y - 2, 0), dim - 1);
                const i = (sy * dim + sx) * 4;
                data[o++] = img.data[i];
                data[o++] = img.data[i + 1];
                data[o++] = img.data[i + 2];
                data[o++] = img.data[i + 3];
            }
        }
        return new Dem(dim, stride, data, unpack);
    }

    clone(): Dem {
        return new Dem(this.dim, this.stride, this.data.slice(), [...this.unpack]);
    }

    private idx(x: number, y: number): number {
        return (y + 2) * this.stride + (x + 2);
    }

    /** `backfillBorder`: copy the neighbor's edge into this tile's border (`dx`, `dy` in -1..=1). */
    backfill(border: Dem, dx: number, dy: number): void {
        if (this.dim !== border.dim) return;
        const d = this.dim;
        let x0 = dx * d;
        let x1 = dx * d + d;
        let y0 = dy * d;
        let y1 = dy * d + d;
        if (dx === -1) x0 = x1 - 2;
        else if (dx === 1) x1 = x0 + 2;
        if (dy === -1) y0 = y1 - 2;
        else if (dy === 1) y1 = y0 + 2;
        const ox = -dx * d;
        const oy = -dy * d;
        for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
                const s = border.idx(x + ox, y + oy) * 4;
                this.data.set(border.data.subarray(s, s + 4), this.idx(x, y) * 4);
            }
        }
    }

    /** The `hillshadePrepare` pass: slopes as `(dx, dy)` unorm8, `(dim+2)²` texels. */
    prepare(zoom: number): Texture {
        const size = this.dim + 2;
        const u = this.unpack;
        const n = this.stride * this.stride;
        const elevations = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            const p = i * 4;
            elevations[i] = this.data[p] * u[0] + this.data[p + 1] * u[1] + this.data[p + 2] * u[2] - u[3];
        }
        const elevation = (x: number, y: number) => elevations[y * this.stride + x];
        const factor = zoom < 2 ? 0.4 : zoom < 4.5 ? 0.35 : 0.3;
        const exaggeration = zoom < 15 ? (zoom - 15) * factor : 0;
        // log2 of the mercator world width in meters.
        const scale = this.dim / 2 ** (exaggeration + (3 + 25.2562 - zoom));
        const unorm = (v: number) => asU8(roundAway(Math.min(Math.max(v, 0), 1) * 255));
        const data = new Uint8Array(size * size * 4);
        let o = 0;
        for (let py = 0; py < size; py++) {
            for (let px = 0; px < size; px++) {
                // Texel (px+1, py+1) of the padded DEM and its eight neighbors.
                const e = (dx: number, dy: number) => elevation(px + dx, py + dy);
                const a = e(0, 0), b = e(1, 0), c = e(2, 0);
                const d = e(0, 1), f = e(2, 1);
                const g = e(0, 2), h = e(1, 2), i = e(2, 2);
                const dx = ((c + f + f + i) - (a + d + d + g)) * scale;
                const dy = ((g + h + h + i) - (a + b + b + c)) * scale;
                data[o++] = unorm(dx / 8 + 128 / 255);
                data[o++] = unorm(dy / 8 + 128 / 255);
                data[o++] = 255;
                data[o++] = 255;
            }
        }
        return new Texture(new Image(size, size, data), false);
    }
}

/** A drawn tile's DEM after `backfillDEM`, shared by its source's layers in one render; the
 * hillshade slopes are prepared on first use (`needsHillshadePrepare`). */
export class DemTile {
    dem: Dem;
    private prepared: Texture | undefined;

    constructor(dem: Dem) {
        this.dem = dem;
    }

    slopes(zoom: number): Texture {
        return (this.prepared ??= this.dem.prepare(zoom));
    }
}

/** `hillshadeUniformValues`. */
export class HillshadeParams {
    private method: number;
    private exaggeration: number;
    private accent: Rgba;
    /** The first light's azimuth + π (standard, igor). */
    private azimuth: number;
    /** Per light: sin(altitude), cos(altitude), and the azimuth's cos, sin as used by `cang`. */
    private lights: [number, number, number, number][];
    /** Standard: the exaggeration's power base and `base^(π/2) - 1`. */
    private base: number;
    private baseMax: number;
    private shadows: Rgba[];
    private highlights: Rgba[];
    /** `NUM_ILLUMINATION_SOURCES`: the number of highlight colors. */
    private sources: number;
    filter: Filter;

    constructor(layer: Layer, ctx: Ctx) {
        const t = dummyTile();
        const p = (n: string) => ctx.paint(layer, n, undefined, t);
        const numbers = (v: Value): number[] => (v instanceof NumberArray ? v.values.slice() : typeof v === 'number' ? [v] : []);
        const colors = (v: Value): Rgba[] =>
            v instanceof ColorArray ? v.values.map((c) => color(c, 1)) : v instanceof Color ? [color(v, 1)] : [];
        const direction = numbers(p('hillshade-illumination-direction'));
        const altitude = numbers(p('hillshade-illumination-altitude'));
        const highlights = colors(p('hillshade-highlight-color'));
        const shadows = colors(p('hillshade-shadow-color'));
        const sources = Math.max(highlights.length, 1);
        const n = Math.max(direction.length, altitude.length, highlights.length, shadows.length, 1);
        const pad = <T>(v: T[], fallback: T) => {
            const last = v.length > 0 ? v[v.length - 1] : fallback;
            v.length = Math.min(v.length, n);
            while (v.length < n) v.push(last);
        };
        pad(direction, 335);
        pad(altitude, 45);
        pad(highlights, [1, 1, 1, 1]);
        pad(shadows, [0, 0, 0, 1]);
        const viewport = p('hillshade-illumination-anchor') !== 'map';
        const bearing = -ctx.transform.bearingRad;
        const azimuths = direction.map((d) => toRadians(d) + (viewport ? bearing : 0));
        const altitudes = altitude.map(toRadians);
        const m = p('hillshade-method');
        const method = m === 'basic' ? 4 : m === 'combined' ? 1 : m === 'igor' ? 2 : m === 'multidirectional' ? 3 : 0;
        const azimuth = azimuths[0] + PI;
        const lights: [number, number, number, number][] = [];
        for (let i = 0; i < (method === 3 ? sources : 1); i++) {
            const [cosAz, sinAz] = method === 3 ? [-Math.cos(azimuths[i]), -Math.sin(azimuths[i])] : [Math.cos(azimuth), Math.sin(azimuth)];
            lights.push([Math.sin(altitudes[i]), Math.cos(altitudes[i]), cosAz, sinAz]);
        }
        const exaggeration = num(p('hillshade-exaggeration'));
        const base = 1.875 - exaggeration * 1.75;
        this.method = method;
        this.exaggeration = exaggeration;
        this.accent = color(p('hillshade-accent-color'), 1);
        this.azimuth = azimuth;
        this.lights = lights;
        this.base = base;
        this.baseMax = base ** (0.5 * PI) - 1;
        this.shadows = shadows;
        this.highlights = highlights;
        this.sources = sources;
        this.filter = p('resampling') === 'nearest' ? 'Nearest' : 'Linear';
    }

    /** The fragment shader for slopes `deriv`. */
    shade(deriv: [number, number]): Rgba {
        const mix = (a: Rgba, b: Rgba, t: number): Rgba => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
        const scale = (c: Rgba, s: number): Rgba => [c[0] * s, c[1] * s, c[2] * s, c[3] * s];
        const add = (a: Rgba, b: Rgba): Rgba => [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]];
        const len = (d: [number, number]) => Math.sqrt(d[0] * d[0] + d[1] * d[1]);
        const aspect = (d: [number, number]) => (d[0] !== 0 ? Math.atan2(d[1], -d[0]) : PI / 2 * (d[1] > 0 ? 1 : -1));
        // GLSL `mod`.
        const gmod = (x: number, y: number) => x - y * Math.floor(x / y);
        const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);
        const boosted: [number, number] = [deriv[0] * this.exaggeration * 2, deriv[1] * this.exaggeration * 2];
        const cang = (d: [number, number], [sinAlt, cosAlt, cosAz, sinAz]: [number, number, number, number]) =>
            (sinAlt - (d[1] * cosAz * cosAlt - d[0] * sinAz * cosAlt)) / Math.sqrt(1 + d[0] * d[0] + d[1] * d[1]);
        const lit = (shade: number, hi: Rgba, sh: Rgba) => (shade > 0.5 ? scale(hi, 2 * shade - 1) : scale(sh, 1 - 2 * shade));
        switch (this.method) {
            // igor
            case 2: {
                const d = boosted;
                const slope = Math.atan(len(d)) * 2 / PI;
                const aspectStrength = 1 - Math.abs(gmod((aspect(d) + this.azimuth) / PI + 0.5, 2) - 1);
                return add(scale(this.shadows[0], slope * aspectStrength), scale(this.highlights[0], slope * (1 - aspectStrength)));
            }
            // basic
            case 4: {
                const shade = clamp01(cang(boosted, this.lights[0]));
                return lit(shade, this.highlights[0], this.shadows[0]);
            }
            // multidirectional
            case 3: {
                const n = this.sources;
                let out: Rgba = [0, 0, 0, 0];
                for (let i = 0; i < this.sources; i++) {
                    const shade = clamp01(cang(boosted, this.lights[i]));
                    out = add(out, scale(lit(shade, this.highlights[i], this.shadows[i]), 1 / n));
                }
                return out;
            }
            // combined
            case 1: {
                const c = Math.min(Math.max(Math.acos(cang(boosted, this.lights[0])), 0), PI / 2);
                const s = Math.atan(len(boosted)) * 4 / PI / PI;
                return add(scale(this.shadows[0], c * s), scale(this.highlights[0], (PI / 2 - c) * s));
            }
            // standard
            default: {
                const slope = Math.atan(0.625 * len(deriv));
                const intensity = this.exaggeration;
                const max = 0.5 * PI;
                const scaled = intensity !== 0.5 ? ((this.base ** slope - 1) / this.baseMax) * max : slope;
                const k = clamp01(intensity * 2);
                const accent = scale(this.accent, (1 - Math.cos(scaled)) * k);
                const shade = Math.abs(gmod((aspect(deriv) + this.azimuth) / PI + 0.5, 2) - 1);
                const shadeColor = scale(mix(this.shadows[0], this.highlights[0], shade), Math.sin(scaled) * k);
                return add(scale(accent, 1 - shadeColor[3]), shadeColor);
            }
        }
    }
}

/** Draw a tile quad, pixel-aligned like rasters; `shade` gets the tile fraction (`a_pos / 8192`). */
function drawQuad(target: Target, ctx: Ctx, tile: RenderTile, mask: Mask | undefined, shade: (v: ArrayLike<number>) => Rgba | undefined): void {
    const toWorld = ctx.tileToWorld(tile);
    const off = ctx.transform.alignedOffset();
    const screen = (p: [number, number]) => {
        const w = toWorld(p);
        return ctx.transform.worldToScreen([w[0] + off[0], w[1] + off[1]]);
    };
    const corners: [number, number][] = [[0, 0], [EXTENT, 0], [0, EXTENT], [EXTENT, EXTENT]];
    const pts = corners.map(screen);
    const uv = corners.map((c) => [c[0] / EXTENT, c[1] / EXTENT]);
    for (const tri of [[1, 0, 2], [1, 2, 3]]) {
        raster.triangle(target, mask, [pts[tri[0]], pts[tri[1]], pts[tri[2]]], [uv[tri[0]], uv[tri[1]], uv[tri[2]]], shade);
    }
}

/** Draw one tile's prepared hillshade texture. */
export function drawHillshadeTile(target: Target, ctx: Ctx, tile: RenderTile, tex: Texture, params: HillshadeParams, mask: Mask | undefined): void {
    // `u_latrange`: latitudes of the tile's top and bottom edges.
    const n = 2 ** tile.canonical.z;
    const lat = (y: number) => mercatorLat(y / n);
    const lat0 = lat(tile.canonical.y);
    const lat1 = lat(tile.canonical.y + 1);
    const [sw, sh] = tex.size();
    drawQuad(target, ctx, tile, mask, (v) => {
        const tp = [(v[0] * (sw - 2) + 1) / sw, (v[1] * (sh - 2) + 1) / sh];
        const px = tex.sample(tp[0], tp[1], params.filter, params.filter, 0);
        const scaleFactor = Math.cos(toRadians((lat0 - lat1) * (1 - v[1]) + lat1));
        const deriv: [number, number] = [(px[0] - 128 / 255) * 8 / scaleFactor, (px[1] - 128 / 255) * 8 / scaleFactor];
        return params.shade(deriv);
    });
}

/** `color-relief-color` as a ramp: elevation stops and their colors (`_createColorRamp`), only
 * from a top-level `interpolate` (anything else draws transparent). */
export class ColorRamp {
    elevations: number[];
    /** Premultiplied on upload, from unpremultiplied bytes (`RGBAImage.setPixel`). */
    colors: [number, number, number, number][];
    opacity: number;
    filter: Filter;

    constructor(layer: Layer, ctx: Ctx) {
        const t = dummyTile();
        const prop = paintProp(layer, 'color-relief-color');
        const elevations: number[] = [];
        const colors: [number, number, number, number][] = [];
        // The compiled property does not expose its expression: the labels of a top-level
        // `interpolate` are read from the layer JSON (an expression that failed to compile has
        // only transparent stops either way).
        const raw = layer.json?.paint?.['color-relief-color'];
        const zoomConstant = prop.kind === 'constant' || prop.kind === 'source';
        if (zoomConstant && Array.isArray(raw) && (raw[0] === 'interpolate' || raw[0] === 'interpolate-hcl' || raw[0] === 'interpolate-lab')) {
            for (let k = 3; k < raw.length; k += 2) {
                const l = raw[k];
                if (typeof l !== 'number') continue;
                const v = prop.evalGlobals({zoom: ctx.transform.zoom, elevation: l});
                elevations.push(l);
                colors.push(rampTexel(v instanceof Color ? v : Color.transparent));
            }
        }
        if (elevations.length === 0) {
            elevations.push(0);
            colors.push([0, 0, 0, 0]);
        }
        if (elevations.length < 2) {
            elevations.push(elevations[0] + 1);
            colors.push(colors[0]);
        }
        this.elevations = elevations;
        this.colors = colors;
        this.opacity = num(ctx.paint(layer, 'color-relief-opacity', undefined, t));
        this.filter = ctx.paint(layer, 'resampling', undefined, t) === 'nearest' ? 'Nearest' : 'Linear';
    }
}

/** `RGBAImage.setPixel` (unpremultiplied bytes) followed by the premultiplying upload. */
export function rampTexel(c: Color): [number, number, number, number] {
    const a = roundAway(c.a * 255);
    const un = (v: number) => (c.a === 0 ? 0 : roundAway(v * 255 / c.a));
    const pm = (v: number) => asU8(roundAway(un(v) * a / 255));
    return [pm(c.r), pm(c.g), pm(c.b), asU8(a)];
}

/** `packDEMData`: an elevation in the DEM's 8-bit encoding. */
function pack(v: number, u: [number, number, number, number]): [number, number, number] {
    let min = Infinity;
    for (const x of [u[0], u[1], u[2]]) if (x !== 0) min = Math.min(min, x);
    if (min === Infinity) return [0, 0, 0];
    const scaled = roundAway((v + u[3]) / min);
    // `as i64 as u8`: truncating, then wrapping to a byte.
    const ch = (factor: number) => {
        if (factor === 0) return 0;
        const x = Math.floor(scaled * min / factor) % 256;
        return x !== x ? 0 : Math.trunc(x) & 255;
    };
    return [ch(u[0]), ch(u[1]), ch(u[2])];
}

/** Draw one tile of a color-relief layer. */
export function drawColorReliefTile(target: Target, ctx: Ctx, tile: RenderTile, dem: Dem, ramp: ColorRamp, mask: Mask | undefined): void {
    const u = dem.unpack;
    const unpack = (p: ArrayLike<number>) => p[0] * 255 * u[0] + p[1] * 255 * u[1] + p[2] * 255 * u[2] - u[3];
    // Elevation stops round-trip through the 8-bit encoding.
    const stops = ramp.elevations.map((e) => unpack(pack(e, u).map((b) => b / 255)));
    const n = stops.length;
    const stride = dem.stride;
    // The DEM texture (`premultiply: false`), filtered on the encoded bytes.
    const texel = (x: number, y: number): [number, number, number] => {
        const i = (Math.min(Math.max(y, 0), stride - 1) * stride + Math.min(Math.max(x, 0), stride - 1)) * 4;
        return [dem.data[i] / 255, dem.data[i + 1] / 255, dem.data[i + 2] / 255];
    };
    const sample = (s: number, t: number): [number, number, number] => {
        const x = s * stride;
        const y = t * stride;
        if (ramp.filter === 'Nearest') return texel(Math.floor(x), Math.floor(y));
        const xs = x - 0.5;
        const ys = y - 0.5;
        const x0 = Math.floor(xs);
        const y0 = Math.floor(ys);
        const fx = xs - x0;
        const fy = ys - y0;
        const a = texel(x0, y0), b = texel(x0 + 1, y0), c = texel(x0, y0 + 1), d = texel(x0 + 1, y0 + 1);
        const lerp = (k: number) => (a[k] * (1 - fx) + b[k] * fx) * (1 - fy) + (c[k] * (1 - fx) + d[k] * fx) * fy;
        return [lerp(0), lerp(1), lerp(2)];
    };
    const colorAt = (x: number): Rgba => {
        // GPUs sample a NaN coordinate (equal stops: 0 / 0) as 0.
        if (x !== x) x = 0;
        const t = x * n - 0.5;
        const i0 = Math.floor(t);
        const f = t - i0;
        const c = (i: number) => ramp.colors[Math.min(Math.max(i, 0), n - 1)];
        const a = c(i0);
        const b = c(i0 + 1);
        return [0, 1, 2, 3].map((k) => (a[k] / 255) * (1 - f) + (b[k] / 255) * f) as Rgba;
    };
    const scale = (stride - 4) / stride;
    const eps = 2 / stride;
    drawQuad(target, ctx, tile, mask, (v) => {
        const el = unpack(sample(v[0] * scale + eps, v[1] * scale + eps));
        // Binary search for the stops around the elevation.
        let l = 0;
        let r = n - 1;
        let elL = stops[l];
        let elR = stops[r];
        while (r - l > 1) {
            const m = Math.floor((l + r) / 2);
            if (el < stops[m]) {
                r = m;
                elR = stops[m];
            } else {
                l = m;
                elL = stops[m];
            }
        }
        const x = (l + (el - elL) / (elR - elL) + 0.5) / n;
        const c = colorAt(x);
        return [c[0] * ramp.opacity, c[1] * ramp.opacity, c[2] * ramp.opacity, c[3] * ramp.opacity];
    });
}
