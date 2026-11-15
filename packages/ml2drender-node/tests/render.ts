// The addon renders a style through the needs → provide loop and encodes the result.
// Run: node tests/render.ts (after pnpm build:native)
import assert from 'node:assert/strict';
import { encodeJpeg, encodePng, encodeWebp, Renderer } from '../src/index.ts';

const style = JSON.stringify({
  version: 8,
  sources: { points: { type: 'geojson', data: 'test://points.geojson' } },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#ffffff' } },
    { id: 'points', type: 'circle', source: 'points', paint: { 'circle-color': '#ff0000' } },
  ],
});
const points = new TextEncoder().encode(JSON.stringify({
  type: 'FeatureCollection',
  features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [140, 37] } }],
}));

const view = { lng: 140, lat: 37, zoom: 4, bearing: 0, width: 64, height: 32, pixelRatio: 1, margin: 0 };
const renderer = new Renderer(style, view);
const urls = await renderer.needs();
assert.deepEqual(urls, ['test://points.geojson']);
for (const url of urls) await renderer.provide(url, points);
assert.deepEqual(await renderer.needs(), []);
const rgba = await renderer.render(0);
assert.equal(rgba.length, 64 * 32 * 4);
const pixel = (x: number, y: number) => [...rgba.subarray((y * 64 + x) * 4, (y * 64 + x) * 4 + 4)];
assert.deepEqual(pixel(0, 0), [255, 255, 255, 255]);
assert.deepEqual(pixel(32, 16), [255, 0, 0, 255]);

assert.deepEqual([...(await encodePng(rgba, 64, 32)).subarray(1, 4)], [0x50, 0x4e, 0x47]);
assert.deepEqual([...(await encodeWebp(rgba, 64, 32)).subarray(8, 12)], [0x57, 0x45, 0x42, 0x50]);
assert.deepEqual([...(await encodeJpeg(rgba, 64, 32, 80)).subarray(0, 2)], [0xff, 0xd8]);
assert.throws(() => new Renderer('{', view));
console.log('ok: native addon renders');
