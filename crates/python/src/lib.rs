//! Python bindings of the `ml2drender` renderer (the same sans-IO core as `crates/napi` and
//! `crates/wasm`). The Python package drives `Renderer` with asynchronous resource fetching.

use pyo3::exceptions::PyRuntimeError;
use pyo3::prelude::*;
use pyo3::types::PyBytes;

fn error(e: ml2drender::Error) -> PyErr {
    PyRuntimeError::new_err(e.to_string())
}

/// A Web Mercator camera: `center` (lng, lat) in degrees, MapLibre `zoom` (the world is
/// 512 * 2^zoom CSS pixels wide), `bearing` in degrees clockwise, the output size in CSS pixels
/// (times `pixel_ratio` in pixels) and `margin` CSS pixels rendered around it and cropped.
#[pyclass(frozen, from_py_object)]
#[derive(Clone)]
struct View(ml2drender::View);

#[pymethods]
impl View {
    #[new]
    #[pyo3(signature = (center, zoom, width, height, bearing = 0.0, pixel_ratio = 1.0, margin = 0))]
    fn new(
        center: (f64, f64),
        zoom: f64,
        width: u32,
        height: u32,
        bearing: f64,
        pixel_ratio: f64,
        margin: u32,
    ) -> Self {
        View(ml2drender::View { center: [center.0, center.1], zoom, bearing, width, height, pixel_ratio, margin })
    }

    /// The XYZ tile `z/x/y` of the Web Mercator grid, `tile_size` CSS pixels square.
    #[staticmethod]
    #[pyo3(signature = (z, x, y, tile_size = 256))]
    fn tile(z: u8, x: u32, y: u32, tile_size: u32) -> Self {
        View(ml2drender::View::tile(z, x, y, tile_size))
    }

    /// Output width and height in pixels.
    #[getter]
    fn size(&self) -> (u32, u32) {
        pixels(self.0.width, self.0.height, self.0.pixel_ratio)
    }
}

fn pixels(width: u32, height: u32, pixel_ratio: f64) -> (u32, u32) {
    ((width as f64 * pixel_ratio).round() as u32, (height as f64 * pixel_ratio).round() as u32)
}

/// A box of a CRS: `bbox` (min x, min y, max x, max y) in CRS units, turned around its center by
/// `bearing` degrees; the output size as in `View`. The CRS is given with it (`set_projected_view`).
#[pyclass(frozen, from_py_object)]
#[derive(Clone)]
struct ProjectedBox(ml2drender::reproject::ProjectedView);

#[pymethods]
impl ProjectedBox {
    #[new]
    #[pyo3(signature = (bbox, width, height, bearing = 0.0, pixel_ratio = 1.0, margin = 0))]
    fn new(bbox: [f64; 4], width: u32, height: u32, bearing: f64, pixel_ratio: f64, margin: u32) -> Self {
        let projjson = String::new();
        ProjectedBox(ml2drender::reproject::ProjectedView {
            projjson,
            bbox,
            bearing,
            width,
            height,
            pixel_ratio,
            margin,
        })
    }

    /// Output width and height in pixels.
    #[getter]
    fn size(&self) -> (u32, u32) {
        pixels(self.0.width, self.0.height, self.0.pixel_ratio)
    }
}

/// A style fixed at creation, drawn for a view (`set_view` or `set_projected_view`) once the
/// resources it `needs` are provided.
#[pyclass(unsendable)]
struct Renderer(ml2drender::Renderer);

#[pymethods]
impl Renderer {
    #[new]
    fn new(style: &str) -> PyResult<Self> {
        Ok(Renderer(ml2drender::Renderer::new(style, ml2drender::View::tile(0, 0, 0, 256)).map_err(error)?))
    }

    /// Point the renderer at a camera, keeping the resources it has.
    fn set_view(&mut self, view: View) {
        self.0.set_view(view.0);
    }

    /// Point the renderer at a box of the CRS `projjson` (a JSON string), keeping the resources it has.
    fn set_projected_view(&mut self, projjson: &str, view: ProjectedBox) -> PyResult<()> {
        let view = ml2drender::reproject::ProjectedView { projjson: projjson.to_owned(), ..view.0 };
        self.0.set_projected_view(&view).map_err(error)
    }

    /// Point the renderer at tile `z/x/y` of the grid (`origin`, `extent_at_zoom0`) of the CRS `projjson`.
    #[allow(clippy::too_many_arguments)]
    fn set_projected_tile(
        &mut self,
        projjson: &str,
        origin: [f64; 2],
        extent_at_zoom0: f64,
        z: u8,
        x: u32,
        y: u32,
        tile_size: u32,
        pixel_ratio: f64,
        margin: u32,
    ) -> PyResult<()> {
        let grid = ml2drender::reproject::TileMatrixSet { origin, extent_at_zoom0 };
        let view = ml2drender::reproject::ProjectedView::tile(projjson, &grid, z, x, y, tile_size).map_err(error)?;
        self.0.set_projected_view(&ml2drender::reproject::ProjectedView { pixel_ratio, margin, ..view }).map_err(error)
    }

    /// Point the renderer at MapLibre GL JS's camera `view` in the CRS `projjson` on its grid.
    fn set_projected_camera(
        &mut self,
        projjson: &str,
        origin: [f64; 2],
        extent_at_zoom0: f64,
        view: View,
    ) -> PyResult<()> {
        let grid = ml2drender::reproject::TileMatrixSet { origin, extent_at_zoom0 };
        let view = ml2drender::reproject::ProjectedView::camera(projjson, &grid, &view.0).map_err(error)?;
        self.0.set_projected_view(&view).map_err(error)
    }

    /// URLs of the resources still needed before `render`.
    fn needs(&self) -> Vec<String> {
        self.0.needs().into_iter().map(|r| r.url).collect()
    }

    /// The bytes of `url`, or None for a missing resource (like HTTP 404).
    #[pyo3(signature = (url, data))]
    fn provide(&mut self, url: &str, data: Option<&[u8]>) {
        self.0.provide(url, data);
    }

    /// RGBA8 pixels, row by row (see `View.size`).
    fn render<'py>(&mut self, py: Python<'py>) -> PyResult<Bound<'py, PyBytes>> {
        Ok(PyBytes::new(py, &self.0.render().map_err(error)?))
    }
}

/// Lossless PNG of RGBA8 pixels.
#[pyfunction]
fn encode_png<'py>(py: Python<'py>, rgba: &[u8], width: u32, height: u32) -> PyResult<Bound<'py, PyBytes>> {
    Ok(PyBytes::new(py, &ml2drender::encode_png(rgba, width, height).map_err(error)?))
}

/// Lossless WebP of RGBA8 pixels.
#[pyfunction]
fn encode_webp<'py>(py: Python<'py>, rgba: &[u8], width: u32, height: u32) -> PyResult<Bound<'py, PyBytes>> {
    Ok(PyBytes::new(py, &ml2drender::encode_webp(rgba, width, height).map_err(error)?))
}

/// JPEG of RGBA8 pixels at `quality` (1–100), flattened over black.
#[pyfunction]
#[pyo3(signature = (rgba, width, height, quality = 90))]
fn encode_jpeg<'py>(
    py: Python<'py>,
    rgba: &[u8],
    width: u32,
    height: u32,
    quality: u8,
) -> PyResult<Bound<'py, PyBytes>> {
    Ok(PyBytes::new(py, &ml2drender::encode_jpeg(rgba, width, height, quality).map_err(error)?))
}

#[pymodule]
#[pyo3(name = "_native")]
fn ml2drender_module(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<View>()?;
    m.add_class::<ProjectedBox>()?;
    m.add_class::<Renderer>()?;
    m.add_function(wrap_pyfunction!(encode_png, m)?)?;
    m.add_function(wrap_pyfunction!(encode_webp, m)?)?;
    m.add_function(wrap_pyfunction!(encode_jpeg, m)?)?;
    Ok(())
}
