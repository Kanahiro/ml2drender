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
| Views | Web Mercator by camera, tile or lng/lat box; projected CRSs (PROJJSON) by box, tile of a grid or camera | Web Mercator by camera; projected CRSs (PROJJSON) by box, tile of a grid or camera |
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

### `renderer.projected(crs)`

The renderer drawing in a projected CRS, with the same three methods as in `@ml2drender/wasm`:

```ts
const utm = renderer.projected({
  projjson: utm54n, // PROJJSON of EPSG:32654
  tileMatrixSet: { origin: [-2_000_000, 6_000_000], extentAtZoom0: 4_000_000 },
});

// a box in CRS units
await utm.render({ bbox: [300_000, 3_900_000, 500_000, 4_100_000], bearing: 0, size: 512, pixelRatio: 1, margin: 0 });
// a tile of the CRS's grid
await utm.renderTile({ z: 3, x: 4, y: 2, tileSize: 256, pixelRatio: 1, margin: 0 });
// a camera: the same view as renderView takes
await utm.renderView({ lng: 139.767, lat: 35.681, zoom: 6, bearing: 30, width: 800, height: 600, pixelRatio: 1, margin: 0 });
```

`crs` is a `crs` of `@ml2drender/wasm` (its `name` is not read):

- `projjson`: the CRS as a PROJJSON object. For the supported methods, see [Projected coordinate reference systems](https://github.com/Kanahiro/ml2drender#projected-coordinate-reference-systems). `projected` throws a `TypeError` if it is not an object, and renders reject for an unsupported CRS.
- `tileMatrixSet`: `{ origin: [minX, maxY], extentAtZoom0 }`, MapLibre GL JS's tile grid for the CRS (`addProjection`). Tile 0/0/0 is a square of side `extentAtZoom0` whose top-left corner is `origin`, and each zoom level splits every tile into four. `renderTile` and `renderView` reject without it; `render` does not need it.

`renderView` draws the same area as MapLibre GL JS does with that center, `zoom` and `bearing` once the CRS is registered with `addProjection`: at zoom 0, tile 0/0/0 of the grid is 512 CSS pixels wide.

Vector layers are drawn with projected vertices; raster, hillshade and color-relief are rendered in Web Mercator and warped. One renderer can mix CRSs and Web Mercator views, and they share loaded resources. Every field of a box is required:

| Field | |
|---|---|
| `bbox` | `[minX, minY, maxX, maxY]` in CRS units (degrees for longlat), easting first: the area drawn at bearing 0. |
| `bearing` | Degrees clockwise from the CRS's y axis of the direction that is up. The view turns around the center of `bbox`. |
| `size` | CSS pixels of the image's long side. The image has the box's aspect ratio. |
| `pixelRatio`, `margin` | As in `renderView`. |

A tile has `z`, `x`, `y`, `tileSize` (CSS pixels), `pixelRatio` and `margin`, all required.

The zoom that drives style evaluation and source tile selection comes from CRS units per CSS pixel (it is not the grid zoom of `renderTile` and `renderView`), as in [`@ml2drender/wasm`](https://github.com/Kanahiro/ml2drender#rendererprojectedcrs).

### `encodePng(rgba, width, height)`, `encodeWebp(rgba, width, height)`, `encodeJpeg(rgba, width, height, quality)`

Encode RGBA8 pixels on the thread pool. PNG and WebP are lossless; JPEG takes `quality` 1–100 and is flattened over black. Each returns a `Promise<Uint8Array>`.

## License

BSD-3-Clause
