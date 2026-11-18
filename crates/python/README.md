# ml2drender (Python)

[![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/Kanahiro/ml2drender/blob/main/examples/python/quickstart.ipynb)

Python bindings of [ml2drender](https://github.com/Kanahiro/ml2drender), a 2D map renderer for MapLibre styles written in pure Rust. It needs no GPU and links no C libraries.

```sh
pip install ml2drender
```

Wheels are built for Linux (x86-64, arm64; glibc), macOS (x86-64, arm64) and Windows (x86-64), for CPython 3.11 and later (abi3).

## Usage

A `Renderer` draws views of a style. It fetches the resources they need (TileJSON, GeoJSON, sprites, tiles, glyph ranges) concurrently with [HTTPX](https://www.python-httpx.org/async/). You can override fetching with an async `load` function.

```python
import asyncio
from pathlib import Path

import httpx
import ml2drender


async def main():
    async with httpx.AsyncClient(follow_redirects=True) as client:
        response = await client.get("https://demotiles.maplibre.org/style.json")
        response.raise_for_status()
        style = response.json()

    renderer = ml2drender.Renderer(style)
    view = ml2drender.View.tile(5, 28, 12, tile_size=512)
    # or a camera: ml2drender.View((139.767, 35.681), zoom=5, width=512, height=512, bearing=0)
    rgba = await renderer.render_view(view)
    width, height = view.pixels
    Path("tile.png").write_bytes(ml2drender.encode_png(rgba, width, height))


asyncio.run(main())
```

HTTP 404 means a missing resource (an empty vector tile, or a raster tile replaced by its parent). Other HTTP and network errors propagate as HTTPX exceptions. Resource URLs are used exactly as the style writes them, so make `glyphs`, `sprite` and TileJSON URLs absolute.

One `httpx.AsyncClient` is reused across all resource stages of a render, with redirects enabled and HTTPX's default timeouts and connection limits. Resources within each stage are fetched concurrently, without caching. A failed or cancelled render cancels and awaits its outstanding loads before closing the client. Decoding and drawing still run synchronously on the calling thread; the asynchronous API covers resource I/O.

A `Renderer` keeps the resources and tiles it has decoded, so later views load only what is missing. Renders of one renderer take turns.

For authentication, caching, custom timeouts or non-HTTP sources, pass an async `load(url)` returning `bytes` or `None` for a missing resource. Raise for other failures; the exception propagates out of `render_view`. The loader must allow concurrent calls and cancellation. For example, inside an async function, to reuse an authenticated client:

```python
async with httpx.AsyncClient(headers={"Authorization": "Bearer ..."}, follow_redirects=True) as client:

    async def load(url):
        response = await client.get(url)
        if response.status_code == 404:
            return None
        response.raise_for_status()
        return response.content

    renderer = ml2drender.Renderer(style, load=load)
    rgba = await renderer.render_view(view)
```

## API

| | |
|---|---|
| `Renderer(style, load=None)` | A renderer of `style` (the style JSON as a `dict`), fixed for its life. `load` is an optional async `load(url) -> bytes \| None`. Not thread-safe. |
| `await renderer.render_view(view)` | Non-premultiplied RGBA8 pixels (`bytes`, row by row) of `view`, after loading the resources it needs. Requires asyncio. |
| `View(center, zoom, width, height, bearing=0.0, pixel_ratio=1.0, margin=0)` | A Web Mercator camera. `center` is (lng, lat) in degrees; `zoom` is the MapLibre zoom (the world is `512 * 2**zoom` CSS pixels wide); `bearing` is degrees clockwise. The image is `width` x `height` CSS pixels, times `pixel_ratio` in pixels. `margin` CSS pixels are drawn around it and cropped, so labels near the edge are placed as in a larger map. |
| `View.tile(z, x, y, tile_size=256)` | The XYZ tile `z/x/y`, `tile_size` CSS pixels square. |
| `View.pixels` | `(width, height)` of the output in pixels. |
| `renderer.projected(projjson, tile_matrix_set=None)` | The renderer drawing in a CRS. `projjson` is the PROJJSON as a `dict` (for the supported methods, see [Projected coordinate reference systems](https://github.com/Kanahiro/ml2drender#projected-coordinate-reference-systems)); anything else raises `TypeError`. `tile_matrix_set` is the CRS's tile grid, which tiles and cameras need: a `TileMatrixSet`, or an OGC 2D TileMatrixSet (2.0) as a `dict`. One renderer can mix CRSs and Web Mercator views, and they share loaded resources. |
| `TileMatrixSet(origin, extent_at_zoom0)` | MapLibre GL JS's tile grid for a CRS (`addProjection`): tile 0/0/0 is a square of side `extent_at_zoom0` whose top-left corner is `origin` (min x, max y), in CRS units. Each zoom level splits every tile into four. Use it when the tiles are shown by MapLibre GL JS (pass the grid given to `addProjection`). Use an OGC 2D TileMatrixSet `dict` for a published grid, or for one this form cannot describe: scales not halved at each level, tiles not square or not 2^z × 2^z, a fixed list of levels. |
| `await projected.render(box)` | `render_view` of a box of the CRS. An unsupported CRS raises `RuntimeError`. |
| `await projected.render_tile(z, x, y, tile_size=256, pixel_ratio=1.0, margin=0)` | Tile `z/x/y` of the CRS's grid, `tile_size` CSS pixels wide and as high as the grid's tiles are. In an OGC set, `z` is an index of its `tileMatrices`. Without a `tile_matrix_set` it raises `TypeError`. |
| `await projected.render_view(view)` | The camera `view` (a `View`) in the CRS: the same area as MapLibre GL JS draws with that center, zoom and bearing once the CRS is registered with `addProjection`. At zoom 0, a tile of the grid's first level (tile 0/0/0 of a `TileMatrixSet`) is 512 CSS pixels wide. Without a `tile_matrix_set` it raises `TypeError`. |
| `ProjectedBox(bbox, size, pixel_ratio=1.0, margin=0)` | A box of a CRS. `bbox` is `(min_x, min_y, max_x, max_y)` in CRS units (degrees for longlat), easting first, with the CRS's y axis up. The image has the box's aspect ratio and `size` CSS pixels on its long side. The rest is as in `View`. For a rotated view, use `render_view`. |
| `ProjectedBox.pixels` | `(width, height)` of the output in pixels. |
| `encode_png(rgba, width, height)` | Lossless PNG. |
| `encode_webp(rgba, width, height)` | Lossless WebP. |
| `encode_jpeg(rgba, width, height, quality=90)` | JPEG, flattened over black. |

Layers of types the renderer does not draw (fill-extrusion) are skipped; rewrite them in the style beforehand if you want them drawn.

A `style` that is not a JSON-serializable `dict` raises `TypeError`; rendering errors raise `RuntimeError`. Type hints and docstrings ship with the package (inline Python annotations, `_native.pyi` and `py.typed`). The sans-IO steps (`needs` / `provide` / `render`) stay in `ml2drender._native.Renderer`, which is not a public API.

In a projected CRS, vector layers are drawn with projected vertices; raster, hillshade and color-relief are rendered in Web Mercator and warped:

```python
# utm54n: PROJJSON of EPSG:32654, as a dict
utm = renderer.projected(utm54n, ml2drender.TileMatrixSet((-2_000_000, 6_000_000), 4_000_000))

# a box in CRS units
box = ml2drender.ProjectedBox((300_000, 3_900_000, 500_000, 4_100_000), size=512)
rgba = await utm.render(box)
# a tile of the CRS's grid
rgba = await utm.render_tile(3, 4, 2)
# a camera
rgba = await utm.render_view(ml2drender.View((139.767, 35.681), zoom=6, width=800, height=600, bearing=30))
```

Reprojected sources for MapLibre GL JS are in the [JavaScript package](https://github.com/Kanahiro/ml2drender#javascript-api).

## License

BSD-3-Clause
