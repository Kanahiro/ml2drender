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

/**
 * Arabic, Persian and Urdu city names, to see Arabic shaping and right-to-left text. The demotiles
 * fonts have no Arabic glyphs, so every label uses the Protomaps Noto Sans glyphs.
 */
function withArabicLabels(style: StyleSpecification): StyleSpecification {
  const cities: [string, string, number, number][] = [
    ['القاهرة', 'Cairo', 31.2357, 30.0444],
    ['الرياض', 'Riyadh', 46.6753, 24.7136],
    ['بغداد', 'Baghdad', 44.3661, 33.3152],
    ['دمشق', 'Damascus', 36.2765, 33.5138],
    ['دبي', 'Dubai', 55.2708, 25.2048],
    ['تونس', 'Tunis', 10.1815, 36.8065],
    ['الدار البيضاء', 'Casablanca', -7.5898, 33.5731],
    ['تهران', 'Tehran', 51.389, 35.6892],
    ['کابل', 'Kabul', 69.2075, 34.5553],
    ['کراچی', 'Karachi', 67.0011, 24.8607],
  ];
  const features = cities.map(([name, en, lng, lat]) => ({
    type: 'Feature' as const,
    properties: { name, en },
    geometry: { type: 'Point' as const, coordinates: [lng, lat] },
  }));
  const font = ['Noto Sans Regular'];
  const layers: LayerSpecification[] = style.layers.map((l) =>
    l.type === 'symbol' ? { ...l, layout: { ...l.layout, 'text-font': font } } : l,
  );
  layers.push(
    { id: 'arabic-cities-dot', type: 'circle', source: 'arabic-cities', paint: { 'circle-radius': 3, 'circle-color': '#c0392b' } },
    {
      id: 'arabic-cities',
      type: 'symbol',
      source: 'arabic-cities',
      layout: {
        'text-field': ['format', ['get', 'name'], {}, '\n', {}, ['get', 'en'], { 'font-scale': 0.7 }],
        'text-font': font,
        'text-size': 16,
        'text-anchor': 'top',
        'text-offset': [0, 0.4],
      },
      paint: { 'text-color': '#222', 'text-halo-color': '#fff', 'text-halo-width': 1.5 },
    },
  );
  return {
    ...style,
    glyphs: 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf',
    sources: { ...style.sources, 'arabic-cities': { type: 'geojson', data: { type: 'FeatureCollection', features } } },
    layers,
  };
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
  { label: 'MapLibre demo tiles + Arabic labels', load: async () => json(withArabicLabels(JSON.parse(demotiles))) },
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
