import type { FillExtrusionLayerSpecification, FillLayerSpecification, LayerSpecification, StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import { Renderer, View as CoreView } from './core/renderer.ts';
import { Projection as CoreProjection } from './core/projection.ts';
import { encodePng } from './core/encode.ts';
import { encodeWebp } from './core/webp.ts';

/** A Web Mercator camera. */
export interface View {
  center: [lng: number, lat: number];
  zoom: number;
  bearing?: number;
  width: number;
  height: number;
  pixelRatio?: number;
  /** Non-negative integer CSS pixels of extra coverage, cropped from the output. Default: 0. */
  margin?: number;
}

/** An XYZ tile of the Web Mercator grid (`tileSize` CSS pixels square). */
export interface TileView {
  z: number;
  x: number;
  y: number;
  /** CSS pixels. Default: 256. */
  tileSize?: number;
  pixelRatio?: number;
  /** Non-negative integer CSS pixels of extra coverage, cropped from the output. Default: 0. */
  margin?: number;
}

/**
 * A longitude/latitude box in Web Mercator. The image has the box's aspect ratio, `size` on its long side,
 * at the zoom that fits the box into it.
 */
export interface LngLatView {
  /** Degrees; `west > east` crosses the antimeridian. Latitudes are clamped to Web Mercator's ±85.0511°. */
  bbox: [west: number, south: number, east: number, north: number];
  /** Positive integer CSS pixels of the image's long side. */
  size: number;
  pixelRatio?: number;
  /** Non-negative integer CSS pixels of extra coverage, cropped from the output. Default: 0. */
  margin?: number;
}

/**
 * A box of a projected CRS. Vector layers (background, fill, line, circle, heatmap, symbol) are drawn in it
 * with projected vertices; raster, hillshade and color-relief are rendered in Web Mercator and warped.
 */
export interface ProjectedView {
  /**
   * PROJJSON of a geographic or projected CRS. Supported methods: Transverse Mercator, Mercator, Pseudo Mercator,
   * Lambert Conic Conformal, Polar Stereographic, Lambert Azimuthal Equal Area, Equal Earth and PROJ's
   * Geostationary Satellite, without datum shifts.
   */
  projjson: object;
  /** In CRS units (degrees for longlat), always easting/longitude first whatever the CRS's axis order. */
  bbox: [minX: number, minY: number, maxX: number, maxY: number];
  width: number;
  height: number;
  pixelRatio?: number;
  /** Non-negative integer CSS pixels of extra coverage, cropped from the output. Default: 0. */
  margin?: number;
}

export interface RenderedImage {
  width: number;
  height: number;
  /** Row-major, 8-bit RGBA pixels. */
  data: Uint8ClampedArray<ArrayBuffer>;
  /** Encode `data` as an owned, lossless RGBA8 PNG. */
  toPng(): Uint8Array<ArrayBuffer>;
  /** Encode `data` as an owned, lossless WebP. */
  toWebp(): Uint8Array<ArrayBuffer>;
}

/** Style Spec layers supported by the 2D renderer. */
export type StyleLayer = Exclude<LayerSpecification, FillExtrusionLayerSpecification>;

export type FillExtrusionLayer = FillExtrusionLayerSpecification;
export type { StyleSpecification };

export interface InitOptions {
  /** Load complete resource bytes, or null for a missing resource (HTTP 404). Other failures must reject. */
  loadResource?: (url: string) => Promise<Uint8Array<ArrayBuffer> | null>;
  /**
   * Decoded resources (tiles and their layer geometry, sprites, glyphs) are kept inside the
   * renderer and reused by later renders; the first render ttlMs or more after they started
   * being kept drops them. 0 disables reuse, Infinity never expires. Default: 5 minutes.
   * Fetched bytes are not cached: rely on the HTTP cache, or cache in `loadResource`.
   */
  cache?: { ttlMs?: number };
  /** Replace each fill-extrusion layer. Defaults to a fill preserving its 2D appearance. */
  transformFillExtrusion?: (layer: FillExtrusionLayer) => StyleLayer;
}

/** A CRS's projection, computed by the renderer itself. */
export interface Projection {
  /** `[lng, lat]` in degrees → `[x, y]` in CRS units; NaN where the CRS has no point (e.g. the far side of a geostationary view). */
  forward(lngLat: number[]): number[];
  /** `[x, y]` → `[lng, lat]` in degrees; NaN outside the projection's domain. */
  inverse(xy: number[]): number[];
}

type ViewArgs = [lng: number, lat: number, zoom: number, bearing: number, width: number, height: number, pixelRatio: number, margin: number];

/** A core renderer shared by overlapping renders; dropped once retired. */
interface Core {
  renderer: Renderer;
  createdAt: number;
  active: number;
  retired: boolean;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const SUPPORTED_LAYERS = new Set<string>([
  'background', 'fill', 'line', 'circle', 'raster', 'symbol', 'hillshade', 'color-relief', 'heatmap',
] satisfies StyleLayer['type'][]);

async function fetchResource(url: string): Promise<Uint8Array<ArrayBuffer> | null> {
  const response = await fetch(url);
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 404) return null;
    throw new Error(`Resource fetch failed: HTTP ${response.status} ${url}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Load a PROJJSON CRS the way `renderProjected` reads `ProjectedView.projjson`, e.g. to compute
 * tile bounds or to register the CRS with MapLibre's `addProjection`, so both agree on the CRS.
 * Throws for a CRS the renderer does not support.
 */
export async function loadProjection(projjson: object): Promise<Projection> {
  return createProjection(projjson);
}

/**
 * A synchronous `loadProjection`, for hosts that must build a projection without awaiting, such
 * as MapLibre's worker `setProjectionHandler`.
 */
export async function loadProjectionFactory(): Promise<(projjson: object) => Projection> {
  return createProjection;
}

function createProjection(projjson: object): Projection {
  if (!projjson || typeof projjson !== 'object') throw new TypeError('projjson must be a PROJJSON object');
  const p = CoreProjection.parse(JSON.stringify(projjson));
  return {
    forward: ([lng, lat]) => p.forward(lng, lat),
    inverse: ([x, y]) => p.inverse([x, y]) ?? [NaN, NaN],
  };
}

function viewArgs(view: View): ViewArgs {
  const [lng, lat] = view.center;
  for (const [name, value] of Object.entries({ lng, lat, zoom: view.zoom, bearing: view.bearing ?? 0 })) {
    if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
  }
  return [lng, lat, view.zoom, view.bearing ?? 0, ...sizeArgs(view), marginArg(view.margin)];
}

/** Width and height (positive uint32 integers) and a finite, positive pixel ratio. */
function sizeArgs({ width, height, pixelRatio = 1 }: { width: number; height: number; pixelRatio?: number }): [number, number, number] {
  for (const [name, value] of [['width', width], ['height', height]] as const) {
    if (!Number.isInteger(value) || value < 1 || value > 0xffffffff) throw new RangeError(`${name} must be a positive uint32 integer`);
  }
  if (!Number.isFinite(pixelRatio) || pixelRatio <= 0) throw new RangeError('pixelRatio must be finite and positive');
  return [width, height, pixelRatio];
}

function tileView({ z, x, y, tileSize = 256, pixelRatio, margin }: TileView): View {
  const n = 2 ** z;
  if (!Number.isInteger(z) || z < 0 || z > 30) throw new RangeError('z must be an integer in 0..=30');
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= n || y >= n) throw new RangeError('x and y must be integers in 0..2^z');
  if (!Number.isInteger(tileSize) || tileSize < 1) throw new RangeError('tileSize must be a positive integer');
  return {
    center: [((x + 0.5) / n) * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n))) * 180 / Math.PI],
    // MapLibre's zoom puts the world in 512 CSS pixels at zoom 0.
    zoom: z + Math.log2(tileSize / 512),
    width: tileSize,
    height: tileSize,
    pixelRatio,
    margin,
  };
}

const MAX_LAT = 85.0511287798066;

function fitLngLat({ bbox: [west, south, east, north], size, pixelRatio, margin }: LngLatView): View {
  if (!Number.isInteger(size) || size < 1 || size > 0xffffffff) throw new RangeError('size must be a positive uint32 integer');
  if (east < west) east += 360;
  [south, north] = [south, north].map((lat) => Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)));
  if (!(east > west && north > south)) throw new RangeError('bbox must be [west, south, east, north] with a non-empty area');
  // Web Mercator y in world units (0 at the north edge, 1 at the south edge).
  const my = (lat: number) => (1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2;
  const [y0, y1] = [my(north), my(south)];
  const [dx, dy] = [(east - west) / 360, y1 - y0];
  // CSS pixels per world: the long side spans `size`.
  const scale = size / Math.max(dx, dy);
  const lng = (west + east) / 2;
  return {
    center: [lng > 180 ? lng - 360 : lng, Math.atan(Math.sinh(Math.PI * (1 - (y0 + y1)))) * 180 / Math.PI],
    zoom: Math.log2(scale / 512),
    width: Math.max(1, Math.round(dx * scale)),
    height: Math.max(1, Math.round(dy * scale)),
    pixelRatio,
    margin,
  };
}

function marginArg(value = 0): number {
  const margin = nonnegative(value, 'margin');
  if (!Number.isInteger(margin) || margin > 0xffffffff) throw new RangeError('margin must be a uint32 integer');
  return margin;
}

function nonnegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a finite, non-negative number`);
  return value;
}

function flattenFillExtrusion(layer: FillExtrusionLayer): FillLayerSpecification {
  const { type, paint, layout, ...base } = layer;
  // Shared paint properties have the same defaults; leaving absent values unset
  // preserves them without duplicating Style Spec defaults. Expressions stay intact.
  return {
    ...base,
    type: 'fill',
    layout: { visibility: layout?.visibility },
    paint: {
      'fill-color': paint?.['fill-extrusion-color'],
      'fill-opacity': paint?.['fill-extrusion-opacity'],
      'fill-pattern': paint?.['fill-extrusion-pattern'],
      'fill-translate': paint?.['fill-extrusion-translate'],
      'fill-translate-anchor': paint?.['fill-extrusion-translate-anchor'],
      'fill-color-transition': paint?.['fill-extrusion-color-transition'],
      'fill-opacity-transition': paint?.['fill-extrusion-opacity-transition'],
      'fill-pattern-transition': paint?.['fill-extrusion-pattern-transition'],
      'fill-translate-transition': paint?.['fill-extrusion-translate-transition'],
    },
  };
}

function prepareStyle(style: StyleSpecification, transform: NonNullable<InitOptions['transformFillExtrusion']> = flattenFillExtrusion): string {
  if (!style || typeof style !== 'object' || !Array.isArray(style.layers)) {
    throw new Error('Style must contain a layers array');
  }
  const layers = style.layers.map((layer: unknown) => {
    if (!layer || typeof layer !== 'object' || !('type' in layer) || layer.type !== 'fill-extrusion') return layer;
    const replacement = transform(layer as FillExtrusionLayer);
    if (!replacement || typeof replacement.id !== 'string' || !SUPPORTED_LAYERS.has(replacement.type)) {
      throw new Error(`Invalid replacement for fill-extrusion layer ${'id' in layer ? String(layer.id) : ''}`);
    }
    return replacement;
  });
  return JSON.stringify({ ...style, layers });
}

/** Render a MapLibre Style as a static 2D RGBA image. */
export class MapRenderer {
  private core?: Core;
  /** Fetches in flight, shared by overlapping renders, with the newest ticket that awaits each. */
  private readonly pending = new Map<string, { request: Promise<void>; ticket: number }>();
  /** Tickets of the renders in progress: the core keeps the tiles they need (`setTicket`). */
  private readonly tickets = new Set<number>();
  private lastTicket = 0;
  private readonly style: string;
  private readonly loadResource: NonNullable<InitOptions['loadResource']>;
  private readonly ttlMs: number;

  private constructor(style: string, loadResource: NonNullable<InitOptions['loadResource']>, ttlMs: number) {
    this.style = style;
    this.loadResource = loadResource;
    this.ttlMs = ttlMs;
  }

  /** Snapshot a style object and load the renderer. Resource URLs are passed to `loadResource` as written. */
  static async init(style: StyleSpecification, options: InitOptions = {}): Promise<MapRenderer> {
    const ttlMs = options.cache?.ttlMs ?? DEFAULT_TTL_MS;
    if (ttlMs !== Infinity) nonnegative(ttlMs, 'cache.ttlMs');
    const loadResource = options.loadResource ?? fetchResource;
    return new MapRenderer(prepareStyle(style, options.transformFillExtrusion), loadResource, ttlMs);
  }

  /** Fetch required resources and return a new RGBA image of a Web Mercator camera. */
  async renderView(view: View): Promise<RenderedImage> {
    const [lng, lat, zoom, bearing, width, height, pixelRatio, margin] = viewArgs(view);
    const coreView = new CoreView([lng, lat], zoom, bearing, width, height, pixelRatio, margin);
    return this.draw(view, coreView, (r) => r.setView(coreView));
  }

  /** `renderView` of an XYZ tile of the Web Mercator grid. */
  async renderZxy(tile: TileView): Promise<RenderedImage> {
    return this.renderView(tileView(tile));
  }

  /** `renderView` of a longitude/latitude box, `view.size` CSS pixels on the long side. */
  async renderLngLat(view: LngLatView): Promise<RenderedImage> {
    return this.renderView(fitLngLat(view));
  }

  /** Fetch required resources and return a new RGBA image of `view.bbox` in the CRS `view.projjson`. */
  async renderProjected(view: ProjectedView): Promise<RenderedImage> {
    if (!view.projjson || typeof view.projjson !== 'object') throw new TypeError('projjson must be a PROJJSON object');
    const margin = marginArg(view.margin);
    const [width, height, pixelRatio] = sizeArgs(view);
    if (!view.bbox.every(Number.isFinite)) throw new RangeError('bbox must be finite');
    const projected = { projjson: JSON.stringify(view.projjson), bbox: [...view.bbox] as [number, number, number, number], width, height, pixelRatio, margin };
    // The initial camera is replaced before the first `needs`.
    const initial = new CoreView([0, 0], 0, 0, width, height, pixelRatio, 0);
    return this.draw(view, initial, (r) => r.setProjectedView(projected));
  }

  /** The fetch-and-render loop of Mercator and projected views; `setView` points a core at the view. */
  private async draw(view: View | ProjectedView, initial: CoreView, setView: (r: Renderer) => void): Promise<RenderedImage> {
    const core = this.acquire(initial);
    const ticket = ++this.lastTicket;
    this.tickets.add(ticket);
    let out: { width: number; height: number; data: Uint8Array };
    try {
      // Other renders may move the camera while this one awaits resources.
      for (let round = 0; ; round++) {
        setView(core.renderer);
        core.renderer.setTicket(ticket);
        const needs = core.renderer.needs();
        if (needs.length === 0) break;
        if (round >= 32) throw new Error('Resource requests did not settle');
        await Promise.all(needs.map(({ url }) => this.fetch(core, url, ticket)));
      }
      // Tickets increase, so the first in the set is the oldest in progress.
      const oldest = this.tickets.values().next().value!;
      out = core.renderer.renderRetaining(oldest);
    } finally {
      this.tickets.delete(ticket);
      this.release(core);
    }
    const width = Math.round(view.width * (view.pixelRatio ?? 1));
    const height = Math.round(view.height * (view.pixelRatio ?? 1));
    const bytes = out.data;
    const data = new Uint8ClampedArray(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
    return {
      width,
      height,
      data,
      toPng: () => encodePng(bytes, width, height) as Uint8Array<ArrayBuffer>,
      toWebp: () => encodeWebp(bytes, width, height) as Uint8Array<ArrayBuffer>,
    };
  }

  /**
   * Fetch `url` once and provide it to `core`, which requested it, before it leaves `pending`. It is
   * kept for the newest render awaiting it: while any of them is in progress, the oldest ticket in
   * progress is at most that one.
   */
  private fetch(core: Core, url: string, ticket: number): Promise<void> {
    const shared = this.pending.get(url);
    if (shared) {
      shared.ticket = Math.max(shared.ticket, ticket);
      return shared.request;
    }
    const entry = { ticket, request: Promise.resolve() };
    entry.request = this.loadResource(url).then((bytes) => {
      // A retired core no render uses any more is dropped; its successor fetches again.
      if (core.retired && core.active === 0) return;
      core.renderer.setTicket(entry.ticket);
      core.renderer.provide(url, bytes ?? undefined);
    }).finally(() => this.pending.delete(url));
    this.pending.set(url, entry);
    return entry.request;
  }

  /** The current core renderer, replaced once older than the cache TTL. */
  private acquire(view: CoreView): Core {
    const now = performance.now();
    if (this.core && now - this.core.createdAt >= this.ttlMs) {
      this.core.retired = true;
      this.core = undefined;
    }
    if (!this.core) {
      this.core = { renderer: new Renderer(this.style, view), createdAt: now, active: 0, retired: false };
    }
    this.core.active++;
    return this.core;
  }

  private release(core: Core) {
    core.active--;
  }
}
