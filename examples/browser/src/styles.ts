import type { LayerSpecification, StyleSpecification } from 'maplibre-gl';
import demotiles from './style.json?raw';

/** A style preset: the JSON text it puts in the editor. */
export interface StylePreset {
  label: string;
  load: () => Promise<string>;
}

const json = (style: StyleSpecification) => JSON.stringify(style, null, 2);

/** Meridians and parallels every 15°, to see the shape of a projection. */
function withGraticule(style: StyleSpecification): StyleSpecification {
  const line = (coordinates: number[][]) => ({ type: 'Feature' as const, properties: {}, geometry: { type: 'LineString' as const, coordinates } });
  const features = [];
  for (let lng = -180; lng < 180; lng += 15) features.push(line([[lng, -85], [lng, 85]]));
  for (let lat = -75; lat <= 75; lat += 15) features.push(line([[-180, lat], [180, lat]]));
  const layer: LayerSpecification = { id: 'graticule', type: 'line', source: 'graticule', paint: { 'line-color': '#c0392b', 'line-width': 1, 'line-opacity': 0.6 } };
  // Under the labels.
  const firstSymbol = style.layers.findIndex((l) => l.type === 'symbol');
  const layers = [...style.layers];
  layers.splice(firstSymbol < 0 ? layers.length : firstSymbol, 0, layer);
  return { ...style, sources: { ...style.sources, graticule: { type: 'geojson', data: { type: 'FeatureCollection', features } } }, layers };
}

const gsi: StyleSpecification = {
  version: 8,
  sources: {
    gsi: { type: 'raster', tiles: ['https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 18, attribution: 'GSI Tiles' },
  },
  layers: [{ id: 'gsi', type: 'raster', source: 'gsi' }],
};

export const stylePresets: StylePreset[] = [
  { label: 'MapLibre demo tiles', load: async () => demotiles },
  { label: 'MapLibre demo tiles + graticule', load: async () => json(withGraticule(JSON.parse(demotiles))) },
  { label: 'GSI standard map (raster)', load: async () => json(gsi) },
  {
    label: 'OpenFreeMap Liberty',
    load: async () => {
      const response = await fetch('https://tiles.openfreemap.org/styles/liberty');
      if (!response.ok) throw new Error(`OpenFreeMap Liberty: HTTP ${response.status}`);
      return json(await response.json());
    },
  },
];
