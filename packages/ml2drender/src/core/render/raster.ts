// A tiny software stand-in for the GL pipeline MapLibre uses: aliased triangle and
// line rasterization at pixel centers, linear varyings, and premultiplied "over"
// blending into an 8-bit framebuffer. Anti-aliasing comes from the emulated shaders,
// exactly as in MapLibre (which renders without MSAA).

/** Premultiplied color in 0..1. */
export type Rgba = number[];

/** Premultiplied RGBA8 framebuffer, row-major, top row first. */
export class Target {
    w: number;
    h: number;
    /** Pixel `i` is `px[4 * i .. 4 * i + 4]`. */
    px: Uint8Array;
    /** When non-empty, pixels written by MapLibre's opaque pass (opaque backgrounds and fill
     * interiors), which depth-test-free layers drawn later (heatmaps) end up on top of. */
    opaque: Uint8Array = new Uint8Array(0);
    /** When non-empty, the topmost opaque-pass layer (`layer` value, 0 = none) of each pixel,
     * standing in for the depth buffer: layers below it skip the pixel, which it overwrites. */
    occ: Uint16Array = new Uint16Array(0);
    /** The layer being drawn: its style index + 1. */
    layer = 0;
    /** Whether `occ` can hide anything from the layers being drawn. */
    cull = false;

    constructor(w: number, h: number) {
        this.w = w;
        this.h = h;
        this.px = new Uint8Array(w * h * 4);
    }

    /** `gl.blendFunc(ONE, ONE_MINUS_SRC_ALPHA)` into a unorm8 target.
     * Callers check `visible` first (heatmaps, which don't, disable culling). */
    blend(i: number, c: ArrayLike<number>): void {
        const d = this.px;
        const o = i * 4;
        // `f32::clamp` keeps NaN, which ends up as 0 like Rust's saturating `as u8`.
        const a = c[3];
        const inv = 1 - (a < 0 ? 0 : a > 1 ? 1 : a);
        // Non-negative (or NaN), where `Math.round` rounds halves away from zero like `f32::round`;
        // NaN → 0 on store.
        const c0 = c[0];
        const r0 = Math.round(((c0 < 0 ? 0 : c0 > 1 ? 1 : c0) + (d[o] / 255) * inv) * 255);
        d[o] = r0 > 255 ? 255 : r0;
        const c1 = c[1];
        const r1 = Math.round(((c1 < 0 ? 0 : c1 > 1 ? 1 : c1) + (d[o + 1] / 255) * inv) * 255);
        d[o + 1] = r1 > 255 ? 255 : r1;
        const c2 = c[2];
        const r2 = Math.round(((c2 < 0 ? 0 : c2 > 1 ? 1 : c2) + (d[o + 2] / 255) * inv) * 255);
        d[o + 2] = r2 > 255 ? 255 : r2;
        const r3 = Math.round(((a < 0 ? 0 : a > 1 ? 1 : a) + (d[o + 3] / 255) * inv) * 255);
        d[o + 3] = r3 > 255 ? 255 : r3;
    }

    /** Whether pixel `i` survives the opaque layers above the current one. */
    visible(i: number): boolean {
        return !this.cull || this.occ[i] <= this.layer;
    }

    /** Opaque pass: draw `c` (alpha 1, so it replaces whatever is below) and record the
     * current layer as the pixel's occluder, unless a layer above already covers it. */
    cover(i: number, c: ArrayLike<number>): void {
        if (this.visible(i)) {
            this.blend(i, c);
            if (i < this.occ.length) this.occ[i] = this.layer;
            this.markOpaque(i);
        }
    }

    /** `cover` for many pixels of one opaque color: `blend` with alpha 1 ignores what is below,
     * so the bytes are computed once. */
    coverer(c: ArrayLike<number>): Coverer {
        const one = new Target(1, 1);
        one.blend(0, c);
        const [r, g, b, a] = one.px;
        const {px, occ, opaque, layer, cull} = this;
        // `cover` of pixels `i0..i1`.
        const run = (i0: number, i1: number) => {
            for (let i = i0; i < i1; i++) {
                if (cull && !(occ[i] <= layer)) continue;
                const o = i * 4;
                px[o] = r;
                px[o + 1] = g;
                px[o + 2] = b;
                px[o + 3] = a;
                if (i < occ.length) occ[i] = layer;
                if (i < opaque.length) opaque[i] = 1;
            }
        };
        const one_ = (i: number) => run(i, i + 1);
        return Object.assign(one_, {run});
    }

    markOpaque(i: number): void {
        if (i < this.opaque.length) this.opaque[i] = 1;
    }

    /** Non-premultiplied RGBA like the render-test harness produces from `readPixels`:
     * each channel divided by alpha and truncated into a `Uint8Array`. Converts `px` in place. */
    intoUnpremultiplied(): Uint8Array {
        const p = this.px;
        for (let o = 0; o < p.length; o += 4) {
            const a8 = p[o + 3];
            // Opaque pixels are unchanged (`v / 1`).
            if (a8 === 0 || a8 === 255) continue;
            const a = a8 / 255;
            for (let k = 0; k < 3; k++) p[o + k] = Math.trunc(p[o + k] / a) & 0xff;
        }
        return p;
    }
}

/** `Target.cover` with one opaque color for a pixel, or (`run`) for pixels `i0..i1`. */
export type Coverer = ((i: number) => void) & {run: (i0: number, i1: number) => void};

/** `f32::round` (half away from zero). */
export function round(x: number): number {
    const t = Math.trunc(x);
    // `x - t` is exact.
    return Math.abs(x - t) >= 0.5 ? t + (x < 0 ? -1 : 1) : t;
}

type Coverage =
    | {kind: 'Rectangle'; x: [number, number]; y: [number, number]}
    | {kind: 'Pixels'; bits: Uint8Array}
    /** The pixels whose entry in a row-major map shared by disjoint masks is this one's index. */
    | {kind: 'Owner'; owners: Uint32Array; i: number};

/** Pixel coverage mask (like the stencil clip of a tile). */
export class Mask {
    w: number;
    h: number;
    coverage: Coverage;

    constructor(w: number, h: number, coverage: Coverage) {
        this.w = w;
        this.h = h;
        this.coverage = coverage;
    }

    static empty(): Mask {
        return new Mask(0, 0, {kind: 'Rectangle', x: [0, 0], y: [0, 0]});
    }

    /** Disjoint masks from the index of each pixel's mask (row-major; `0xFFFFFFFF` for none). */
    static fromOwners(w: number, h: number, owners: Uint32Array, count: number): Mask[] {
        const out: Mask[] = [];
        for (let i = 0; i < count; i++) out.push(new Mask(w, h, {kind: 'Owner', owners, i}));
        return out;
    }

    clone(): Mask {
        const c = this.coverage;
        switch (c.kind) {
            case 'Rectangle':
                return new Mask(this.w, this.h, {kind: 'Rectangle', x: [c.x[0], c.x[1]], y: [c.y[0], c.y[1]]});
            case 'Pixels':
                return new Mask(this.w, this.h, {kind: 'Pixels', bits: c.bits.slice()});
            case 'Owner':
                return new Mask(this.w, this.h, {kind: 'Owner', owners: c.owners, i: c.i});
        }
    }

    get(x: number, y: number): boolean {
        const c = this.coverage;
        switch (c.kind) {
            case 'Rectangle':
                return x >= c.x[0] && x < c.x[1] && y >= c.y[0] && y < c.y[1];
            case 'Pixels':
                return c.bits[y * this.w + x] !== 0;
            case 'Owner':
                return c.owners[y * this.w + x] === c.i;
        }
    }

    subtract(other: Mask): void {
        const w = this.w;
        const c = this.coverage;
        let bits: Uint8Array;
        switch (c.kind) {
            case 'Rectangle':
                bits = new Uint8Array(w * this.h);
                for (let row = c.y[0]; row < c.y[1]; row++) bits.fill(1, row * w + c.x[0], row * w + c.x[1]);
                break;
            case 'Owner':
                bits = new Uint8Array(c.owners.length);
                for (let k = 0; k < c.owners.length; k++) bits[k] = c.owners[k] === c.i ? 1 : 0;
                break;
            case 'Pixels':
                bits = c.bits;
        }
        this.coverage = {kind: 'Pixels', bits};
        const o = other.coverage;
        switch (o.kind) {
            case 'Rectangle':
                for (let row = o.y[0]; row < o.y[1]; row++) bits.fill(0, row * w + o.x[0], row * w + o.x[1]);
                break;
            case 'Pixels': {
                const n = Math.min(bits.length, o.bits.length);
                for (let k = 0; k < n; k++) if (o.bits[k]) bits[k] = 0;
                break;
            }
            case 'Owner': {
                const n = Math.min(bits.length, o.owners.length);
                for (let k = 0; k < n; k++) if (o.owners[k] === o.i) bits[k] = 0;
                break;
            }
        }
    }

    /** Coverage of a straight-edged screen-space quad. Geographic projection and any
     * tessellation of curved boundaries belong before this operation. */
    static fromQuad(w: number, h: number, q: ArrayLike<ArrayLike<number>>): Mask {
        // Decide from screen geometry, never from the geographic projection
        // or camera bearing. Rotated/warped quads keep the general coverage path.
        const area = (q[1][0] - q[0][0]) * (q[3][1] - q[0][1]);
        let finite = true;
        for (let k = 0; k < 4; k++) finite &&= Number.isFinite(q[k][0]) && Number.isFinite(q[k][1]);
        if (area !== 0 && Number.isFinite(area) && finite
            && q[0][1] === q[1][1] && q[2][1] === q[3][1] && q[0][0] === q[3][0] && q[1][0] === q[2][0]) {
            const left = Math.min(q[0][0], q[1][0]);
            const right = Math.max(q[0][0], q[1][0]);
            const top = Math.min(q[0][1], q[3][1]);
            const bottom = Math.max(q[0][1], q[3][1]);
            const cl = (v: number, n: number) => Math.min(Math.max(v, 0), n);
            // GL includes the left and bottom boundaries, excludes the right and top.
            const x: [number, number] = [cl(Math.ceil(left - 0.5), w), cl(Math.ceil(right - 0.5), w)];
            const y: [number, number] = [cl(Math.floor(top - 0.5) + 1, h), cl(Math.floor(bottom - 0.5) + 1, h)];
            return new Mask(w, h, {kind: 'Rectangle', x, y});
        }
        const bits = new Uint8Array(w * h);
        for (const tri of [[q[0], q[1], q[2]], [q[0], q[2], q[3]]]) {
            forEachPixel(w, h, tri, (x, y) => {
                bits[y * w + x] = 1;
            });
        }
        return new Mask(w, h, {kind: 'Pixels', bits});
    }
}

/** Visit pixels whose centers are covered by the triangle (top-left fill rule), with
 * barycentric weights. */
export function forEachPixel(w: number, h: number, p: ArrayLike<ArrayLike<number>>, f: (x: number, y: number, wts: [number, number, number]) => void): void {
    const setup = Setup.create(w, h, p);
    if (!setup) return;
    const edges = setup.edges;
    setup.runs((y, x0, x1) => {
        const cy = y + 0.5;
        for (let x = x0; x < x1; x++) {
            const cx = x + 0.5;
            const wts: [number, number, number] = [0, 0, 0];
            for (let i = 0; i < 3; i++) {
                const e = edges[i];
                wts[i] = (e.sign * (e.dx * (cy - e.ay) - e.dy * (cx - e.ax))) / setup.area;
            }
            if (setup.flip) {
                const t = wts[1];
                wts[1] = wts[2];
                wts[2] = t;
            }
            f(x, y, wts);
        }
    });
}

/** Calls `f(y, x0, x1)` for each run of pixels `x0..x1` whose centers the triangle covers: the
 * pixels `forEachPixel` visits, without their weights. */
export function forEachRun(w: number, h: number, p: ArrayLike<ArrayLike<number>>, f: (y: number, x0: number, x1: number) => void): void {
    Setup.create(w, h, p)?.runs(f);
}

/** The edge function at the center of pixel `x` in the row whose center is `cy`. */
function edgeValue(e: Edge, cy: number, x: number): number {
    return e.sign * (e.dx * (cy - e.ay) - e.dy * (x + 0.5 - e.ax));
}

const outside = (e: number, include: boolean): boolean => e < 0 || (e === 0 && !include);

/** An edge from its lexicographically smaller endpoint. */
interface Edge {
    ax: number;
    ay: number;
    dx: number;
    dy: number;
    sign: number;
    include: boolean;
}

/** A positively oriented triangle's edge functions and pixel bounds. */
class Setup {
    edges: Edge[];
    area: number;
    flip: boolean;
    x0: number;
    x1: number;
    y0: number;
    y1: number;

    constructor(edges: Edge[], area: number, flip: boolean, x0: number, x1: number, y0: number, y1: number) {
        this.edges = edges;
        this.area = area;
        this.flip = flip;
        this.x0 = x0;
        this.x1 = x1;
        this.y0 = y0;
        this.y1 = y1;
    }

    static create(w: number, h: number, q: ArrayLike<ArrayLike<number>>): Setup | undefined {
        let area = (q[1][0] - q[0][0]) * (q[2][1] - q[0][1]) - (q[1][1] - q[0][1]) * (q[2][0] - q[0][0]);
        if (area === 0 || !Number.isFinite(area)) return undefined;
        // Normalize to positive orientation.
        const flip = area < 0;
        const p = flip ? [q[0], q[2], q[1]] : [q[0], q[1], q[2]];
        area = Math.abs(area);
        const minX = Math.min(p[0][0], p[1][0], p[2][0]);
        const maxX = Math.max(p[0][0], p[1][0], p[2][0]);
        const minY = Math.min(p[0][1], p[1][1], p[2][1]);
        const maxY = Math.max(p[0][1], p[1][1], p[2][1]);
        const x0 = Math.max(Math.ceil(minX - 0.5), 0);
        const x1 = Math.min(Math.floor(maxX - 0.5), w - 1);
        const y0 = Math.max(Math.ceil(minY - 0.5), 0);
        const y1 = Math.min(Math.floor(maxY - 0.5), h - 1);
        if (x0 > x1 || y0 > y1) return undefined;
        // Edge i is opposite vertex i: from p[(i+1)%3] to p[(i+2)%3]. Each edge is evaluated from
        // its lexicographically smaller endpoint so that a shared edge yields exactly negated
        // values in both triangles (no gaps or double hits from rounding).
        const edge = (i: number): Edge => {
            const a = p[(i + 1) % 3];
            const b = p[(i + 2) % 3];
            const dx = b[0] - a[0];
            const dy = b[1] - a[1];
            // GL's top-left rule applies in y-up window space; in our y-down buffer that
            // includes left edges and *bottom* horizontal edges.
            const include = dy < 0 || (dy === 0 && dx < 0);
            const flip = b[0] !== a[0] ? b[0] < a[0] : b[1] < a[1];
            return flip
                ? {ax: b[0], ay: b[1], dx: -dx, dy: -dy, sign: -1, include}
                : {ax: a[0], ay: a[1], dx, dy, sign: 1, include};
        };
        return new Setup([edge(0), edge(1), edge(2)], area, flip, x0, x1, y0, y1);
    }

    /** Calls `f(y, x0, x1)` for each run `x0..x1` of covered pixels in row `y`. */
    runs(f: (y: number, x0: number, x1: number) => void): void {
        const {x0, x1, edges} = this;
        rows: for (let y = this.y0; y <= this.y1; y++) {
            const cy = y + 0.5;
            let rowX0 = x0;
            let rowX1 = x1;
            // Whether every pixel of rowX0..=rowX1 is known to be inside.
            let exact = false;
            // Direct testing is cheaper than span setup for short rows (e.g. glyph quads).
            if (x1 - x0 >= 16) {
                exact = true;
                // Each edge is monotone along a scanline. An intersection suggests its pixel
                // boundary, but only the original edge predicate can confirm it. Binary search
                // handles rounding/cancellation without changing coverage or shared-edge rules.
                for (let k = 0; k < 3; k++) {
                    const edge = edges[k];
                    const {ax, ay, dx, dy, include} = edge;
                    const left = edgeValue(edge, cy, rowX0);
                    const right = edgeValue(edge, cy, rowX1);
                    // Non-finite edge intermediates need the original per-pixel behavior.
                    if (!Number.isFinite(left) || !Number.isFinite(right)) {
                        exact = false;
                        continue;
                    }
                    const leftOut = outside(left, include);
                    const rightOut = outside(right, include);
                    if (leftOut === rightOut) {
                        if (leftOut) continue rows;
                        continue;
                    }
                    let lo = rowX0;
                    let hi = rowX1;
                    const crossing = ax + (dx * (cy - ay)) / dy - 0.5;
                    // Non-finite hints fail the range test, as Rust's saturating cast does.
                    const hint = leftOut ? Math.ceil(crossing) : Math.floor(crossing) + 1;
                    if (hint > lo && hint <= hi && outside(edgeValue(edge, cy, hint - 1), include) === leftOut && outside(edgeValue(edge, cy, hint), include) !== leftOut) {
                        lo = hint - 1;
                        hi = hint;
                    }
                    while (hi - lo > 1) {
                        const mid = lo + Math.floor((hi - lo) / 2);
                        if (outside(edgeValue(edge, cy, mid), include) === leftOut) lo = mid;
                        else hi = mid;
                    }
                    if (leftOut) rowX0 = hi;
                    else rowX1 = lo;
                }
            }
            if (exact) {
                if (rowX0 <= rowX1) f(y, rowX0, rowX1 + 1);
                continue;
            }
            let run = -1;
            for (let x = rowX0; x <= rowX1; x++) {
                const cx = x + 0.5;
                let inside = true;
                for (let k = 0; k < 3; k++) {
                    const e0 = edges[k];
                    const e = e0.sign * (e0.dx * (cy - e0.ay) - e0.dy * (cx - e0.ax));
                    if (e < 0 || (e === 0 && !e0.include)) {
                        inside = false;
                        break;
                    }
                }
                if (inside && run < 0) {
                    run = x;
                } else if (!inside && run >= 0) {
                    f(y, run, x);
                    run = -1;
                }
            }
            if (run >= 0) f(y, run, rowX1 + 1);
        }
    }
}

/** Rasterize a triangle with `N` varyings (`v[i].length`); `shade` returns the premultiplied
 * fragment color. Varyings are interpolated as screen-space planes (exact for the affine,
 * unpitched camera up to rounding). `shade`'s argument is reused between fragments. */
export function triangle(
    t: Target,
    mask: Mask | undefined,
    p: ArrayLike<ArrayLike<number>>,
    v: ArrayLike<ArrayLike<number>>,
    shade: (vary: number[]) => ArrayLike<number> | undefined,
): void {
    const w = t.w;
    const setup = Setup.create(w, t.h, p);
    if (!setup) return;
    const n = v[0].length;
    // v(x, y) = v0 + gx (x - p0x) + gy (y - p0y).
    const e1x = p[1][0] - p[0][0];
    const e1y = p[1][1] - p[0][1];
    const e2x = p[2][0] - p[0][0];
    const e2y = p[2][1] - p[0][1];
    const det = e1x * e2y - e1y * e2x;
    const gx: number[] = new Array(n);
    const gy: number[] = new Array(n);
    for (let k = 0; k < n; k++) {
        const d1 = v[1][k] - v[0][k];
        const d2 = v[2][k] - v[0][k];
        gx[k] = (d1 * e2y - d2 * e1y) / det;
        gy[k] = (d2 * e1x - d1 * e2x) / det;
    }
    const row: number[] = new Array(n).fill(0);
    const vary: number[] = new Array(n).fill(0);
    const p0x = p[0][0];
    const p0y = p[0][1];
    // `mask.get` and `t.visible`, specialized: a rectangle mask clips the run, others test pixels.
    const cov = mask?.coverage;
    const rect = cov?.kind === 'Rectangle' ? cov : undefined;
    const pixelMask = cov && !rect ? mask : undefined;
    const {cull, occ, layer} = t;
    setup.runs((y, x0, x1) => {
        if (rect) {
            if (y < rect.y[0] || y >= rect.y[1]) return;
            x0 = Math.max(x0, rect.x[0]);
            x1 = Math.min(x1, rect.x[1]);
        }
        const dy = y + 0.5 - p0y;
        for (let k = 0; k < n; k++) row[k] = v[0][k] + gy[k] * dy;
        const base = y * w;
        for (let x = x0; x < x1; x++) {
            if ((pixelMask && !pixelMask.get(x, y)) || (cull && !(occ[base + x] <= layer))) continue;
            const dx = x + 0.5 - p0x;
            for (let k = 0; k < n; k++) vary[k] = row[k] + gx[k] * dx;
            const c = shade(vary);
            if (c) t.blend(base + x, c);
        }
    });
}

/** Aliased 1px GL line (`gl.LINES`); `shade` gets the distance of the fragment center from
 * the line and the position along it (0 at `a`, 1 at `b`) for interpolating varyings. */
export function line(
    t: Target,
    accept: (x: number, y: number) => boolean,
    a: ArrayLike<number>,
    b: ArrayLike<number>,
    shade: (dist: number, t: number) => ArrayLike<number> | undefined,
): void {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    if ((dx === 0 && dy === 0) || !(Number.isFinite(dx) && Number.isFinite(dy))) return;
    const xMajor = Math.abs(dx) >= Math.abs(dy);
    const majorA = xMajor ? a[0] : a[1];
    const majorB = xMajor ? b[0] : b[1];
    const lo = majorA <= majorB ? majorA : majorB;
    const hi = majorA <= majorB ? majorB : majorA;
    const start = Math.ceil(lo - 0.5);
    const end = Math.ceil(hi - 0.5); // exclusive: diamond-exit drops the last pixel
    // Only rows/columns of the target (projected endpoints can be far outside it).
    const limit = xMajor ? t.w : t.h;
    for (let i = Math.max(start, 0); i < Math.min(end, limit); i++) {
        const c = i + 0.5;
        const tParam = (c - majorA) / (majorB - majorA);
        const minor = xMajor ? a[1] + dy * tParam : a[0] + dx * tParam;
        const j = Math.floor(minor);
        const x = xMajor ? i : j;
        const y = xMajor ? j : i;
        if (x < 0 || y < 0 || x >= t.w || y >= t.h) continue;
        if (!t.visible(y * t.w + x) || !accept(x, y)) continue;
        const dist = Math.abs(j + 0.5 - minor);
        const col = shade(dist, tParam);
        if (col) t.blend(y * t.w + x, col);
    }
}

/** Screen-space gradients (d/dx, d/dy) of linearly interpolated varyings over a triangle,
 * for emulating `fwidth`. */
export function varyingGradients(p: ArrayLike<ArrayLike<number>>, v: ArrayLike<ArrayLike<number>>): [number[], number[]] {
    const n = v[0].length;
    const e1x = p[1][0] - p[0][0];
    const e1y = p[1][1] - p[0][1];
    const e2x = p[2][0] - p[0][0];
    const e2y = p[2][1] - p[0][1];
    const det = e1x * e2y - e1y * e2x;
    const out: [number[], number[]] = [new Array(n).fill(0), new Array(n).fill(0)];
    if (det === 0) return out;
    for (let k = 0; k < n; k++) {
        const d1 = v[1][k] - v[0][k];
        const d2 = v[2][k] - v[0][k];
        out[0][k] = (d1 * e2y - d2 * e1y) / det;
        out[1][k] = (d2 * e1x - d1 * e2x) / det;
    }
    return out;
}

export function smoothstep(e0: number, e1: number, x: number): number {
    let t = (x - e0) / (e1 - e0);
    // `f32::clamp` keeps NaN.
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return t * t * (3 - 2 * t);
}
