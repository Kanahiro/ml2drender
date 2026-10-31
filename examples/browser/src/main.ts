import { Map as MapLibreMap, setWorkerUrl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// maplibre-gl resolves its worker next to its own module, which breaks once Vite pre-bundles it.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
// Built by `pnpm build:wasm` (the root `pnpm demo` does it first).
import wasmUrl from '../../../target/wasm32-unknown-unknown/release/mlrender_wasm.wasm?url';

/** C-ABI exports of the `wasm/` crate. Pointers are byte offsets into `memory`. */
interface Exports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  dealloc(ptr: number, len: number): void;
  out_ptr(): number;
  out_len(): number;
  renderer_new(
    stylePtr: number, styleLen: number,
    lng: number, lat: number, zoom: number, bearing: number,
    width: number, height: number, pixelRatio: number,
  ): number;
  renderer_needs(r: number): number;
  renderer_provide(r: number, urlPtr: number, urlLen: number, dataPtr: number, dataLen: number, found: number): void;
  renderer_render(r: number): number;
  renderer_free(r: number): void;
}

const SIZE = 512;
const form = document.getElementById('controls') as HTMLFormElement;
const input = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
const logEl = document.getElementById('log')!;
const statusEl = document.getElementById('status')!;
const log = (msg: string, cls?: string) => {
  const line = document.createElement('div');
  line.textContent = msg;
  if (cls) line.className = cls;
  logEl.append(line);
};
const status = (msg: string, isError = false) => {
  statusEl.textContent = msg;
  statusEl.className = isError ? 'error' : '';
};
const fail = (err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  log(msg, 'error');
  status(`error: ${msg}`, true);
};
// Anything that slips through still ends up on the page, not only in the console.
window.addEventListener('error', (e) => fail(e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => fail(e.reason));

const enc = new TextEncoder();
const dec = new TextDecoder();
let w: Exports;
const out = () => new Uint8Array(w.memory.buffer, w.out_ptr(), w.out_len()).slice();
/** Copy bytes into wasm memory, call `f(ptr, len)`, free. */
const withBytes = <T>(bytes: Uint8Array, f: (ptr: number, len: number) => T): T => {
  const p = w.alloc(bytes.length);
  new Uint8Array(w.memory.buffer, p, bytes.length).set(bytes);
  try {
    return f(p, bytes.length);
  } finally {
    w.dealloc(p, bytes.length);
  }
};

setWorkerUrl(workerUrl);
const map = new MapLibreMap({
  container: 'map',
  style: input('style').value,
  center: [0, 0],
  zoom: 1,
  maxPitch: 0,
  pitchWithRotate: false,
  attributionControl: false,
});
input('style').addEventListener('change', () => map.setStyle(input('style').value));

// Same camera as View::tile(z, x, y, 512) in core.
document.getElementById('tile')!.onclick = () => {
  const [z, x, y] = ['z', 'x', 'y'].map((k) => Number(input(k).value));
  const n = 2 ** z;
  const lng = ((x + 0.5) / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n))) * 180) / Math.PI;
  map.jumpTo({ center: [lng, lat], zoom: z, bearing: 0 });
};

// Re-render whenever the reference map settles; one render at a time, latest view wins.
let busy = false;
let pending = false;
async function requestRender() {
  if (!w) return;
  if (busy) {
    pending = true;
    return;
  }
  busy = true;
  logEl.textContent = '';
  try {
    await render();
  } catch (err) {
    fail(err);
  } finally {
    busy = false;
    if (pending) {
      pending = false;
      void requestRender();
    }
  }
}
form.onsubmit = (e) => {
  e.preventDefault();
  void requestRender();
};
map.on('moveend', () => void requestRender());

async function init() {
  status('loading wasm…');
  const res = await fetch(wasmUrl, { cache: 'no-store' });
  if (!res.ok) throw new Error(`wasm fetch failed: ${res.status} ${wasmUrl} (run \`pnpm build:wasm\`)`);
  const bytes = await res.arrayBuffer();
  w = (await WebAssembly.instantiate(bytes)).instance.exports as unknown as Exports;
  log(`wasm loaded: ${(bytes.byteLength / 1024).toFixed(1)} KiB`);
  await requestRender();
}
init().catch(fail);

/** The sans-IO host loop: needs() → fetch → provide() until needs() is empty, then render(). */
async function render() {
  status('rendering…');
  const t0 = performance.now();
  const styleUrl = input('style').value;
  const styleText = await (await fetch(styleUrl)).text();
  const c = map.getCenter();
  const dpr = devicePixelRatio;
  const r = withBytes(enc.encode(styleText), (p, n) =>
    w.renderer_new(p, n, c.lng, c.lat, map.getZoom(), map.getBearing(), SIZE, SIZE, dpr),
  );
  if (!r) throw new Error(dec.decode(out()));
  try {
    for (let round = 1; ; round++) {
      const n = w.renderer_needs(r);
      if (!n) break;
      if (round > 32) throw new Error('needs() not settling');
      const urls = dec.decode(out()).split('\n');
      const bodies = await Promise.all(
        urls.map(async (u) => {
          try {
            const res = await fetch(new URL(u, styleUrl));
            return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
          } catch {
            return null;
          }
        }),
      );
      urls.forEach((u, i) => {
        const body = bodies[i];
        withBytes(enc.encode(u), (up, ul) =>
          withBytes(body ?? new Uint8Array(), (dp, dl) => w.renderer_provide(r, up, ul, dp, dl, body ? 1 : 0)),
        );
      });
      const bytes = bodies.reduce((s, b) => s + (b?.length ?? 0), 0);
      log(`round ${round}: ${n} resources, ${bodies.filter((b) => !b).length} failed, ${(bytes / 1024).toFixed(1)} KiB`);
    }
    const t1 = performance.now();
    if (!w.renderer_render(r)) throw new Error(dec.decode(out()));
    const t2 = performance.now();
    const px = Math.round(SIZE * dpr);
    const canvas = document.getElementById('out') as HTMLCanvasElement;
    canvas.width = canvas.height = px;
    canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(out().buffer), px, px), 0, 0);
    log(`fetch ${(t1 - t0).toFixed(0)} ms, render ${(t2 - t1).toFixed(0)} ms`);
    status(`rendered in ${(t2 - t1).toFixed(0)} ms (zoom ${map.getZoom().toFixed(2)})`);
  } finally {
    w.renderer_free(r);
  }
}
