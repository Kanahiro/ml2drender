// Encoders run inside WASM: lossy WebP must not spawn threads (a trap in WASM).
// Run: node tests/encode.ts (after pnpm build:wasm)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MapRenderer } from '../src/index.ts';

const wasm = await WebAssembly.compile(readFileSync(new URL('../wasm/ml2drender_wasm.wasm', import.meta.url)));
const renderer = await MapRenderer.init({ version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#336699' } }] }, { wasm });
const image = await renderer.renderView({ center: [0, 0], zoom: 0, width: 64, height: 32 });
const fourcc = (bytes: Uint8Array) => new TextDecoder().decode(bytes.subarray(8, 16));
assert.equal(fourcc(image.toWebp()), 'WEBPVP8L');
assert.equal(fourcc(image.toWebp(75)), 'WEBPVP8 ');
assert.throws(() => image.toWebp(Number.NaN), RangeError);
console.log('ok: lossless and lossy WebP');
