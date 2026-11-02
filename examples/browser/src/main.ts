import { addProtocol, Map as MapLibreMap, setWorkerUrl, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { TileWorker } from './worker-client';
import initialStyle from './style.json?raw';

const TILE_SIZE = 256;
const MARGIN = 64;
const form = document.getElementById('controls') as HTMLFormElement;
const styleInput = form.elements.namedItem('style') as HTMLTextAreaElement;
styleInput.value = initialStyle;
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

// Bound the sample window so long pan/zoom sessions do not grow memory indefinitely.
const samples: { renderMs: number; roundTripMs: number }[] = [];
let completedTiles = 0;
let initMs: number | undefined;
const metric = (id: string, value: string) => { document.getElementById(id)!.textContent = value; };
const milliseconds = (value: number | undefined) => value === undefined ? '—' : `${value.toFixed(1)} ms`;
function updateStats() {
  const sorted = samples.map((sample) => sample.renderMs).sort((a, b) => a - b);
  const mean = (key: 'renderMs' | 'roundTripMs') => samples.length
    ? samples.reduce((sum, sample) => sum + sample[key], 0) / samples.length : undefined;
  metric('stat-tiles', completedTiles.toLocaleString());
  metric('stat-mean', milliseconds(mean('renderMs')));
  metric('stat-p95', milliseconds(sorted[Math.ceil(sorted.length * 0.95) - 1]));
  metric('stat-max', milliseconds(sorted.at(-1)));
  metric('stat-roundtrip', milliseconds(mean('roundTripMs')));
  metric('stat-init', milliseconds(initMs));
}
function resetStats() {
  samples.length = 0;
  completedTiles = 0;
  updateStats();
}
document.getElementById('reset-stats')!.onclick = resetStats;

addProtocol('ml2drender', async (request, controller) => {
  const url = new URL(request.url);
  const generation = Number(url.hostname);
  const revision = Number(url.searchParams.get('revision'));
  const checkActive = () => {
    controller.signal.throwIfAborted();
    if (!ready || generation !== styleGeneration || revision !== tileRevision) throw new DOMException('Style changed', 'AbortError');
  };
  checkActive();
  const [z, x, y] = url.pathname.slice(1).split('/').map(Number);
  const n = 2 ** z;
  const lng = ((x + 0.5) / n) * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 0.5) / n))) * 180 / Math.PI;
  const started = performance.now();
  const { bitmap, renderMs } = await tileWorker.render({
    center: [lng, lat],
    // A 256px XYZ tile is one zoom below MapLibre's 512px world convention.
    zoom: z - 1,
    width: TILE_SIZE,
    height: TILE_SIZE,
    pixelRatio: devicePixelRatio,
    margin: MARGIN,
  });
  try {
    checkActive();
    samples.push({ renderMs, roundTripMs: performance.now() - started });
    if (samples.length > 200) samples.shift();
    completedTiles++;
    updateStats();
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
const map = new MapLibreMap({ ...camera, container: 'map', style: emptyStyle() });
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
  status('タイルを描画中…');
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
  let style: StyleSpecification;
  try {
    style = JSON.parse(styleInput.value);
    if (!style || style.version !== 8 || !style.sources || typeof style.sources !== 'object' || Array.isArray(style.sources) || !Array.isArray(style.layers)) {
      throw new Error('Style JSONには version: 8、sourcesオブジェクト、layers配列が必要です。');
    }
  } catch (error) {
    fail(error);
    return;
  }
  const generation = ++styleGeneration;
  ready = false;
  initMs = undefined;
  resetStats();
  rasterMap.setStyle(emptyStyle(), { diff: false });
  logEl.textContent = '';
  status('スタイルとWASMを初期化中…');
  try {
    map.setStyle(style, { diff: false });
    const started = performance.now();
    await tileWorker.init(style);
    if (generation !== styleGeneration) return;
    initMs = performance.now() - started;
    updateStats();
    ready = true;
    redraw();
  } catch (error) {
    if (generation === styleGeneration) fail(error);
  }
}

form.onsubmit = (event) => {
  event.preventDefault();
  void loadStyle();
};
document.getElementById('redraw')!.onclick = redraw;
rasterMap.on('idle', () => {
  if (ready && rasterMap.getSource('rendered') && rasterMap.isSourceLoaded('rendered') && !statusEl.classList.contains('error')) {
    status(`描画完了 · zoom ${map.getZoom().toFixed(2)}`);
  }
});
void loadStyle();
