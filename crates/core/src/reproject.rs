//! Rendering into a projected CRS. Buckets are built in tile space as usual; layers drawn from
//! vertices (fill, line, circle, heatmap, symbol, background) are drawn straight into the target
//! grid with their vertices projected ([`Warp::world_to_screen`]), segments split so that they
//! curve, and pixel lengths (line widths, radii, text) extruded in screen space. Image patterns
//! and dashes repeat evenly on the output's pixels ([`Warp::pixel_origin`]). Rasters and DEMs are
//! drawn in Web Mercator and the picture is warped into the target grid ([`Warp::composite`]).
//! Tile clipping uses the Mercator position of each output pixel
//! ([`Warp::pixel_world`]), as tile boundaries curve.

use crate::projection::Projection;
use crate::render::raster::{Rgba, Target};
use crate::tile::{self, Transform};
use crate::{Error, View};

/// A target-CRS view: what [`crate::Renderer::set_projected_view`] renders.
#[derive(Debug, Clone, PartialEq)]
pub struct ProjectedView {
    /// The target CRS as PROJJSON, geographic or projected. Supported methods: Transverse Mercator,
    /// Mercator, Pseudo Mercator, Lambert Conic Conformal, Polar Stereographic, Lambert Azimuthal Equal
    /// Area, Equal Earth and PROJ's Geostationary Satellite, on any ellipsoid, without datum shifts.
    /// Coordinates are (easting, northing) / (longitude, latitude) whatever the axis order.
    pub projjson: String,
    /// `[min_x, min_y, max_x, max_y]` in CRS units (degrees for longlat).
    pub bbox: [f64; 4],
    /// CSS pixels; the output is `round(width*pixel_ratio)` × `round(height*pixel_ratio)`.
    pub width: u32,
    pub height: u32,
    pub pixel_ratio: f64,
    /// CSS pixels rendered around the view before cropping to the requested output size.
    pub margin: u32,
}

/// Largest output side, margins included, in device pixels (bounds the per-pixel buffers).
const MAX_SIZE: usize = 16384;

/// Mesh spacing in output device pixels: the Mercator position of each output pixel is
/// interpolated bilinearly between exactly inverse-projected nodes.
const GRID: usize = 8;

/// A projected view's mapping to and from the Web Mercator render.
#[derive(Debug)]
pub struct Warp {
    proj: Projection,
    bbox: [f64; 4],
    /// Rendered size in device pixels, margins included.
    pub size: [usize; 2],
    /// Rendered size in CSS pixels.
    pub css_size: [f64; 2],
    /// Device pixels cropped from each side of the rendered image.
    pub margin: usize,
    /// Mercator coordinates (world = 1, unwrapped around the reference point) of the mesh nodes,
    /// row-major; NaN outside the projection's domain. Empty when the whole view is outside.
    nodes: Vec<[f64; 2]>,
    cols: usize,
    /// Longitudes are unwrapped to within 180° of this one.
    reference_lng: f64,
    /// Mercator x (world = 1) of the projection's central meridian; `None` for longlat.
    central_x: Option<f64>,
    /// `pixel_world`, computed once.
    pixels: std::cell::OnceCell<Vec<[f64; 2]>>,
}

impl Warp {
    /// The warp for `view` and the Mercator view to render for it: about one Mercator pixel per
    /// output pixel at the view center, covering the whole output. No Mercator view when nothing
    /// of `view` is in the projection's domain (the output is then transparent).
    pub fn new(view: &ProjectedView) -> Result<(Warp, Option<View>), Error> {
        let proj = Projection::parse(&view.projjson)?;
        let b = view.bbox;
        let out = [
            (view.width as f64 * view.pixel_ratio).round() as usize,
            (view.height as f64 * view.pixel_ratio).round() as usize,
        ];
        if !(b[2] > b[0] && b[3] > b[1]) || out[0] == 0 || out[1] == 0 {
            return Err(Error::Unsupported(format!("empty projected view {b:?}")));
        }
        // The margin extends the box by whole device pixels of the output's resolution.
        let margin = (view.margin as f64 * view.pixel_ratio).round() as usize;
        if out.iter().any(|&n| n.saturating_add(margin.saturating_mul(2)) > MAX_SIZE) {
            return Err(Error::Unsupported(format!("projected view over {MAX_SIZE} device pixels wide or high")));
        }
        let size = [out[0] + 2 * margin, out[1] + 2 * margin];
        let (ux, uy) = ((b[2] - b[0]) / out[0] as f64, (b[3] - b[1]) / out[1] as f64);
        let m = margin as f64;
        let b = [b[0] - m * ux, b[1] - m * uy, b[2] + m * ux, b[3] + m * uy];
        let (cols, rows) = (size[0].div_ceil(GRID) + 1, size[1].div_ceil(GRID) + 1);
        let grid: Vec<(f64, f64)> = (0..rows)
            .flat_map(|j| (0..cols).map(move |i| ((i * GRID) as f64, (j * GRID) as f64)))
            .collect();
        // The reference point: the center or else, e.g. for a tile on the edge of a world
        // projection, the node nearest to it in the domain, with neighbors 1 px toward the center.
        let (cx, cy) = (size[0] as f64 / 2.0, size[1] as f64 / 2.0);
        let css_size = [
            size[0] as f64 / view.pixel_ratio,
            size[1] as f64 / view.pixel_ratio,
        ];
        let mut warp = Warp {
            proj,
            bbox: b,
            size,
            css_size,
            margin,
            nodes: Vec::new(),
            cols,
            reference_lng: 0.0,
            central_x: None,
            pixels: Default::default(),
        };
        let in_domain = |x: f64, y: f64| warp.lnglat(x, y);
        // Nodes by distance from the center, sorted only if the center is not in the domain.
        let candidates = std::iter::once_with(|| {
            let mut c = grid.clone();
            let d2 = |p: &(f64, f64)| (p.0 - cx).powi(2) + (p.1 - cy).powi(2);
            c.sort_by(|a, b| d2(a).total_cmp(&d2(b)));
            c
        })
        .flatten();
        let reference = std::iter::once((cx, cy))
            .chain(candidates)
            .find_map(|(x, y)| {
                let (sx, sy) = (
                    if x < cx { 1.0 } else { -1.0 },
                    if y < cy { 1.0 } else { -1.0 },
                );
                let p = in_domain(x, y)?;
                (in_domain(x + sx, y).is_some() && in_domain(x, y + sy).is_some())
                    .then_some((x, y, sx, sy, p[0]))
            });
        let Some((rx, ry, sx, sy, reference_lng)) = reference else {
            return Ok((warp, None));
        };
        warp.reference_lng = reference_lng;
        // The central meridian itself (not a world copy of it): `world_to_screen` measures
        // longitudes from it.
        warp.central_x = warp.proj.central_meridian().map(tile::mercator_x);
        let merc = |x: f64, y: f64| warp.merc(x, y);
        let nodes: Vec<[f64; 2]> = grid.into_iter().map(|(x, y)| merc(x, y)).collect();
        // Mercator units per output device pixel at the reference point. It is also the zoom
        // styles are evaluated at, like a Mercator map's center.
        let (m0, mx, my) = (merc(rx, ry), merc(rx + sx, ry), merc(rx, ry + sy));
        let scale = ((mx[0] - m0[0]) * (my[1] - m0[1]) - (mx[1] - m0[1]) * (my[0] - m0[0]))
            .abs()
            .sqrt();
        let mut zoom = (1.0 / (scale * view.pixel_ratio * 512.0)).log2();
        let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
        for n in nodes.iter().filter(|n| n[0].is_finite()) {
            (x0, y0, x1, y1) = (x0.min(n[0]), y0.min(n[1]), x1.max(n[0]), y1.max(n[1]));
        }
        // ponytail: one zoom for the whole view; far from the center (e.g. continental views) the
        // picture is resampled up or down. Bound the Mercator render to 16× the output area.
        let css = |zoom: f64| {
            [
                (x1 - x0) * 512.0 * 2f64.powf(zoom),
                (y1 - y0) * 512.0 * 2f64.powf(zoom),
            ]
        };
        let [w, h] = css(zoom);
        let max_area = 16.0 * css_size[0] * css_size[1];
        if w * h > max_area {
            zoom -= 0.5 * (w * h / max_area).log2();
        }
        // Sized for the zoom the view is clamped to, or the picture would not cover the view.
        let zoom = zoom.max(tile::MIN_ZOOM);
        let [w, h] = css(zoom);
        let (mx, my) = ((x0 + x1) / 2.0, (y0 + y1) / 2.0);
        let mercator = View {
            center: [
                mx * 360.0 - 180.0,
                tile::mercator_lat(my),
            ],
            zoom,
            bearing: 0.0,
            // A pixel of padding on each side for bilinear sampling.
            width: w.ceil() as u32 + 2,
            height: h.ceil() as u32 + 2,
            pixel_ratio: view.pixel_ratio,
            margin: 0,
        };
        warp.nodes = nodes;
        Ok((warp, Some(mercator)))
    }

    /// Longitude/latitude at an output pixel position, if Mercator has it.
    fn lnglat(&self, x: f64, y: f64) -> Option<[f64; 2]> {
        let b = self.bbox;
        self.proj
            .inverse([
                b[0] + x / self.size[0] as f64 * (b[2] - b[0]),
                b[3] - y / self.size[1] as f64 * (b[3] - b[1]),
            ])
            .filter(|p| p[1].abs() <= tile::MAX_LAT)
    }

    /// Mercator coordinates (world = 1) at an output pixel position; NaN where there are none.
    fn merc(&self, x: f64, y: f64) -> [f64; 2] {
        let Some([lng, lat]) = self.lnglat(x, y) else {
            return [f64::NAN; 2];
        };
        let lng = self.reference_lng + (lng - self.reference_lng + 540.0).rem_euclid(360.0) - 180.0;
        [tile::mercator_x(lng), tile::mercator_y(lat)]
    }

    /// Whether nothing of the view is in the projection's domain.
    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    /// Mercator x of the projection's central meridian: drawn geometry is unwrapped to within
    /// 0.5 of it, where the projection is continuous. `None` for longlat (continuous anywhere).
    pub fn central_x(&self) -> Option<f64> {
        self.central_x
    }

    /// Mercator x offsets (whole worlds) that bring the range `x0..x1` within 0.5 of the central
    /// meridian, where its geometry lands on the map; two for a range across the antimeridian.
    pub fn branch_shifts(&self, x0: f64, x1: f64) -> std::ops::RangeInclusive<i32> {
        match self.central_x {
            Some(c) => (c - 0.5 - x1).ceil() as i32..=(c + 0.5 - x0).floor() as i32,
            None => 0..=0,
        }
    }

    /// Whether a Mercator point (world = 1) is on the map: within 180° of the central meridian
    /// (not a world copy past the antimeridian) and projectable.
    pub fn in_domain(&self, p: [f64; 2]) -> bool {
        self.on_map(p).is_some()
    }

    /// `world_to_screen` of a Mercator point that is `in_domain`.
    pub fn on_map(&self, p: [f64; 2]) -> Option<[f64; 2]> {
        if self.central_x.is_some_and(|c| (p[0] - c).abs() > 0.5) {
            return None;
        }
        Some(self.world_to_screen(p)).filter(|s| s[0].is_finite())
    }

    /// The output's pixel (0, 0) in a grid of the CRS's own: x = CRS x, y = −CRS y, both in output
    /// device pixels. Anything laid out on it (e.g. image patterns) lines up across views of the
    /// same resolution, such as neighboring tiles.
    pub fn pixel_origin(&self) -> [f64; 2] {
        let b = self.bbox;
        let (ux, uy) = (
            (b[2] - b[0]) / self.size[0] as f64,
            (b[3] - b[1]) / self.size[1] as f64,
        );
        [b[0] / ux, -b[3] / uy]
    }

    /// Mercator (world = 1) → output device pixel. Longitudes are not folded: past the
    /// antimeridian, points land beyond the edge of the map.
    pub fn world_to_screen(&self, p: [f64; 2]) -> [f64; 2] {
        let lat = tile::mercator_lat(p[1]);
        let [x, y] = self.proj.forward_continuous(p[0] * 360.0 - 180.0, lat);
        let b = self.bbox;
        [
            (x - b[0]) / (b[2] - b[0]) * self.size[0] as f64,
            (b[3] - y) / (b[3] - b[1]) * self.size[1] as f64,
        ]
    }

    /// Mercator coordinates (world = 1) of each output pixel center, row-major; NaN outside the
    /// projection's domain. Interpolated in the mesh; exact in cells on the domain's edge (e.g.
    /// a globe's limb), and NaN in cells with no corner in it.
    pub fn pixel_world(&self) -> &[[f64; 2]] {
        self.pixels.get_or_init(|| {
            if self.is_empty() {
                return vec![[f64::NAN; 2]; self.size[0] * self.size[1]];
            }
            let [w, h] = self.size;
            let g = GRID as f64;
            let mut out = Vec::with_capacity(w * h);
            for y in 0..h {
                let gy = (y as f64 + 0.5) / g;
                let (j, fy) = (gy as usize, gy.fract());
                for x in 0..w {
                    let gx = (x as f64 + 0.5) / g;
                    let (i, fx) = (gx as usize, gx.fract());
                    let k = j * self.cols + i;
                    let [a, b, c, d] = [
                        self.nodes[k],
                        self.nodes[k + 1],
                        self.nodes[k + self.cols],
                        self.nodes[k + self.cols + 1],
                    ];
                    let lerp = |q: usize| {
                        (a[q] * (1.0 - fx) + b[q] * fx) * (1.0 - fy)
                            + (c[q] * (1.0 - fx) + d[q] * fx) * fy
                    };
                    let m = [lerp(0), lerp(1)];
                    // A cell across the cut where longitudes unwrap (e.g. the meridian opposite
                    // a polar view's reference point) spans about a world: exact too.
                    let xs = [a[0], b[0], c[0], d[0]];
                    let span = xs.iter().fold(f64::MIN, |s, &v| s.max(v))
                        - xs.iter().fold(f64::MAX, |s, &v| s.min(v));
                    out.push(if m[0].is_finite() && span <= 0.5 {
                        m
                    } else if [a, b, c, d].iter().any(|n| n[0].is_finite()) {
                        self.merc(x as f64 + 0.5, y as f64 + 0.5)
                    } else {
                        [f64::NAN; 2]
                    });
                }
            }
            out
        })
    }

    /// Draws the Mercator picture `src` (rendered with `t`) over `dst`, then clears `src`.
    pub fn composite(&self, src: &mut Target, t: &Transform, dst: &mut Target) {
        let ws = t.world_size;
        for (i, m) in self.pixel_world().iter().enumerate() {
            if m[0].is_nan() {
                continue;
            }
            let [sx, sy] = t.world_to_screen([m[0] * ws, m[1] * ws]);
            let px = sample(src, sx - 0.5, sy - 0.5);
            if px != [0.0; 4] {
                dst.blend(i, px);
            }
        }
        src.px.fill([0; 4]);
    }
}

/// Bilinear sample of a premultiplied target at pixel-center coordinates; transparent outside.
fn sample(t: &Target, x: f64, y: f64) -> Rgba {
    let (x0, y0) = (x.floor(), y.floor());
    let (fx, fy) = ((x - x0) as f32, (y - y0) as f32);
    let at = |xi: f64, yi: f64| -> [f32; 4] {
        if xi < 0.0 || yi < 0.0 || xi >= t.w as f64 || yi >= t.h as f64 {
            return [0.0; 4];
        }
        t.px[yi as usize * t.w + xi as usize].map(|c| c as f32 / 255.0)
    };
    let (a, b, c, d) = (
        at(x0, y0),
        at(x0 + 1.0, y0),
        at(x0, y0 + 1.0),
        at(x0 + 1.0, y0 + 1.0),
    );
    std::array::from_fn(|k| {
        (a[k] * (1.0 - fx) + b[k] * fx) * (1.0 - fy) + (c[k] * (1.0 - fx) + d[k] * fx) * fy
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::projection::test_crs;

    #[test]
    fn polar_views_interpolate_no_cell_across_the_unwrapping_cut() {
        // Antarctic polar stereographic: the meridian opposite the reference point runs from the
        // pole through the picture, where unwrapped longitudes jump by a world.
        let view = ProjectedView {
            projjson: test_crs::projected(
                "Polar Stereographic (variant B)",
                test_crs::WGS84,
                &[("Latitude of standard parallel", -71.0), ("Longitude of origin", 0.0)],
            ),
            bbox: [-4e6, -4e6, 4e6, 4e6],
            width: 128,
            height: 128,
            pixel_ratio: 1.0,
            margin: 0,
        };
        let (warp, _) = Warp::new(&view).unwrap();
        for (i, m) in warp.pixel_world().iter().enumerate() {
            let exact = warp.merc((i % 128) as f64 + 0.5, (i / 128) as f64 + 0.5);
            if m[0].is_finite() {
                assert!((m[0] - exact[0]).abs() < 0.01, "pixel {i}: {m:?} vs {exact:?}");
            }
        }
    }
}
