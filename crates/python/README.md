# ml2drender (Python)

Python bindings of [ml2drender](https://github.com/Kanahiro/ml2drender), a 2D map renderer for MapLibre styles written in pure Rust. It needs no GPU and links no C libraries.

```sh
pip install ml2drender
```

Wheels are built for Linux (x86-64, arm64; glibc), macOS (x86-64, arm64) and Windows (x86-64), for CPython 3.9 and later (abi3).

## Usage

The renderer does no I/O. It asks for the resources a style needs (TileJSON, GeoJSON, sprites, tiles, glyph ranges) and you load them. `render` runs that loop with a `load` function:

```python
import json
import urllib.error
import urllib.request

import ml2drender

def load(url):
    try:
        with urllib.request.urlopen(url) as response:
            return response.read()
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None  # missing: an empty vector tile, a raster tile replaced by its parent
        raise

style = load("https://demotiles.maplibre.org/style.json").decode()

view = ml2drender.View.tile(5, 28, 12, tile_size=512)
# or a camera: ml2drender.View((139.767, 35.681), zoom=5, width=512, height=512, bearing=0)
rgba = ml2drender.render(style, view, load)
width, height = view.size
open("tile.png", "wb").write(ml2drender.encode_png(rgba, width, height))
```

Resource URLs reach `load` exactly as the style writes them, so make `glyphs`, `sprite` and TileJSON URLs absolute. `load` should return `None` only for a missing resource; raise for other failures (the exception propagates out of `render`).

To load concurrently (for example with asyncio or a thread pool), drive the steps yourself. Resources come in stages, each found from the last, so repeat until nothing is needed:

```python
from concurrent.futures import ThreadPoolExecutor

renderer = ml2drender.Renderer(style, view)
with ThreadPoolExecutor(16) as pool:
    while urls := renderer.needs():
        for url, data in zip(urls, pool.map(load, urls)):
            renderer.provide(url, data)
rgba = renderer.render()
```

A `Renderer` keeps what it has loaded: `set_view` points it at another camera and the next `needs` asks only for what is missing.

## API

| | |
|---|---|
| `View(center, zoom, width, height, bearing=0.0, pixel_ratio=1.0, margin=0)` | A Web Mercator camera. `center` is (lng, lat) in degrees; `zoom` is the MapLibre zoom (the world is `512 * 2**zoom` CSS pixels wide); `bearing` is degrees clockwise. The image is `width` x `height` CSS pixels, times `pixel_ratio` in pixels. `margin` CSS pixels are drawn around it and cropped, so labels near the edge are placed as in a larger map. |
| `View.tile(z, x, y, tile_size=256)` | The XYZ tile `z/x/y`, `tile_size` CSS pixels square. |
| `View.size` | `(width, height)` of the output in pixels. |
| `render(style, view, load)` | Non-premultiplied RGBA8 pixels (`bytes`, row by row) of `style` (a JSON string) in `view`. |
| `Renderer(style, view)` | The steps of `render`: `needs() -> list[str]`, `provide(url, data: bytes \| None)`, `render() -> bytes`, `set_view(view)`. Not thread-safe. |
| `encode_png(rgba, width, height)` | Lossless PNG. |
| `encode_webp(rgba, width, height)` | Lossless WebP. |
| `encode_jpeg(rgba, width, height, quality=90)` | JPEG, flattened over black. |

Invalid styles and rendering errors raise `RuntimeError`. Type hints and docstrings ship with the package (`ml2drender.pyi`).

The Python bindings draw Web Mercator views only. Projected CRSs (PROJJSON), reprojected sources for MapLibre GL JS and resource fetching are in the [JavaScript package](https://github.com/Kanahiro/ml2drender#javascript-api).

## License

BSD-3-Clause
