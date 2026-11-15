# @ml2drender/node

[ml2drender](https://github.com/Kanahiro/ml2drender), a 2D map renderer for MapLibre styles written in pure Rust, as a native Node.js addon (Node-API). It needs no GPU.

```sh
npm install @ml2drender/node
```

Prebuilt addons are published for Linux (x64, arm64; glibc 2.34+), macOS (x64, arm64) and Windows (x64). npm installs the one for your machine.

## Which package?

| | `@ml2drender/wasm` (WebAssembly) | `@ml2drender/node` (this package) |
|---|---|---|
| Runs in | browsers, Node.js, Deno, Cloudflare Workers | Node.js |
| Fetching | built in (`loadResource` to customize) | you write the `needs` → fetch → `provide` loop |
| Views | Web Mercator, projected CRSs (PROJJSON) | Web Mercator |
| Reprojected sources for GL JS (`getTile`, `toStyle`) | yes | no |
| Concurrency | renders take turns on the JS thread | renders run in parallel on libuv's thread pool, off the JS thread |

Both draw with the same Rust core, so the same view gives the same image. Choose this package for throughput on a Node.js server; choose [`@ml2drender/wasm`](https://github.com/Kanahiro/ml2drender#readme) for everything else.

## Usage

```ts
import { encodePng, Renderer } from '@ml2drender/node';

const style = await (await fetch('https://demotiles.maplibre.org/style.json')).text();
const renderer = new Renderer(style, {
  lng: 139.767, lat: 35.681, zoom: 5, bearing: 0,
  width: 512, height: 512, pixelRatio: 1, margin: 0,
});

// Resources come in stages (sources, then tiles, then glyph ranges), each found from the last.
for (let urls = await renderer.needs(); urls.length > 0; urls = await renderer.needs()) {
  await Promise.all(urls.map(async (url) => {
    const response = await fetch(url);
    if (!response.ok && response.status !== 404) throw new Error(`HTTP ${response.status} ${url}`);
    await renderer.provide(url, response.ok ? new Uint8Array(await response.arrayBuffer()) : null);
  }));
}
const rgba = await renderer.render(0);
const png = await encodePng(rgba, 512, 512);
```

Resource URLs are passed on exactly as the style writes them, so make `glyphs`, `sprite` and TileJSON URLs absolute. Provide `null` only for a missing resource (like HTTP 404: a missing vector tile is empty, a missing raster tile is replaced by its parent). Fetched bytes are not cached: cache in your fetch loop if you need to.

## API

### `new Renderer(style, view)`

`style` is the style JSON as a string. Throws on an invalid style. The style is fixed for the life of the renderer.

`view` is a Web Mercator camera; every field is required:

| Field | |
|---|---|
| `lng`, `lat` | Center, in degrees. |
| `zoom` | MapLibre zoom: the world is `512 * 2^zoom` CSS pixels wide. |
| `bearing` | Degrees clockwise. |
| `width`, `height` | Output size in CSS pixels. |
| `pixelRatio` | Device pixels per CSS pixel. The image is `round(width * pixelRatio)` x `round(height * pixelRatio)` pixels. |
| `margin` | CSS pixels drawn around the view and cropped, so labels near the edge are placed as in a larger map. |

Calls on one renderer must not overlap: await each before the next. Use several renderers to render in parallel.

| Method | |
|---|---|
| `needs(): Promise<string[]>` | URLs still needed before `render`. Repeat with `provide` until it is empty. |
| `provide(url, bytes \| null): Promise<void>` | The bytes of a URL from `needs`, or `null` if it is missing. The bytes are read in place: don't modify them until this resolves. |
| `render(oldest): Promise<Uint8Array>` | Non-premultiplied RGBA8 pixels, row by row. Pass `0` as `oldest` unless you use tickets (below). |
| `setView(view)` | Point the renderer at another camera. Resources and tiles it already has are reused, so the next `needs` asks only for what is missing. |
| `setKeepBuckets(keep)` | `false` frees line and fill geometry as soon as it is drawn: lower peak memory for a renderer used once. Default `true`. |
| `setTicket(ticket)` | For hosts that interleave the fetch loops of several views on one renderer (calling `setView` before each step): number each render with an increasing ticket, set it before each of its steps, and pass the oldest ticket still in progress to `render`, so that tiles another render still needs are kept. |

### `encodePng(rgba, width, height)`, `encodeWebp(rgba, width, height)`, `encodeJpeg(rgba, width, height, quality)`

Encode RGBA8 pixels on the thread pool. PNG and WebP are lossless; JPEG takes `quality` 1–100 and is flattened over black. Each returns a `Promise<Uint8Array>`.

## License

BSD-3-Clause
