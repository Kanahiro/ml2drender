"""MapLibre style 2D renderer with asynchronous HTTP resource fetching."""

import asyncio
import json
from collections.abc import Awaitable, Callable
from contextlib import AsyncExitStack
from typing import Any

import httpx

from . import _native
from ._native import ProjectedView, View, encode_jpeg, encode_png, encode_webp

__all__ = ["ProjectedView", "Renderer", "View", "encode_jpeg", "encode_png", "encode_webp"]


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
        """Return non-premultiplied RGBA8 pixels of ``view``, row by row (see :attr:`View.size`).

        Resources are loaded concurrently within each stage. The default loader uses one
        ``httpx.AsyncClient`` per render, with redirects enabled and HTTPX's default timeouts;
        HTTP and network errors other than 404 propagate. Fetched bytes are not cached. Failed or
        cancelled renders cancel and await outstanding loads before closing the HTTP client.

        Decoding and drawing run synchronously on the calling thread.
        """
        return await self._render(lambda renderer: renderer.set_view(view))

    async def render_projected_view(self, view: ProjectedView) -> bytes:
        """:meth:`render_view` of a box of a CRS (see :attr:`ProjectedView.size`).

        Raises ``RuntimeError`` for a CRS the renderer does not support. Resources loaded for one
        CRS serve the others, and Web Mercator views, too.
        """
        return await self._render(lambda renderer: renderer.set_projected_view(view))

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
