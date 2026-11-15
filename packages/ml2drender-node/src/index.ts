/**
 * The ml2drender renderer as a native Node.js addon (Node-API).
 *
 * A {@link Renderer} draws views of a style, fetching the resources they need (or loading them
 * through `loadResource`). The work runs on libuv's thread pool, so the JavaScript thread stays
 * free and several renderers draw in parallel. It draws Web Mercator views only; for projected CRSs and reprojected sources,
 * use the WebAssembly package `@ml2drender/wasm`, which also runs in Node.js.
 *
 * @module
 */
import { createRequire } from 'node:module';
import type { FillExtrusionLayerSpecification, FillLayerSpecification, LayerSpecification, StyleSpecification } from '@maplibre/maplibre-gl-style-spec';

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

/** Options of {@link Renderer}. */
export interface RendererOptions {
  /**
   * Load bytes for a URL, or `null` for a missing resource (HTTP 404). Other failures must
   * reject. Use this for authentication, caching, retries or non-HTTP resources. URLs are passed
   * through as written in the style. Loads within each stage run concurrently. Default: `fetch`.
   */
  loadResource?: (url: string) => Promise<Uint8Array | null>;
  /**
   * Replace each layer of a type the renderer does not draw (fill-extrusion) with any number of
   * layers. Default: a fill-extrusion becomes a fill preserving its 2D appearance, any other is
   * dropped. Layers of supported types are not passed; unsupported layers returned are skipped.
   */
  transformLayer?: (layer: LayerSpecification) => LayerSpecification[];
}

/** The addon's sans-IO renderer. Calls on one renderer must not overlap. */
interface NativeRenderer {
  setView(view: View): void;
  /** URLs still needed: sources, then tiles, then glyph ranges, each stage found from the last. */
  needs(): Promise<string[]>;
  /** `null` is a missing resource. The bytes are read in place until this resolves. */
  provide(url: string, bytes: Uint8Array | null): Promise<void>;
  /** `oldest` is the oldest ticket of renders in progress; 0 without tickets. */
  render(oldest: number): Promise<Uint8Array>;
}

interface Binding {
  Renderer: new (style: string, view: View) => NativeRenderer;
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

// The same replacement as `@ml2drender/wasm`: keep the two in step.
const SUPPORTED_LAYERS = new Set<string>(['background', 'fill', 'line', 'circle', 'raster', 'symbol', 'hillshade', 'color-relief', 'heatmap']);

function flattenFillExtrusion(layer: FillExtrusionLayerSpecification): FillLayerSpecification {
  const { type, paint, layout, ...base } = layer;
  // Shared paint properties have the same defaults; absent values stay unset. Expressions stay intact.
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
    },
  };
}

function transformUnsupported(layer: LayerSpecification): LayerSpecification[] {
  return layer.type === 'fill-extrusion' ? [flattenFillExtrusion(layer)] : [];
}

function styleJson(style: StyleSpecification, transform: NonNullable<RendererOptions['transformLayer']> = transformUnsupported): string {
  // A JSON string would stringify to a valid, empty style and draw nothing.
  if (!style || typeof style !== 'object' || !Array.isArray(style.layers)) throw new TypeError('style must be a style object with layers');
  const layers = style.layers.flatMap((layer: LayerSpecification) => {
    if (!layer || typeof layer !== 'object' || SUPPORTED_LAYERS.has(layer.type)) return [layer];
    const replacement = transform(layer);
    if (!Array.isArray(replacement)) throw new TypeError(`transformLayer must return an array of layers (layer ${layer.id})`);
    return replacement;
  });
  return JSON.stringify({ ...style, layers });
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
    this.#style = styleJson(style, options.transformLayer);
    this.#loadResource = options.loadResource ?? fetchResource;
  }

  /**
   * Non-premultiplied RGBA8 pixels of `view`, row by row, after loading the resources it needs.
   * Loading and rendering errors reject. Renders of one renderer take turns; use several
   * renderers to draw in parallel.
   */
  renderView(view: View): Promise<Uint8Array> {
    // The native renderer takes one call at a time and has one view.
    const rgba = this.#queue.then(() => this.#draw(view));
    this.#queue = rgba.catch(() => {});
    return rgba;
  }

  async #draw(view: View): Promise<Uint8Array> {
    if (this.#native) this.#native.setView(view);
    else this.#native = new binding.Renderer(this.#style, view);
    const native = this.#native;
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
