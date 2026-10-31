import { Map as MapLibreMap, setWorkerUrl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { TileWorker } from './worker-client';

const TILE_SIZE = 256;
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

/** Leaflet's zoom 0 has a 256px world; MapLibre's has a 512px world. */
const leafletZoom = (mapLibreZoom: number) => mapLibreZoom + 1;
const mapLibreZoom = (leafletZoomValue: number) => leafletZoomValue - 1;

class WasmTiles extends L.GridLayer {
  private ready = false;
  private generation = 0;

  constructor(private readonly worker: TileWorker, options: L.GridLayerOptions) {
    super(options);
  }

  setReady(ready: boolean) {
    this.ready = ready;
    this.generation++;
    this.redraw();
  }

  createTile(coords: L.Coords, done: L.DoneCallback): HTMLElement {
    const canvas = document.createElement('canvas');
    const ratio = devicePixelRatio;
    canvas.width = canvas.height = Math.round(TILE_SIZE * ratio);
    const generation = this.generation;
    if (!this.ready) {
      done(undefined, canvas);
      return canvas;
    }
    const n = 2 ** coords.z;
    const lng = ((coords.x + 0.5) / n) * 360 - 180;
    const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (coords.y + 0.5) / n))) * 180 / Math.PI;
    void this.worker.render({
      center: [lng, lat],
      zoom: mapLibreZoom(coords.z),
      width: TILE_SIZE,
      height: TILE_SIZE,
      pixelRatio: ratio,
    }).then((image) => {
      if (generation === this.generation) {
        canvas.getContext('2d')!.putImageData(
          new ImageData(Uint8ClampedArray.from(image.data), image.width, image.height), 0, 0,
        );
      }
      done(undefined, canvas);
    }).catch((error: unknown) => {
      if (generation !== this.generation) {
        done(undefined, canvas);
        return;
      }
      fail(error);
      done(error instanceof Error ? error : new Error(String(error)), canvas);
    });
    return canvas;
  }
}

setWorkerUrl(workerUrl);
const map = new MapLibreMap({
  container: 'map',
  style: input('style').value,
  center: [0, 0],
  zoom: 1,
  minZoom: 0,
  maxPitch: 0,
  dragRotate: false,
  pitchWithRotate: false,
  attributionControl: false,
});
const leaflet = L.map('out', {
  center: [0, 0],
  zoom: leafletZoom(1),
  minZoom: 1,
  maxZoom: 23,
  zoomSnap: 0,
  zoomControl: false,
  attributionControl: false,
});
const tileWorker = new TileWorker();
const tiles = new WasmTiles(tileWorker, { tileSize: TILE_SIZE, noWrap: true, updateWhenIdle: true }).addTo(leaflet);

// Both maps use Web Mercator. The guard prevents the programmatic move from echoing back.
let syncing = false;
map.on('move', () => {
  if (syncing) return;
  syncing = true;
  try {
    const center = map.getCenter();
    leaflet.setView([center.lat, center.lng], leafletZoom(map.getZoom()), { animate: false });
  } finally {
    syncing = false;
  }
});
leaflet.on('move', () => {
  if (syncing) return;
  syncing = true;
  try {
    const center = leaflet.getCenter();
    map.jumpTo({ center: [center.lng, center.lat], zoom: mapLibreZoom(leaflet.getZoom()), bearing: 0 });
  } finally {
    syncing = false;
  }
});

let styleGeneration = 0;
async function loadStyle() {
  const generation = ++styleGeneration;
  tiles.setReady(false);
  status('loading style and WASM…');
  try {
    await tileWorker.init(new URL(input('style').value, location.href).href);
    if (generation !== styleGeneration) return;
    tiles.setReady(true);
    status('rendering tiles…');
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
  tiles.redraw();
};
tiles.on('load', () => status(`tiles ready (zoom ${map.getZoom().toFixed(2)})`));
void loadStyle();
