// WebP decoding and lossless encoding: port of the `image-webp` 0.2.4 crate (`decoder.rs`, `extended.rs`,
// `alpha_blending.rs`; the codecs live in `webp/`). Decoding returns what the Rust renderer got from
// `WebPDecoder::read_image` (the first frame of an animation), as RGBA.

import {BitReader, decodeLossless} from './webp/lossless.ts';
import {decodeVp8, fillRgbFancy} from './webp/vp8.ts';

export {encodeWebp} from './webp/encoder.ts';

const fail = (msg: string): never => {
    throw new Error(`webp: ${msg}`);
};

export interface DecodedWebp {
    width: number;
    height: number;
    /** Non-premultiplied RGBA8, row-major. */
    data: Uint8Array;
}

/** Decodes a WebP (lossy, lossless, alpha, extended; the first frame of an animation). `undefined` on any error. */
export function decodeWebp(bytes: Uint8Array): DecodedWebp | undefined {
    try {
        return decode(bytes);
    } catch {
        return undefined;
    }
}

type Range = [start: number, end: number];

interface ExtendedInfo {
    alpha: boolean;
    exifMetadata: boolean;
    xmpMetadata: boolean;
    animation: boolean;
}

const fourcc = (b: Uint8Array, p: number): string => String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
const KNOWN_CHUNKS = new Set(['RIFF', 'WEBP', 'VP8 ', 'VP8L', 'VP8X', 'ANIM', 'ANMF', 'ALPH', 'ICCP', 'EXIF', 'XMP ']);

/** A `Cursor` over the file: reads past the end fail, seeks past it don't. */
class Reader {
    b: Uint8Array;
    pos = 0;

    constructor(b: Uint8Array) {
        this.b = b;
    }

    has(n: number): boolean {
        return this.pos + n <= this.b.length;
    }

    take(n: number): number {
        if (!this.has(n)) fail('unexpected end of file');
        const p = this.pos;
        this.pos += n;
        return p;
    }

    u8(): number {
        return this.b[this.take(1)];
    }

    u16(): number {
        const p = this.take(2);
        return this.b[p] | (this.b[p + 1] << 8);
    }

    u24(): number {
        const p = this.take(3);
        return this.b[p] | (this.b[p + 1] << 8) | (this.b[p + 2] << 16);
    }

    u32(): number {
        const p = this.take(4);
        return (this.b[p] | (this.b[p + 1] << 8) | (this.b[p + 2] << 16) | (this.b[p + 3] << 24)) >>> 0;
    }

    /** `[fourcc, size, size rounded up to even (saturating)]` */
    chunkHeader(): [string, number, number] {
        const name = fourcc(this.b, this.take(4));
        const size = this.u32();
        return [name, size, Math.min(size + (size & 1), 0xffffffff)];
    }
}

function decode(bytes: Uint8Array): DecodedWebp {
    const r = new Reader(bytes);
    const chunks = new Map<string, Range>();
    let width = 0;
    let height = 0;
    let hasAlpha = false;
    let info: ExtendedInfo | undefined;

    const [riff, riffSize] = r.chunkHeader();
    if (riff !== 'RIFF') fail('invalid RIFF signature');
    if (fourcc(bytes, r.take(4)) !== 'WEBP') fail('invalid WebP signature');

    const [chunk, chunkSize, chunkSizeRounded] = r.chunkHeader();
    const start = r.pos;

    if (chunk === 'VP8 ') {
        const tag = r.u24();
        if ((tag & 1) !== 0) fail('non-keyframe frames are not supported');
        const p = r.take(3);
        if (bytes[p] !== 0x9d || bytes[p + 1] !== 0x01 || bytes[p + 2] !== 0x2a) fail('invalid VP8 magic');
        width = r.u16() & 0x3fff;
        height = r.u16() & 0x3fff;
        if (width === 0 || height === 0) fail('inconsistent image sizes');
        chunks.set('VP8 ', [start, start + chunkSize]);
    } else if (chunk === 'VP8L') {
        if (r.u8() !== 0x2f) fail('invalid lossless signature');
        const header = r.u32();
        if (header >>> 29 !== 0) fail('invalid lossless version number');
        width = (1 + header) & 0x3fff;
        height = (1 + (header >>> 14)) & 0x3fff;
        chunks.set('VP8L', [start, start + chunkSize]);
        hasAlpha = ((header >>> 28) & 1) !== 0;
    } else if (chunk === 'VP8X') {
        const flags = r.u8();
        info = {
            alpha: (flags & 0b00010000) !== 0,
            exifMetadata: (flags & 0b00001000) !== 0,
            xmpMetadata: (flags & 0b00000100) !== 0,
            animation: (flags & 0b00000010) !== 0,
        };
        r.u24(); // reserved
        width = r.u24() + 1;
        height = r.u24() + 1;
        // product of canvas dimensions cannot be larger than u32 max
        if (width * height > 0xffffffff) fail('image too large');

        let isLossy = false;
        let position = start + chunkSizeRounded;
        const maxPosition = position + Math.max(riffSize - 12, 0);
        while (position < maxPosition) {
            r.pos = position;
            if (!r.has(8)) break; // end of file
            const [name, size, rounded] = r.chunkHeader();
            const range: Range = [position + 8, position + 8 + size];
            position += 8 + rounded;
            if (KNOWN_CHUNKS.has(name) && !chunks.has(name)) chunks.set(name, range);

            if (name === 'ANMF') {
                if (size < 24) fail('invalid chunk size');
                r.pos += 12;
                r.u32(); // duration and flags
                // If the image is animated, the image data chunk will be inside the ANMF chunks; VP8 and
                // ALPH chunks indicate lossy data.
                if (!isLossy) {
                    const [sub] = r.chunkHeader();
                    if (sub === 'VP8 ' || sub === 'ALPH') isLossy = true;
                }
            }
        }

        // We allow malformed images that have the ICC flag set without an ICCP chunk, because this is
        // relatively common.
        if (
            (info.animation && (!chunks.has('ANIM') || !chunks.has('ANMF'))) ||
            (info.exifMetadata && !chunks.has('EXIF')) ||
            (info.xmpMetadata && !chunks.has('XMP ')) ||
            (!info.animation && chunks.has('VP8 ') === chunks.has('VP8L'))
        ) {
            fail('an expected chunk was missing');
        }

        // Decode ANIM chunk (background color and loop count, unused here).
        if (info.animation) {
            const [s, e] = chunks.get('ANIM')!;
            if (e - s > 6) fail('invalid chunk size');
            r.pos = s;
            r.take(e - s);
            if (e - s < 6) fail('unexpected end of file');
        }

        // If the image is animated, the image data chunk will be inside the ANMF chunks. We store the
        // ALPH, VP8, and VP8L chunks (as applicable) of the first frame so that we can read them later.
        // (The crate reads the second header right after the first one, i.e. from the first subchunk's
        // payload, but records it at the position past that subchunk.)
        const anmf = chunks.get('ANMF');
        if (anmf) {
            let p = anmf[0] + 16;
            r.pos = p;
            for (let i = 0; i < 2; i++) {
                const [sub, size, rounded] = r.chunkHeader();
                if (!chunks.has(sub)) chunks.set(sub, [p + 8, p + 8 + size]);
                p += 8 + rounded;
                if (p + 8 > anmf[1]) break;
            }
        }

        hasAlpha = info.alpha;
    } else {
        fail('invalid chunk header');
    }

    const data = new Uint8Array(width * height * 4);

    if (info?.animation) {
        readFirstFrame(bytes, chunks.get('ANMF')![0] - 8, width, height, data);
    } else if (chunks.has('VP8L')) {
        const [s, e] = chunks.get('VP8L')!;
        decodeLossless(new BitReader(bytes, s, e), width, height, false, data);
    } else {
        const range = chunks.get('VP8 ') ?? fail('an expected chunk was missing');
        const frame = decodeVp8(bytes, range[0], range[1]);
        if (frame.width !== width || frame.height !== height) fail('inconsistent image sizes');
        fillRgbFancy(frame, data, 4);
        if (hasAlpha) {
            const [s, e] = chunks.get('ALPH') ?? fail('an expected chunk was missing');
            applyAlpha(data, readAlphaChunk(bytes, s, e, width, height), frame.width, frame.height);
        }
    }

    if (!hasAlpha) for (let i = 3; i < data.length; i += 4) data[i] = 255;
    return {width, height, data};
}

/**
 * Decodes the first ANMF frame (header at `pos`) and composites it onto a transparent canvas, as
 * `WebPDecoder::read_frame` does for a freshly reset animation (no background color, nothing to dispose).
 */
function readFirstFrame(bytes: Uint8Array, pos: number, canvasWidth: number, canvasHeight: number, canvas: Uint8Array): void {
    const r = new Reader(bytes);
    r.pos = pos;
    const [name, anmfSize] = r.chunkHeader();
    if (name !== 'ANMF' || anmfSize < 32) fail('invalid ANMF chunk');

    const frameX = r.u24() * 2;
    const frameY = r.u24() * 2;
    const frameWidth = r.u24() + 1;
    const frameHeight = r.u24() + 1;
    if (frameWidth > 16384 || frameHeight > 16384) fail('image too large');
    if (frameX + frameWidth > canvasWidth || frameY + frameHeight > canvasHeight) fail('frame outside image');
    r.u24(); // duration
    const frameInfo = r.u8();
    const useAlphaBlending = (frameInfo & 0b10) === 0;

    // Read normal bitstream now
    const [chunk, chunkSize, chunkSizeRounded] = r.chunkHeader();
    if (chunkSizeRounded + 24 > anmfSize) fail('invalid chunk header');

    let frame: Uint8Array;
    let frameHasAlpha: boolean;
    if (chunk === 'VP8 ') {
        const raw = decodeVp8(bytes, r.pos, r.pos + chunkSize);
        if (raw.width !== frameWidth || raw.height !== frameHeight) fail('inconsistent image sizes');
        frame = new Uint8Array(frameWidth * frameHeight * 3);
        fillRgbFancy(raw, frame, 3);
        frameHasAlpha = false;
    } else if (chunk === 'VP8L') {
        frame = new Uint8Array(frameWidth * frameHeight * 4);
        decodeLossless(new BitReader(bytes, r.pos, r.pos + chunkSize), frameWidth, frameHeight, false, frame);
        frameHasAlpha = true;
    } else if (chunk === 'ALPH') {
        if (chunkSizeRounded + 32 > anmfSize) fail('invalid chunk header');
        const nextChunkStart = r.pos + chunkSizeRounded;
        const alpha = readAlphaChunk(bytes, r.pos, r.pos + chunkSize, frameWidth, frameHeight);

        r.pos = nextChunkStart;
        const [, nextChunkSize] = r.chunkHeader();
        if (chunkSize + nextChunkSize + 32 > anmfSize) fail('invalid chunk header');
        const raw = decodeVp8(bytes, r.pos, r.pos + nextChunkSize);
        frame = new Uint8Array(frameWidth * frameHeight * 4);
        fillRgbFancy(raw, frame, 4);
        applyAlpha(frame, alpha, raw.width, raw.height);
        frameHasAlpha = true;
    } else {
        return fail('invalid chunk header');
    }

    compositeFrame(canvas, canvasWidth, canvasHeight, frame, frameX, frameY, frameWidth, frameHeight, frameHasAlpha, useAlphaBlending);
}

interface AlphaChunk {
    filteringMethod: number; // 0 none, 1 horizontal, 2 vertical, 3 gradient
    data: Uint8Array;
}

function readAlphaChunk(bytes: Uint8Array, start: number, end: number, width: number, height: number): AlphaChunk {
    end = Math.min(end, bytes.length);
    if (start >= end) fail('unexpected end of file');
    const infoByte = bytes[start];
    // the preprocessing flag (level reduction) needs no decoder action
    if (((infoByte & 0b00110000) >> 4) > 1) fail('invalid alpha preprocessing');
    const filteringMethod = (infoByte & 0b00001100) >> 2;
    const compression = infoByte & 0b00000011;
    if (compression > 1) fail('invalid compression method');

    const w = width & 0xffff, h = height & 0xffff;
    let data: Uint8Array;
    if (compression === 1) {
        const rgba = new Uint8Array(w * h * 4);
        decodeLossless(new BitReader(bytes, start + 1, end), w, h, true, rgba);
        data = new Uint8Array(w * h);
        for (let i = 0; i < data.length; i++) data[i] = rgba[i * 4 + 1];
    } else {
        if (start + 1 + w * h > end) fail('unexpected end of file');
        data = bytes.slice(start + 1, start + 1 + w * h);
    }
    return {filteringMethod, data};
}

/** Undoes the alpha filtering into the alpha bytes of `buf` (RGBA, `width` pixels per row). */
function applyAlpha(buf: Uint8Array, alpha: AlphaChunk, width: number, height: number): void {
    const a = (x: number, y: number): number => buf[(y * width + x) * 4 + 3];
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let predictor = 0;
            switch (alpha.filteringMethod) {
                case 1: // horizontal
                    predictor = x === 0 && y === 0 ? 0 : x === 0 ? a(0, y - 1) : a(x - 1, y);
                    break;
                case 2: // vertical
                    predictor = x === 0 && y === 0 ? 0 : y === 0 ? a(x - 1, 0) : a(x, y - 1);
                    break;
                case 3: {
                    // gradient
                    let left: number, top: number, topLeft: number;
                    if (x === 0 && y === 0) left = top = topLeft = 0;
                    else if (x === 0) left = top = topLeft = a(0, y - 1);
                    else if (y === 0) left = top = topLeft = a(x - 1, 0);
                    else [left, top, topLeft] = [a(x - 1, y), a(x, y - 1), a(x - 1, y - 1)];
                    predictor = Math.max(0, Math.min(255, left + top - topLeft));
                    break;
                }
            }
            const i = y * width + x;
            buf[i * 4 + 3] = predictor + alpha.data[i];
        }
    }
}

/**
 * Copies or blends a frame onto the canvas. (The crate first clears the previous frame's rectangle to
 * the background color, which only applies when one was set and so never for the first frame.)
 */
function compositeFrame(
    canvas: Uint8Array, canvasWidth: number, canvasHeight: number, frame: Uint8Array, offsetX: number, offsetY: number,
    frameWidth: number, frameHeight: number, frameHasAlpha: boolean, useAlphaBlending: boolean,
): void {
    const bpp = frameHasAlpha ? 4 : 3;
    const width = Math.min(frameWidth, Math.max(canvasWidth - offsetX, 0));
    const height = Math.min(frameHeight, Math.max(canvasHeight - offsetY, 0));
    const blend = frameHasAlpha && useAlphaBlending;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const f = (y * frameWidth + x) * bpp;
            const c = ((y + offsetY) * canvasWidth + x + offsetX) * 4;
            if (blend) {
                blendPixel(frame, f, canvas, c);
            } else {
                canvas[c] = frame[f];
                canvas[c + 1] = frame[f + 1];
                canvas[c + 2] = frame[f + 2];
                canvas[c + 3] = frameHasAlpha ? frame[f + 3] : 255;
            }
        }
    }
}

/** Divides by 255, rounding to nearest. */
const divBy255 = (v: number): number => (((v + 0x80) >> 8) + v + 0x80) >> 8;

/**
 * Blends a non-premultiplied `src` pixel over `dst` (libwebp's anim_decode.c, with a more precise
 * `dst_factor_a`): integer arithmetic, so not exact.
 */
function blendPixel(src: Uint8Array, s: number, dst: Uint8Array, d: number): void {
    const srcA = src[s + 3];
    if (srcA === 0) return;
    const dstFactorA = divBy255(dst[d + 3] * (255 - srcA));
    const blendA = srcA + dstFactorA;
    const scale = Math.floor((1 << 24) / blendA);
    for (let k = 0; k < 3; k++) dst[d + k] = ((src[s + k] * srcA + dst[d + k] * dstFactorA) * scale) >>> 24;
    dst[d + 3] = blendA;
}
