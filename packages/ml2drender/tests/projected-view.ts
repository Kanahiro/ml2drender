// `projected(crs).renderView` is GL JS's camera on the CRS's grid: `center` lands on the middle of the
// image, and a CSS pixel is `extentAtZoom0 / (512 * 2^zoom)` CRS units.
// Run: node --experimental-transform-types tests/projected-view.ts (after pnpm build:wasm)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadProjection, MapRenderer, type StyleSpecification } from '../src/index.ts';

const wasm = await WebAssembly.compile(readFileSync(new URL('../wasm/ml2drender_wasm.wasm', import.meta.url)));
// UTM zone 54N.
const projjson = {
  type: 'ProjectedCRS',
  base_crs: { datum: { ellipsoid: { semi_major_axis: 6378137, inverse_flattening: 298.257222101 } } },
  conversion: {
    method: { name: 'Transverse Mercator' },
    parameters: [
      { name: 'Longitude of natural origin', value: 141 },
      { name: 'Scale factor at natural origin', value: 0.9996 },
      { name: 'False easting', value: 500000 },
    ],
  },
};
const crs = { name: 'EPSG:32654', projjson, tileMatrixSet: { origin: [-2000000, 6000000] as [number, number], extentAtZoom0: 4000000 } };
const projection = await loadProjection(projjson, { wasm });

const center: [number, number] = [139.76, 35.68];
const zoom = 6.5;
const unit = crs.tileMatrixSet.extentAtZoom0 / (512 * 2 ** zoom);
const [x, y] = projection.forward(center);
// A point 100 px east and 40 px north of the center.
const other = projection.inverse([x + 100 * unit, y + 40 * unit]);
const point = (coordinates: number[]) => ({ type: 'Feature' as const, properties: {}, geometry: { type: 'Point' as const, coordinates } });
const style: StyleSpecification = {
  version: 8,
  sources: { g: { type: 'geojson', data: { type: 'FeatureCollection', features: [point(center), point(other)] } } },
  layers: [{ id: 'c', type: 'circle', source: 'g', paint: { 'circle-radius': 3, 'circle-color': '#f00' } }],
};

const renderer = await MapRenderer.init(style, { wasm });
const image = await renderer.projected(crs).renderView({ center, zoom, width: 256, height: 128 });
const alpha = (px: number, py: number) => image.data[(py * image.width + px) * 4 + 3];
assert.deepEqual([image.width, image.height], [256, 128]);
assert.equal(alpha(128, 64), 255, 'the center is in the middle');
assert.equal(alpha(228, 24), 255, 'a pixel is extentAtZoom0 / (512 * 2^zoom) CRS units');
assert.equal(alpha(178, 44), 0);
// @ts-expect-error No bearing in a CRS.
await assert.rejects(renderer.projected(crs).renderView({ center, zoom, bearing: 30, width: 256, height: 128 }), RangeError);
console.log('ok: projected renderView');
