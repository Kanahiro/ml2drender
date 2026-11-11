// Tile IDs, Web Mercator math, visible tile covering and tile URL templates.

import type {Warp} from './reproject.ts';
import {asI32, roundAway} from './util.ts';

export class TileId {
  z: number;
  x: number;
  y: number;
  constructor(z: number, x: number, y: number) {
    this.z = z;
    this.x = x;
    this.y = y;
  }

  parentAt(z: number): TileId {
    const d = this.z - z;
    return new TileId(z, this.x >>> d, this.y >>> d);
  }

  key(): string {
    return `${this.z}/${this.x}/${this.y}`;
  }
}

/** A tile as rendered: `canonical` data drawn at `overscaledZ`, shifted by `wrap` worlds. */
export interface RenderTile {
  overscaledZ: number;
  wrap: number;
  canonical: TileId;
}

export const renderTileKey = (t: RenderTile): string => `${t.overscaledZ}/${t.wrap}/${t.canonical.key()}`;

const DEG = 180 / Math.PI;

export const mercatorX = (lng: number): number => (180 + lng) / 360;

export const mercatorY = (lat: number): number =>
  (180 - DEG * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360;

/** Latitude (degrees) at Mercator y (world = 1), the inverse of `mercatorY`. */
export const mercatorLat = (y: number): number => Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * DEG;

export const MAX_LAT = 85.051129;
/** MapLibre's minimum zoom: views are clamped to it. */
export const MIN_ZOOM = -2;

const clampF = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

/**
 * Camera for a 2D Web Mercator map: world coordinates are in CSS pixels at `zoom`
 * (world is `512 * 2^zoom` wide), screen coordinates in device pixels.
 */
export class Transform {
  zoom: number;
  worldSize: number;
  /** World-pixel position of the screen center. */
  center: [number, number];
  bearingRad: number;
  width: number;
  height: number;
  pixelRatio: number;
  /** Original viewport size, preserved for raster pixel alignment when adding coverage. */
  viewportSize: [number, number];
  /** sin/cos of `bearingRad` and of `-bearingRad`, for per-point projections. */
  rot: [[number, number], [number, number]];
  /**
   * Set on the transform symbols are placed and drawn with in a projected view: world
   * positions then map to the projected output instead (see `reproject.ts`).
   */
  warp: Warp | undefined;

  constructor(center: [number, number], zoom: number, bearingDeg: number, width: number, height: number, pixelRatio: number) {
    const worldSize = 512 * Math.pow(2, zoom);
    const lat = clampF(center[1], -MAX_LAT, MAX_LAT);
    const c: [number, number] = [mercatorX(center[0]) * worldSize, mercatorY(lat) * worldSize];
    // Like MapLibre's `_constrain` for an unrotated mercator map: keep the world filling
    // the viewport vertically when it is tall enough.
    if (worldSize >= height) {
      const half = height / 2;
      c[1] = clampF(c[1], half, worldSize - half);
    } else {
      c[1] = worldSize / 2;
    }
    const bearingRad = -bearingDeg * (Math.PI / 180);
    this.zoom = zoom;
    this.worldSize = worldSize;
    this.center = c;
    this.bearingRad = bearingRad;
    this.width = width;
    this.height = height;
    this.pixelRatio = pixelRatio;
    this.viewportSize = [width, height];
    this.rot = [
      [Math.sin(bearingRad), Math.cos(bearingRad)],
      [Math.sin(-bearingRad), Math.cos(-bearingRad)],
    ];
    this.warp = undefined;
  }

  clone(): Transform {
    const t: Transform = Object.assign(Object.create(Transform.prototype), this);
    t.center = [...this.center];
    t.viewportSize = [...this.viewportSize];
    return t;
  }

  /** Extend coverage without constraining the camera again or shifting its pixel grid. */
  setMargin(margin: number): void {
    const m = roundAway(margin * this.pixelRatio) / this.pixelRatio;
    this.width = this.viewportSize[0] + 2 * m;
    this.height = this.viewportSize[1] + 2 * m;
  }

  /**
   * This Mercator camera's world drawn into `warp`'s projected output, for the layers drawn
   * from vertices (background, fill, line, circle, heatmap, symbol).
   */
  reprojected(warp: Warp): Transform {
    const [width, height] = warp.cssSize;
    const t = this.clone();
    t.width = width;
    t.height = height;
    t.viewportSize = [width, height];
    t.warp = warp;
    return t;
  }

  /**
   * Whether world positions map to a projected output (`reprojected`), where straight
   * segments curve and pixel lengths need `localFrame`.
   */
  isProjected(): boolean {
    return this.warp !== undefined;
  }

  /** Mercator coordinates (world = 1) of each output pixel center of a projected output. */
  pixelWorld(): [number, number][] | undefined {
    return this.warp?.pixelWorld();
  }

  /** See `Warp.pixelOrigin`. */
  pixelOrigin(): [number, number] | undefined {
    return this.warp?.pixelOrigin();
  }

  /** See `Warp.centralX`. */
  centralX(): number | undefined {
    return this.warp?.centralX();
  }

  /** Whether world point `p` is on a projected output's map (see `Warp.inDomain`); always for Mercator. */
  inDomain(p: [number, number]): boolean {
    return this.warp === undefined || this.warp.inDomain([p[0] / this.worldSize, p[1] / this.worldSize]);
  }

  /** `worldToScreen` of world point `p` if it is `inDomain`, projecting it once. */
  onMap(p: [number, number]): [number, number] | undefined {
    if (this.warp) return this.warp.onMap([p[0] / this.worldSize, p[1] / this.worldSize]);
    return this.worldToScreen(p);
  }

  /**
   * Screen position of world point `p` and the rotation [sin, cos] from world to screen
   * directions there: in a projected output, the rotation nearest the projection's local
   * Jacobian, for offsets given in screen pixels (line widths) around projected points.
   */
  localFrame(p: [number, number]): [[number, number], [number, number]] {
    const s = this.worldToScreen(p);
    if (this.warp === undefined) return [s, this.rot[0]];
    const ex = this.worldToScreen([p[0] + 1, p[1]]);
    const ey = this.worldToScreen([p[0], p[1] + 1]);
    const [a, c, b, d] = [ex[0] - s[0], ex[1] - s[1], ey[0] - s[0], ey[1] - s[1]];
    const angle = Math.atan2(c - b, a + d);
    return [s, Number.isFinite(angle) ? [Math.sin(angle), Math.cos(angle)] : [0, 1]];
  }

  /** World pixel (CSS) → screen device pixel. */
  worldToScreen(p: [number, number]): [number, number] {
    if (this.warp) return this.warp.worldToScreen([p[0] / this.worldSize, p[1] / this.worldSize]);
    const dx = p[0] - this.center[0];
    const dy = p[1] - this.center[1];
    const [s, c] = this.rot[0];
    return [(dx * c - dy * s + this.width / 2) * this.pixelRatio, (dx * s + dy * c + this.height / 2) * this.pixelRatio];
  }

  /**
   * World-space shift of MapLibre's pixel-aligned projection (`_alignedProjMatrix`), used
   * for rasters: rounds the center to the pixel grid, with half-pixel corrections for odd
   * viewport sizes rotated by the bearing.
   */
  alignedOffset(): [number, number] {
    const [x, y] = this.center;
    const xShift = (this.viewportSize[0] % 2) / 2;
    const yShift = (this.viewportSize[1] % 2) / 2;
    const bearing = -this.bearingRad;
    const cos = Math.cos(bearing);
    const sin = Math.sin(-bearing);
    const dx = x - Math.round(x) + cos * xShift + sin * yShift;
    const dy = y - Math.round(y) + cos * yShift + sin * xShift;
    return [dx > 0.5 ? dx - 1 : dx, dy > 0.5 ? dy - 1 : dy];
  }

  /** Screen device pixel → world pixel (CSS). */
  screenToWorld(p: [number, number]): [number, number] {
    const x = p[0] / this.pixelRatio - this.width / 2;
    const y = p[1] / this.pixelRatio - this.height / 2;
    const [s, c] = this.rot[1];
    return [x * c - y * s + this.center[0], x * s + y * c + this.center[1]];
  }

  /** Tile zoom for a source with `tileSize` (MapLibre `coveringZoomLevel`). */
  coveringZoom(tileSize: number, round: boolean): number {
    const z = this.zoom + Math.log2(512 / tileSize);
    const r = round ? roundAway(z) : Math.floor(z);
    return asI32(r !== r ? 0 : Math.max(r, 0));
  }

  /** Tiles at `z` (unclamped, possibly wrapped x) intersecting the viewport, as [x, y, wrap]. */
  coveringTiles(z: number): [number, number, number][] {
    const corners = [
      [0, 0],
      [this.width, 0],
      [0, this.height],
      [this.width, this.height],
    ].map(([x, y]) => this.screenToWorld([x * this.pixelRatio, y * this.pixelRatio]));
    const scale = Math.pow(2, z) / this.worldSize;
    let [x0, y0, x1, y1] = [Number.MAX_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE, -Number.MAX_VALUE];
    for (const c of corners) {
      x0 = fmin(x0, c[0] * scale);
      y0 = fmin(y0, c[1] * scale);
      x1 = fmax(x1, c[0] * scale);
      y1 = fmax(y1, c[1] * scale);
    }
    const n = 1 << z;
    const out: [number, number, number][] = [];
    const tyEnd = Math.min(asI32(Math.ceil(y1)) - 1, n - 1);
    const txEnd = asI32(Math.ceil(x1)) - 1;
    for (let ty = Math.max(asI32(Math.floor(y0)), 0); ty <= tyEnd; ty++) {
      for (let tx = asI32(Math.floor(x0)); tx <= txEnd; tx++) {
        const wrap = Math.floor(tx / n);
        out.push([tx - wrap * n, ty, wrap]);
      }
    }
    return out;
  }
}

/** Rust `f64::min` / `max`: a NaN argument yields the other one. */
const fmin = (a: number, b: number): number => (a !== a ? b : b !== b ? a : Math.min(a, b));
const fmax = (a: number, b: number): number => (a !== a ? b : b !== b ? a : Math.max(a, b));

/** Fill a tile URL template. */
export function tileUrl(templates: string[], id: TileId, schemeTms: boolean): string {
  const t = templates[(id.x + id.y) % Math.max(templates.length, 1)];
  const y = schemeTms ? 2 ** id.z - 1 - id.y : id.y;
  let quadkey = '';
  for (let z = id.z; z >= 1; z--) {
    const mask = 1 << (z - 1);
    quadkey += String(((id.x & mask) !== 0 ? 1 : 0) + 2 * ((id.y & mask) !== 0 ? 1 : 0));
  }
  const size = (2 * Math.PI * 6378137) / 2 ** id.z;
  const minX = id.x * size - Math.PI * 6378137;
  const maxY = Math.PI * 6378137 - id.y * size;
  // JS number formatting (as upstream joins the numbers); Rust's `{}` never uses exponents.
  const bbox = `${minX},${maxY - size},${minX + size},${maxY}`;
  return t
    .replaceAll('{prefix}', `${(id.x % 16).toString(16)}${(id.y % 16).toString(16)}`)
    .replaceAll('{z}', String(id.z))
    .replaceAll('{x}', String(id.x))
    .replaceAll('{y}', String(y))
    .replaceAll('{quadkey}', quadkey)
    .replaceAll('{bbox-epsg-3857}', bbox)
    .replaceAll('{ratio}', '');
}
