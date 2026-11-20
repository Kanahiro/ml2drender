"""python -m unittest discover crates/python/tests (with the wheel installed)."""

import asyncio
import copy
import json
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Barrier, BrokenBarrierError, Thread

import httpx
import ml2drender

STYLE = {
    "version": 8,
    "sources": {"points": {"type": "geojson", "data": "test://points.geojson"}},
    "layers": [
        {"id": "bg", "type": "background", "paint": {"background-color": "#ffffff"}},
        {"id": "points", "type": "circle", "source": "points", "paint": {"circle-color": "#ff0000"}},
    ],
}

POINTS = json.dumps(
    {
        "type": "FeatureCollection",
        "features": [
            {"type": "Feature", "properties": {}, "geometry": {"type": "Point", "coordinates": [140.0, 37.0]}}
        ],
    }
).encode()


async def load(url):
    return POINTS if url == "test://points.geojson" else None


async def render(style, view, load=None):
    return await ml2drender.Renderer(style, load).render_view(view)


def two_sources(first, second):
    style = copy.deepcopy(STYLE)
    style["sources"]["points"]["data"] = first
    style["sources"]["other"] = {"type": "geojson", "data": second}
    style["layers"].append({**style["layers"][1], "id": "other", "source": "other"})
    return style


class RenderTest(unittest.IsolatedAsyncioTestCase):
    async def test_render_tile(self):
        view = ml2drender.View.tile(5, 28, 12, 256)
        rgba = await render(STYLE, view, load)
        width, height = view.pixels
        self.assertEqual(len(rgba), width * height * 4)
        pixels = {bytes(rgba[i : i + 4]) for i in range(0, len(rgba), 4)}
        self.assertIn(bytes([255, 255, 255, 255]), pixels)  # background
        self.assertIn(bytes([255, 0, 0, 255]), pixels)  # the circle
        png = ml2drender.encode_png(rgba, width, height)
        self.assertEqual(png[:4], b"\x89PNG")
        self.assertEqual(ml2drender.encode_jpeg(rgba, width, height)[:2], b"\xff\xd8")
        self.assertEqual(ml2drender.encode_webp(rgba, width, height)[8:16], b"WEBPVP8L")
        self.assertEqual(ml2drender.encode_webp(rgba, width, height, 75)[8:16], b"WEBPVP8 ")

    async def test_reuse(self):
        loaded = []

        async def counting(url):
            loaded.append(url)
            return await load(url)

        renderer = ml2drender.Renderer(STYLE, counting)
        view = ml2drender.View((140.0, 37.0), 4.0, 64, 32)
        west = ml2drender.View((120.0, 37.0), 4.0, 64, 32)
        first = await renderer.render_view(view)
        # Overlapping renders of one renderer take turns, and reuse what was loaded.
        moved, again = await asyncio.gather(renderer.render_view(west), renderer.render_view(view))
        self.assertEqual(again, first)
        self.assertEqual(first[(16 * 64 + 32) * 4 :][:4], bytes([255, 0, 0, 255]))
        self.assertEqual(moved[(16 * 64 + 32) * 4 :][:4], bytes([255, 255, 255, 255]))
        self.assertEqual(loaded, ["test://points.geojson"])

    async def test_projected(self):
        # Longitude/latitude: the point is in the middle of 130..150 E, 32..42 N.
        longlat = {
            "type": "GeographicCRS",
            "datum": {"ellipsoid": {"semi_major_axis": 6378137, "inverse_flattening": 298.257223563}},
        }
        renderer = ml2drender.Renderer(STYLE, load)
        crs = renderer.projected(longlat)
        box = ml2drender.ProjectedBox((130, 32, 150, 42), 64, pixel_ratio=2)
        self.assertEqual(box.pixels, (128, 64))

        def at(rgba, x, y):
            return tuple(rgba[(y * 128 + x) * 4 :][:4])

        red, white = (255, 0, 0, 255), (255, 255, 255, 255)
        rgba = await crs.render(box)
        self.assertEqual(len(rgba), 128 * 64 * 4)
        self.assertEqual((at(rgba, 64, 32), at(rgba, 0, 0)), (red, white))
        # With the box 3.125 degrees further east, the circle (10 pixels in radius) is 20 pixels
        # left of the middle.
        east = (133.125, 32, 153.125, 42)
        rgba = await crs.render(ml2drender.ProjectedBox(east, 64, pixel_ratio=2))
        self.assertEqual((at(rgba, 44, 32), at(rgba, 64, 32)), (red, white))
        # An unsupported CRS raises, and Mercator views still draw afterwards.
        bonne = {"type": "ProjectedCRS", "conversion": {"method": {"name": "Bonne"}}}
        with self.assertRaises(RuntimeError):
            await renderer.projected(bonne).render(ml2drender.ProjectedBox((0, 0, 1, 1), 64))
        with self.assertRaises(TypeError):  # PROJJSON is a dict, not a PROJ string
            renderer.projected("+proj=longlat")
        with self.assertRaises(TypeError):  # tiles and cameras need a grid
            await crs.render_tile(0, 0, 0)
        # On a grid whose tile 0/0/0 is 80 degrees wide from 90 E 62 N, tile 2/2/1 is
        # 130..150 E, 22..42 N, and at zoom -1 a 64 x 32 view is the first box.
        grid = renderer.projected(longlat, ml2drender.TileMatrixSet((90, 62), 80))
        tile = await grid.render_tile(2, 2, 1, tile_size=64)
        self.assertEqual(tile, await crs.render(ml2drender.ProjectedBox((130, 22, 150, 42), 64)))
        camera = ml2drender.View((140.0, 37.0), -1.0, 64, 32, pixel_ratio=2)
        self.assertEqual(await grid.render_view(camera), await crs.render(box))
        # Turned 90 degrees around the center of the box further east, east is up, so the circle
        # is below the middle.
        turned = ml2drender.View((143.125, 37.0), -1.0, 64, 32, bearing=90, pixel_ratio=2)
        rgba = await grid.render_view(turned)
        self.assertEqual((at(rgba, 64, 52), at(rgba, 64, 32), at(rgba, 44, 32)), (red, white, white))
        with self.assertRaises(RuntimeError):
            await grid.render_tile(2, 4, 1)
        # The same tile as an OGC TileMatrixSet's level, latitude first.
        level = {"cellSize": 20 / 64, "pointOfOrigin": [62, 90], "tileWidth": 64, "tileHeight": 64}
        ogc = {"orderedAxes": ["Lat", "Lon"], "tileMatrices": [{**level, "matrixWidth": 4, "matrixHeight": 4}]}
        self.assertEqual(await renderer.projected(longlat, ogc).render_tile(0, 2, 1, tile_size=64), tile)
        mercator = await renderer.render_view(ml2drender.View((140.0, 37.0), 4.0, 64, 32))
        self.assertEqual(mercator[(16 * 64 + 32) * 4 :][:4], bytes(red))

    async def test_unsupported_layers_skipped(self):
        box = [[[130, 30], [150, 30], [150, 45], [130, 45], [130, 30]]]
        style = {
            "version": 8,
            "sources": {
                "box": {
                    "type": "geojson",
                    "data": {"type": "Feature", "properties": {}, "geometry": {"type": "Polygon", "coordinates": box}},
                }
            },
            "layers": [
                {"id": "bg", "type": "background", "paint": {"background-color": "#ffffff"}},
                {
                    "id": "box",
                    "type": "fill-extrusion",
                    "source": "box",
                    "paint": {"fill-extrusion-color": "#0000ff", "fill-extrusion-height": 10},
                },
                {"id": "future", "type": "unknown"},
            ],
        }
        view = ml2drender.View((140.0, 37.0), 4.0, 64, 32)
        rgba = await render(style, view)
        # fill-extrusion and unknown types are left out: only the background shows.
        self.assertEqual(tuple(rgba[(16 * 64 + 32) * 4 :][:4]), (255, 255, 255, 255))

    async def test_custom_missing(self):
        view = ml2drender.View((140.0, 37.0), 4.0, 64, 32)

        async def missing(url):
            return None

        self.assertEqual(await render(STYLE, view, load=missing), bytes([255]) * (64 * 32 * 4))

    async def test_errors(self):
        with self.assertRaises(TypeError):  # a JSON string is not a style
            ml2drender.Renderer(json.dumps(STYLE))

        async def broken(url):
            raise OSError("offline")

        with self.assertRaises(OSError):
            await render(STYLE, ml2drender.View.tile(5, 28, 12), broken)

    async def test_concurrent_custom_loads(self):
        started = set()
        ready = asyncio.Event()

        async def concurrent(url):
            started.add(url)
            if len(started) == 2:
                ready.set()
            await ready.wait()
            return POINTS

        style = two_sources("test://first", "test://second")
        view = ml2drender.View.tile(0, 0, 0, 32)
        rgba = await asyncio.wait_for(render(style, view, concurrent), timeout=2)
        self.assertEqual(started, {"test://first", "test://second"})
        self.assertEqual(len(rgba), 32 * 32 * 4)

    async def test_failure_cancels_other_loads(self):
        started = asyncio.Event()
        finished = asyncio.Event()
        error = OSError("offline")

        async def failing(url):
            if url == "test://fail":
                await started.wait()
                raise error
            try:
                started.set()
                await asyncio.Event().wait()
            finally:
                finished.set()

        style = two_sources("test://fail", "test://pending")
        with self.assertRaises(OSError) as raised:
            await asyncio.wait_for(render(style, ml2drender.View.tile(0, 0, 0, 32), failing), timeout=2)
        self.assertIs(raised.exception, error)
        self.assertTrue(finished.is_set())

    async def test_cancellation_waits_for_load_cleanup(self):
        started = asyncio.Event()
        finished = asyncio.Event()

        async def pending(url):
            try:
                started.set()
                await asyncio.Event().wait()
            finally:
                await asyncio.sleep(0)
                finished.set()

        task = asyncio.create_task(render(STYLE, ml2drender.View.tile(0, 0, 0, 32), pending))
        await asyncio.wait_for(started.wait(), timeout=2)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue(finished.is_set())


class HttpRenderTest(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.requests = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                cls.requests.append(self.path)
                if self.path == "/points.geojson":
                    data = POINTS
                elif self.path.startswith("/parallel/"):
                    try:
                        cls.barrier.wait()
                    except BrokenBarrierError:
                        self.send_error(500, "requests did not overlap")
                        return
                    data = POINTS
                elif self.path == "/redirect":
                    self.send_response(302)
                    self.send_header("Location", "/points.geojson")
                    self.end_headers()
                    return
                elif self.path == "/source.json":
                    data = json.dumps(
                        {"tiles": [f"{cls.base}/tiles/{{z}}/{{x}}/{{y}}.pbf"], "minzoom": 0, "maxzoom": 0}
                    ).encode()
                elif self.path == "/tiles/0/0/0.pbf":
                    data = b""  # An empty MVT is a valid empty tile.
                elif self.path == "/offline":
                    self.close_connection = True
                    return
                else:
                    self.send_error(403 if self.path == "/forbidden" else 500 if self.path == "/error" else 404)
                    return
                self.send_response(200)
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"
        cls.thread = Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    async def asyncSetUp(self):
        self.view = ml2drender.View((140.0, 37.0), 4.0, 64, 32)
        self.expected = await render(STYLE, self.view, load)
        self.empty = bytes([255]) * (64 * 32 * 4)

    def style(self, path):
        return {**STYLE, "sources": {"points": {"type": "geojson", "data": self.base + path}}}

    async def test_default_http(self):
        self.assertEqual(await render(self.style("/points.geojson"), self.view), self.expected)
        self.assertEqual(await render(self.style("/points.geojson"), self.view, load=None), self.expected)
        self.assertEqual(await render(self.style("/redirect"), self.view), self.expected)

    async def test_missing(self):
        self.assertEqual(await render(self.style("/missing"), self.view), self.empty)

    async def test_http_errors(self):
        for path, status in [("/forbidden", 403), ("/error", 500)]:
            with self.subTest(status=status), self.assertRaises(httpx.HTTPStatusError) as raised:
                await render(self.style(path), self.view)
            self.assertEqual(raised.exception.response.status_code, status)

    async def test_network_error(self):
        with self.assertRaises(httpx.RequestError):
            await render(self.style("/offline"), self.view)

    async def test_staged_resources(self):
        style = copy.deepcopy(STYLE)
        style["sources"]["points"] = {"type": "vector", "url": self.base + "/source.json"}
        style["layers"][1]["source-layer"] = "points"
        self.assertEqual(await render(style, self.view), self.empty)
        self.assertIn("/source.json", self.requests)
        self.assertIn("/tiles/0/0/0.pbf", self.requests)
        style["sources"]["points"] = {
            "type": "vector",
            "tiles": [self.base + "/missing/{z}/{x}/{y}.pbf"],
            "maxzoom": 0,
        }
        self.assertEqual(await render(style, self.view), self.empty)

    async def test_default_http_loads_overlap(self):
        type(self).barrier = Barrier(2, timeout=2)
        style = two_sources(self.base + "/parallel/first", self.base + "/parallel/second")

        async def points(url):
            return POINTS

        expected = await render(style, self.view, points)
        self.assertEqual(await asyncio.wait_for(render(style, self.view), timeout=4), expected)


if __name__ == "__main__":
    unittest.main()
