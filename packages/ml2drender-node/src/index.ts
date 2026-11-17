/**
 * The ml2drender renderer as a native Node.js addon (Node-API).
 *
 * A {@link Renderer} draws views of a style, fetching the resources they need (or loading them
 * through `loadResource`). The work runs on libuv's thread pool, so the JavaScript thread stays
 * free and several renderers draw in parallel. It draws Web Mercator cameras, and boxes, tiles and cameras of a
 * CRS (PROJJSON); for reprojected sources for MapLibre GL JS, use the WebAssembly package `@ml2drender/wasm`, which
 * also runs in Node.js.
 *
 * @module
 */
import { createRequire } from 'node:module';
import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';

/**
 * A camera, of Web Mercator ({@link Renderer.renderView}) or of a CRS ({@link ProjectedRenderer.renderView}). Every
 * field is required.
 */
export interface View {
  /** Longitude of the center, in degrees. */
  lng: number;
  /** Latitude of the center, in degrees. */
  lat: number;
  /** MapLibre zoom: the world (in a CRS: tile 0/0/0 of its grid) is `512 * 2^zoom` CSS pixels wide. */
  zoom: number;
  /** Degrees clockwise from north (in a CRS: from its y axis) of the direction that is up. */
  bearing: number;
  /** Output width in CSS pixels. */
  width: number;
  /** Output height in CSS pixels. */
  height: number;
  /** Device pixels per CSS pixel: the image is `round(width * pixelRatio)` pixels wide. */
  pixelRatio: number;
  /** CSS pixels drawn around the view and cropped, so that labels near the edge are placed as in a larger map. */
  margin: number;
}

/** A CRS, with a tile grid for it: the `Crs` of `@ml2drender/wasm`, whose `name` is not read here. */
export interface Crs {
  /**
   * PROJJSON of a geographic or projected CRS (or of a bound or compound CRS of one). Supported methods: Transverse
   * Mercator, Mercator, Pseudo Mercator, Lambert Conic Conformal, Albers Equal Area, Polar and Oblique
   * Stereographic, Hotine Oblique Mercator, Lambert Azimuthal Equal Area, Azimuthal Equidistant, Orthographic,
   * Equidistant Cylindrical, Equal Earth, Mollweide, Robinson, Sinusoidal and PROJ's Geostationary Satellite,
   * without datum shifts.
   */
  projjson: object;
  /**
   * The CRS's tile grid, which a CRS does not have by itself. Required by `renderTile` and `renderView` (whose
   * zoom is the grid's); `render` of a box works without it.
   */
  tileMatrixSet?: TileMatrixSet;
}

/**
 * MapLibre GL JS's `TileMatrixSet` (`addProjection`): tile 0/0/0 is the square of side `extentAtZoom0` whose
 * top-left corner is `origin`, and each zoom splits every tile in four; x grows east, y south.
 */
export interface TileMatrixSet {
  /** CRS coordinates of the top-left corner of tile 0/0/0: [min x, max y]. */
  origin: [number, number];
  /** Width (= height) of tile 0/0/0 in CRS units. */
  extentAtZoom0: number;
}

/** A tile of a CRS's grid. Every field is required. */
export interface Tile {
  /** Zoom level: an integer in 0..=30. */
  z: number;
  /** Column, from the grid's west edge: an integer in 0..2^z. */
  x: number;
  /** Row, from the grid's north edge: an integer in 0..2^z. */
  y: number;
  /** Width and height in CSS pixels. */
  tileSize: number;
  /** Device pixels per CSS pixel: the image is `round(tileSize * pixelRatio)` pixels square. */
  pixelRatio: number;
  /** CSS pixels drawn around the tile and cropped, so that labels near the edge are placed as in a larger map. */
  margin: number;
}

/**
 * A box of a CRS (see {@link Renderer.projected}). Every field is required. Vector layers are drawn in it with
 * projected vertices; raster, hillshade and color-relief are rendered in Web Mercator and warped.
 */
export interface ProjectedBox {
  /** In CRS units (degrees for longlat), easting/longitude first whatever the CRS's axis order; the CRS's y axis is up. */
  bbox: [minX: number, minY: number, maxX: number, maxY: number];
  /** CSS pixels of the image's long side; the image has the box's aspect ratio. */
  size: number;
  /** Device pixels per CSS pixel. */
  pixelRatio: number;
  /** CSS pixels drawn around the view and cropped, so that labels near the edge are placed as in a larger map. */
  margin: number;
}

/** A {@link Renderer} drawing in a CRS (see {@link Renderer.projected}). */
export interface ProjectedRenderer {
  /**
   * `renderView` of a box of the CRS, in an image of its aspect ratio with `size * pixelRatio` pixels (rounded) on
   * the long side. A CRS the renderer does not support rejects.
   */
  render(box: ProjectedBox): Promise<Uint8Array>;
  /** `render` of tile `z/x/y` of the CRS's grid. Rejects without `crs.tileMatrixSet`. */
  renderTile(tile: Tile): Promise<Uint8Array>;
  /**
   * `render` of MapLibre GL JS's camera in the CRS (registered with `addProjection`): `lng` and `lat` in degrees
   * in the middle, tile 0/0/0 of the grid in 512 CSS pixels at zoom 0, turned around the center by `bearing`.
   * Rejects without `crs.tileMatrixSet`, and for a center outside the CRS.
   */
  renderView(view: View): Promise<Uint8Array>;
}

/** Options of {@link Renderer}. */
export interface RendererOptions {
  /**
   * Load bytes for a URL, or `null` for a missing resource (HTTP 404). Other failures must
   * reject. Use this for authentication, caching, retries or non-HTTP resources. URLs are passed
   * through as written in the style. Loads within each stage run concurrently. Default: `fetch`.
   */
  loadResource?: (url: string) => Promise<Uint8Array | null>;
}

/** The addon's sans-IO renderer. Calls on one renderer must not overlap. */
interface NativeRenderer {
  setView(view: View): void;
  /** Throws for a CRS the renderer does not support. */
  setProjectedView(view: ProjectedBox & { projjson: string }): void;
  setProjectedTile(projjson: string, grid: TileMatrixSet, tile: Tile): void;
  setProjectedCamera(projjson: string, grid: TileMatrixSet, view: View): void;
  /** URLs still needed: sources, then tiles, then glyph ranges, each stage found from the last. */
  needs(): Promise<string[]>;
  /** `null` is a missing resource. The bytes are read in place until this resolves. */
  provide(url: string, bytes: Uint8Array | null): Promise<void>;
  /** `oldest` is the oldest ticket of renders in progress; 0 without tickets. */
  render(oldest: number): Promise<Uint8Array>;
}

interface Binding {
  Renderer: new (style: string) => NativeRenderer;
  encodePng(rgba: Uint8Array, width: number, height: number): Promise<Uint8Array>;
  encodeWebp(rgba: Uint8Array, width: number, height: number): Promise<Uint8Array>;
  encodeJpeg(rgba: Uint8Array, width: number, height: number, quality: number): Promise<Uint8Array>;
}

/** The npm package with the addon for this platform. */
const target = `@ml2drender/node-${process.platform}-${process.arch}${process.platform === 'linux' ? '-gnu' : ''}`;

function load(): Binding {
  const require = createRequire(import.meta.url);
  // A build from this repository (`pnpm build:native`), else the published addon.
  try {
    return require(`../native/ml2drender.${process.platform}-${process.arch}.node`);
  } catch (error) {
    if ((error as { code?: string }).code !== 'MODULE_NOT_FOUND') throw error;
  }
  try {
    return require(target);
  } catch (error) {
    throw new Error(`@ml2drender/node: no prebuilt addon for this platform (${target}). Use the WebAssembly package @ml2drender/wasm instead.`, { cause: error });
  }
}

const binding = load();

async function fetchResource(url: string): Promise<Uint8Array | null> {
  const response = await fetch(url);
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 404) return null;
    throw new Error(`Resource fetch failed: HTTP ${response.status} ${url}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

function styleJson(style: StyleSpecification): string {
  // A JSON string would stringify to a valid, empty style and draw nothing.
  if (!style || typeof style !== 'object' || !Array.isArray(style.layers)) throw new TypeError('style must be a style object with layers');
  return JSON.stringify(style);
}

/**
 * A style fixed at creation, drawn for any number of views. Decoded resources and tiles are kept
 * and reused by later renders.
 *
 * @example
 * ```ts
 * const renderer = new Renderer(style);
 * const rgba = await renderer.renderView({ lng: 139.767, lat: 35.681, zoom: 5, bearing: 0, width: 512, height: 512, pixelRatio: 1, margin: 0 });
 * ```
 */
export class Renderer {
  readonly #style: string;
  readonly #loadResource: NonNullable<RendererOptions['loadResource']>;
  #native: NativeRenderer | undefined;
  #queue: Promise<unknown> = Promise.resolve();

  /**
   * @param style - The style, with absolute resource URLs. Throws a `TypeError` if it is not a style object.
   */
  constructor(style: StyleSpecification, options: RendererOptions = {}) {
    this.#style = styleJson(style);
    this.#loadResource = options.loadResource ?? fetchResource;
  }

  /**
   * Non-premultiplied RGBA8 pixels of `view`, row by row, after loading the resources it needs.
   * Loading and rendering errors reject. Renders of one renderer take turns; use several
   * renderers to draw in parallel.
   */
  renderView(view: View): Promise<Uint8Array> {
    return this.#enqueue((native) => native.setView(view));
  }

  /**
   * This renderer drawing in `crs`. Resources loaded for one CRS serve the others, and Web Mercator views, too.
   * Throws a `TypeError` if `crs.projjson` is not a PROJJSON object.
   */
  projected(crs: Crs): ProjectedRenderer {
    if (!crs.projjson || typeof crs.projjson !== 'object') throw new TypeError('crs.projjson must be a PROJJSON object');
    const projjson = JSON.stringify(crs.projjson);
    const grid = (): TileMatrixSet => {
      if (!crs.tileMatrixSet) throw new TypeError('crs.tileMatrixSet is required for tiles and cameras');
      return crs.tileMatrixSet;
    };
    return {
      render: ({ bbox, size, pixelRatio, margin }) =>
        this.#enqueue((native) => native.setProjectedView({ bbox, size, pixelRatio, margin, projjson })),
      renderTile: (tile) => this.#enqueue((native) => native.setProjectedTile(projjson, grid(), tile)),
      renderView: (view) => this.#enqueue((native) => native.setProjectedCamera(projjson, grid(), view)),
    };
  }

  #enqueue(setView: (native: NativeRenderer) => void): Promise<Uint8Array> {
    // The native renderer takes one call at a time and has one view.
    const rgba = this.#queue.then(() => this.#draw(setView));
    this.#queue = rgba.catch(() => {});
    return rgba;
  }

  async #draw(setView: (native: NativeRenderer) => void): Promise<Uint8Array> {
    const native = this.#native ??= new binding.Renderer(this.#style);
    setView(native);
    for (let round = 0; ; round++) {
      const urls = await native.needs();
      if (urls.length === 0) break;
      if (round >= 32) throw new Error('Resource requests did not settle');
      const resources = await Promise.all(urls.map((url) => this.#loadResource(url)));
      // Only fetching overlaps: calls on the native renderer must be awaited one at a time.
      for (let i = 0; i < urls.length; i++) await native.provide(urls[i], resources[i]);
    }
    return native.render(0);
  }
}

/** Lossless PNG of RGBA8 pixels. Runs on the thread pool; don't modify `rgba` until it resolves. */
export const encodePng: (rgba: Uint8Array, width: number, height: number) => Promise<Uint8Array> = binding.encodePng;

/** Lossless WebP of RGBA8 pixels. Runs on the thread pool; don't modify `rgba` until it resolves. */
export const encodeWebp: (rgba: Uint8Array, width: number, height: number) => Promise<Uint8Array> = binding.encodeWebp;

/**
 * JPEG of RGBA8 pixels at `quality` (1–100), flattened over black. Runs on the thread pool; don't
 * modify `rgba` until it resolves.
 */
export const encodeJpeg: (rgba: Uint8Array, width: number, height: number, quality: number) => Promise<Uint8Array> = binding.encodeJpeg;
