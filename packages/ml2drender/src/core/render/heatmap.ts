// Heatmap layers (`draw_heatmap.ts`): Gaussian kernels added into a quarter-resolution RGBA16F
// framebuffer (`ONE, ONE` blending, half-float storage), then upsampled with LINEAR filtering
// through the `heatmap-color` ramp.

import {Color} from '@maplibre/maplibre-gl-style-spec';
import {type Layer, paint as paintProp} from '../style.ts';
import {rampTexel} from './dem.ts';
import * as raster from './raster.ts';
import type {Target} from './raster.ts';
import {type Ctx, EXTENT, type TileFeatures, dummyTile, num} from './mod.ts';

const GAUSS_COEF = 0.3989423;
const ZERO = 1 / 255 / 16;

/** Rust `round_ties_even`. */
function roundTiesEven(x: number): number {
    const r = Math.round(x);
    return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** Round to the nearest half float (ties to even), as an RGBA16F attachment stores it. */
export function f16(x: number): number {
    const a = Math.abs(x);
    if (!Number.isFinite(a) || a >= 65520) return x !== x ? x : x < 0 ? -Infinity : Infinity;
    let e = Math.floor(Math.log2(a));
    if (2 ** e > a) e--;
    else if (2 ** (e + 1) <= a) e++;
    const step = a < 2 ** -14 ? 2 ** -24 : 2 ** (e - 10);
    return roundTiesEven(x / step) * step;
}

/** The `heatmap-color` ramp: 256 texels over `heatmap-density` 0..1 (`renderColorRamp`). */
function colorRamp(layer: Layer, ctx: Ctx): [number, number, number, number][] {
    const prop = paintProp(layer, 'heatmap-color');
    const out: [number, number, number, number][] = [];
    for (let i = 0; i < 256; i++) {
        const v = prop.evalGlobals({zoom: ctx.transform.zoom, heatmapDensity: i / 255});
        out.push(v instanceof Color ? rampTexel(v) : [0, 0, 0, 0]);
    }
    return out;
}

/** The heatmap's premultiplied color per canvas pixel, 4 floats each (to blend in layer order,
 * and again over later opaque-pass pixels). */
export function drawHeatmap(target: Target, layer: Layer, ctx: Ctx, tiles: TileFeatures[]): Float32Array {
    const t = ctx.transform;
    const dummy = dummyTile();
    const out = new Float32Array(target.w * target.h * 4);
    const opacity = num(ctx.paint(layer, 'heatmap-opacity', undefined, dummy));
    if (opacity === 0) return out;
    const intensity = num(ctx.paint(layer, 'heatmap-intensity', undefined, dummy));
    // The offscreen framebuffer is a quarter of the canvas (sizes truncated like GLsizei).
    const w4 = Math.floor(target.w / 4);
    const h4 = Math.floor(target.h / 4);
    if (w4 === 0 || h4 === 0) return out;
    const sx = w4 / target.w;
    const sy = h4 / target.h;
    const density = new Float32Array(w4 * h4);
    for (const tf of tiles) {
        const toWorld = ctx.tileToWorld(tf.tile);
        const extrudeScale = EXTENT / ctx.tilePx(tf.tile);
        for (const f of ctx.bucketFeatures(layer, tf, undefined)) {
            const weight = num(ctx.paint(layer, 'heatmap-weight', f, tf.tile));
            const radius = num(ctx.paint(layer, 'heatmap-radius', f, tf.tile));
            // Kernel extent where it falls to `ZERO`, in units of the radius.
            const s = Math.sqrt(-2 * Math.log(ZERO / weight / intensity / GAUSS_COEF)) / 3;
            if (!Number.isFinite(s)) continue;
            const val0 = weight * intensity * GAUSS_COEF;
            // Quad vertices (extrude -1/1 per axis), indices (0, 3, 1), (0, 2, 3).
            const corners: [number, number][] = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
            const vary = corners.map((e) => [e[0] * s, e[1] * s]);
            for (const line of f.geometry) {
                for (const p of line) {
                    if (p[0] < 0 || p[0] >= EXTENT || p[1] < 0 || p[1] >= EXTENT) continue;
                    // Projected: the kernel is extruded in screen pixels around the projected point.
                    let center: [number, number] | undefined;
                    if (t.isProjected()) {
                        center = t.onMap(toWorld(p));
                        if (!center) continue;
                    }
                    const pos = corners.map((e): [number, number] => {
                        let d: [number, number];
                        if (center) {
                            const off = s * radius * t.pixelRatio;
                            d = [center[0] + e[0] * off, center[1] + e[1] * off];
                        } else {
                            const off = s * radius * extrudeScale;
                            d = t.worldToScreen(toWorld([p[0] + e[0] * off, p[1] + e[1] * off]));
                        }
                        return [d[0] * sx, d[1] * sy];
                    });
                    for (const tri of [[0, 3, 1], [0, 2, 3]]) {
                        const [v0, v1, v2] = [vary[tri[0]], vary[tri[1]], vary[tri[2]]];
                        raster.forEachPixel(w4, h4, [pos[tri[0]], pos[tri[1]], pos[tri[2]]], (x: number, y: number, b: ArrayLike<number>) => {
                            const vx = v0[0] * b[0] + v1[0] * b[1] + v2[0] * b[2];
                            const vy = v0[1] * b[0] + v1[1] * b[1] + v2[1] * b[2];
                            const d = -0.5 * 3 * 3 * (vx * vx + vy * vy);
                            const i = y * w4 + x;
                            density[i] = f16(density[i] + f16(val0 * Math.exp(d)));
                        });
                    }
                }
            }
        }
    }
    // `heatmap_texture`: upsample the density (LINEAR, clamp) and look up the ramp.
    const ramp = colorRamp(layer, ctx);
    const texel = (x: number, y: number) => density[Math.min(Math.max(y, 0), h4 - 1) * w4 + Math.min(Math.max(x, 0), w4 - 1)];
    for (let y = 0; y < target.h; y++) {
        for (let x = 0; x < target.w; x++) {
            const u = (x + 0.5) / target.w * w4 - 0.5;
            const v = (y + 0.5) / target.h * h4 - 0.5;
            const x0 = Math.floor(u);
            const y0 = Math.floor(v);
            const fx = u - x0;
            const fy = v - y0;
            const d = (texel(x0, y0) * (1 - fx) + texel(x0 + 1, y0) * fx) * (1 - fy) + (texel(x0, y0 + 1) * (1 - fx) + texel(x0 + 1, y0 + 1) * fx) * fy;
            // The ramp texture (LINEAR, clamp) at `d`.
            const tx = d * 256 - 0.5;
            const i0 = Math.floor(tx);
            const f = tx - i0;
            const a = ramp[Math.min(Math.max(i0, 0), 255)];
            const b = ramp[Math.min(Math.max(i0 + 1, 0), 255)];
            const o = (y * target.w + x) * 4;
            for (let k = 0; k < 4; k++) out[o + k] = ((a[k] / 255) * (1 - f) + (b[k] / 255) * f) * opacity;
        }
    }
    return out;
}

/** Blend a heatmap's colors, at all pixels or only where `only` is set. */
export function blend(target: Target, colors: Float32Array, only: ArrayLike<unknown> | undefined): void {
    for (let i = 0; i * 4 < colors.length; i++) {
        if (only && !only[i]) continue;
        const o = i * 4;
        if (colors[o] !== 0 || colors[o + 1] !== 0 || colors[o + 2] !== 0 || colors[o + 3] !== 0) {
            target.blend(i, [colors[o], colors[o + 1], colors[o + 2], colors[o + 3]]);
        }
    }
}

/** Blend the heatmaps again over the pixels the last layer wrote in the opaque pass. */
export function reapply(target: Target, heatmaps: Float32Array[]): void {
    const only = target.opaque;
    target.opaque = only.slice(0, 0) as typeof only;
    let any = false;
    for (let i = 0; i < only.length; i++) {
        if (only[i]) {
            any = true;
            break;
        }
    }
    if (any) {
        for (const colors of heatmaps) blend(target, colors, only);
    }
}
