import type { FillLayerSpecification, LayerSpecification, StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import { loadProjection, loadProjectionFactory, MapRenderer, projectedStyle, type FillExtrusionLayer, type InitOptions, type Projection, type StyleLayer } from '../src/index';
import wasm from 'ml2drender/renderer.wasm';

async function pngResponse() {
  const style: StyleSpecification = await (await fetch('https://example.com/style.json')).json();
  const renderer = await MapRenderer.init(style, { wasm });
  const png: Uint8Array<ArrayBuffer> = (await renderer.renderView({ center: [0, 0], zoom: 0, width: 256, height: 256 })).toPng();
  return new Response(png, { headers: { 'Content-Type': 'image/png' } });
}

const utm = { type: 'ProjectedCRS', name: 'WGS 84 / UTM zone 54N' /* ... */ };

async function projectedPng(renderer: MapRenderer): Promise<Uint8Array<ArrayBuffer>> {
  return (await renderer.renderProjected({ projjson: utm, bbox: [300000, 3900000, 400000, 4000000], width: 512, height: 512 })).toPng();
}

async function projectedMvt(renderer: MapRenderer): Promise<Response> {
  // A tile of the grid registered with GL JS's `addProjection({ tileMatrixSet })`.
  const tileMatrixSet = { origin: [-2000000, 6000000] as [number, number], extentAtZoom0: 4000000 };
  const mvt = await renderer.renderProjectedSource({ projjson: utm, tileMatrixSet, z: 3, x: 4, y: 2, source: 'openmaptiles' });
  // @ts-expect-error A source's tile is addressed by its tile index, not a box.
  await renderer.renderProjectedSource({ projjson: utm, bbox: [300000, 3900000, 400000, 4000000], width: 512, height: 512, source: 'openmaptiles' });
  return new Response(mvt, { headers: { 'Content-Type': 'application/vnd.mapbox-vector-tile' } });
}

function glStyle(style: StyleSpecification): StyleSpecification {
  // The style for GL JS, from tiles a Worker serves with `renderProjectedSource`.
  return projectedStyle(style, { projection: 'EPSG:32654', tiles: (source) => `https://example.com/${source}/{z}/{x}/{y}` });
}

async function mercatorPngs(renderer: MapRenderer): Promise<Uint8Array<ArrayBuffer>[]> {
  const tile = await renderer.renderZxy({ z: 3, x: 7, y: 3 });
  const tokyo = await renderer.renderLngLat({ bbox: [139.5, 35.5, 140, 36], size: 1024 });
  return [tile.toPng(), tokyo.toPng()];
}

async function wrongPath(renderer: MapRenderer) {
  // @ts-expect-error A CRS box renders with `renderProjected`.
  await renderer.renderView({ projjson: utm, bbox: [300000, 3900000, 400000, 4000000], width: 512, height: 512 });
  // @ts-expect-error A Mercator camera renders with `renderView`.
  await renderer.renderProjected({ center: [0, 0], zoom: 0, width: 256, height: 256 });
  // @ts-expect-error `renderProjected` takes PROJJSON, not a PROJ string.
  await renderer.renderProjected({ projjson: '+proj=utm +zone=54 +ellps=GRS80', bbox: [300000, 3900000, 400000, 4000000], width: 512, height: 512 });
}

async function utmEasting(): Promise<number> {
  const projection: Projection = await loadProjection(utm, { wasm });
  const lngLat: number[] = projection.inverse(projection.forward([139.76, 35.68]));
  // @ts-expect-error `loadProjection` takes PROJJSON, not a PROJ string.
  await loadProjection('+proj=utm +zone=54 +ellps=GRS80');
  const create: (projjson: object) => Projection = await loadProjectionFactory({ wasm });
  create(utm).forward([139.76, 35.68]);
  return lngLat ? lngLat[0] : NaN;
}

async function webpBytes(renderer: MapRenderer): Promise<Uint8Array<ArrayBuffer>> {
  return (await renderer.renderView({ center: [0, 0], zoom: 0, width: 256, height: 256 })).toWebp();
}

const transform: NonNullable<InitOptions['transformFillExtrusion']> = (layer) => ({
  id: layer.id,
  type: 'fill',
  source: layer.source,
  'source-layer': layer['source-layer'],
  minzoom: layer.minzoom,
  maxzoom: layer.maxzoom,
  filter: layer.filter,
  layout: { visibility: layer.layout?.visibility },
  paint: { 'fill-color': layer.paint?.['fill-extrusion-color'] ?? '#888888' },
});

const extrusion: FillExtrusionLayer = {
  id: 'buildings', type: 'fill-extrusion', source: 'buildings',
  paint: { 'fill-extrusion-height': ['get', 'height'] },
};
const replacement: LayerSpecification = transform(extrusion);
const fill: FillLayerSpecification = { id: 'fill', type: 'fill', source: 'buildings' };
const supported: StyleLayer = fill;

// @ts-expect-error A fill layer requires a source.
const missingSource: StyleLayer = { id: 'fill', type: 'fill' };
// @ts-expect-error Fill paint must use Style Spec property names.
const misspelledPaint: StyleLayer = { id: 'fill', type: 'fill', source: 'buildings', paint: { 'fill-colour': '#888888' } };
// @ts-expect-error Fill color cannot be a number.
const invalidColor: StyleLayer = { id: 'fill', type: 'fill', source: 'buildings', paint: { 'fill-color': 123 } };
// @ts-expect-error The replacement must be a supported 2D layer.
const unsupportedTransform: InitOptions = { transformFillExtrusion: (layer) => layer };

const customResourceLoader: InitOptions = {
  loadResource: async (url) => new Uint8Array(await (await fetch(url)).arrayBuffer()),
};
const missingResourceLoader: InitOptions = { loadResource: async () => null };

MapRenderer.init({ version: 8, sources: {}, layers: [] }, { wasm });
// @ts-expect-error The style must be an object; fetch a style URL first.
MapRenderer.init('https://example.com/style.json', { wasm });
// @ts-expect-error Style Spec version must be 8.
MapRenderer.init({ version: 7, sources: {}, layers: [] });
