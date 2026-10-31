import type { FillLayerSpecification, LayerSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { FillExtrusionLayer, InitOptions, StyleLayer } from '../src/index';

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
