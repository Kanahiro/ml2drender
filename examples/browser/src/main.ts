import { addProtocol, LngLat, Map as MapLibreMap, Popup, setWorkerUrl, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import projjsonPresets from './projjson-presets.json';
import { type Crs, registerProjJson, zoomOffset } from './projections';
import { type Crs as RendererCrs, MapRenderer } from '@ml2drender/wasm';
import { stylePresets } from './styles';
import { TileWorker } from './worker-client';

const TILE_SIZE = 256;
/** Output pixels per CSS pixel of the rendered tiles. At most 2: a render's memory grows with its pixels (at 3, 2.25 times as many). */
const PIXEL_RATIO = Math.min(devicePixelRatio, 2);
/** Sources of a Mercator map for GL JS: EPSG:3857 on GL JS's own tile grid. */
const WEB_MERCATOR: RendererCrs = {
  name: 'mercator',
  projjson: projjsonPresets.find((p) => p.projjson.conversion?.method?.name === 'Popular Visualisation Pseudo Mercator')!.projjson as object,
  tileMatrixSet: { origin: [-20037508.342789244, 20037508.342789244], extentAtZoom0: 40075016.68557849 },
};
/** The applied projection as ml2drender takes it. */
const rendererCrs = (): RendererCrs | undefined => projection && {
  name: projection.name,
  projjson: projection.definition,
  tileMatrixSet: { origin: projection.origin, extentAtZoom0: projection.extent },
};
const modeSelect = document.getElementById('mode') as HTMLSelectElement;
const MARGIN = 64;
const styleInput = document.getElementById('style') as HTMLTextAreaElement;
const projInput = document.getElementById('projjson') as HTMLTextAreaElement;
const stylePresetSelect = document.getElementById('style-preset') as HTMLSelectElement;
const projPresetSelect = document.getElementById('projjson-preset') as HTMLSelectElement;
const geojsonInput = document.getElementById('geojson') as HTMLTextAreaElement;
const geojsonPresetSelect = document.getElementById('geojson-preset') as HTMLSelectElement;
const crsNameEl = document.getElementById('crs-name')!;
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
/** The applied Style JSON and GeoJSON inputs: the renderer follows these. */
let appliedStyle: string | undefined;
/** The applied style on the main thread, for the style GL JS draws from reprojected sources (`toStyle`). */
let appliedRenderer: MapRenderer | undefined;
let appliedProjJson: string | undefined;
/** The applied projection; undefined renders Web Mercator without reprojection. */
let projection: Crs | undefined;

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

/** A tile request of the current style and revision: `ml2drender[-source]://<generation>/z/x/y?revision=…`. */
function tileRequest(requestUrl: string, signal: AbortSignal) {
  const url = new URL(requestUrl);
  const generation = Number(url.hostname);
  const revision = Number(url.searchParams.get('revision'));
  const checkActive = () => {
    signal.throwIfAborted();
    if (!ready || generation !== styleGeneration || revision !== tileRevision) throw new DOMException('Style changed', 'AbortError');
  };
  checkActive();
  const [z, x, y] = url.pathname.slice(1).split('/').map(Number);
  return { url, z, x, y, checkActive };
}

function recordTile(renderMs: number, started: number) {
  samples.push({ renderMs, roundTripMs: performance.now() - started });
  if (samples.length > 200) samples.shift();
  completedTiles++;
  updateStats();
}

addProtocol('ml2drender', async (request, controller) => {
  const { z, x, y, checkActive } = tileRequest(request.url, controller.signal);
  const started = performance.now();
  const { bitmap, renderMs } = await tileWorker.render({ z, x, y, tileSize: TILE_SIZE, pixelRatio: PIXEL_RATIO, margin: MARGIN }, rendererCrs());
  try {
    checkActive();
    recordTile(renderMs, started);
    return { data: bitmap };
  } catch (error) {
    bitmap.close();
    throw error;
  }
});

// GL JS mode: a source of the style reprojected onto the map's grid (see `ProjectedRenderer.toStyle`).
addProtocol('ml2drender-source', async (request, controller) => {
  const { url, z, x, y, checkActive } = tileRequest(request.url, controller.signal);
  const started = performance.now();
  const { data, renderMs } = await tileWorker.getTile({ source: url.searchParams.get('source')!, z, x, y }, rendererCrs() ?? WEB_MERCATOR);
  checkActive();
  recordTile(renderMs, started);
  return { data };
});

setWorkerUrl(workerUrl);
const emptyStyle = (): StyleSpecification => ({ version: 8, sources: {}, layers: [] });
// The URL hash (`#zoom/lat/lng`) keeps the location across reloads and links. A CRS's zoom can be
// below the Mercator one's at the same scale.
const map = new MapLibreMap({
  container: 'out',
  style: emptyStyle(),
  hash: true,
  center: [0, 0],
  zoom: 1,
  minZoom: -2,
  maxZoom: 22,
  maxPitch: 0,
  dragRotate: false,
  pitchWithRotate: false,
  attributionControl: false,
});
map.touchZoomRotate.disableRotation();
map.keyboard.disableRotation();
map.on('error', (event) => {
  if (!(event.error instanceof Error && event.error.name === 'AbortError')) fail(event.error);
});

// Hovering a feature in GL JS mode shows its attributes.
const popup = new Popup({ closeButton: false, closeOnClick: false, maxWidth: '320px' });
/** Layers whose features show on hover (set by `redraw`). */
let hoverLayers: string[] = [];
const hideHover = () => {
  map.getCanvas().style.cursor = '';
  popup.remove();
};
map.on('mousemove', (event) => {
  const layers = hoverLayers.filter((id) => map.getLayer(id));
  const feature = layers.length ? map.queryRenderedFeatures(event.point, { layers })[0] : undefined;
  if (!feature) return hideHover();
  map.getCanvas().style.cursor = 'pointer';
  const pre = document.createElement('pre');
  pre.style.cssText = 'margin:0;max-height:240px;overflow:auto;font-size:11px';
  const title = `[${feature.layer.id}${feature.sourceLayer ? ` · ${feature.sourceLayer}` : ''}]`;
  const id = feature.id === undefined ? [] : [`id: ${feature.id}`];
  pre.textContent = [title, ...id, ...Object.entries(feature.properties).map(([k, v]) => `${k}: ${v}`)].join('\n');
  popup.setLngLat(event.lngLat).setDOMContent(pre).addTo(map);
});
map.getCanvas().addEventListener('mouseleave', hideHover);

/** Shows the rendered tiles of the applied style and projection again. */
function redraw() {
  if (!ready) return;
  status('Rendering tiles…');
  // A new URL revision bypasses GL JS's tile cache on explicit redraw.
  const revision = `revision=${++tileRevision}${projection ? `&crs=${encodeURIComponent(projection.name)}` : ''}`;
  const crs = projection?.name ?? 'mercator';
  const tiles: StyleSpecification = modeSelect.value === 'gl'
    ? appliedRenderer!.projected(rendererCrs() ?? WEB_MERCATOR).toStyle({
      tiles: (source) => `ml2drender-source://${styleGeneration}/{z}/{x}/{y}?source=${encodeURIComponent(source)}&${revision}`,
    })
    : {
      version: 8,
      projection: { type: crs },
      sources: { rendered: { type: 'raster', tiles: [`ml2drender://${styleGeneration}/{z}/{x}/{y}?${revision}`], tileSize: TILE_SIZE, maxzoom: 23 } },
      layers: [{ id: 'rendered', type: 'raster', source: 'rendered', paint: { 'raster-fade-duration': 0 } }],
    };
  hoverLayers = tiles.layers.filter((l) => l.type !== 'background' && l.id !== 'rendered').map((l) => l.id);
  map.setStyle(tiles, { diff: false });
}

/** The Style JSON and GeoJSON inputs, as the key of what the renderer follows. */
const styleInputs = () => `${styleInput.value}\0${geojsonInput.value.trim()}`;

/** The style input with the GeoJSON input (empty: nothing) on top as the source `check`. */
function inputStyle(): StyleSpecification {
  const style: StyleSpecification = JSON.parse(styleInput.value);
  if (!style || style.version !== 8 || !style.sources || typeof style.sources !== 'object' || Array.isArray(style.sources) || !Array.isArray(style.layers)) {
    throw new Error('Style JSON needs version: 8, a sources object and a layers array.');
  }
  const geojson = geojsonInput.value.trim();
  if (!geojson) return style;
  return {
    ...style,
    sources: { ...style.sources, check: { type: 'geojson', data: JSON.parse(geojson) } },
    layers: [
      ...style.layers,
      { id: 'check-fill', type: 'fill', source: 'check', filter: ['in', ['geometry-type'], ['literal', ['Polygon', 'MultiPolygon']]], paint: { 'fill-color': '#1e6fd9', 'fill-opacity': 0.2 } },
      { id: 'check-line', type: 'line', source: 'check', filter: ['!', ['in', ['geometry-type'], ['literal', ['Point', 'MultiPoint']]]], paint: { 'line-color': '#1e6fd9', 'line-width': 1.5 } },
      { id: 'check', type: 'circle', source: 'check', filter: ['in', ['geometry-type'], ['literal', ['Point', 'MultiPoint']]], paint: { 'circle-radius': 3, 'circle-color': '#1e6fd9', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1 } },
    ],
  };
}

/** Loads the style and GeoJSON inputs into the renderers, if they changed. */
async function applyStyle(): Promise<boolean> {
  const text = styleInputs();
  if (text === appliedStyle) return true;
  const style = inputStyle();
  const generation = ++styleGeneration;
  ready = false;
  initMs = undefined;
  resetStats();
  status('Initializing style and WASM…');
  const started = performance.now();
  const [renderer] = await Promise.all([MapRenderer.init(style, { cache: { ttlMs: 0 } }), tileWorker.init(style)]);
  if (generation !== styleGeneration) return false;
  initMs = performance.now() - started;
  updateStats();
  appliedStyle = text;
  appliedRenderer = renderer;
  ready = true;
  return true;
}

/** Registers the PROJJSON input (empty: Web Mercator), if it changed, keeping the view's place and scale. */
async function applyProjection() {
  const text = projInput.value.trim();
  if (text === appliedProjJson) return;
  const next = text ? registerProjJson(text) : undefined;
  let center = map.getCenter();
  const zoom = map.getZoom() - (projection ? zoomOffset(projection, center) : 0);
  // GL JS cannot migrate its camera to a CRS without a point for the center (e.g. the far side of a
  // geostationary view): it throws midway through loading the style. Move to the grid's center first.
  if (next && !next.converter.forward(center.toArray()).every(Number.isFinite)) {
    const mid = next.converter.inverse([next.origin[0] + next.extent / 2, next.origin[1] - next.extent / 2]);
    if (mid.every(Number.isFinite)) {
      center = new LngLat(mid[0], mid[1]);
      map.jumpTo({ center });
    }
  }
  const nextZoom = zoom + (next ? zoomOffset(next, center) : 0);
  projection = next;
  appliedProjJson = text;
  crsNameEl.textContent = projection ? String((projection.definition as { name?: string }).name ?? 'PROJJSON') : 'Web Mercator';
  // The projection takes effect with the style; then the same place, at about the same scale.
  map.once('style.load', () => map.jumpTo({ center, zoom: Number.isFinite(nextZoom) ? nextZoom : map.getZoom() }));
}

/** Applies the inputs; redraws the tiles if any changed. */
async function apply() {
  logEl.textContent = '';
  try {
    const changed = styleInputs() !== appliedStyle || projInput.value.trim() !== appliedProjJson;
    if (!await applyStyle()) return;
    await applyProjection();
    if (changed) redraw();
  } catch (error) {
    fail(error);
  }
}
// One at a time, so that a slow style load cannot finish after a newer projection.
let applying = Promise.resolve();
const scheduleApply = () => { applying = applying.then(apply); };

// Typing applies the inputs once it pauses.
let debounce: ReturnType<typeof setTimeout> | undefined;
for (const input of [styleInput, projInput, geojsonInput]) {
  input.oninput = () => {
    clearTimeout(debounce);
    debounce = setTimeout(scheduleApply, 500);
  };
}
// The headings open and close their editors.
for (const button of document.querySelectorAll<HTMLButtonElement>('.editor-heading button')) {
  button.onclick = () => {
    const body = document.getElementById(button.getAttribute('aria-controls')!)!;
    body.hidden = !body.hidden;
    button.setAttribute('aria-expanded', String(!body.hidden));
  };
}
map.on('idle', () => {
  if (ready && map.isStyleLoaded() && !statusEl.classList.contains('error')) {
    status(`Done · zoom ${map.getZoom().toFixed(2)}`);
  }
});

// Raster tiles or vector tiles: queued behind any apply, which may be loading a style.
modeSelect.onchange = () => {
  applying = applying.then(redraw);
};

// Presets fill in an input and apply it.
stylePresetSelect.append(...stylePresets.map((p, i) => new Option(p.label, String(i))));
stylePresetSelect.onchange = async () => {
  try {
    styleInput.value = await stylePresets[Number(stylePresetSelect.value)].load();
  } catch (error) {
    fail(error);
    return;
  }
  scheduleApply();
};
projPresetSelect.append(new Option('Web Mercator (no reprojection)', ''), ...projjsonPresets.map((p, i) => new Option(p.label, String(i))));
projPresetSelect.onchange = () => {
  const preset = projPresetSelect.value === '' ? undefined : projjsonPresets[Number(projPresetSelect.value)];
  projInput.value = preset ? JSON.stringify(preset.projjson, null, 2) : '';
  scheduleApply();
};
const geojsonPresets = [
  // Natural Earth 1:50m populated places (~1,250 cities).
  { label: 'Natural Earth populated places', url: 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_populated_places_simple.geojson' },
  { label: 'Natural Earth countries (polygons)', url: 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson' },
  { label: 'Natural Earth rivers (lines)', url: 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_rivers_lake_centerlines.geojson' },
  { label: 'None', url: undefined },
];
geojsonPresetSelect.append(...geojsonPresets.map((p, i) => new Option(p.label, String(i))));
geojsonPresetSelect.onchange = async () => {
  const { url } = geojsonPresets[Number(geojsonPresetSelect.value)];
  try {
    geojsonInput.value = url ? await (await fetch(url)).text() : '';
  } catch (error) {
    fail(error);
    return;
  }
  scheduleApply();
};

styleInput.value = await stylePresets[0].load();
scheduleApply();
void geojsonPresetSelect.onchange(new Event('change'));
