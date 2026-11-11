// Image patterns (`*-pattern`): MapLibre's `get_pattern_pos` and pattern texture lookups.

import {ResolvedImage} from '@maplibre/maplibre-gl-style-spec';
import {EXTENT} from './mod.ts';
import type {Ctx} from './mod.ts';
import type {StyleImage} from '../sprite.ts';
import type {RenderTile} from '../tile.ts';

/** GLSL `mod`. */
function gmod(x: number, y: number): number {
    return x - y * Math.floor(x / y);
}

/** `f64::rem_euclid`. */
function remEuclid(x: number, y: number): number {
    const r = x % y;
    return r < 0 ? r + Math.abs(y) : r;
}

/** Name of the image a pattern property evaluated to. */
export function imageName(v: unknown): string | undefined {
    if (v instanceof ResolvedImage) return v.name;
    if (typeof v === 'string' && v !== '') return v;
    return undefined;
}

/** Per-tile pattern uniforms (`patternUniformValues`). */
export class TilePattern {
    /** Pixels per tile unit at the integer tile zoom (`u_scale.x` / `u_tile_units_to_pixels`). */
    tileRatio: number;
    pixelUpper: [number, number];
    pixelLower: [number, number];
    /** In a projected output: the output's pixel origin (`Transform.pixelOrigin`) and device
     * pixels per pattern pixel. Patterns are laid out on the output's pixels there, one pattern
     * pixel per CSS pixel (a Mercator map's scale at an integer zoom), instead of following the
     * projected tiles. Not scaled by the view's zoom: that differs between neighboring tiles of a
     * projected map (it follows the Mercator scale at each tile's center), and so would the pattern. */
    screen: [[number, number], number] | undefined;

    constructor(ctx: Ctx, tile: RenderTile) {
        const tileZoom = Math.max(Math.floor(ctx.transform.zoom), 0);
        const sizeAtNearest = 512 * Math.pow(2, tileZoom - tile.canonical.z);
        const numTiles = Math.pow(2, tile.overscaledZ);
        const px = sizeAtNearest * (tile.canonical.x + tile.wrap * numTiles);
        const py = sizeAtNearest * tile.canonical.y;
        // Split like the shader uniforms: `x >> 16` and `x & 0xFFFF` on int32 (`v as i64 as i32`
        // wraps, as `| 0` does).
        const i = px | 0;
        const j = py | 0;
        this.tileRatio = sizeAtNearest / EXTENT;
        this.pixelUpper = [i >> 16, j >> 16];
        this.pixelLower = [i & 0xffff, j & 0xffff];
        const o = ctx.transform.pixelOrigin();
        this.screen = o ? [o, ctx.transform.pixelRatio] : undefined;
    }

    /** The pattern position of a vertex at tile position `pos`, drawn at output pixel `screen`. */
    pos(size: ArrayLike<number>, pos: ArrayLike<number>, screen: ArrayLike<number>): [number, number] {
        if (!this.screen) return this.patternPos(size, pos);
        const [origin, k] = this.screen;
        // The origin reduced to one repeat keeps the varying small (f32).
        return [
            (screen[0] / k + remEuclid(origin[0] / k, size[0])) / size[0],
            (screen[1] / k + remEuclid(origin[1] / k, size[1])) / size[1],
        ];
    }

    /** `get_pattern_pos` for a vertex at tile position `pos` and pattern display size `size`. */
    patternPos(size: ArrayLike<number>, pos: ArrayLike<number>): [number, number] {
        const out: [number, number] = [0, 0];
        for (let i = 0; i < 2; i++) {
            const offset = gmod(gmod(gmod(this.pixelUpper[i], size[i]) * 256, size[i]) * 256 + this.pixelLower[i], size[i]);
            out[i] = (this.tileRatio * pos[i] + offset) / size[i];
        }
        return out;
    }
}

export function displaySize(img: StyleImage): [number, number] {
    return [img.image.w / img.pixelRatio, img.image.h / img.pixelRatio];
}

/** `texture(u_image, mix(tl / texsize, br / texsize, mod(v_pos, 1)))` on the padded image. */
export function sampleFill(img: StyleImage, vPos: ArrayLike<number>): number[] {
    const [pw, ph] = img.pattern.size();
    const u = (1 + gmod(vPos[0], 1) * img.image.w) / pw;
    const v = (1 + gmod(vPos[1], 1) * img.image.h) / ph;
    return img.pattern.sample(u, v, 'Linear', 'Linear', 0);
}

/** The line pattern lookup spans the padding: normalized `(x, y)` over the padded image. */
export function sampleLine(img: StyleImage, x: number, y: number): number[] {
    return img.pattern.sample(x, y, 'Linear', 'Linear', 0);
}
