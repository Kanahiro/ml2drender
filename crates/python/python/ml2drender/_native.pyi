"""MapLibre style 2D renderer (pure Rust, no GPU).

The renderer is sans-IO: it asks for the resources it needs (TileJSON, GeoJSON, sprites, tiles,
glyph ranges) and the host loads them.
"""

class View:
    """A camera, of Web Mercator or of a CRS (``ProjectedRenderer.render_view`` of the package).

    ``center`` is (lng, lat) in degrees, ``zoom`` is the MapLibre zoom (the world, or in a CRS
    tile 0/0/0 of its grid, is ``512 * 2**zoom`` CSS pixels wide), ``bearing`` is in degrees
    clockwise (in a CRS: from its y axis). The image is
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
    def pixels(self) -> tuple[int, int]:
        """Output width and height in pixels."""

class ProjectedBox:
    """A box of a CRS (see ``Renderer.projected`` of the package).

    ``bbox`` is (min x, min y, max x, max y) in CRS units (degrees for longlat),
    easting/longitude first whatever the CRS's axis order: what is drawn at bearing 0. ``bearing``
    is the degrees clockwise from the CRS's y axis of the direction that is up: the view turns
    around the center of ``bbox``. The image has the aspect ratio of ``bbox`` and ``size`` CSS
    pixels on its long side. ``pixel_ratio`` and ``margin`` are those of :class:`View`.

    Vector layers are drawn with projected vertices; raster, hillshade and color-relief are
    rendered in Web Mercator and warped.
    """

    def __init__(
        self,
        bbox: tuple[float, float, float, float],
        size: int,
        bearing: float = 0.0,
        pixel_ratio: float = 1.0,
        margin: int = 0,
    ) -> None: ...
    @property
    def pixels(self) -> tuple[int, int]:
        """Output width and height in pixels."""

class Renderer:
    """A style (JSON string) fixed at creation, drawn for a view once the resources it needs are provided.

    Raises ``RuntimeError`` on an invalid style. Not thread-safe: use it from the thread that created it.
    """

    def __init__(self, style: str) -> None: ...
    def set_view(self, view: View) -> None:
        """Point the renderer at a camera, keeping the resources and tiles it has."""
    def set_projected_view(self, projjson: str, view: ProjectedBox) -> None:
        """Point the renderer at a box of the CRS ``projjson`` (a JSON string), keeping the resources and tiles it has.

        Raises ``RuntimeError`` for a CRS the renderer does not support.
        """
    def set_projected_tile(
        self,
        projjson: str,
        origin: tuple[float, float],
        extent_at_zoom0: float,
        z: int,
        x: int,
        y: int,
        tile_size: int,
        pixel_ratio: float,
        margin: int,
    ) -> None:
        """Point the renderer at tile ``z/x/y`` of the grid (``origin``, ``extent_at_zoom0``) of the CRS ``projjson``.

        Raises ``RuntimeError`` for a tile that is not of the grid.
        """
    def set_projected_camera(
        self, projjson: str, origin: tuple[float, float], extent_at_zoom0: float, view: View
    ) -> None:
        """Point the renderer at MapLibre GL JS's camera ``view`` in the CRS ``projjson`` on its grid.

        Raises ``RuntimeError`` for a center outside the CRS.
        """
    def needs(self) -> list[str]:
        """URLs still needed before :meth:`render`.

        Resources come in stages, each found from the last (style sources, then tiles, then glyph
        ranges), so repeat :meth:`needs` and :meth:`provide` until this is empty.
        """
    def provide(self, url: str, data: bytes | None) -> None:
        """The bytes of ``url``, or None for a missing resource (like HTTP 404: a missing vector
        tile is empty, a missing raster tile is replaced by its parent)."""
    def render(self) -> bytes:
        """Non-premultiplied RGBA8 pixels of the view, row by row (see its ``size``). Raises ``RuntimeError`` while resources are still needed."""

def encode_png(rgba: bytes, width: int, height: int) -> bytes:
    """Lossless PNG of RGBA8 pixels."""

def encode_webp(rgba: bytes, width: int, height: int) -> bytes:
    """Lossless WebP of RGBA8 pixels."""

def encode_jpeg(rgba: bytes, width: int, height: int, quality: int = 90) -> bytes:
    """JPEG of RGBA8 pixels at ``quality`` (1–100), flattened over black."""
