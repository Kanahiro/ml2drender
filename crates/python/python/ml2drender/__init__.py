"""MapLibre style 2D renderer with asynchronous HTTP resource fetching."""

import asyncio
from collections.abc import Awaitable, Callable
from contextlib import AsyncExitStack

import httpx

from ._native import Renderer, View, encode_jpeg, encode_png, encode_webp

__all__ = ["Renderer", "View", "encode_jpeg", "encode_png", "encode_webp", "render"]


async def render(
    style: str,
    view: View,
    load: Callable[[str], Awaitable[bytes | None]] | None = None,
) -> bytes:
    """Return non-premultiplied RGBA8 pixels of ``style`` (JSON string) in ``view``.

    Resources are fetched concurrently within each stage using one ``httpx.AsyncClient`` per
    render, with redirects enabled and HTTPX's default timeouts. HTTP 404 means a missing
    resource; other HTTP and network errors propagate. Fetched bytes are not cached.

    Override with an async ``load(url)`` returning bytes or None when missing; its exceptions
    propagate. URLs are passed through as written in the style; use absolute URLs. Failed or
    cancelled renders cancel and await outstanding loads before closing the HTTP client.

    Requires asyncio. Decoding and drawing run synchronously on the calling thread.
    """
    renderer = Renderer(style, view)
    async with AsyncExitStack() as stack:
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
