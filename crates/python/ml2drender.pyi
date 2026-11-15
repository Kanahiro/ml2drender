"""MapLibre style 2D renderer (pure Rust, no GPU).

The renderer is sans-IO: it asks for the resources it needs (TileJSON, GeoJSON, sprites, tiles,
glyph ranges) and the host loads them. :func:`render` runs that loop with a ``load`` callable;
:class:`Renderer` exposes the steps, for hosts that load concurrently.
"""

from collections.abc import Callable

class View:
    """A Web Mercator camera.

    ``center`` is (lng, lat) in degrees, ``zoom`` is the MapLibre zoom (the world is
    ``512 * 2**zoom`` CSS pixels wide), ``bearing`` is in degrees clockwise. The image is
    ``width`` x ``height`` CSS pixels, times ``pixel_ratio`` in pixels. ``margin`` CSS pixels are
    drawn around it and cropped, so that labels near the edge are placed as in a larger map.
    """

    def __init__(
        self,
        center: tuple[float, float],
        zoom: float,
        width: int,
        height: int,
        bearing: float = 0.0,
        pixel_ratio: float = 1.0,
        margin: int = 0,
    ) -> None: ...
    @staticmethod
    def tile(z: int, x: int, y: int, tile_size: int = 256) -> View:
        """The XYZ tile ``z/x/y`` of the Web Mercator grid, ``tile_size`` CSS pixels square."""
    @property
    def size(self) -> tuple[int, int]:
        """Output width and height in pixels."""

class Renderer:
    """A style (JSON string) fixed at creation, drawn for a view once the resources it needs are provided.

    Raises ``RuntimeError`` on an invalid style. Not thread-safe: use it from the thread that created it.
    """

    def __init__(self, style: str, view: View) -> None: ...
    def set_view(self, view: View) -> None:
        """Point the renderer at another camera, keeping the resources and tiles it has."""
    def needs(self) -> list[str]:
        """URLs still needed before :meth:`render`.

        Resources come in stages, each found from the last (style sources, then tiles, then glyph
        ranges), so repeat :meth:`needs` and :meth:`provide` until this is empty.
        """
    def provide(self, url: str, data: bytes | None) -> None:
        """The bytes of ``url``, or None for a missing resource (like HTTP 404: a missing vector
        tile is empty, a missing raster tile is replaced by its parent)."""
    def render(self) -> bytes:
        """Non-premultiplied RGBA8 pixels, row by row (see :attr:`View.size`). Raises ``RuntimeError`` while resources are still needed."""

def render(style: str, view: View, load: Callable[[str], bytes | None]) -> bytes:
    """Non-premultiplied RGBA8 pixels of ``style`` (JSON string) in ``view``.

    Each resource is loaded with ``load(url)``, which returns its bytes, or None when it is
    missing (like HTTP 404). Exceptions raised by ``load`` propagate.
    """

def encode_png(rgba: bytes, width: int, height: int) -> bytes:
    """Lossless PNG of RGBA8 pixels."""

def encode_webp(rgba: bytes, width: int, height: int) -> bytes:
    """Lossless WebP of RGBA8 pixels."""

def encode_jpeg(rgba: bytes, width: int, height: int, quality: int = 90) -> bytes:
    """JPEG of RGBA8 pixels at ``quality`` (1–100), flattened over black."""
