import wasmUrl from '../target/wasm32-unknown-unknown/release/ml2drender_wasm.wasm?url';

export interface View {
  center: [lng: number, lat: number];
  zoom: number;
  bearing?: number;
  width: number;
  height: number;
  pixelRatio?: number;
}

export interface RenderedImage {
  width: number;
  height: number;
  /** Row-major, 8-bit RGBA pixels. */
  data: Uint8ClampedArray;
}

export interface StyleLayer {
  id: string;
  type: string;
  [property: string]: unknown;
}

export type FillExtrusionLayer = StyleLayer & { type: 'fill-extrusion' };

export interface InitOptions {
  /** Resource cache. ttlMs = 0 disables it; Infinity never expires. Defaults: 5 minutes, 64 MiB. */
  cache?: { ttlMs?: number; maxBytes?: number };
  /** Replace each fill-extrusion layer before the style reaches the renderer. */
  transformFillExtrusion?: (layer: FillExtrusionLayer) => StyleLayer;
}

interface WasmExports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  dealloc(ptr: number, len: number): void;
  out_ptr(): number;
  out_len(): number;
  renderer_new(stylePtr: number, styleLen: number, lng: number, lat: number, zoom: number, bearing: number, width: number, height: number, pixelRatio: number): number;
  renderer_needs(handle: number): number;
  renderer_provide(handle: number, urlPtr: number, urlLen: number, dataPtr: number, dataLen: number, found: number): void;
  renderer_render(handle: number): number;
  renderer_free(handle: number): void;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const SUPPORTED_LAYERS = new Set(['background', 'fill', 'line', 'circle', 'raster', 'symbol', 'hillshade', 'color-relief', 'heatmap']);

function nonnegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a finite, non-negative number`);
  return value;
}

/** Per-renderer, byte-bounded LRU cache; expiry is measured from the fetch completion. */
class ResourceCache {
  private readonly entries = new Map<string, { bytes: Uint8Array; expiresAt: number }>();
  private readonly pending = new Map<string, Promise<Uint8Array | null>>();
  private size = 0;

  constructor(private readonly ttlMs: number, private readonly maxBytes: number) {}

  async get(url: string): Promise<Uint8Array | null> {
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

  private async fetch(url: string): Promise<Uint8Array | null> {
    try {
      const response = await globalThis.fetch(url);
      if (!response.ok) return null;
      const bytes = new Uint8Array(await response.arrayBuffer());
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
    } catch {
      return null;
    }
  }
}

function prepareStyle(bytes: ArrayBuffer, transform?: InitOptions['transformFillExtrusion']): Uint8Array {
  if (!transform) return new Uint8Array(bytes);
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

/** Render a MapLibre Style as a static 2D RGBA image. */
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
    const [styleResponse, wasmResponse] = await Promise.all([fetch(url), fetch(wasmUrl)]);
    if (!styleResponse.ok) throw new Error(`Style fetch failed: ${styleResponse.status} ${url}`);
    if (!wasmResponse.ok) throw new Error(`WASM fetch failed: ${wasmResponse.status} ${wasmUrl}`);
    const [style, wasmBytes] = await Promise.all([styleResponse.arrayBuffer(), wasmResponse.arrayBuffer()]);
    const instance = await WebAssembly.instantiate(wasmBytes);
    return new MapRenderer(instance.instance.exports as unknown as WasmExports,
      prepareStyle(style, options.transformFillExtrusion), url.href, new ResourceCache(ttlMs, maxBytes));
  }

  /** Fetch required resources and return a new RGBA image for the requested view. */
  async render(view: View): Promise<RenderedImage> {
    const w = this.wasm;
    const handle = this.withBytes(this.style, (ptr, len) =>
      w.renderer_new(ptr, len, view.center[0], view.center[1], view.zoom, view.bearing ?? 0,
        view.width, view.height, view.pixelRatio ?? 1));
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
            w.renderer_provide(handle, urlPtr, urlLen, dataPtr, dataLen, resources[i] ? 1 : 0))));
      }
      if (!w.renderer_render(handle)) throw new Error(decoder.decode(this.output()));
      const width = Math.round(view.width * (view.pixelRatio ?? 1));
      const height = Math.round(view.height * (view.pixelRatio ?? 1));
      return { width, height, data: new Uint8ClampedArray(this.output()) };
    } finally {
      w.renderer_free(handle);
    }
  }

  private output(): Uint8Array {
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
