// Rendering into a projected CRS. Buckets are built in tile space as usual; layers drawn from
// vertices (fill, line, circle, heatmap, symbol, background) are drawn straight into the target
// grid with their vertices projected (`Warp.worldToScreen`), segments split so that they
// curve, and pixel lengths (line widths, radii, text) extruded in screen space. Image patterns
// and dashes repeat evenly on the output's pixels (`Warp.pixelOrigin`). Rasters and DEMs are
// drawn in Web Mercator and the picture is warped into the target grid (`Warp.composite`).
// Tile clipping uses the Mercator position of each output pixel (`Warp.pixelWorld`), as tile
// boundaries curve.

import {Projection} from './projection.ts';
import type {Rgba, Target} from './render/raster.ts';
import type {View} from './renderer.ts';
import {MAX_LAT, MIN_ZOOM, mercatorLat, mercatorX, mercatorY, type Transform} from './tile.ts';
import {asI32, roundAway} from './util.ts';

/** A target-CRS view: what `Renderer.setProjectedView` renders. */
export interface ProjectedView {
  /**
   * The target CRS as PROJJSON, geographic or projected. Supported methods: Transverse Mercator,
   * Mercator, Pseudo Mercator, Lambert Conic Conformal, Polar Stereographic, Lambert Azimuthal Equal
   * Area, Equal Earth and PROJ's Geostationary Satellite, on any ellipsoid, without datum shifts.
   * Coordinates are (easting, northing) / (longitude, latitude) whatever the axis order.
   */
  projjson: string;
  /** `[minX, minY, maxX, maxY]` in CRS units (degrees for longlat). */
  bbox: [number, number, number, number];
  /** CSS pixels; the output is `round(width*pixelRatio)` × `round(height*pixelRatio)`. */
  width: number;
  height: number;
  pixelRatio: number;
  /** CSS pixels rendered around the view before cropping to the requested output size. */
  margin: number;
}

/** Largest output side, margins included, in device pixels (bounds the per-pixel buffers). */
const MAX_SIZE = 16384;

/**
 * Mesh spacing in output device pixels: the Mercator position of each output pixel is
 * interpolated bilinearly between exactly inverse-projected nodes.
 */
const GRID = 8;

/** Rust `x as usize` from a float: truncates, saturates at 0, NaN → 0. */
const asUsize = (x: number): number => (x !== x ? 0 : Math.max(0, Math.trunc(x)));
/** Rust `x as u32` from a float. */
const asU32 = (x: number): number => (x !== x ? 0 : Math.max(0, Math.min(4294967295, Math.trunc(x))));
/** Rust `f64::rem_euclid`. */
const remEuclid = (a: number, b: number): number => {
  const r = a % b;
  return r < 0 ? r + Math.abs(b) : r;
};

const NAN2 = (): [number, number] => [NaN, NaN];

/** A projected view's mapping to and from the Web Mercator render. */
export class Warp {
  proj: Projection;
  bbox: [number, number, number, number];
  /** Rendered size in device pixels, margins included. */
  size: [number, number];
  /** Rendered size in CSS pixels. */
  cssSize: [number, number];
  /** Device pixels cropped from each side of the rendered image. */
  margin: number;
  /**
   * Mercator coordinates (world = 1, unwrapped around the reference point) of the mesh nodes,
   * row-major; NaN outside the projection's domain. Empty when the whole view is outside.
   */
  nodes: [number, number][];
  cols: number;
  /** Longitudes are unwrapped to within 180° of this one. */
  referenceLng: number;
  /** Mercator x (world = 1) of the projection's central meridian; `undefined` for longlat. */
  centralX_: number | undefined;
  /** `pixelWorld`, computed once. */
  pixels: [number, number][] | undefined;

  constructor(
    proj: Projection,
    bbox: [number, number, number, number],
    size: [number, number],
    cssSize: [number, number],
    margin: number,
    cols: number,
  ) {
    this.proj = proj;
    this.bbox = bbox;
    this.size = size;
    this.cssSize = cssSize;
    this.margin = margin;
    this.nodes = [];
    this.cols = cols;
    this.referenceLng = 0;
    this.centralX_ = undefined;
    this.pixels = undefined;
  }

  /**
   * The warp for `view` and the Mercator view to render for it: about one Mercator pixel per
   * output pixel at the view center, covering the whole output. No Mercator view when nothing
   * of `view` is in the projection's domain (the output is then transparent).
   */
  static new(view: ProjectedView): [Warp, View | undefined] {
    const proj = Projection.parse(view.projjson);
    let b = view.bbox;
    const out = [asUsize(roundAway(view.width * view.pixelRatio)), asUsize(roundAway(view.height * view.pixelRatio))];
    if (!(b[2] > b[0] && b[3] > b[1]) || out[0] === 0 || out[1] === 0) {
      throw new Error(`unsupported: empty projected view [${b.join(', ')}]`);
    }
    // The margin extends the box by whole device pixels of the output's resolution.
    const margin = asUsize(roundAway(view.margin * view.pixelRatio));
    if (out.some((n) => n + margin * 2 > MAX_SIZE)) {
      throw new Error(`unsupported: projected view over ${MAX_SIZE} device pixels wide or high`);
    }
    const size: [number, number] = [out[0] + 2 * margin, out[1] + 2 * margin];
    const ux = (b[2] - b[0]) / out[0];
    const uy = (b[3] - b[1]) / out[1];
    const m = margin;
    b = [b[0] - m * ux, b[1] - m * uy, b[2] + m * ux, b[3] + m * uy];
    const cols = Math.ceil(size[0] / GRID) + 1;
    const rows = Math.ceil(size[1] / GRID) + 1;
    const grid: [number, number][] = [];
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) grid.push([i * GRID, j * GRID]);
    // The reference point: the center or else, e.g. for a tile on the edge of a world
    // projection, the node nearest to it in the domain, with neighbors 1 px toward the center.
    const cx = size[0] / 2;
    const cy = size[1] / 2;
    const cssSize: [number, number] = [size[0] / view.pixelRatio, size[1] / view.pixelRatio];
    const warp = new Warp(proj, b, size, cssSize, margin, cols);
    const inDomain = (x: number, y: number) => warp.lnglat(x, y);
    const try_ = ([x, y]: [number, number]) => {
      const sx = x < cx ? 1 : -1;
      const sy = y < cy ? 1 : -1;
      const p = inDomain(x, y);
      if (p === undefined) return undefined;
      return inDomain(x + sx, y) !== undefined && inDomain(x, y + sy) !== undefined
        ? ([x, y, sx, sy, p[0]] as const)
        : undefined;
    };
    let reference = try_([cx, cy]);
    if (reference === undefined) {
      // Nodes by distance from the center, sorted only if the center is not in the domain.
      const d2 = (p: [number, number]) => (p[0] - cx) ** 2 + (p[1] - cy) ** 2;
      const candidates = [...grid].sort((a, b) => d2(a) - d2(b));
      for (const c of candidates) {
        reference = try_(c);
        if (reference !== undefined) break;
      }
    }
    if (reference === undefined) return [warp, undefined];
    const [rx, ry, sx, sy, referenceLng] = reference;
    warp.referenceLng = referenceLng;
    // The central meridian itself (not a world copy of it): `worldToScreen` measures
    // longitudes from it.
    const cm = warp.proj.centralMeridian();
    warp.centralX_ = cm === undefined ? undefined : mercatorX(cm);
    const merc = (x: number, y: number) => warp.merc(x, y);
    const nodes = grid.map(([x, y]) => merc(x, y));
    // Mercator units per output device pixel at the reference point. It is also the zoom
    // styles are evaluated at, like a Mercator map's center.
    const [m0, mx, my] = [merc(rx, ry), merc(rx + sx, ry), merc(rx, ry + sy)];
    const scale = Math.sqrt(Math.abs((mx[0] - m0[0]) * (my[1] - m0[1]) - (mx[1] - m0[1]) * (my[0] - m0[0])));
    let zoom = Math.log2(1 / (scale * view.pixelRatio * 512));
    let [x0, y0, x1, y1] = [Number.MAX_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE, -Number.MAX_VALUE];
    for (const n of nodes) {
      if (!Number.isFinite(n[0])) continue;
      [x0, y0, x1, y1] = [Math.min(x0, n[0]), Math.min(y0, n[1]), Math.max(x1, n[0]), Math.max(y1, n[1])];
    }
    // ponytail: one zoom for the whole view; far from the center (e.g. continental views) the
    // picture is resampled up or down. Bound the Mercator render to 16× the output area.
    const css = (zoom: number): [number, number] => [(x1 - x0) * 512 * Math.pow(2, zoom), (y1 - y0) * 512 * Math.pow(2, zoom)];
    let [w, h] = css(zoom);
    const maxArea = 16 * cssSize[0] * cssSize[1];
    if (w * h > maxArea) zoom -= 0.5 * Math.log2((w * h) / maxArea);
    // Sized for the zoom the view is clamped to, or the picture would not cover the view.
    // (Rust `f64::max` ignores NaN.)
    zoom = zoom !== zoom ? MIN_ZOOM : Math.max(zoom, MIN_ZOOM);
    [w, h] = css(zoom);
    const [cmx, cmy] = [(x0 + x1) / 2, (y0 + y1) / 2];
    const mercator: View = {
      center: [cmx * 360 - 180, mercatorLat(cmy)],
      zoom,
      bearing: 0,
      // A pixel of padding on each side for bilinear sampling.
      width: asU32(Math.ceil(w)) + 2,
      height: asU32(Math.ceil(h)) + 2,
      pixelRatio: view.pixelRatio,
      margin: 0,
    };
    warp.nodes = nodes;
    return [warp, mercator];
  }

  /** Longitude/latitude at an output pixel position, if Mercator has it. */
  lnglat(x: number, y: number): [number, number] | undefined {
    const b = this.bbox;
    const p = this.proj.inverse([b[0] + (x / this.size[0]) * (b[2] - b[0]), b[3] - (y / this.size[1]) * (b[3] - b[1])]);
    return p !== undefined && Math.abs(p[1]) <= MAX_LAT ? p : undefined;
  }

  /** Mercator coordinates (world = 1) at an output pixel position; NaN where there are none. */
  merc(x: number, y: number): [number, number] {
    const p = this.lnglat(x, y);
    if (p === undefined) return NAN2();
    const [lng0, lat] = p;
    const lng = this.referenceLng + remEuclid(lng0 - this.referenceLng + 540, 360) - 180;
    return [mercatorX(lng), mercatorY(lat)];
  }

  /** Whether nothing of the view is in the projection's domain. */
  isEmpty(): boolean {
    return this.nodes.length === 0;
  }

  /**
   * Mercator x of the projection's central meridian: drawn geometry is unwrapped to within
   * 0.5 of it, where the projection is continuous. `undefined` for longlat (continuous anywhere).
   */
  centralX(): number | undefined {
    return this.centralX_;
  }

  /**
   * Mercator x offsets (whole worlds) that bring the range `x0..x1` within 0.5 of the central
   * meridian, where its geometry lands on the map; two for a range across the antimeridian.
   * (Rust returns the inclusive range; here its values.)
   */
  branchShifts(x0: number, x1: number): number[] {
    const c = this.centralX_;
    if (c === undefined) return [0];
    const out: number[] = [];
    for (let k = asI32(Math.ceil(c - 0.5 - x1)); k <= asI32(Math.floor(c + 0.5 - x0)); k++) out.push(k);
    return out;
  }

  /**
   * Whether a Mercator point (world = 1) is on the map: within 180° of the central meridian
   * (not a world copy past the antimeridian) and projectable.
   */
  inDomain(p: [number, number]): boolean {
    return this.onMap(p) !== undefined;
  }

  /** `worldToScreen` of a Mercator point that is `inDomain`. */
  onMap(p: [number, number]): [number, number] | undefined {
    if (this.centralX_ !== undefined && Math.abs(p[0] - this.centralX_) > 0.5) return undefined;
    const s = this.worldToScreen(p);
    return Number.isFinite(s[0]) ? s : undefined;
  }

  /**
   * The output's pixel (0, 0) in a grid of the CRS's own: x = CRS x, y = −CRS y, both in output
   * device pixels. Anything laid out on it (e.g. image patterns) lines up across views of the
   * same resolution, such as neighboring tiles.
   */
  pixelOrigin(): [number, number] {
    const b = this.bbox;
    const ux = (b[2] - b[0]) / this.size[0];
    const uy = (b[3] - b[1]) / this.size[1];
    return [b[0] / ux, -b[3] / uy];
  }

  /**
   * Mercator (world = 1) → output device pixel. Longitudes are not folded: past the
   * antimeridian, points land beyond the edge of the map.
   */
  worldToScreen(p: [number, number]): [number, number] {
    const lat = mercatorLat(p[1]);
    const [x, y] = this.proj.forwardContinuous(p[0] * 360 - 180, lat);
    const b = this.bbox;
    return [((x - b[0]) / (b[2] - b[0])) * this.size[0], ((b[3] - y) / (b[3] - b[1])) * this.size[1]];
  }

  /**
   * Mercator coordinates (world = 1) of each output pixel center, row-major; NaN outside the
   * projection's domain. Interpolated in the mesh; exact in cells on the domain's edge (e.g.
   * a globe's limb), and NaN in cells with no corner in it.
   */
  pixelWorld(): [number, number][] {
    if (this.pixels !== undefined) return this.pixels;
    const [w, h] = this.size;
    const out: [number, number][] = new Array(w * h);
    if (this.isEmpty()) {
      for (let i = 0; i < w * h; i++) out[i] = NAN2();
      return (this.pixels = out);
    }
    const nodes = this.nodes;
    const cols = this.cols;
    let i = 0;
    for (let y = 0; y < h; y++) {
      const gy = (y + 0.5) / GRID;
      const j = Math.trunc(gy);
      const fy = gy - j;
      for (let x = 0; x < w; x++) {
        const gx = (x + 0.5) / GRID;
        const ii = Math.trunc(gx);
        const fx = gx - ii;
        const k = j * cols + ii;
        const a = nodes[k];
        const b = nodes[k + 1];
        const c = nodes[k + cols];
        const d = nodes[k + cols + 1];
        const lerp = (q: 0 | 1) => (a[q] * (1 - fx) + b[q] * fx) * (1 - fy) + (c[q] * (1 - fx) + d[q] * fx) * fy;
        const m: [number, number] = [lerp(0), lerp(1)];
        // A cell across the cut where longitudes unwrap (e.g. the meridian opposite
        // a polar view's reference point) spans about a world: exact too.
        const span = Math.max(a[0], b[0], c[0], d[0]) - Math.min(a[0], b[0], c[0], d[0]);
        if (Number.isFinite(m[0]) && span <= 0.5) out[i++] = m;
        else if (Number.isFinite(a[0]) || Number.isFinite(b[0]) || Number.isFinite(c[0]) || Number.isFinite(d[0]))
          out[i++] = this.merc(x + 0.5, y + 0.5);
        else out[i++] = NAN2();
      }
    }
    return (this.pixels = out);
  }

  /** Draws the Mercator picture `src` (rendered with `t`) over `dst`, then clears `src`. */
  composite(src: Target, t: Transform, dst: Target): void {
    const ws = t.worldSize;
    const pw = this.pixelWorld();
    for (let i = 0; i < pw.length; i++) {
      const m = pw[i];
      if (Number.isNaN(m[0])) continue;
      const [sx, sy] = t.worldToScreen([m[0] * ws, m[1] * ws]);
      const px = sample(src, sx - 0.5, sy - 0.5);
      if (px[0] !== 0 || px[1] !== 0 || px[2] !== 0 || px[3] !== 0) dst.blend(i, px);
    }
    src.px.fill(0);
  }
}

/** Bilinear sample of a premultiplied target at pixel-center coordinates; transparent outside. */
function sample(t: Target, x: number, y: number): Rgba {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const px = t.px;
  const at = (xi: number, yi: number, k: number): number => {
    if (xi < 0 || yi < 0 || xi >= t.w || yi >= t.h) return 0;
    return px[(yi * t.w + xi) * 4 + k] / 255;
  };
  const out: Rgba = [0, 0, 0, 0];
  for (let k = 0; k < 4; k++) {
    const a = at(x0, y0, k);
    const b = at(x0 + 1, y0, k);
    const c = at(x0, y0 + 1, k);
    const d = at(x0 + 1, y0 + 1, k);
    out[k] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }
  return out;
}
