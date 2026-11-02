import type { FillLayerSpecification, LayerSpecification, StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import { MapRenderer, type FillExtrusionLayer, type InitOptions, type StyleLayer } from '../src/index';
import wasm from 'ml2drender/renderer.wasm';

async function pngResponse() {
  const style: StyleSpecification = await (await fetch('https://example.com/style.json')).json();
  const renderer = await MapRenderer.init(style, { wasm });
  const png: Uint8Array<ArrayBuffer> = await renderer.renderPng({ center: [0, 0], zoom: 0, width: 256, height: 256 });
  return new Response(png, { headers: { 'Content-Type': 'image/png' } });
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
