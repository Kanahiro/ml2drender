// Image encoding of rendered RGBA8 pixels.

import {zlibSync} from 'fflate';

export {encodeWebp} from './webp.ts';

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(b: Uint8Array): number {
    let c = 0xffffffff;
    for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function paeth(a: number, b: number, c: number): number {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** RGBA8 PNG of row-major RGBA8 pixels, e.g. the output of `Renderer.render`. Encoding is on the
 * request's CPU budget, so it favors speed over minimum file size (like the `png` crate's
 * `Compression::Fast`: adaptive filtering, fast deflate). */
export function encodePng(rgba: Uint8Array, width: number, height: number): Uint8Array {
    if (rgba.length !== width * height * 4) throw new Error(`${rgba.length} bytes is not ${width}x${height} RGBA`);
    const stride = width * 4;
    // Each row: a filter type byte, then the filtered row. Adaptive: the filter with the smallest
    // sum of absolute (signed) residuals.
    const raw = new Uint8Array((stride + 1) * height);
    const cand = Array.from({length: 5}, () => new Uint8Array(stride));
    const [c0, c1, c2, c3, c4] = cand;
    const sums = [0, 0, 0, 0, 0];
    // |v| as a signed byte.
    const mag = (v: number) => (v < 128 ? v : 256 - v);
    for (let y = 0; y < height; y++) {
        const r = y * stride;
        const p = r - stride;
        let s0 = 0;
        let s1 = 0;
        let s2 = 0;
        let s3 = 0;
        let s4 = 0;
        // All five filters in one pass.
        for (let i = 0; i < stride; i++) {
            const x = rgba[r + i];
            const a = i >= 4 ? rgba[r + i - 4] : 0;
            const b = y > 0 ? rgba[p + i] : 0;
            const c = y > 0 && i >= 4 ? rgba[p + i - 4] : 0;
            const v1 = (x - a) & 0xff;
            const v2 = (x - b) & 0xff;
            const v3 = (x - ((a + b) >> 1)) & 0xff;
            const v4 = (x - paeth(a, b, c)) & 0xff;
            c0[i] = x;
            c1[i] = v1;
            c2[i] = v2;
            c3[i] = v3;
            c4[i] = v4;
            s0 += mag(x);
            s1 += mag(v1);
            s2 += mag(v2);
            s3 += mag(v3);
            s4 += mag(v4);
        }
        sums[0] = s0;
        sums[1] = s1;
        sums[2] = s2;
        sums[3] = s3;
        sums[4] = s4;
        // The first filter with the smallest sum.
        let best = 0;
        for (let f = 1; f < 5; f++) if (sums[f] < sums[best]) best = f;
        raw[y * (stride + 1)] = best;
        raw.set(cand[best], y * (stride + 1) + 1);
    }
    const idat = zlibSync(raw, {level: 1});
    const chunks: [string, Uint8Array][] = [];
    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, width);
    dv.setUint32(4, height);
    ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA, deflate, adaptive filtering, no interlace
    chunks.push(['IHDR', ihdr], ['IDAT', idat], ['IEND', new Uint8Array(0)]);
    const size = 8 + chunks.reduce((n, [, d]) => n + 12 + d.length, 0);
    const png = new Uint8Array(size);
    const view = new DataView(png.buffer);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    let o = 8;
    for (const [type, data] of chunks) {
        view.setUint32(o, data.length);
        for (let i = 0; i < 4; i++) png[o + 4 + i] = type.charCodeAt(i);
        png.set(data, o + 8);
        view.setUint32(o + 8 + data.length, crc32(png.subarray(o + 4, o + 8 + data.length)));
        o += 12 + data.length;
    }
    return png;
}
