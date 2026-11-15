// The addon renders views of a style, loading what they need, and encodes the result.
// Run: node tests/render.ts (after pnpm build:native)
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import { encodeJpeg, encodePng, encodeWebp, Renderer, type RendererOptions } from '../src/index.ts';

const style: StyleSpecification = {
  version: 8,
  sources: { points: { type: 'geojson', data: 'test://points.geojson' } },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#ffffff' } },
    { id: 'points', type: 'circle', source: 'points', paint: { 'circle-color': '#ff0000' } },
  ],
};
const points = new TextEncoder().encode(JSON.stringify({
  type: 'FeatureCollection',
  features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [140, 37] } }],
}));

const view = { lng: 140, lat: 37, zoom: 4, bearing: 0, width: 64, height: 32, pixelRatio: 1, margin: 0 };
const loaded: string[] = [];
const renderer = new Renderer(style, { loadResource: async (url) => {
  loaded.push(url);
  return points;
} });
const rgba = await renderer.renderView(view);
assert.deepEqual(loaded, ['test://points.geojson']);
assert.equal(rgba.length, 64 * 32 * 4);
const pixel = (x: number, y: number) => [...rgba.subarray((y * 64 + x) * 4, (y * 64 + x) * 4 + 4)];
assert.deepEqual(pixel(0, 0), [255, 255, 255, 255]);
assert.deepEqual(pixel(32, 16), [255, 0, 0, 255]);

assert.deepEqual([...(await encodePng(rgba, 64, 32)).subarray(1, 4)], [0x50, 0x4e, 0x47]);
assert.deepEqual([...(await encodeWebp(rgba, 64, 32)).subarray(8, 12)], [0x57, 0x45, 0x42, 0x50]);
assert.deepEqual([...(await encodeJpeg(rgba, 64, 32, 80)).subarray(0, 2)], [0xff, 0xd8]);
// A JSON string is not a style.
assert.throws(() => new Renderer(JSON.stringify(style) as any), TypeError);

// A renderer keeps what it loaded, and overlapping renders of other views take turns.
const west = { ...view, lng: 120 };
const [moved, again] = await Promise.all([renderer.renderView(west), renderer.renderView(view)]);
assert.deepEqual(again, rgba);
assert.deepEqual([...moved.subarray((16 * 64 + 32) * 4, (16 * 64 + 32) * 4 + 4)], [255, 255, 255, 255]);
assert.deepEqual(loaded, ['test://points.geojson']);

const render = (style: StyleSpecification, options?: RendererOptions) => new Renderer(style, options).renderView(view);
const missing = await render(style, { loadResource: async () => null });
assert.deepEqual(missing, new Uint8Array(64 * 32 * 4).fill(255));
// A failed render rejects and leaves the renderer usable.
let offline: Error | undefined = new Error('offline');
const flaky = new Renderer(style, { loadResource: async () => {
  if (offline) throw offline;
  return points;
} });
await assert.rejects(flaky.renderView(view), (error) => error === offline);
offline = undefined;
assert.deepEqual(await flaky.renderView(view), rgba);

// Layers the renderer does not draw go through transformLayer: by default a fill-extrusion
// becomes a fill and others are dropped; unsupported layers that come back are skipped.
const extruded: StyleSpecification = {
  version: 8,
  sources: { box: { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[130, 30], [150, 30], [150, 45], [130, 45], [130, 30]]] } } } },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#ffffff' } },
    { id: 'box', type: 'fill-extrusion', source: 'box', paint: { 'fill-extrusion-color': '#0000ff', 'fill-extrusion-height': 10 } },
    { id: 'future', type: 'unknown' } as any,
  ],
};
const center = async (transformLayer?: (layer: any) => any[]) => [...(await render(extruded, { transformLayer })).subarray((16 * 64 + 32) * 4, (16 * 64 + 32) * 4 + 4)];
assert.deepEqual(await center(), [0, 0, 255, 255]);
assert.deepEqual(await center(() => []), [255, 255, 255, 255]);
assert.deepEqual(await center((layer) => [layer]), [255, 255, 255, 255]);
const seen: string[] = [];
assert.deepEqual(await center((layer) => {
  seen.push(layer.id);
  return layer.id === 'box' ? [{ id: 'a', type: 'fill', source: 'box', paint: { 'fill-color': '#00ff00' } }, { id: 'b', type: 'line', source: 'box' }] : [];
}), [0, 255, 0, 255]);
assert.deepEqual(seen, ['box', 'future']);
assert.throws(() => new Renderer(extruded, { transformLayer: ((layer: any) => layer) as any }), TypeError);

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
const httpStyle = (path: string): StyleSpecification => ({ ...style, sources: { points: { type: 'geojson', data: `${base}${path}` } } });
try {
  assert.deepEqual(await render(httpStyle('/points.geojson')), rgba);
  assert.deepEqual(await render(httpStyle('/redirect')), rgba);
  assert.deepEqual(await render(httpStyle('/missing')), missing);
  for (const [path, status] of [['/forbidden', 403], ['/error', 500]] as const) {
    await assert.rejects(render(httpStyle(path)), new RegExp(`HTTP ${status} ${base}${path}`));
  }
  await assert.rejects(render(httpStyle('/offline')), TypeError);
  const vectorStyle = structuredClone(style) as any;
  vectorStyle.sources.points = { type: 'vector', url: `${base}/source.json` };
  vectorStyle.layers[1]['source-layer'] = 'points';
  assert.deepEqual(await render(vectorStyle), missing);
  assert.ok(requests.includes('/source.json'));
  assert.ok(requests.includes('/tiles/0/0/0.pbf'));
  vectorStyle.sources.points = { type: 'vector', tiles: [`${base}/missing/{z}/{x}/{y}.pbf`], maxzoom: 0 };
  assert.deepEqual(await render(vectorStyle), missing);
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
console.log('ok: native addon renders');
