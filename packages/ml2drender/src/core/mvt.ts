// Mapbox Vector Tile (protobuf) decoding.

import {gunzipSync} from 'fflate';
import type {TileId} from './tile.ts';
import {asI32, roundAway} from './util.ts';

/** Unknown, Point, LineString, Polygon (the MVT `GeomType` values). */
export type GeomType = 0 | 1 | 2 | 3;

const GEOM_TYPE_NAMES = ['Unknown', 'Point', 'LineString', 'Polygon'] as const;

export function geomTypeName(t: GeomType): 'Unknown' | 'Point' | 'LineString' | 'Polygon' {
    return GEOM_TYPE_NAMES[t];
}

/**
 * A decoded feature in tile coordinates of its layer's extent. Rings/lines are explicit
 * (polygon rings closed by repeating the first point, like vector-tile-js).
 */
export interface Feature {
    id?: unknown;
    type: GeomType;
    properties: Record<string, unknown>;
    geometry: [number, number][][];
}

export interface Layer {
    name: string;
    extent: number;
    features: Feature[];
}

const lossy = new TextDecoder('utf-8', {ignoreBOM: true});
const strict = new TextDecoder('utf-8', {ignoreBOM: true, fatal: true});

export class Reader {
    buf: Uint8Array;
    pos: number;
    /** Low / high 32 bits (unsigned) of the last varint read. */
    lo = 0;
    hi = 0;

    constructor(buf: Uint8Array, pos: number) {
        this.buf = buf;
        this.pos = pos;
    }

    /** A u64 varint as a number (rounded above 2^53; `lo` / `hi` hold the exact bits). */
    varint(): number | undefined {
        let lo = 0;
        let hi = 0;
        for (let shift = 0; shift < 64; shift += 7) {
            if (this.pos >= this.buf.length) return undefined;
            const b = this.buf[this.pos++];
            const v = b & 0x7f;
            if (shift < 28) {
                lo |= v << shift;
            } else if (shift === 28) {
                lo |= v << 28;
                hi |= v >>> 4;
            } else {
                // Bits past 64 are dropped, like the u64 shift in Rust.
                hi |= v << (shift - 32);
            }
            if (b < 0x80) {
                this.lo = lo >>> 0;
                this.hi = hi >>> 0;
                return this.hi * 4294967296 + this.lo;
            }
        }
        return undefined;
    }

    bytes(): Uint8Array | undefined {
        const len = this.varint();
        if (len === undefined) return undefined;
        if (this.pos + len > this.buf.length) return undefined;
        const s = this.buf.subarray(this.pos, this.pos + len);
        this.pos += len;
        return s;
    }

    /** Next [field, wire type]; `undefined` at end. */
    /** Field number and wire type of the last key read by `next`. */
    tag = 0;
    wire = 0;

    /** Reads the next field key into `tag` / `wire`; false at the end or on a malformed key. */
    next(): boolean {
        if (this.pos >= this.buf.length) return false;
        if (this.varint() === undefined) return false;
        // k >> 3 on the u64 key.
        this.tag = this.hi * 536870912 + (this.lo >>> 3);
        this.wire = this.lo & 7;
        return true;
    }

    skip(wire: number): boolean {
        switch (wire) {
            case 0:
                if (this.varint() === undefined) return false;
                break;
            case 1:
                this.pos += 8;
                break;
            case 2:
                if (this.bytes() === undefined) return false;
                break;
            case 5:
                this.pos += 4;
                break;
            default:
                return false;
        }
        return this.pos <= this.buf.length;
    }

    fixed(n: number): DataView | undefined {
        if (this.pos + n > this.buf.length) return undefined;
        const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, n);
        this.pos += n;
        return v;
    }
}

/** Packed varints (each truncated to u32), into a reused buffer. */
function packed(data: Uint8Array, out: number[]): boolean {
    const r = new Reader(data, 0);
    out.length = 0;
    while (r.pos < data.length) {
        if (r.varint() === undefined) return false;
        out.push(r.lo);
    }
    return true;
}

/** `null` for an empty value message, `undefined` when malformed. */
function decodeValue(data: Uint8Array): unknown {
    const r = new Reader(data, 0);
    let v: unknown = null;
    while (r.next()) {
        const f = r.tag;
        const w = r.wire;
        if (f === 1 && w === 2) {
            const b = r.bytes();
            if (!b) return undefined;
            try {
                v = strict.decode(b);
            } catch {
                return undefined;
            }
        } else if (f === 2 && w === 5) {
            const d = r.fixed(4);
            if (!d) return undefined;
            v = d.getFloat32(0, true);
        } else if (f === 3 && w === 1) {
            const d = r.fixed(8);
            if (!d) return undefined;
            v = d.getFloat64(0, true);
        } else if ((f === 4 || f === 5 || f === 6 || f === 7) && w === 0) {
            if (r.varint() === undefined) return undefined;
            const {lo, hi} = r;
            if (f === 4) {
                // `as i64 as f64`
                v = (hi | 0) * 4294967296 + lo;
            } else if (f === 5) {
                v = hi * 4294967296 + lo;
            } else if (f === 6) {
                // zigzag: (n >> 1) as i64 ^ -(n & 1)
                const u = (hi >>> 1) * 4294967296 + (((lo >>> 1) | ((hi & 1) << 31)) >>> 0);
                v = lo & 1 ? -u - 1 : u;
            } else {
                v = hi !== 0 || lo !== 0;
            }
        } else if (!r.skip(w)) {
            return undefined;
        }
    }
    return v;
}

function decodeGeometry(cmds: number[]): [number, number][][] {
    const lines: [number, number][][] = [];
    let line: [number, number][] | undefined;
    let x = 0;
    let y = 0;
    let i = 0;
    const zz = (v: number) => ((v >>> 1) ^ -(v & 1)) | 0;
    while (i < cmds.length) {
        const cmd = cmds[i] & 7;
        const count = cmds[i] >>> 3;
        i++;
        if (cmd === 1 || cmd === 2) {
            for (let c = 0; c < count; c++) {
                if (i + 1 >= cmds.length) return lines;
                x = (x + zz(cmds[i])) | 0;
                y = (y + zz(cmds[i + 1])) | 0;
                i += 2;
                if (cmd === 1) {
                    if (line) lines.push(line);
                    line = [];
                }
                (line ??= []).push([x, y]);
            }
        } else if (cmd === 7) {
            if (line && line.length > 0) line.push(line[0]);
        } else {
            return lines;
        }
    }
    if (line) lines.push(line);
    return lines;
}

/** The layer's name bytes; `undefined` when malformed. */
function layerName(data: Uint8Array): Uint8Array | undefined {
    const r = new Reader(data, 0);
    while (r.next()) {
        const f = r.tag;
        const w = r.wire;
        if (f === 1 && w === 2) return r.bytes();
        if (!r.skip(w)) return undefined;
    }
    return new Uint8Array(0);
}

function decodeLayer(data: Uint8Array): Layer | undefined {
    const r = new Reader(data, 0);
    let name = '';
    let extent = 4096;
    const keys: string[] = [];
    const values: unknown[] = [];
    const rawFeatures: Uint8Array[] = [];
    while (r.next()) {
        const f = r.tag;
        const w = r.wire;
        if (f === 1 && w === 2) {
            const b = r.bytes();
            if (!b) return undefined;
            name = lossy.decode(b);
        } else if (f === 2 && w === 2) {
            const b = r.bytes();
            if (!b) return undefined;
            rawFeatures.push(b);
        } else if (f === 3 && w === 2) {
            const b = r.bytes();
            if (!b) return undefined;
            keys.push(lossy.decode(b));
        } else if (f === 4 && w === 2) {
            const b = r.bytes();
            if (!b) return undefined;
            const v = decodeValue(b);
            if (v === undefined) return undefined;
            values.push(v);
        } else if (f === 5 && w === 0) {
            if (r.varint() === undefined) return undefined;
            extent = r.lo; // `as u32`
        } else if (!r.skip(w)) {
            return undefined;
        }
    }
    const features: Feature[] = [];
    const tags: number[] = [];
    const geom: number[] = [];
    for (const fd of rawFeatures) {
        const r = new Reader(fd, 0);
        let id: number | undefined;
        let type: GeomType = 0;
        tags.length = 0;
        geom.length = 0;
        while (r.next()) {
            const f = r.tag;
            const w = r.wire;
            if (f === 1 && w === 0) {
                const v = r.varint();
                if (v === undefined) return undefined;
                id = v;
            } else if (f === 2 && w === 2) {
                const b = r.bytes();
                if (!b || !packed(b, tags)) return undefined;
            } else if (f === 3 && w === 0) {
                const v = r.varint();
                if (v === undefined) return undefined;
                type = v === 1 || v === 2 || v === 3 ? v : 0;
            } else if (f === 4 && w === 2) {
                const b = r.bytes();
                if (!b || !packed(b, geom)) return undefined;
            } else if (!r.skip(w)) {
                return undefined;
            }
        }
        const properties: Record<string, unknown> = {};
        for (let k = 0; k + 1 < tags.length; k += 2) {
            const key = keys[tags[k]];
            const value = tags[k + 1] < values.length ? values[tags[k + 1]] : undefined;
            if (key !== undefined && value !== undefined) properties[key] = value;
        }
        const feature: Feature = {type, properties, geometry: decodeGeometry(geom)};
        if (id !== undefined) feature.id = id;
        features.push(feature);
    }
    return {name, extent, features};
}

/**
 * Decode a (possibly gzip-compressed) vector tile, keeping only the layers whose name
 * passes `keep` (the others are skipped undecoded).
 */
export function decode(data: Uint8Array, keep: (name: string) => boolean): Layer[] | undefined {
    if (data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b) {
        try {
            data = gunzipSync(data);
        } catch {
            return undefined;
        }
    }
    const r = new Reader(data, 0);
    const layers: Layer[] = [];
    while (r.next()) {
        const f = r.tag;
        const w = r.wire;
        if (f === 3 && w === 2) {
            const bytes = r.bytes();
            if (!bytes) return undefined;
            const name = layerName(bytes);
            if (!name) return undefined;
            if (keep(lossy.decode(name))) {
                const layer = decodeLayer(bytes);
                if (!layer) return undefined;
                layers.push(layer);
            }
        } else if (!r.skip(w)) {
            return undefined;
        }
    }
    return layers;
}

/**
 * MapLibre's overzoom slicing (`sliceVectorTileLayer`): a child tile below the source's
 * maxzoom is cut out of the parent tile, rescaled to the same extent, clipped with a buffer
 * and round-tripped through MVT encoding (whose deltas are truncated to integers).
 */
export function sliceLayer(layer: Layer, parent: TileId, target: TileId): Layer {
    const extent = layer.extent;
    const scale = 2 ** (target.z - parent.z);
    const ox = (target.x - parent.x * scale) * extent;
    const oy = (target.y - parent.y * scale) * extent;
    const buffer = Math.max(128, roundAway((128 * extent) / 4096));
    const lo = -buffer;
    const hi = extent + buffer;
    const features: Feature[] = [];
    for (const f of layer.features) {
        const geom = f.geometry.map(r => r.map(p => [p[0] * scale - ox, p[1] * scale - oy] as [number, number]));
        const clipped = clipAxis(clipAxis(geom, f.type, lo, hi, 0), f.type, lo, hi, 1);
        if (clipped.length === 0) continue;
        const feature: Feature = {type: f.type, properties: f.properties, geometry: reencode(clipped, f.type)};
        if (f.id !== undefined) feature.id = f.id;
        features.push(feature);
    }
    return {name: layer.name, extent: layer.extent, features};
}

/**
 * vt-pbf `writeGeometry` + decode: each delta is truncated (`zigzag` uses int32 ops)
 * while the encoder's cursor tracks the exact float position.
 */
function reencode(geom: [number, number][][], type: GeomType): [number, number][][] {
    let fx = 0;
    let fy = 0;
    let ix = 0;
    let iy = 0;
    const out: [number, number][][] = [];
    for (const ring of geom) {
        const closed = type === 3 && ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
        const n = closed ? ring.length - 1 : ring.length;
        const r: [number, number][] = [];
        for (let i = 0; i < n; i++) {
            const p = ring[i];
            const dx = p[0] - fx;
            const dy = p[1] - fy;
            ix += asI32(dx);
            iy += asI32(dy);
            fx += dx;
            fy += dy;
            r.push([ix | 0, iy | 0]);
        }
        if (type === 3 && r.length > 0) r.push(r[0]);
        if (type === 1) {
            for (const p of r) out.push([p]);
        } else {
            out.push(r);
        }
    }
    return out;
}

/** `clipGeometryOnAxis` (symbol/clip_line.ts). */
function clipAxis(geom: [number, number][][], type: GeomType, start: number, end: number, axis: 0 | 1): [number, number][][] {
    const out: [number, number][][] = [];
    if (type === 1) {
        for (const line of geom) {
            for (const p of line) {
                if (p[axis] >= start && p[axis] <= end) out.push([p]);
            }
        }
    } else if (type === 2 || type === 3) {
        const isPolygon = type === 3;
        const at = (p: [number, number], q: [number, number], v: number): [number, number] => {
            const t = (v - p[axis]) / (q[axis] - p[axis]);
            return axis === 0 ? [v, p[1] + (q[1] - p[1]) * t] : [p[0] + (q[0] - p[0]) * t, v];
        };
        for (const line of geom) {
            let slice: [number, number][] = [];
            for (let i = 0; i + 1 < line.length; i++) {
                const p1 = line[i];
                const p2 = line[i + 1];
                const a = p1[axis];
                const b = p2[axis];
                let exited = false;
                if (a < start) {
                    if (b >= start) slice.push(at(p1, p2, start));
                } else if (a > end) {
                    if (b <= end) slice.push(at(p1, p2, end));
                } else {
                    slice.push(p1);
                }
                if (b < start && a >= start) {
                    slice.push(at(p1, p2, start));
                    exited = true;
                }
                if (b > end && a <= end) {
                    slice.push(at(p1, p2, end));
                    exited = true;
                }
                if (!isPolygon && exited) {
                    out.push(slice);
                    slice = [];
                }
            }
            const last = line[line.length - 1];
            if (last && last[axis] >= start && last[axis] <= end) slice.push(last);
            if (isPolygon && slice.length > 0) {
                const f = slice[0];
                const l = slice[slice.length - 1];
                if (f[0] !== l[0] || f[1] !== l[1]) slice.push(f);
            }
            if (slice.length > 0) out.push(slice);
        }
    }
    return out;
}
