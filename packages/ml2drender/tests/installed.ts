// The packed package, installed from its tarball, renders in Node.
// Run from a directory where the tarball is installed: cp tests/installed.ts <dir> && node <dir>/installed.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { MapRenderer } from '@ml2drender/wasm';

const wasm = await WebAssembly.compile(readFileSync(createRequire(import.meta.url).resolve('@ml2drender/wasm/renderer.wasm')));
const renderer = await MapRenderer.init({ version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#f00' } }] }, { wasm });
const image = await renderer.renderTile({ z: 0, x: 0, y: 0 });
assert.deepEqual([...image.data.subarray(0, 4)], [255, 0, 0, 255]);
assert.deepEqual([...image.toPng().subarray(1, 4)], [...Buffer.from('PNG')]);
console.log('ok: installed package renders');
