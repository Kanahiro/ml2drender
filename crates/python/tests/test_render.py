"""python -m unittest discover crates/python/tests (with the wheel installed)."""

import asyncio
import json
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Barrier, BrokenBarrierError, Thread

import httpx
import ml2drender

STYLE = json.dumps(
    {
        "version": 8,
        "sources": {"points": {"type": "geojson", "data": "test://points.geojson"}},
        "layers": [
            {"id": "bg", "type": "background", "paint": {"background-color": "#ffffff"}},
            {"id": "points", "type": "circle", "source": "points", "paint": {"circle-color": "#ff0000"}},
        ],
    }
)

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


def two_sources(first, second):
    style = json.loads(STYLE)
    style["sources"]["points"]["data"] = first
    style["sources"]["other"] = {"type": "geojson", "data": second}
    style["layers"].append({**style["layers"][1], "id": "other", "source": "other"})
    return json.dumps(style)


class RenderTest(unittest.IsolatedAsyncioTestCase):
    async def test_render_tile(self):
        view = ml2drender.View.tile(5, 28, 12, 256)
        rgba = await ml2drender.render(STYLE, view, load)
        width, height = view.size
        self.assertEqual(len(rgba), width * height * 4)
        pixels = {bytes(rgba[i : i + 4]) for i in range(0, len(rgba), 4)}
        self.assertIn(bytes([255, 255, 255, 255]), pixels)  # background
        self.assertIn(bytes([255, 0, 0, 255]), pixels)  # the circle
        png = ml2drender.encode_png(rgba, width, height)
        self.assertEqual(png[:4], b"\x89PNG")
        self.assertEqual(ml2drender.encode_jpeg(rgba, width, height)[:2], b"\xff\xd8")

    async def test_step_by_step(self):
        r = ml2drender.Renderer(STYLE, ml2drender.View((140.0, 37.0), 4.0, 64, 32))
        urls = r.needs()
        self.assertTrue(urls)
        for url in urls:
            r.provide(url, await load(url))
        self.assertEqual(r.needs(), [])
        self.assertEqual(len(r.render()), 64 * 32 * 4)

    async def test_custom_missing(self):
        view = ml2drender.View((140.0, 37.0), 4.0, 64, 32)

        async def missing(url):
            return None

        self.assertEqual(await ml2drender.render(STYLE, view, load=missing), bytes([255]) * (64 * 32 * 4))

    async def test_errors(self):
        with self.assertRaises(RuntimeError):
            ml2drender.Renderer("{", ml2drender.View.tile(0, 0, 0))

        async def broken(url):
            raise OSError("offline")

        with self.assertRaises(OSError):
            await ml2drender.render(STYLE, ml2drender.View.tile(5, 28, 12), broken)

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
        rgba = await asyncio.wait_for(ml2drender.render(style, view, concurrent), timeout=2)
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
            await asyncio.wait_for(ml2drender.render(style, ml2drender.View.tile(0, 0, 0, 32), failing), timeout=2)
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

        task = asyncio.create_task(ml2drender.render(STYLE, ml2drender.View.tile(0, 0, 0, 32), pending))
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
        self.expected = await ml2drender.render(STYLE, self.view, load)
        self.empty = bytes([255]) * (64 * 32 * 4)

    def style(self, path):
        return STYLE.replace("test://points.geojson", self.base + path)

    async def test_default_http(self):
        self.assertEqual(await ml2drender.render(self.style("/points.geojson"), self.view), self.expected)
        self.assertEqual(await ml2drender.render(self.style("/points.geojson"), self.view, load=None), self.expected)
        self.assertEqual(await ml2drender.render(self.style("/redirect"), self.view), self.expected)

    async def test_missing(self):
        self.assertEqual(await ml2drender.render(self.style("/missing"), self.view), self.empty)

    async def test_http_errors(self):
        for path, status in [("/forbidden", 403), ("/error", 500)]:
            with self.subTest(status=status), self.assertRaises(httpx.HTTPStatusError) as raised:
                await ml2drender.render(self.style(path), self.view)
            self.assertEqual(raised.exception.response.status_code, status)

    async def test_network_error(self):
        with self.assertRaises(httpx.RequestError):
            await ml2drender.render(self.style("/offline"), self.view)

    async def test_staged_resources(self):
        style = json.loads(STYLE)
        style["sources"]["points"] = {"type": "vector", "url": self.base + "/source.json"}
        style["layers"][1]["source-layer"] = "points"
        self.assertEqual(await ml2drender.render(json.dumps(style), self.view), self.empty)
        self.assertIn("/source.json", self.requests)
        self.assertIn("/tiles/0/0/0.pbf", self.requests)
        style["sources"]["points"] = {
            "type": "vector",
            "tiles": [self.base + "/missing/{z}/{x}/{y}.pbf"],
            "maxzoom": 0,
        }
        self.assertEqual(await ml2drender.render(json.dumps(style), self.view), self.empty)

    async def test_default_http_loads_overlap(self):
        type(self).barrier = Barrier(2, timeout=2)
        style = two_sources(self.base + "/parallel/first", self.base + "/parallel/second")

        async def points(url):
            return POINTS

        expected = await ml2drender.render(style, self.view, points)
        self.assertEqual(await asyncio.wait_for(ml2drender.render(style, self.view), timeout=4), expected)


if __name__ == "__main__":
    unittest.main()
