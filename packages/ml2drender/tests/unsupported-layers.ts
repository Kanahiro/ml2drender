// Layers of types the renderer does not draw are left out.
// Run: node tests/unsupported-layers.ts (after pnpm build:wasm)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MapRenderer, type StyleSpecification } from '../src/index.ts';

const wasm = await WebAssembly.compile(readFileSync(new URL('../wasm/ml2drender_wasm.wasm', import.meta.url)));
const style: StyleSpecification = {
  version: 8,
  sources: { box: { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[130, 30], [150, 30], [150, 45], [130, 45], [130, 30]]] } } } },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#ffffff' } },
    { id: 'box', type: 'fill-extrusion', source: 'box', paint: { 'fill-extrusion-color': '#0000ff', 'fill-extrusion-height': 10 } },
    { id: 'future', type: 'unknown' } as never,
  ],
};
const renderer = await MapRenderer.init(style, { wasm });
const { data } = await renderer.renderView({ center: [140, 37], zoom: 4, width: 64, height: 32 });
assert.deepEqual([...data.subarray((16 * 64 + 32) * 4, (16 * 64 + 32) * 4 + 4)], [255, 255, 255, 255]);
console.log('ok: unsupported layers are left out');
