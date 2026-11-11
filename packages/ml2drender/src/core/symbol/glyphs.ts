//! SDF glyph ranges (`glyphs` URL, PBF): parsing and the per-fontstack store.
//!
//! Like MapLibre's `GlyphManager` with a glyphs URL and no `font-faces`/local fonts: each
//! codepoint comes from the 256-codepoint range file of its font stack. A range that fails to
//! load leaves its glyphs missing (MapLibre would draw them with the browser's fonts instead).

import {PbfReader} from 'pbf';

/** SDF border around each glyph bitmap (`GLYPH_PBF_BORDER`). */
export const BORDER = 3;

export interface Metrics {
  width: number;
  height: number;
  left: number;
  top: number;
  advance: number;
}

export interface Glyph {
  /** Alpha SDF, `(width + 2*BORDER) x (height + 2*BORDER)`. */
  bitmap: Uint8Array;
  bw: number;
  bh: number;
  metrics: Metrics;
}

const VARINT = 0;
const BYTES = 2;

function parseGlyph(pbf: PbfReader, end: number): [number, Glyph] {
  let id = 0;
  let bitmap: Uint8Array = new Uint8Array(0);
  const m: Metrics = {width: 0, height: 0, left: 0, top: 0, advance: 0};
  pbf.readFields((field, _, p) => {
    const wire = p.type;
    if (field === 1 && wire === VARINT) id = p.readVarint() >>> 0;
    else if (field === 2 && wire === BYTES) bitmap = p.readBytes();
    else if (field === 3 && wire === VARINT) m.width = p.readVarint();
    else if (field === 4 && wire === VARINT) m.height = p.readVarint();
    else if (field === 5 && wire === VARINT) m.left = p.readSVarint();
    else if (field === 6 && wire === VARINT) m.top = p.readSVarint();
    else if (field === 7 && wire === VARINT) m.advance = p.readVarint();
  }, null, end);
  const bw = m.width + 2 * BORDER;
  const bh = m.height + 2 * BORDER;
  // Even an empty glyph (a space) gets a zero-filled bitmap and so an atlas rect and a quad.
  const full = new Uint8Array(bw * bh);
  full.set(bitmap.subarray(0, bw * bh));
  return [id, {bitmap: full, bw, bh, metrics: m}];
}

/** `parseGlyphPbf`: glyphs → stacks (field 1) → glyph (field 3). Malformed data keeps what parsed before it. */
export function parse(data: Uint8Array): Map<number, Glyph> {
  const out = new Map<number, Glyph>();
  const pbf = new PbfReader(data);
  try {
    pbf.readFields((field, _, p) => {
      if (field !== 1 || p.type !== BYTES) return;
      const end = p.readVarint() + p.pos;
      if (end > p.length) throw new Error('truncated');
      p.readFields((field, _, s) => {
        if (field !== 3 || s.type !== BYTES) return;
        const gEnd = s.readVarint() + s.pos;
        if (gEnd > end) throw new Error('truncated');
        try {
          const [id, g] = parseGlyph(s, gEnd);
          out.set(id, g);
        } catch {
          // A malformed glyph is dropped; the stack goes on after it.
        }
        s.pos = gEnd;
      }, null, end);
    }, null);
  } catch {
    // Like the Rust reader: stop at the first malformed field.
  }
  return out;
}

/** Glyphs of one range by code point. */
type Range = Map<number, Glyph>;

const rangeKey = (stack: string, range: number) => `${range}/${stack}`;

/**
 * Loaded glyph ranges by font stack (`"Font A,Font B"`) and range index (`codepoint / 256`).
 * `undefined` value = the range failed to load.
 */
export class Glyphs {
  url: string | undefined;
  private ranges = new Map<string, Range | undefined>();

  constructor(url: string | undefined) {
    this.url = url;
  }

  rangeUrl(stack: string, range: number): string | undefined {
    if (this.url === undefined) return undefined;
    const begin = range * 256;
    return this.url.replaceAll('{fontstack}', () => stack).replaceAll('{range}', () => `${begin}-${begin + 255}`);
  }

  /** URLs of the ranges in `deps` not provided yet, with their keys (deduplicated, in `BTreeSet` order). */
  needs(deps: Iterable<readonly [string, number]>): [string, [string, number]][] {
    const uniq = new Map<string, [string, number]>();
    for (const [s, r] of deps) uniq.set(rangeKey(s, r), [s, r]);
    const sorted = [...uniq.values()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
    const out: [string, [string, number]][] = [];
    for (const k of sorted) {
      if (this.ranges.has(rangeKey(k[0], k[1]))) continue;
      const url = this.rangeUrl(k[0], k[1]);
      if (url !== undefined) out.push([url, k]);
    }
    return out;
  }

  provide(key: readonly [string, number], bytes: Uint8Array | undefined): void {
    const k = rangeKey(key[0], key[1]);
    if (!this.ranges.has(k)) this.ranges.set(k, bytes === undefined ? undefined : parse(bytes));
  }

  /** `c`: one code point. */
  get(stack: string, c: string): Glyph | undefined {
    const cp = c.codePointAt(0)!;
    return this.ranges.get(rangeKey(stack, Math.floor(cp / 256)))?.get(cp);
  }
}
