// `projected(crs).renderView` is GL JS's camera on the CRS's grid: `center` lands on the middle of the
// image, a CSS pixel is `extentAtZoom0 / (512 * 2^zoom)` CRS units, and `bearing` turns the map around `center`.
// Run: node tests/projected-view.ts (after pnpm build:wasm)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MapRenderer, type StyleSpecification } from '../src/index.ts';

const wasm = await WebAssembly.compile(readFileSync(new URL('../wasm/ml2drender_wasm.wasm', import.meta.url)));
// Web Mercator, whose formulas fit in a line each.
const R = 6378137;
const projjson = {
  type: 'ProjectedCRS',
  base_crs: { datum: { ellipsoid: { semi_major_axis: R, inverse_flattening: 298.257223563 } } },
  conversion: { method: { name: 'Popular Visualisation Pseudo Mercator' }, parameters: [] },
};
const forward = ([lng, lat]: number[]) => [R * lng * Math.PI / 180, R * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360))];
const inverse = ([x, y]: number[]) => [x / R * 180 / Math.PI, (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI];
const crs = { name: 'EPSG:3857', projjson, tileMatrixSet: { origin: [13000000, 6000000] as [number, number], extentAtZoom0: 4000000 } };

const center: [number, number] = [139.76, 35.68];
const zoom = 6.5;
const unit = crs.tileMatrixSet.extentAtZoom0 / (512 * 2 ** zoom);
const [x, y] = forward(center);
// A point 100 px east and 40 px north of the center.
const other = inverse([x + 100 * unit, y + 40 * unit]);
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
// Bearing 90: east is up, north to the left.
const turned = await renderer.projected(crs).renderView({ center, zoom, bearing: 90, width: 256, height: 256 });
const turnedAlpha = (px: number, py: number) => turned.data[(py * turned.width + px) * 4 + 3];
assert.equal(turnedAlpha(128, 128), 255, 'the map turns around the center');
assert.equal(turnedAlpha(88, 28), 255, '100 px east is 100 px up, 40 px north is 40 px left');
assert.equal(turnedAlpha(228, 88), 0);
await assert.rejects(renderer.projected(crs).renderView({ center, zoom, bearing: NaN, width: 256, height: 128 }), RangeError);
console.log('ok: projected renderView');
