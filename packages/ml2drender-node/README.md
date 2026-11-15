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
| Fetching | built in (`loadResource` to customize) | built in (`loadResource` to customize) |
| Views | Web Mercator, projected CRSs (PROJJSON) | Web Mercator |
| Reprojected sources for GL JS (`getTile`, `toStyle`) | yes | no |
| Concurrency | renders take turns on the JS thread | renders run in parallel on libuv's thread pool, off the JS thread |

Both draw with the same Rust core, so the same view gives the same image. Choose this package for throughput on a Node.js server; choose [`@ml2drender/wasm`](https://github.com/Kanahiro/ml2drender#readme) for everything else.

## Usage

```ts
import { encodePng, Renderer } from '@ml2drender/node';

const style = await (await fetch('https://demotiles.maplibre.org/style.json')).json();
const renderer = new Renderer(style);
const rgba = await renderer.renderView({
  lng: 139.767, lat: 35.681, zoom: 5, bearing: 0,
  width: 512, height: 512, pixelRatio: 1, margin: 0,
});

const png = await encodePng(rgba, 512, 512);
```

The renderer fetches TileJSON, GeoJSON, sprites, tiles and glyph ranges with the standard `fetch`. HTTP 404 means a missing resource (an empty vector tile, or a raster tile replaced by its parent); other HTTP and network errors reject. Resource URLs are passed on exactly as the style writes them, so make `glyphs`, `sprite` and TileJSON URLs absolute.

## API

### `new Renderer(style, options?)`

`style` is the style object (`StyleSpecification` of `@maplibre/maplibre-gl-style-spec`). Throws a `TypeError` if it is not a style object. The style is fixed for the life of the renderer.

| Option | Default | Description |
|---|---|---|
| `loadResource` | HTTP `fetch` | `(url: string) => Promise<Uint8Array \| null>`, for authentication, caching or non-HTTP sources. Return `null` only for a missing resource; reject for other failures. Loads within a stage run concurrently. Fetched bytes are not cached: cache in your loader if needed. |
| `transformLayer` | fill-extrusion to fill | `(layer) => LayerSpecification[]`. Replaces each layer of a type the renderer does not draw (fill-extrusion) with any number of layers. By default a fill-extrusion becomes a fill with the same color, opacity, pattern and translation, and any other is dropped. |

### `renderer.renderView(view)`

Returns non-premultiplied RGBA8 pixels, row by row, as a `Promise<Uint8Array>`. Resources come in stages (sources, then tiles, then glyph ranges); the renderer repeats the loading loop until all are ready, then draws.

A renderer keeps the resources and tiles it has decoded, so later views load only what is missing. Renders of one renderer take turns; use several renderers to render in parallel.

`view` is a Web Mercator camera; every field is required:

| Field | |
|---|---|
| `lng`, `lat` | Center, in degrees. |
| `zoom` | MapLibre zoom: the world is `512 * 2^zoom` CSS pixels wide. |
| `bearing` | Degrees clockwise. |
| `width`, `height` | Output size in CSS pixels. |
| `pixelRatio` | Device pixels per CSS pixel. The image is `round(width * pixelRatio)` x `round(height * pixelRatio)` pixels. |
| `margin` | CSS pixels drawn around the view and cropped, so labels near the edge are placed as in a larger map. |

### `encodePng(rgba, width, height)`, `encodeWebp(rgba, width, height)`, `encodeJpeg(rgba, width, height, quality)`

Encode RGBA8 pixels on the thread pool. PNG and WebP are lossless; JPEG takes `quality` 1–100 and is flattened over black. Each returns a `Promise<Uint8Array>`.

## License

BSD-3-Clause
