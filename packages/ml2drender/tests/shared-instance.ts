// Renderers share one WASM instance per module. A renderer with ttlMs 0 frees its WASM renderer
// after each render, so serving many requests (e.g. a Cloudflare Workers isolate creating a
// renderer per request) reuses the same memory instead of growing it.
// Run: node --experimental-transform-types tests/shared-instance.ts (after pnpm build:wasm)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MapRenderer, type StyleSpecification } from '../src/index.ts';

const wasm = await WebAssembly.compile(readFileSync(new URL('../wasm/ml2drender_wasm.wasm', import.meta.url)));
const features = Array.from({ length: 2000 }, (_, i) => {
  const [x, y] = [(i % 50) * 0.02, Math.floor(i / 50) * 0.02];
  return { type: 'Feature' as const, properties: { k: i % 3 }, geometry: { type: 'Polygon' as const, coordinates: [[[x, y], [x + 0.015, y], [x + 0.01, y + 0.015], [x, y]]] } };
});
const style: StyleSpecification = {
  version: 8,
  sources: { g: { type: 'geojson', data: { type: 'FeatureCollection', features } } },
  layers: [
    { id: 'f', type: 'fill', source: 'g', paint: { 'fill-color': ['match', ['get', 'k'], 0, '#c33', 1, '#3c3', '#33c'] } },
    { id: 'l', type: 'line', source: 'g', paint: { 'line-width': 2 } },
  ],
};
const view = { center: [0.5, 0.4] as [number, number], zoom: 9, width: 512, height: 512 };
const memory = (r: MapRenderer) => (r as unknown as { wasm: { memory: WebAssembly.Memory } }).wasm.memory;

const first = await MapRenderer.init(style, { wasm, cache: { ttlMs: 0 } });
const expected = (await first.renderView(view)).data;
const size = memory(first).buffer.byteLength;
for (let i = 0; i < 20; i++) {
  const r = await MapRenderer.init(style, { wasm, cache: { ttlMs: 0 } });
  assert.equal(memory(r), memory(first), 'renderers of one module share an instance');
  assert.deepEqual((await r.renderView(view)).data, expected);
}
assert.equal(memory(first).buffer.byteLength, size, 'repeated renders reuse the freed memory');
console.log(`ok: 21 renders in ${(size / 2 ** 20).toFixed(1)} MiB of WASM memory`);

