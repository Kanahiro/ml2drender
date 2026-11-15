// Layers the renderer does not draw go through `transformLayer`: by default a fill-extrusion
// becomes a fill and others are dropped; unsupported layers that come back are skipped.
// Run: node tests/transform-layer.ts (after pnpm build:wasm)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MapRenderer, type InitOptions, type StyleSpecification } from '../src/index.ts';

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
const center = async (transformLayer?: InitOptions['transformLayer']) => {
  const renderer = await MapRenderer.init(style, { wasm, transformLayer });
  const { data } = await renderer.renderView({ center: [140, 37], zoom: 4, width: 64, height: 32 });
  return [...data.subarray((16 * 64 + 32) * 4, (16 * 64 + 32) * 4 + 4)];
};

assert.deepEqual(await center(), [0, 0, 255, 255]);
assert.deepEqual(await center(() => []), [255, 255, 255, 255]);
assert.deepEqual(await center((layer) => [layer]), [255, 255, 255, 255]);
const seen: string[] = [];
assert.deepEqual(await center((layer) => {
  seen.push(layer.id);
  return layer.id === 'box' ? [{ id: 'a', type: 'fill', source: 'box', paint: { 'fill-color': '#00ff00' } }, { id: 'b', type: 'line', source: 'box' }] : [];
}), [0, 255, 0, 255]);
assert.deepEqual(seen, ['box', 'future']);
await assert.rejects(MapRenderer.init(style, { wasm, transformLayer: ((layer: unknown) => layer) as never }), TypeError);
console.log('ok: transformLayer replaces unsupported layers');
