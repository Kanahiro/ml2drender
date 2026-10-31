import wasmUrl from '../target/wasm32-unknown-unknown/wasm/mlrender_wasm.wasm?url';

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

/** Render a MapLibre Style as a static 2D RGBA image. */
export class MapRenderer {
  private constructor(
    private readonly wasm: WasmExports,
    private readonly style: Uint8Array,
    private readonly styleUrl: string,
  ) {}

  /** Fetch the style JSON and load the renderer. The URL is used to resolve style resources. */
  static async init(styleUrl: string): Promise<MapRenderer> {
    const url = new URL(styleUrl, globalThis.location?.href);
    const [styleResponse, wasmResponse] = await Promise.all([fetch(url), fetch(wasmUrl)]);
    if (!styleResponse.ok) throw new Error(`Style fetch failed: ${styleResponse.status} ${url}`);
    if (!wasmResponse.ok) throw new Error(`WASM fetch failed: ${wasmResponse.status} ${wasmUrl}`);
    const [style, wasmBytes] = await Promise.all([styleResponse.arrayBuffer(), wasmResponse.arrayBuffer()]);
    const instance = await WebAssembly.instantiate(wasmBytes);
    return new MapRenderer(instance.instance.exports as unknown as WasmExports, new Uint8Array(style), url.href);
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
        const resources = await Promise.all(urls.map(async (url) => {
          try {
            const response = await fetch(new URL(url, this.styleUrl));
            return response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
          } catch {
            return null;
          }
        }));
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
