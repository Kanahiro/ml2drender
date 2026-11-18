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

// A box of a CRS (PROJJSON), here longitude/latitude: the point is in the middle of 130..150°E, 32..42°N.
const longlat = { type: 'GeographicCRS', datum: { ellipsoid: { semi_major_axis: 6378137, inverse_flattening: 298.257223563 } } };
const box = { bbox: [130, 32, 150, 42] as [number, number, number, number], size: 64, pixelRatio: 2, margin: 0 };
const crs = renderer.projected({ projjson: longlat });
const projected = await crs.render(box);
assert.equal(projected.length, 128 * 64 * 4);
assert.deepEqual([...projected.subarray(0, 4)], [255, 255, 255, 255]);
assert.deepEqual([...projected.subarray((32 * 128 + 64) * 4, (32 * 128 + 64) * 4 + 4)], [255, 0, 0, 255]);
// With the box 3.125° further east, the circle (10 device px in radius) is 20 device px left of the middle.
const offCenter = { ...box, bbox: [133.125, 32, 153.125, 42] as [number, number, number, number] };
const at = (rgba: Uint8Array, x: number, y: number) => [...rgba.subarray((y * 128 + x) * 4, (y * 128 + x) * 4 + 4)];
const moved20 = await crs.render(offCenter);
assert.deepEqual([at(moved20, 44, 32), at(moved20, 64, 32)], [[255, 0, 0, 255], [255, 255, 255, 255]]);
// An unsupported CRS rejects, a first render in a CRS works, and Mercator views still draw afterwards.
await assert.rejects(renderer.projected({ projjson: { type: 'ProjectedCRS', conversion: { method: { name: 'Bonne' } } } }).render(box), /unsupported/);
assert.throws(() => renderer.projected({ projjson: '+proj=longlat' as any }), TypeError);
await assert.rejects(crs.render({ ...box, bbox: [130, 32, Infinity, 42] }), /unsupported/);
assert.deepEqual(await new Renderer(style, { loadResource: async () => points }).projected({ projjson: longlat }).render(box), projected);
// On a grid whose tile 0/0/0 is 80° wide from 90°E 62°N, a tile and GL JS's camera are boxes: tile 2/2/1 is
// 130..150°E, 22..42°N, and at zoom -1 (80° in 256 CSS pixels) 64 x 32 CSS pixels are the box above.
const grid = renderer.projected({ projjson: longlat, tileMatrixSet: { origin: [90, 62], extentAtZoom0: 80 } });
assert.deepEqual(await grid.renderTile({ z: 2, x: 2, y: 1, tileSize: 64, pixelRatio: 1, margin: 0 }), await crs.render({ ...box, bbox: [130, 22, 150, 42], pixelRatio: 1 }));
assert.deepEqual(await grid.renderView({ ...view, zoom: -1, pixelRatio: 2 }), projected);
// The same tiles as an OGC TileMatrixSet's level (latitude first), and tiles half as high as wide.
const level = { cellSize: 20 / 64, pointOfOrigin: [62, 90], tileWidth: 64, tileHeight: 64, matrixWidth: 4, matrixHeight: 4 };
const ogc = (m: object) => renderer.projected({ projjson: longlat, tileMatrixSet: { orderedAxes: ['Lat', 'Lon'], tileMatrices: [{ ...level, ...m }] } as any });
assert.deepEqual(await ogc({}).renderTile({ z: 0, x: 2, y: 1, tileSize: 64, pixelRatio: 1, margin: 0 }), await grid.renderTile({ z: 2, x: 2, y: 1, tileSize: 64, pixelRatio: 1, margin: 0 }));
assert.deepEqual(await ogc({ tileHeight: 32 }).renderTile({ z: 0, x: 2, y: 1, tileSize: 64, pixelRatio: 1, margin: 0 }), await crs.render({ ...box, bbox: [130, 42, 150, 52], pixelRatio: 1 }));
await assert.rejects(ogc({}).renderTile({ z: 1, x: 0, y: 0, tileSize: 64, pixelRatio: 1, margin: 0 }), /unsupported/);
assert.deepEqual(await grid.renderView({ ...view, lng: 143.125, zoom: -1, pixelRatio: 2 }), moved20);
// Turned 90° around the center of that box, east is up, so the circle is below the middle.
const turned = await grid.renderView({ ...view, lng: 143.125, zoom: -1, bearing: 90, pixelRatio: 2 });
assert.deepEqual([at(turned, 64, 52), at(turned, 64, 32), at(turned, 44, 32)], [[255, 0, 0, 255], [255, 255, 255, 255], [255, 255, 255, 255]]);
await assert.rejects(grid.renderTile({ z: 2, x: 4, y: 1, tileSize: 64, pixelRatio: 1, margin: 0 }), /unsupported/);
await assert.rejects(crs.renderTile({ z: 0, x: 0, y: 0, tileSize: 64, pixelRatio: 1, margin: 0 }), TypeError);
await assert.rejects(crs.renderView(view), TypeError);
assert.deepEqual(await renderer.renderView(view), rgba);
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

// Layers of types the renderer does not draw are left out.
const extruded: StyleSpecification = {
  version: 8,
  sources: { box: { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[130, 30], [150, 30], [150, 45], [130, 45], [130, 30]]] } } } },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#ffffff' } },
    { id: 'box', type: 'fill-extrusion', source: 'box', paint: { 'fill-extrusion-color': '#0000ff', 'fill-extrusion-height': 10 } },
    { id: 'future', type: 'unknown' } as any,
  ],
};
assert.deepEqual([...(await render(extruded)).subarray((16 * 64 + 32) * 4, (16 * 64 + 32) * 4 + 4)], [255, 255, 255, 255]);

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
