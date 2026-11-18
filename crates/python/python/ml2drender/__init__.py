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


class TileMatrixSet(NamedTuple):
    """The tile grid of a CRS, as MapLibre GL JS's ``TileMatrixSet`` (``addProjection``).

    Tile 0/0/0 is the square of side ``extent_at_zoom0`` whose top-left corner is ``origin``
    (min x, max y), in CRS units. Each zoom splits every tile in four; x grows east, y south.

    Use it when the tiles are shown by MapLibre GL JS, with the grid given to its
    ``addProjection``. For a published grid (a TileMatrixSet registry, an OGC API - Tiles
    server, a national grid), or one this form cannot describe (scales not halved at each
    level, tiles not square or not 2^z x 2^z, a fixed list of levels), pass an OGC 2D
    TileMatrixSet as a dict instead. A ``TileMatrixSet`` is the OGC set whose level z has
    512 x 512 px tiles, ``cellSize`` = ``extent_at_zoom0 / 512 / 2**z`` and 2^z x 2^z tiles.
    """

    origin: tuple[float, float]
    extent_at_zoom0: float


class Renderer:
    """A style (the style JSON as a dict) fixed at creation, drawn for any number of views.

    Decoded resources and tiles are kept and reused by later renders.

    ``load`` is an async ``load(url)`` returning bytes, or None for a missing resource; its
    exceptions propagate out of the render. By default resources are fetched with HTTPX
    (HTTP 404 means missing). URLs are passed through as written in the style; use absolute URLs.

    Raises ``TypeError`` if ``style`` is not a JSON-serializable dict with a ``layers`` list.
    Not thread-safe: use it from one thread. Requires asyncio.
    """

    def __init__(
        self,
        style: dict[str, Any],
        load: Callable[[str], Awaitable[bytes | None]] | None = None,
    ) -> None:
        if not isinstance(style, dict) or not isinstance(style.get("layers"), list):
            raise TypeError("style must be a dict with a layers list")
        self._style = json.dumps(style)
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

    def projected(
        self, projjson: dict[str, Any], tile_matrix_set: TileMatrixSet | dict[str, Any] | None = None
    ) -> "ProjectedRenderer":
        """Return this renderer drawing in the CRS ``projjson`` (PROJJSON as a dict).

        Supported methods: Transverse Mercator, Mercator, Pseudo Mercator, Lambert Conic Conformal,
        Albers Equal Area, Equidistant Conic, Polar and Oblique Stereographic, Hotine Oblique
        Mercator, Krovak (North Orientated), Cassini-Soldner, American Polyconic, Lambert Azimuthal
        Equal Area, Azimuthal Equidistant, Lambert Cylindrical Equal Area, Equidistant Cylindrical,
        Orthographic, Equal Earth, Mollweide, Robinson, Sinusoidal, Natural Earth, Winkel Tripel,
        Miller Cylindrical and PROJ's Geostationary Satellite, without datum shifts. Resources
        loaded for one CRS serve the others, and Web Mercator views, too. Raises ``TypeError`` if
        ``projjson`` is not a dict.

        ``tile_matrix_set`` is the CRS's tile grid, which a CRS does not have by itself: a
        :class:`TileMatrixSet`, or an OGC 2D TileMatrixSet (2.0) as a dict, whose ``tileMatrices``
        are the zoom levels (``cellSize``, ``pointOfOrigin`` in the CRS's axis order,
        ``cornerOfOrigin``, ``tileWidth``, ``tileHeight``, ``matrixWidth`` and ``matrixHeight`` are
        read; ``variableMatrixWidths`` are not supported). Tiles and cameras need it (a camera's
        zoom is the grid's); boxes do not.
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

    def __init__(
        self, renderer: Renderer, projjson: str, tile_matrix_set: TileMatrixSet | dict[str, Any] | None
    ) -> None:
        self._renderer = renderer
        self._projjson = projjson
        self._tile_matrix_set = tile_matrix_set

    def _grid(self) -> tuple[str, str]:
        grid = self._tile_matrix_set
        if grid is None:
            raise TypeError("tile_matrix_set is required for tiles and cameras")
        if isinstance(grid, TileMatrixSet):
            grid = {"origin": grid.origin, "extentAtZoom0": grid.extent_at_zoom0}
        return self._projjson, json.dumps(grid)

    async def render(self, box: ProjectedBox) -> bytes:
        """:meth:`Renderer.render_view` of a box of the CRS (see :attr:`ProjectedBox.pixels`).

        Raises ``RuntimeError`` for a CRS the renderer does not support.
        """
        return await self._renderer._render(lambda renderer: renderer.set_projected_view(self._projjson, box))

    async def render_tile(
        self, z: int, x: int, y: int, tile_size: int = 256, pixel_ratio: float = 1.0, margin: int = 0
    ) -> bytes:
        """:meth:`render` of tile ``z/x/y`` of the CRS's grid, ``tile_size`` CSS pixels wide.

        The image is ``round(tile_size * pixel_ratio)`` pixels wide, and as high as the grid's tiles
        are (square in a :class:`TileMatrixSet`). ``z`` is a zoom level of the grid (an index of an
        OGC set's ``tileMatrices``). Raises ``TypeError`` without a ``tile_matrix_set`` and
        ``RuntimeError`` for a grid it does not read or a tile that is not of the grid.
        """
        grid = self._grid()
        tile = (z, x, y, tile_size, pixel_ratio, margin)
        return await self._renderer._render(lambda renderer: renderer.set_projected_tile(*grid, *tile))

    async def render_view(self, view: View) -> bytes:
        """:meth:`render` of MapLibre GL JS's camera in the CRS (registered with ``addProjection``).

        ``view.center`` (lng, lat) is in the middle, a tile of the grid's first level (tile 0/0/0
        of a :class:`TileMatrixSet`) is 512 CSS pixels wide at zoom 0, and the view turns around the center by ``view.bearing`` (from the CRS's y
        axis). Raises ``TypeError`` without a ``tile_matrix_set`` and ``RuntimeError`` for a center
        outside the CRS.
        """
        grid = self._grid()
        return await self._renderer._render(lambda renderer: renderer.set_projected_camera(*grid, view))
