/**
 * The ml2drender renderer as a native Node.js addon (Node-API).
 *
 * This is the low-level sans-IO renderer: the host fetches every resource itself, in a loop of
 * {@link Renderer.needs} → fetch → {@link Renderer.provide}, then calls {@link Renderer.render}.
 * The work runs on libuv's thread pool, so the JavaScript thread stays free and several renderers
 * draw in parallel. It draws Web Mercator views only; for projected CRSs, reprojected sources and
 * resource fetching, use the WebAssembly package `@ml2drender/wasm`, which also runs in Node.js.
 *
 * @module
 */
import { createRequire } from 'node:module';

/** A Web Mercator camera. Every field is required. */
export interface View {
  /** Longitude of the center, in degrees. */
  lng: number;
  /** Latitude of the center, in degrees. */
  lat: number;
  /** MapLibre zoom: the world is `512 * 2^zoom` CSS pixels wide. */
  zoom: number;
  /** Degrees clockwise. */
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

/**
 * A style fixed at creation, drawn for a view once the resources it needs are provided.
 *
 * Calls on one renderer must not overlap: await each before the next.
 */
export interface Renderer {
  /** Point the renderer at another camera, keeping the resources and tiles it has. */
  setView(view: View): void;
  /**
   * Number the render about to run, for {@link Renderer.render}'s `oldest`. Only hosts that
   * interleave renders of several views on one renderer need it.
   */
  setTicket(ticket: number): void;
  /**
   * Whether to keep line and fill geometry between renders (default: true). `false` frees it as
   * soon as the last layer using it is drawn, lowering peak memory for one-off renders.
   */
  setKeepBuckets(keep: boolean): void;
  /**
   * URLs still needed before {@link Renderer.render}: the style's TileJSON, GeoJSON, sprites and
   * images, then tiles, then glyph ranges. Resources come in stages, each found from the last, so
   * repeat until it is empty.
   */
  needs(): Promise<string[]>;
  /**
   * The bytes of `url`, or `null` for a missing resource (like HTTP 404: a missing vector tile is
   * empty, a missing raster tile is replaced by its parent). The bytes are read in place: don't
   * modify them until this resolves.
   */
  provide(url: string, bytes: Uint8Array | null): Promise<void>;
  /**
   * Non-premultiplied RGBA8 pixels, row by row. Call when {@link Renderer.needs} is empty. `oldest` is the oldest
   * ticket (see {@link Renderer.setTicket}) of renders still in progress, whose tiles are kept;
   * pass 0 if you don't use tickets.
   */
  render(oldest: number): Promise<Uint8Array>;
}

interface Binding {
  Renderer: new (style: string, view: View) => Renderer;
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

/**
 * Create a renderer of `style` (style JSON) for `view`. Throws on an invalid style.
 *
 * @example
 * ```ts
 * const renderer = new Renderer(JSON.stringify(style), view);
 * for (let urls = await renderer.needs(); urls.length > 0; urls = await renderer.needs()) {
 *   await Promise.all(urls.map(async (url) => {
 *     const response = await fetch(url);
 *     await renderer.provide(url, response.ok ? new Uint8Array(await response.arrayBuffer()) : null);
 *   }));
 * }
 * const rgba = await renderer.render(0);
 * ```
 */
export const Renderer: new (style: string, view: View) => Renderer = binding.Renderer;

/** Lossless PNG of RGBA8 pixels. Runs on the thread pool; don't modify `rgba` until it resolves. */
export const encodePng: (rgba: Uint8Array, width: number, height: number) => Promise<Uint8Array> = binding.encodePng;

/** Lossless WebP of RGBA8 pixels. Runs on the thread pool; don't modify `rgba` until it resolves. */
export const encodeWebp: (rgba: Uint8Array, width: number, height: number) => Promise<Uint8Array> = binding.encodeWebp;

/**
 * JPEG of RGBA8 pixels at `quality` (1–100), flattened over black. Runs on the thread pool; don't
 * modify `rgba` until it resolves.
 */
export const encodeJpeg: (rgba: Uint8Array, width: number, height: number, quality: number) => Promise<Uint8Array> = binding.encodeJpeg;
