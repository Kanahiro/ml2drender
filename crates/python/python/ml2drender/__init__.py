"""MapLibre style 2D renderer with asynchronous HTTP resource fetching."""

import asyncio
import json
from collections.abc import Awaitable, Callable
from contextlib import AsyncExitStack
from typing import Any, NamedTuple

import httpx

from . import _native
from ._native import ProjectedBox, View, encode_jpeg, encode_png, encode_webp

__all__ = [
    "ProjectedBox",
    "ProjectedRenderer",
    "Renderer",
    "TileMatrixSet",
    "View",
    "encode_jpeg",
    "encode_png",
    "encode_webp",
]


Layer = dict[str, Any]
TransformLayer = Callable[[Layer], list[Layer]]

_SUPPORTED_LAYERS = frozenset(
    {"background", "fill", "line", "circle", "raster", "symbol", "hillshade", "color-relief", "heatmap"}
)
_FLAT_PAINT = ("color", "opacity", "pattern", "translate", "translate-anchor")


def _transform_unsupported(layer: Layer) -> list[Layer]:
    """The same replacement as the JavaScript packages: a fill-extrusion becomes a fill, others are dropped."""
    if layer.get("type") != "fill-extrusion":
        return []
    paint = layer.get("paint") or {}
    layout = layer.get("layout") or {}
    fill = {key: value for key, value in layer.items() if key not in ("paint", "layout")}
    fill["type"] = "fill"
    # Shared paint properties have the same defaults, so absent ones stay unset.
    fill["paint"] = {f"fill-{p}": paint[f"fill-extrusion-{p}"] for p in _FLAT_PAINT if f"fill-extrusion-{p}" in paint}
    if "visibility" in layout:
        fill["layout"] = {"visibility": layout["visibility"]}
    return [fill]


class TileMatrixSet(NamedTuple):
    """The tile grid of a CRS, as MapLibre GL JS's ``TileMatrixSet`` (``addProjection``).

    Tile 0/0/0 is the square of side ``extent_at_zoom0`` whose top-left corner is ``origin``
    (min x, max y), in CRS units. Each zoom splits every tile in four; x grows east, y south.
    """

    origin: tuple[float, float]
    extent_at_zoom0: float


class Renderer:
    """A style (the style JSON as a dict) fixed at creation, drawn for any number of views.

    Decoded resources and tiles are kept and reused by later renders.

    ``load`` is an async ``load(url)`` returning bytes, or None for a missing resource; its
    exceptions propagate out of the render. By default resources are fetched with HTTPX
    (HTTP 404 means missing). URLs are passed through as written in the style; use absolute URLs.

    ``transform_layer(layer)`` replaces each layer of a type the renderer does not draw
    (fill-extrusion) with a list of layers. By default a fill-extrusion becomes a fill keeping its
    2D appearance and any other is dropped. Layers of supported types are not passed; unsupported
    layers returned are skipped.

    Raises ``TypeError`` if ``style`` is not a JSON-serializable dict with a ``layers`` list.
    Not thread-safe: use it from one thread. Requires asyncio.
    """

    def __init__(
        self,
        style: dict[str, Any],
        load: Callable[[str], Awaitable[bytes | None]] | None = None,
        transform_layer: TransformLayer | None = None,
    ) -> None:
        if not isinstance(style, dict) or not isinstance(style.get("layers"), list):
            raise TypeError("style must be a dict with a layers list")
        transform_layer = transform_layer or _transform_unsupported
        layers = []
        for layer in style["layers"]:
            if not isinstance(layer, dict) or layer.get("type") in _SUPPORTED_LAYERS:
                layers.append(layer)
                continue
            replacement = transform_layer(layer)
            if not isinstance(replacement, list):
                raise TypeError(f"transform_layer must return a list of layers (layer {layer.get('id')})")
            layers += replacement
        self._style = json.dumps({**style, "layers": layers})
        self._load = load
        self._native: _native.Renderer | None = None
        # The native renderer has one view: renders of one renderer take turns.
        self._lock = asyncio.Lock()

    async def render_view(self, view: View) -> bytes:
        """Return non-premultiplied RGBA8 pixels of ``view``, row by row (see :attr:`View.pixels`).

        Resources are loaded concurrently within each stage. The default loader uses one
        ``httpx.AsyncClient`` per render, with redirects enabled and HTTPX's default timeouts;
        HTTP and network errors other than 404 propagate. Fetched bytes are not cached. Failed or
        cancelled renders cancel and await outstanding loads before closing the HTTP client.

        Decoding and drawing run synchronously on the calling thread.
        """
        return await self._render(lambda renderer: renderer.set_view(view))

    def projected(self, projjson: dict[str, Any], tile_matrix_set: TileMatrixSet | None = None) -> "ProjectedRenderer":
        """Return this renderer drawing in the CRS ``projjson`` (PROJJSON as a dict).

        Supported methods: Transverse Mercator, Mercator, Pseudo Mercator, Lambert Conic Conformal,
        Polar Stereographic, Lambert Azimuthal Equal Area, Equal Earth and PROJ's Geostationary
        Satellite, without datum shifts. Resources loaded for one CRS serve the others, and Web
        Mercator views, too. Raises ``TypeError`` if ``projjson`` is not a dict.

        ``tile_matrix_set`` is the CRS's tile grid, which a CRS does not have by itself. Tiles and
        cameras need it (a camera's zoom is the grid's); boxes do not.
        """
        if not isinstance(projjson, dict):
            raise TypeError("projjson must be a PROJJSON dict")
        return ProjectedRenderer(self, json.dumps(projjson), tile_matrix_set)

    async def _render(self, set_view: Callable[[_native.Renderer], None]) -> bytes:
        async with self._lock, AsyncExitStack() as stack:
            if self._native is None:
                self._native = _native.Renderer(self._style)
            renderer = self._native
            set_view(renderer)
            load = self._load
            if load is None:
                client = await stack.enter_async_context(httpx.AsyncClient(follow_redirects=True))

                async def fetch(url: str) -> bytes | None:
                    response = await client.get(url)
                    if response.status_code == 404:
                        return None
                    response.raise_for_status()
                    return response.content

                load = fetch

            async def provide(url: str) -> None:
                renderer.provide(url, await load(url))

            # Each batch reveals the next: sources, then tiles, then glyph ranges or raster parents.
            round = 0
            while urls := renderer.needs():
                if round >= 32:
                    raise RuntimeError("resource requests did not settle")
                tasks = [asyncio.create_task(provide(url)) for url in urls]
                try:
                    await asyncio.gather(*tasks)
                finally:
                    # gather alone leaves siblings running when one load fails.
                    for task in tasks:
                        task.cancel()
                    await asyncio.gather(*tasks, return_exceptions=True)
                round += 1
            return renderer.render()


class ProjectedRenderer:
    """A :class:`Renderer` drawing in a CRS (see :meth:`Renderer.projected`)."""

    def __init__(self, renderer: Renderer, projjson: str, tile_matrix_set: TileMatrixSet | None) -> None:
        self._renderer = renderer
        self._projjson = projjson
        self._tile_matrix_set = tile_matrix_set

    def _grid(self) -> tuple[str, tuple[float, float], float]:
        if self._tile_matrix_set is None:
            raise TypeError("tile_matrix_set is required for tiles and cameras")
        origin, extent_at_zoom0 = self._tile_matrix_set
        return self._projjson, origin, extent_at_zoom0

    async def render(self, box: ProjectedBox) -> bytes:
        """:meth:`Renderer.render_view` of a box of the CRS (see :attr:`ProjectedBox.pixels`).

        Raises ``RuntimeError`` for a CRS the renderer does not support.
        """
        return await self._renderer._render(lambda renderer: renderer.set_projected_view(self._projjson, box))

    async def render_tile(
        self, z: int, x: int, y: int, tile_size: int = 256, pixel_ratio: float = 1.0, margin: int = 0
    ) -> bytes:
        """:meth:`render` of tile ``z/x/y`` of the CRS's grid, ``tile_size`` CSS pixels square.

        The image is ``round(tile_size * pixel_ratio)`` pixels square. Raises ``TypeError`` without
        a ``tile_matrix_set`` and ``RuntimeError`` for a tile that is not of the grid.
        """
        grid = self._grid()
        tile = (z, x, y, tile_size, pixel_ratio, margin)
        return await self._renderer._render(lambda renderer: renderer.set_projected_tile(*grid, *tile))

    async def render_view(self, view: View) -> bytes:
        """:meth:`render` of MapLibre GL JS's camera in the CRS (registered with ``addProjection``).

        ``view.center`` (lng, lat) is in the middle, tile 0/0/0 of the grid is 512 CSS pixels wide
        at zoom 0, and the view turns around the center by ``view.bearing`` (from the CRS's y
        axis). Raises ``TypeError`` without a ``tile_matrix_set`` and ``RuntimeError`` for a center
        outside the CRS.
        """
        grid = self._grid()
        return await self._renderer._render(lambda renderer: renderer.set_projected_camera(*grid, view))
