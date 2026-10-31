import { addProtocol, Map as MapLibreMap, setWorkerUrl, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { TileWorker } from './worker-client';

const TILE_SIZE = 256;
const MARGIN = 64;
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

const tileWorker = new TileWorker();
let styleGeneration = 0;
let tileRevision = 0;
let ready = false;

addProtocol('ml2drender', async (request, controller) => {
  const url = new URL(request.url);
  const generation = Number(url.hostname);
  const checkActive = () => {
    controller.signal.throwIfAborted();
    if (!ready || generation !== styleGeneration) throw new DOMException('Style changed', 'AbortError');
  };
  checkActive();
  const [z, x, y] = url.pathname.slice(1).split('/').map(Number);
  const n = 2 ** z;
  const lng = ((x + 0.5) / n) * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 0.5) / n))) * 180 / Math.PI;
  const image = await tileWorker.render({
    center: [lng, lat],
    // A 256px XYZ tile is one zoom below MapLibre's 512px world convention.
    zoom: z - 1,
    width: TILE_SIZE,
    height: TILE_SIZE,
    pixelRatio: devicePixelRatio,
    margin: MARGIN,
  });
  checkActive();
  const bitmap = await createImageBitmap(new ImageData(Uint8ClampedArray.from(image.data), image.width, image.height));
  try {
    checkActive();
    return { data: bitmap };
  } catch (error) {
    bitmap.close();
    throw error;
  }
});

setWorkerUrl(workerUrl);
const camera = {
  center: [0, 0] as [number, number],
  zoom: 1,
  minZoom: 0,
  maxZoom: 22,
  maxPitch: 0,
  dragRotate: false,
  pitchWithRotate: false,
  attributionControl: false as const,
};
const emptyStyle = (): StyleSpecification => ({ version: 8, sources: {}, layers: [] });
const map = new MapLibreMap({ ...camera, container: 'map', style: input('style').value });
const rasterMap = new MapLibreMap({ ...camera, container: 'out', style: emptyStyle() });
for (const view of [map, rasterMap]) {
  view.touchZoomRotate.disableRotation();
  view.keyboard.disableRotation();
  view.on('error', (event) => {
    if (!(event.error instanceof Error && event.error.name === 'AbortError')) fail(event.error);
  });
}

// Both views use the same camera convention; the guard prevents move events echoing back.
let syncing = false;
for (const [source, destination] of [[map, rasterMap], [rasterMap, map]]) {
  source.on('move', () => {
    if (syncing) return;
    syncing = true;
    try {
      destination.jumpTo({ center: source.getCenter(), zoom: source.getZoom(), bearing: source.getBearing() });
    } finally {
      syncing = false;
    }
  });
}

function redraw() {
  if (!ready) return;
  status('rendering tiles…');
  // A new URL revision bypasses GL JS's tile cache on explicit redraw.
  rasterMap.setStyle({
    version: 8,
    sources: {
      rendered: {
        type: 'raster',
        tiles: [`ml2drender://${styleGeneration}/{z}/{x}/{y}?revision=${++tileRevision}`],
        tileSize: TILE_SIZE,
        maxzoom: 23,
      },
    },
    layers: [{ id: 'rendered', type: 'raster', source: 'rendered', paint: { 'raster-fade-duration': 0 } }],
  }, { diff: false });
}

async function loadStyle() {
  const generation = ++styleGeneration;
  ready = false;
  rasterMap.setStyle(emptyStyle(), { diff: false });
  logEl.textContent = '';
  status('loading style and WASM…');
  try {
    await tileWorker.init(new URL(input('style').value, location.href).href);
    if (generation !== styleGeneration) return;
    ready = true;
    redraw();
  } catch (error) {
    if (generation === styleGeneration) fail(error);
  }
}
input('style').addEventListener('change', () => {
  map.setStyle(input('style').value);
  void loadStyle();
});

document.getElementById('tile')!.onclick = () => {
  const [z, x, y] = ['z', 'x', 'y'].map((key) => Number(input(key).value));
  const n = 2 ** z;
  const lng = ((x + 0.5) / n) * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 0.5) / n))) * 180 / Math.PI;
  map.jumpTo({ center: [lng, lat], zoom: z, bearing: 0 });
};
form.onsubmit = (event) => {
  event.preventDefault();
  redraw();
};
rasterMap.on('idle', () => {
  if (ready && rasterMap.getSource('rendered') && rasterMap.isSourceLoaded('rendered') && !statusEl.classList.contains('error')) {
    status(`tiles ready (zoom ${map.getZoom().toFixed(2)})`);
  }
});
void loadStyle();
