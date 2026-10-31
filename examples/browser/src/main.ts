import { Map as MapLibreMap, setWorkerUrl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { MapRenderer } from '../../../src/index';

const SIZE = 512;
const form = document.getElementById('controls') as HTMLFormElement;
const input = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
const logEl = document.getElementById('log')!;
const statusEl = document.getElementById('status')!;
const status = (message: string, error = false) => {
  statusEl.textContent = message;
  statusEl.className = error ? 'error' : '';
};
const fail = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  logEl.textContent = message;
  status(`error: ${message}`, true);
};
window.addEventListener('error', (event) => fail(event.error ?? event.message));
window.addEventListener('unhandledrejection', (event) => fail(event.reason));

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
input('style').addEventListener('change', () => {
  renderer = undefined;
  map.setStyle(input('style').value);
});

document.getElementById('tile')!.onclick = () => {
  const [z, x, y] = ['z', 'x', 'y'].map((key) => Number(input(key).value));
  const n = 2 ** z;
  const lng = ((x + 0.5) / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n))) * 180) / Math.PI;
  map.jumpTo({ center: [lng, lat], zoom: z, bearing: 0 });
};

let renderer: MapRenderer | undefined;
let busy = false;
let pending = false;
async function requestRender() {
  if (busy) {
    pending = true;
    return;
  }
  busy = true;
  try {
    status('rendering…');
    const styleUrl = input('style').value;
    const active = renderer ?? await MapRenderer.init(styleUrl, { cache: { ttlMs: Infinity } });
    if (styleUrl !== input('style').value) return;
    renderer = active;
    const center = map.getCenter();
    const started = performance.now();
    const image = await active.render({
      center: [center.lng, center.lat],
      zoom: map.getZoom(),
      bearing: map.getBearing(),
      width: SIZE,
      height: SIZE,
      pixelRatio: devicePixelRatio,
    });
    if (styleUrl !== input('style').value) return;
    const canvas = document.getElementById('out') as HTMLCanvasElement;
    canvas.width = image.width;
    canvas.height = image.height;
    canvas.getContext('2d')!.putImageData(new ImageData(Uint8ClampedArray.from(image.data), image.width, image.height), 0, 0);
    const elapsed = (performance.now() - started).toFixed(0);
    logEl.textContent = `rendered in ${elapsed} ms`;
    status(`rendered in ${elapsed} ms (zoom ${map.getZoom().toFixed(2)})`);
  } catch (error) {
    fail(error);
  } finally {
    busy = false;
    if (pending) {
      pending = false;
      void requestRender();
    }
  }
}
form.onsubmit = (event) => {
  event.preventDefault();
  void requestRender();
};
map.on('moveend', () => void requestRender());
void requestRender();
