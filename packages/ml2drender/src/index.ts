import type { FillExtrusionLayerSpecification, FillLayerSpecification, LayerSpecification } from '@maplibre/maplibre-gl-style-spec';

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

export interface RenderedImage {
  width: number;
  height: number;
  /** Row-major, 8-bit RGBA pixels. */
  data: Uint8ClampedArray<ArrayBuffer>;
}

/** Style Spec layers supported by the 2D renderer. */
export type StyleLayer = Exclude<LayerSpecification, FillExtrusionLayerSpecification>;

export type FillExtrusionLayer = FillExtrusionLayerSpecification;

export interface InitOptions {
  /** Load complete resource bytes, or null for a missing resource (HTTP 404). Other failures must reject. */
  loadResource?: (url: string) => Promise<Uint8Array<ArrayBuffer> | null>;
  /** Precompiled WASM (required on Cloudflare Workers). Defaults to the bundled asset in browsers. */
  wasm?: WebAssembly.Module;
  /** Resource cache. ttlMs = 0 disables it; Infinity never expires. Defaults: 5 minutes, 64 MiB. */
  cache?: { ttlMs?: number; maxBytes?: number };
  /** Replace each fill-extrusion layer. Defaults to a fill preserving its 2D appearance. */
  transformFillExtrusion?: (layer: FillExtrusionLayer) => StyleLayer;
}

interface WasmExports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  dealloc(ptr: number, len: number): void;
  out_ptr(): number;
  out_len(): number;
  renderer_new(stylePtr: number, styleLen: number, lng: number, lat: number, zoom: number, bearing: number, width: number, height: number, pixelRatio: number, margin: number): number;
  renderer_needs(handle: number): number;
  renderer_provide(handle: number, urlPtr: number, urlLen: number, dataPtr: number, dataLen: number, found: number): void;
  renderer_render(handle: number): number;
  renderer_render_png(handle: number): number;
  renderer_free(handle: number): void;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
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

async function loadWasm(module: WebAssembly.Module | undefined, loadResource: NonNullable<InitOptions['loadResource']>): Promise<WasmExports> {
  if (!module) {
    // Vite bundles this asset for browsers. Workers supply their imported module and
    // never fetch or compile WASM at runtime.
    const url = new URL('../wasm/ml2drender_wasm.wasm', import.meta.url);
    const bytes = await loadResource(url.href);
    if (bytes === null) throw new Error(`WASM not found: ${url}`);
    module = await WebAssembly.compile(bytes);
  }
  const instance = await WebAssembly.instantiate(module);
  return instance.exports as unknown as WasmExports;
}

function nonnegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a finite, non-negative number`);
  return value;
}

/** Per-renderer, byte-bounded LRU cache; expiry is measured from the fetch completion. */
class ResourceCache {
  private readonly entries = new Map<string, { bytes: Uint8Array<ArrayBuffer>; expiresAt: number }>();
  private readonly pending = new Map<string, Promise<Uint8Array<ArrayBuffer> | null>>();
  private size = 0;

  constructor(
    private readonly ttlMs: number,
    private readonly maxBytes: number,
    private readonly loadResource: NonNullable<InitOptions['loadResource']>,
  ) {}

  async get(url: string): Promise<Uint8Array<ArrayBuffer> | null> {
    const cached = this.entries.get(url);
    if (cached) {
      this.entries.delete(url);
      if (cached.expiresAt > performance.now()) {
        this.entries.set(url, cached);
        return cached.bytes;
      }
      this.size -= cached.bytes.byteLength;
    }
    const existing = this.pending.get(url);
    if (existing) return existing;
    const request = this.fetch(url);
    this.pending.set(url, request);
    try {
      return await request;
    } finally {
      this.pending.delete(url);
    }
  }

  private async fetch(url: string): Promise<Uint8Array<ArrayBuffer> | null> {
    const bytes = await this.loadResource(url);
    if (bytes === null) return null;
    if (this.ttlMs > 0 && bytes.byteLength <= this.maxBytes) {
      const now = performance.now();
      for (const [key, entry] of this.entries) {
        if (entry.expiresAt <= now) {
          this.entries.delete(key);
          this.size -= entry.bytes.byteLength;
        }
      }
      while (this.size + bytes.byteLength > this.maxBytes) {
        const oldest = this.entries.keys().next().value;
        if (oldest === undefined) break;
        this.size -= this.entries.get(oldest)!.bytes.byteLength;
        this.entries.delete(oldest);
      }
      this.entries.set(url, { bytes, expiresAt: now + this.ttlMs });
      this.size += bytes.byteLength;
    }
    return bytes;
  }
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

function prepareStyle(bytes: Uint8Array<ArrayBuffer>, transform: NonNullable<InitOptions['transformFillExtrusion']> = flattenFillExtrusion): Uint8Array {
  const style: unknown = JSON.parse(decoder.decode(bytes));
  if (!style || typeof style !== 'object' || !('layers' in style) || !Array.isArray(style.layers)) {
    throw new Error('Style must contain a layers array');
  }
  style.layers = style.layers.map((layer: unknown) => {
    if (!layer || typeof layer !== 'object' || !('type' in layer) || layer.type !== 'fill-extrusion') return layer;
    const replacement = transform(layer as FillExtrusionLayer);
    if (!replacement || typeof replacement.id !== 'string' || !SUPPORTED_LAYERS.has(replacement.type)) {
      throw new Error(`Invalid replacement for fill-extrusion layer ${'id' in layer ? String(layer.id) : ''}`);
    }
    return replacement;
  });
  return encoder.encode(JSON.stringify(style));
}

/** Render a MapLibre Style as a static 2D RGBA image or PNG. */
export class MapRenderer {
  private constructor(
    private readonly wasm: WasmExports,
    private readonly style: Uint8Array,
    private readonly styleUrl: string,
    private readonly cache: ResourceCache,
  ) {}

  /** Fetch the style JSON and load the renderer. The URL is used to resolve style resources. */
  static async init(styleUrl: string, options: InitOptions = {}): Promise<MapRenderer> {
    const ttlMs = options.cache?.ttlMs ?? DEFAULT_TTL_MS;
    if (ttlMs !== Infinity) nonnegative(ttlMs, 'cache.ttlMs');
    const maxBytes = nonnegative(options.cache?.maxBytes ?? DEFAULT_MAX_BYTES, 'cache.maxBytes');
    const url = new URL(styleUrl, globalThis.location?.href);
    const loadResource = options.loadResource ?? fetchResource;
    const [style, wasm] = await Promise.all([loadResource(url.href), loadWasm(options.wasm, loadResource)]);
    if (style === null) throw new Error(`Style not found: ${url}`);
    return new MapRenderer(wasm,
      prepareStyle(style, options.transformFillExtrusion), url.href, new ResourceCache(ttlMs, maxBytes, loadResource));
  }

  /** Fetch required resources and return a new RGBA image for the requested view. */
  async render(view: View): Promise<RenderedImage> {
    const bytes = await this.renderOutput(view, 'rgba');
    const width = Math.round(view.width * (view.pixelRatio ?? 1));
    const height = Math.round(view.height * (view.pixelRatio ?? 1));
    return { width, height, data: new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
  }

  /** Fetch required resources and return an owned, lossless PNG encoded inside WASM. */
  renderPng(view: View): Promise<Uint8Array<ArrayBuffer>> {
    return this.renderOutput(view, 'png');
  }

  private async renderOutput(view: View, format: 'rgba' | 'png'): Promise<Uint8Array<ArrayBuffer>> {
    const margin = nonnegative(view.margin ?? 0, 'margin');
    if (!Number.isInteger(margin) || margin > 0xffffffff) throw new RangeError('margin must be a uint32 integer');
    const w = this.wasm;
    const handle = this.withBytes(this.style, (ptr, len) =>
      w.renderer_new(ptr, len, view.center[0], view.center[1], view.zoom, view.bearing ?? 0,
        view.width, view.height, view.pixelRatio ?? 1, margin));
    if (!handle) throw new Error(decoder.decode(this.output()));
    try {
      for (let round = 0; ; round++) {
        const count = w.renderer_needs(handle);
        if (count === 0) break;
        if (round >= 32) throw new Error('Resource requests did not settle');
        const urls = decoder.decode(this.output()).split('\n');
        const resources = await Promise.all(urls.map((url) => this.cache.get(new URL(url, this.styleUrl).href)));
        urls.forEach((url, i) => this.withBytes(encoder.encode(url), (urlPtr, urlLen) =>
          this.withBytes(resources[i] ?? new Uint8Array(), (dataPtr, dataLen) =>
            w.renderer_provide(handle, urlPtr, urlLen, dataPtr, dataLen, resources[i] === null ? 0 : 1))));
      }
      const ok = format === 'png' ? w.renderer_render_png(handle) : w.renderer_render(handle);
      if (!ok) throw new Error(decoder.decode(this.output()));
      // Own the bytes before another render can overwrite or grow WASM memory.
      return this.output();
    } finally {
      w.renderer_free(handle);
    }
  }

  private output(): Uint8Array<ArrayBuffer> {
    const w = this.wasm;
    return new Uint8Array(w.memory.buffer, w.out_ptr(), w.out_len()).slice();
  }

  private withBytes<T>(bytes: Uint8Array, call: (ptr: number, len: number) => T): T {
    const w = this.wasm;
    const ptr = w.alloc(bytes.length);
    new Uint8Array(w.memory.buffer, ptr, bytes.length).set(bytes);
    try {
      return call(ptr, bytes.length);
    } finally {
      w.dealloc(ptr, bytes.length);
    }
  }
}
