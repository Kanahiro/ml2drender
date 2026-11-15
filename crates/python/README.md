# ml2drender (Python)

Python bindings of [ml2drender](https://github.com/Kanahiro/ml2drender), a 2D map renderer for MapLibre styles written in pure Rust. It needs no GPU and links no C libraries.

```sh
pip install ml2drender
```

Wheels are built for Linux (x86-64, arm64; glibc), macOS (x86-64, arm64) and Windows (x86-64), for CPython 3.11 and later (abi3).

## Usage

`await render(...)` fetches the resources a style needs (TileJSON, GeoJSON, sprites, tiles, glyph ranges) concurrently with [HTTPX](https://www.python-httpx.org/async/). You can override fetching with an async `load` function.

```python
import asyncio
from pathlib import Path

import httpx
import ml2drender


async def main():
    async with httpx.AsyncClient(follow_redirects=True) as client:
        response = await client.get("https://demotiles.maplibre.org/style.json")
        response.raise_for_status()
        style = response.text

    view = ml2drender.View.tile(5, 28, 12, tile_size=512)
    # or a camera: ml2drender.View((139.767, 35.681), zoom=5, width=512, height=512, bearing=0)
    rgba = await ml2drender.render(style, view)
    width, height = view.size
    Path("tile.png").write_bytes(ml2drender.encode_png(rgba, width, height))


asyncio.run(main())
```

HTTP 404 means a missing resource (an empty vector tile, or a raster tile replaced by its parent). Other HTTP and network errors propagate as HTTPX exceptions. Resource URLs are used exactly as the style writes them, so make `glyphs`, `sprite` and TileJSON URLs absolute.

One `httpx.AsyncClient` is reused across all resource stages of a render, with redirects enabled and HTTPX's default timeouts and connection limits. Resources within each stage are fetched concurrently, without caching. A failed or cancelled render cancels and awaits its outstanding loads before closing the client. Decoding and drawing still run synchronously on the calling thread; the asynchronous API covers resource I/O.

`render` is an async function: existing synchronous calls must become `await ml2drender.render(...)`. At a synchronous entry point, use `asyncio.run(...)`; inside an existing asyncio event loop, use `await` directly.

For authentication, caching, custom timeouts or non-HTTP sources, pass an async `load(url)` returning `bytes` or `None` for a missing resource. Raise for other failures; the exception propagates out of `render`. The loader must allow concurrent calls and cancellation. For example, inside an async function, to reuse an authenticated client:

```python
async with httpx.AsyncClient(headers={"Authorization": "Bearer ..."}, follow_redirects=True) as client:

    async def load(url):
        response = await client.get(url)
        if response.status_code == 404:
            return None
        response.raise_for_status()
        return response.content

    rgba = await ml2drender.render(style, view, load=load)
```

To reuse decoded resources across views or manage fetching yourself, drive the sans-IO steps. Resources come in stages, each found from the last, so repeat until nothing is needed. Inside the client context above, replace the `render` call with:

```python
renderer = ml2drender.Renderer(style, view)
while urls := renderer.needs():
    # Supply each URL's bytes (or None for a missing resource).
    for url in urls:
        renderer.provide(url, await load(url))
rgba = renderer.render()
```

A `Renderer` keeps what it has loaded: `set_view` points it at another camera and the next `needs` asks only for what is missing.

## API

| | |
|---|---|
| `View(center, zoom, width, height, bearing=0.0, pixel_ratio=1.0, margin=0)` | A Web Mercator camera. `center` is (lng, lat) in degrees; `zoom` is the MapLibre zoom (the world is `512 * 2**zoom` CSS pixels wide); `bearing` is degrees clockwise. The image is `width` x `height` CSS pixels, times `pixel_ratio` in pixels. `margin` CSS pixels are drawn around it and cropped, so labels near the edge are placed as in a larger map. |
| `View.tile(z, x, y, tile_size=256)` | The XYZ tile `z/x/y`, `tile_size` CSS pixels square. |
| `View.size` | `(width, height)` of the output in pixels. |
| `await render(style, view, load=None)` | Non-premultiplied RGBA8 pixels (`bytes`, row by row) of `style` (a JSON string) in `view`. Fetches resources concurrently with HTTPX by default; optionally pass an async `load(url) -> bytes \| None` callable. Requires asyncio. |
| `Renderer(style, view)` | The steps of `render`: `needs() -> list[str]`, `provide(url, data: bytes \| None)`, `render() -> bytes`, `set_view(view)`. Not thread-safe. |
| `encode_png(rgba, width, height)` | Lossless PNG. |
| `encode_webp(rgba, width, height)` | Lossless WebP. |
| `encode_jpeg(rgba, width, height, quality=90)` | JPEG, flattened over black. |

Invalid styles and rendering errors raise `RuntimeError`. Type hints and docstrings ship with the package (inline Python annotations, `_native.pyi` and `py.typed`).

The Python bindings draw Web Mercator views only. Projected CRSs (PROJJSON) and reprojected sources for MapLibre GL JS are in the [JavaScript package](https://github.com/Kanahiro/ml2drender#javascript-api).

## License

BSD-3-Clause
