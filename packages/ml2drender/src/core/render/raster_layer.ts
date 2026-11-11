// Raster layers (raster tiles and image sources): MapLibre's `raster` shaders.

import type {Filter, Texture} from '../image.ts';
import type {Layer} from '../style.ts';
import type {RenderTile} from '../tile.ts';
import * as raster from './raster.ts';
import type {Mask, Rgba, Target} from './raster.ts';
import {type Ctx, EXTENT, dummyTile, num} from './mod.ts';

type P = [number, number];

const toRadians = (deg: number) => deg * (Math.PI / 180);

/** Raster paint uniforms (`rasterUniformValues`). */
export class RasterParams {
    private opacity: number;
    private brightnessLow: number;
    private brightnessHigh: number;
    private saturation: number;
    private contrast: number;
    private spin: [number, number, number];
    mag: Filter;

    constructor(layer: Layer, ctx: Ctx) {
        const t = dummyTile();
        const p = (n: string) => ctx.paint(layer, n, undefined, t);
        const hue = toRadians(num(p('raster-hue-rotate')));
        const s = Math.sin(hue);
        const c = Math.cos(hue);
        const sat = num(p('raster-saturation'));
        const con = num(p('raster-contrast'));
        const nearest = p('resampling') === 'nearest' || p('raster-resampling') === 'nearest';
        this.opacity = num(p('raster-opacity'));
        this.brightnessLow = num(p('raster-brightness-min'));
        this.brightnessHigh = num(p('raster-brightness-max'));
        this.saturation = sat > 0 ? 1 - 1 / (1.001 - sat) : -sat;
        this.contrast = con > 0 ? 1 / (1 - con) : 1 + con;
        this.spin = [(2 * c + 1) / 3, (-Math.sqrt(3) * s - c + 1) / 3, (Math.sqrt(3) * s - c + 1) / 3];
        this.mag = nearest ? 'Nearest' : 'Linear';
    }

    /** Fragment shader on a premultiplied texel. */
    shade(texel: ArrayLike<number>): Rgba {
        const a = texel[3];
        let c = [texel[0], texel[1], texel[2]];
        if (a > 0) c = c.map((v) => v / a);
        const alpha = a * this.opacity;
        const w = this.spin;
        const rgb = [
            c[0] * w[0] + c[1] * w[1] + c[2] * w[2],
            c[0] * w[2] + c[1] * w[0] + c[2] * w[1],
            c[0] * w[1] + c[1] * w[2] + c[2] * w[0],
        ];
        const average = (c[0] + c[1] + c[2]) / 3;
        const out = rgb.map((v) => {
            v = v + (average - v) * this.saturation;
            v = (v - 0.5) * this.contrast + 0.5;
            return (this.brightnessLow + (this.brightnessHigh - this.brightnessLow) * v) * alpha;
        });
        return [out[0], out[1], out[2], alpha];
    }
}

/** A textured quad in tile units of `tile`: corners top-left, top-right, bottom-right,
 * bottom-left, and the image warp (`[perspective x, perspective y, bilinear blend]`). */
export class Quad {
    tile: RenderTile;
    corners: [P, P, P, P];
    warp: [number, number, number];
    subdivided: boolean;

    constructor(tile: RenderTile, corners: [P, P, P, P], warp: [number, number, number], subdivided: boolean) {
        this.tile = tile;
        this.corners = corners;
        this.warp = warp;
        this.subdivided = subdivided;
    }

    static tile(tile: RenderTile): Quad {
        return new Quad(tile, [[0, 0], [EXTENT, 0], [EXTENT, EXTENT], [0, EXTENT]], [0, 0, 1], false);
    }
}

export function drawQuad(target: Target, ctx: Ctx, q: Quad, tex: Texture, params: RasterParams, mask: Mask | undefined): void {
    const toWorld = ctx.tileToWorld(q.tile);
    const off = ctx.transform.alignedOffset();
    const [tl, tr, br, bl] = q.corners;
    const w = q.warp;
    const lerp = (a: P, b: P, t: number): P => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    // Vertex shader for a mesh vertex at fractional tile position `f`.
    const vertex = (f: P): [P, number[]] => {
        const bilinear = lerp(lerp(tl, tr, f[0]), lerp(bl, br, f[0]), f[1]);
        const den = w[0] * f[0] + w[1] * f[1] + 1;
        const across = [tr[0] - tl[0] + w[0] * tr[0], tr[1] - tl[1] + w[0] * tr[1]];
        const down = [bl[0] - tl[0] + w[1] * bl[0], bl[1] - tl[1] + w[1] * bl[1]];
        const projective: P = [(across[0] * f[0] + down[0] * f[1] + tl[0]) / den, (across[1] * f[0] + down[1] * f[1] + tl[1]) / den];
        const pos = lerp(projective, bilinear, w[2]);
        const wp = toWorld(pos);
        const s = ctx.transform.worldToScreen([wp[0] + off[0], wp[1] + off[1]]);
        const ratio = 1 / den + (1 - 1 / den) * w[2];
        return [s, [f[0] * ratio, f[1] * ratio, ratio]];
    };
    const g = q.subdivided ? 16 : 1;
    const verts: [P, number[]][] = [];
    for (let y = 0; y <= g; y++) {
        for (let x = 0; x <= g; x++) verts.push(vertex([x / g, y / g]));
    }
    const [tw, th] = tex.size();
    let lambda = 0;
    const shade = (t: ArrayLike<number>) => params.shade(tex.sample(t[0] / t[2], t[1] / t[2], params.mag, 'Linear', lambda));
    for (let y = 0; y < g; y++) {
        for (let x = 0; x < g; x++) {
            const v0 = y * (g + 1) + x;
            const [v1, v2, v3] = [v0 + 1, v0 + g + 1, v0 + g + 2];
            for (const tri of [[v1, v0, v2], [v1, v2, v3]]) {
                const p: [P, P, P] = [verts[tri[0]][0], verts[tri[1]][0], verts[tri[2]][0]];
                const v: [number[], number[], number[]] = [verts[tri[0]][1], verts[tri[1]][1], verts[tri[2]][1]];
                lambda = mipLambda(p, v, tw, th);
                raster.triangle(target, mask, p, v, shade);
            }
        }
    }
}

/** log2 of texels per screen pixel for an (affine) triangle. */
function mipLambda(p: [P, P, P], v: number[][], tw: number, th: number): number {
    const t = v.map((v) => [v[0] / v[2] * tw, v[1] / v[2] * th]);
    const e1 = [p[1][0] - p[0][0], p[1][1] - p[0][1]];
    const e2 = [p[2][0] - p[0][0], p[2][1] - p[0][1]];
    const t1 = [t[1][0] - t[0][0], t[1][1] - t[0][1]];
    const t2 = [t[2][0] - t[0][0], t[2][1] - t[0][1]];
    const det = e1[0] * e2[1] - e1[1] * e2[0];
    if (det === 0) return 0;
    // d(tex)/d(screen x) and d(tex)/d(screen y).
    const dx = [(t1[0] * e2[1] - t2[0] * e1[1]) / det, (t1[1] * e2[1] - t2[1] * e1[1]) / det];
    const dy = [(t2[0] * e1[0] - t1[0] * e2[0]) / det, (t2[1] * e1[0] - t1[1] * e2[0]) / det];
    const a = Math.hypot(dx[0], dx[1]);
    const b = Math.hypot(dy[0], dy[1]);
    // Rust `f64::max` ignores a NaN operand.
    const rho = a !== a ? b : b !== b ? a : Math.max(a, b);
    return Math.log2(rho);
}
