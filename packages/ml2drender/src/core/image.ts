// Image decoding and GL-like textures (premultiplied on upload, optional mipmaps,
// LINEAR / NEAREST filtering with clamp-to-edge).

import {decode as decodePngData} from 'fast-png';
import {decode as decodeJpegData} from 'jpeg-js';
import {decodeWebp} from './webp.ts';

/** Non-premultiplied RGBA8. */
export class Image {
    w: number;
    h: number;
    data: Uint8Array;

    constructor(w: number, h: number, data: Uint8Array) {
        this.w = w;
        this.h = h;
        this.data = data;
    }

    /** PNG, JPEG or WebP, by magic bytes. */
    static decode(bytes: Uint8Array): Image | undefined {
        const b = bytes;
        if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
            return decodePng(b);
        } else if (b.length >= 2 && b[0] === 0xff && b[1] === 0xd8) {
            return decodeJpeg(b);
        } else if (b.length > 12 && ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) {
            const img = decodeWebp(b);
            return img && new Image(img.width, img.height, img.data);
        }
        return undefined;
    }

    /** Copy a `w`×`h` region at `(x, y)` (out-of-range pixels are transparent). */
    subImage(x: number, y: number, w: number, h: number): Image {
        const data = new Uint8Array(w * h * 4);
        for (let row = 0; row < h; row++) {
            const sy = y + row;
            if (sy >= this.h) break;
            // Columns inside the source are a contiguous run.
            const n = Math.min(w, Math.max(this.w - x, 0));
            if (n > 0) {
                const s = (sy * this.w + x) * 4;
                data.set(this.data.subarray(s, s + n * 4), row * w * 4);
            }
        }
        return new Image(w, h, data);
    }

    /** `ImageAtlas` icon entry: the image with a 1px transparent border. */
    withPadding(): Image {
        const w = this.w + 2;
        const h = this.h + 2;
        const data = new Uint8Array(w * h * 4);
        for (let y = 0; y < this.h; y++) {
            data.set(this.data.subarray(y * this.w * 4, (y + 1) * this.w * 4), ((y + 1) * w + 1) * 4);
        }
        return new Image(w, h, data);
    }

    /** `ImageAtlas` pattern entry: the image with a 1px border of wrapped edge pixels
     * (corners stay transparent). */
    withWrappedPadding(): Image {
        const w = this.w + 2;
        const h = this.h + 2;
        const data = new Uint8Array(w * h * 4);
        const put = (dx: number, dy: number, sx: number, sy: number) => {
            const s = (sy * this.w + sx) * 4;
            data.set(this.data.subarray(s, s + 4), (dy * w + dx) * 4);
        };
        for (let y = 0; y < this.h; y++) {
            for (let x = 0; x < this.w; x++) put(x + 1, y + 1, x, y);
        }
        for (let x = 0; x < this.w; x++) {
            put(x + 1, 0, x, this.h - 1);
            put(x + 1, h - 1, x, 0);
        }
        for (let y = 0; y < this.h; y++) {
            put(0, y + 1, this.w - 1, y);
            put(w - 1, y + 1, 0, y);
        }
        return new Image(w, h, data);
    }
}

function ascii(b: Uint8Array, at: number, s: string): boolean {
    for (let i = 0; i < s.length; i++) if (b[at + i] !== s.charCodeAt(i)) return false;
    return true;
}

function decodeJpeg(bytes: Uint8Array): Image | undefined {
    try {
        const img = decodeJpegData(bytes, {useTArray: true, formatAsRGBA: true});
        return new Image(img.width, img.height, img.data);
    } catch {
        return undefined;
    }
}

/** The `png` crate's `EXPAND | STRIP_16` output, widened to RGBA8: palettes expanded (with
 * tRNS alpha; out-of-range indices are opaque black), gray below 8 bits scaled by
 * `255 / (2^depth - 1)`, tRNS turned into an alpha channel (compared at the file's bit depth;
 * below 16 bits against the low byte of each tRNS sample), 16-bit samples cut to their high byte. */
function decodePng(bytes: Uint8Array): Image | undefined {
    let png;
    try {
        png = decodePngData(bytes);
    } catch {
        return undefined;
    }
    const {width: w, height: h, depth, channels} = png;
    const data = png.data;
    const out = new Uint8Array(w * h * 4);
    const indexed = channels === 1 && png.palette !== undefined;
    if (depth < 8) {
        // Rows are bit-packed (only single-sample color types have these depths).
        const bpl = Math.ceil((depth * w) / 8);
        const mask = (1 << depth) - 1;
        const scale = (255 / mask) | 0;
        const palette = png.palette;
        const trns = png.transparency;
        if (!indexed && trns && trns.length < 1) return undefined;
        const key = trns ? trns[0] & 0xff : -1;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const bit = x * depth;
                const v = (data[y * bpl + (bit >> 3)] >> (8 - depth - (bit & 7))) & mask;
                const o = (y * w + x) * 4;
                if (indexed) {
                    paletteColor(palette!, v, out, o);
                } else {
                    const g = v * scale;
                    out[o] = out[o + 1] = out[o + 2] = g;
                    out[o + 3] = v === key ? 0 : 255;
                }
            }
        }
        return new Image(w, h, out);
    }
    const n = w * h;
    if (indexed) {
        for (let i = 0; i < n; i++) paletteColor(png.palette!, data[i], out, i * 4);
        return new Image(w, h, out);
    }
    const shift = depth === 16 ? 8 : 0;
    // tRNS only exists for gray and RGB: those get an alpha channel from it.
    const trns = png.transparency;
    let key: number[] | undefined;
    if (trns && (channels === 1 || channels === 3)) {
        if (trns.length < channels) return undefined;
        key = depth === 16
            // The whole tRNS chunk is compared with the pixel's samples.
            ? (trns.length === channels ? Array.from(trns) : undefined)
            : Array.from(trns.subarray(0, channels), (t) => t & 0xff);
    }
    const hasKey = trns !== undefined && (channels === 1 || channels === 3);
    for (let i = 0; i < n; i++) {
        const s = i * channels;
        const o = i * 4;
        let r: number, g: number, b: number, a: number;
        if (channels === 1 || channels === 2) {
            r = g = b = data[s] >> shift;
            a = channels === 2 ? data[s + 1] >> shift : 255;
        } else {
            r = data[s] >> shift;
            g = data[s + 1] >> shift;
            b = data[s + 2] >> shift;
            a = channels === 4 ? data[s + 3] >> shift : 255;
        }
        if (hasKey) {
            let eq = key !== undefined;
            for (let k = 0; eq && k < channels; k++) eq = data[s + k] === key![k];
            a = eq ? 0 : 255;
        }
        out[o] = r;
        out[o + 1] = g;
        out[o + 2] = b;
        out[o + 3] = a;
    }
    return new Image(w, h, out);
}

function paletteColor(palette: number[][], i: number, out: Uint8Array, o: number): void {
    const c = palette[i];
    if (c) {
        out[o] = c[0];
        out[o + 1] = c[1];
        out[o + 2] = c[2];
        out[o + 3] = c.length > 3 ? c[3] : 255;
    } else {
        out[o + 3] = 255;
    }
}

/** One mip level: premultiplied RGBA8. */
interface Level {
    w: number;
    h: number;
    px: Uint8Array;
}

export type Filter = 'Linear' | 'Nearest';

/** `px[(clamp(y) * w + clamp(x)) * 4]`, clamping like Rust's saturating `as i64` and `clamp`
 * (NaN → 0). */
function texelIndex(l: Level, x: number, y: number): number {
    const cx = x > l.w - 1 ? l.w - 1 : x >= 0 ? x : 0;
    const cy = y > l.h - 1 ? l.h - 1 : y >= 0 ? y : 0;
    return (cy * l.w + cx) * 4;
}

export class Texture {
    levels: Level[];

    /** `premultiplyAlpha` (rounded) on upload; `mipmaps` like `gl.generateMipmap` (box filter). */
    constructor(img: Image, mipmaps: boolean) {
        const src = img.data;
        const px = new Uint8Array(src.length);
        for (let o = 0; o < src.length; o += 4) {
            const a = src[o + 3];
            // round(c·a / 255) in integers: c·a / 255 is never a tie.
            px[o] = ((src[o] * a + 127) / 255) | 0;
            px[o + 1] = ((src[o + 1] * a + 127) / 255) | 0;
            px[o + 2] = ((src[o + 2] * a + 127) / 255) | 0;
            px[o + 3] = a;
        }
        const levels: Level[] = [{w: Math.max(img.w, 1), h: Math.max(img.h, 1), px}];
        for (;;) {
            const l = levels[levels.length - 1];
            if (!mipmaps || !(l.w > 1 || l.h > 1)) break;
            const w = Math.max(l.w >> 1, 1);
            const h = Math.max(l.h >> 1, 1);
            const out = new Uint8Array(w * h * 4);
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    const y0 = Math.min(y * 2, l.h - 1) * l.w;
                    const y1 = Math.min(y * 2 + 1, l.h - 1) * l.w;
                    const x0 = Math.min(x * 2, l.w - 1);
                    const x1 = Math.min(x * 2 + 1, l.w - 1);
                    const s = [(y0 + x0) * 4, (y0 + x1) * 4, (y1 + x0) * 4, (y1 + x1) * 4];
                    for (let k = 0; k < 4; k++) {
                        out[(y * w + x) * 4 + k] = (l.px[s[0] + k] + l.px[s[1] + k] + l.px[s[2] + k] + l.px[s[3] + k] + 2) >> 2;
                    }
                }
            }
            levels.push({w, h, px: out});
        }
        this.levels = levels;
    }

    size(): [number, number] {
        return [this.levels[0].w, this.levels[0].h];
    }

    /** Sample at normalized `(u, v)`. `lambda` is log2 of texels per pixel: `> 0` minifies with
     * `min` (and picks the nearest mip level, `*_MIPMAP_NEAREST`), otherwise `mag` applies. */
    sample(u: number, v: number, mag: Filter, min: Filter, lambda: number): [number, number, number, number] {
        const n = this.levels.length;
        let level = 0;
        if (!(lambda <= 0.5 || n === 1)) {
            const c = Math.ceil(lambda + 0.5);
            // NaN: Rust's `0usize - 1` wraps, then `min` picks the last level.
            level = c !== c ? n - 1 : Math.min(c - 1, n - 1);
        }
        const filter = lambda > 0 ? min : mag;
        const l = this.levels[level];
        const p = l.px;
        const tx = u * l.w;
        const ty = v * l.h;
        if (filter === 'Nearest') {
            const i = texelIndex(l, Math.floor(tx), Math.floor(ty));
            return [p[i] / 255, p[i + 1] / 255, p[i + 2] / 255, p[i + 3] / 255];
        }
        const x = tx - 0.5;
        const y = ty - 0.5;
        const x0 = Math.floor(x);
        const y0 = Math.floor(y);
        const fx = x - x0;
        const fy = y - y0;
        const a = texelIndex(l, x0, y0);
        const b = texelIndex(l, x0 + 1, y0);
        const c = texelIndex(l, x0, y0 + 1);
        const d = texelIndex(l, x0 + 1, y0 + 1);
        const gx = 1 - fx;
        const gy = 1 - fy;
        const out: [number, number, number, number] = [0, 0, 0, 0];
        for (let k = 0; k < 4; k++) {
            out[k] = ((p[a + k] / 255) * gx + (p[b + k] / 255) * fx) * gy + ((p[c + k] / 255) * gx + (p[d + k] / 255) * fx) * fy;
        }
        return out;
    }
}
