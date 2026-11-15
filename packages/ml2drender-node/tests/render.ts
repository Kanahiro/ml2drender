// The addon renders a style through the needs → provide loop and encodes the result.
// Run: node tests/render.ts (after pnpm build:native)
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { encodeJpeg, encodePng, encodeWebp, render, Renderer } from '../src/index.ts';

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

// The convenience API preserves custom schemes and the low-level renderer's output.
const loaded: string[] = [];
assert.deepEqual(await render(style, view, async (url) => {
  loaded.push(url);
  return points;
}), rgba);
assert.deepEqual(loaded, ['test://points.geojson']);
const missing = await render(style, view, async () => null);
assert.deepEqual(missing, new Uint8Array(64 * 32 * 4).fill(255));
const offline = new Error('offline');
await assert.rejects(render(style, view, async () => { throw offline; }), (error) => error === offline);
await assert.rejects(render('{', view));

// Exercise real HTTP without depending on a public service, including staged TileJSON → tile loads.
const requests: string[] = [];
const server = createServer((req, res) => {
  requests.push(req.url!);
  if (req.url === '/points.geojson') {
    res.end(points);
  } else if (req.url === '/redirect') {
    res.writeHead(302, { location: '/points.geojson' }).end();
  } else if (req.url === '/source.json') {
    res.end(JSON.stringify({ tiles: [`${base}/tiles/{z}/{x}/{y}.pbf`], minzoom: 0, maxzoom: 0 }));
  } else if (req.url === '/tiles/0/0/0.pbf') {
    res.end(); // An empty MVT is a valid empty tile.
  } else if (req.url === '/offline') {
    req.socket.destroy();
  } else {
    res.writeHead(req.url === '/forbidden' ? 403 : req.url === '/error' ? 500 : 404).end();
  }
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;
const httpStyle = (path: string) => style.replace('test://points.geojson', `${base}${path}`);
try {
  assert.deepEqual(await render(httpStyle('/points.geojson'), view), rgba);
  assert.deepEqual(await render(httpStyle('/redirect'), view), rgba);
  assert.deepEqual(await render(httpStyle('/missing'), view), missing);
  for (const [path, status] of [['/forbidden', 403], ['/error', 500]] as const) {
    await assert.rejects(render(httpStyle(path), view), new RegExp(`HTTP ${status} ${base}${path}`));
  }
  await assert.rejects(render(httpStyle('/offline'), view), TypeError);
  const vectorStyle = JSON.parse(style);
  vectorStyle.sources.points = { type: 'vector', url: `${base}/source.json` };
  vectorStyle.layers[1]['source-layer'] = 'points';
  assert.deepEqual(await render(JSON.stringify(vectorStyle), view), missing);
  assert.ok(requests.includes('/source.json'));
  assert.ok(requests.includes('/tiles/0/0/0.pbf'));
  vectorStyle.sources.points = { type: 'vector', tiles: [`${base}/missing/{z}/{x}/{y}.pbf`], maxzoom: 0 };
  assert.deepEqual(await render(JSON.stringify(vectorStyle), view), missing);
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
console.log('ok: native addon renders');
