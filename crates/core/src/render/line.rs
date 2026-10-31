//! Line layers: port of MapLibre's `LineBucket.addLine` geometry and the `line` shader.

use super::raster::{self, Rgba, Target};
use super::{color, num, BucketFeature, Ctx, TileFeatures, EXTENT};
use crate::expression::Value;
use crate::mvt::GeomType;
use crate::style::Layer;

const EXTRUDE_SCALE: f64 = 63.0;
const COS_HALF_SHARP_CORNER: f64 = 0.7933533402912352; // cos(75° / 2)
const SHARP_CORNER_OFFSET: f64 = 15.0;
const DEG_PER_TRIANGLE: f64 = 20.0;
const MAX_OFFSET_MITER_LENGTH: f64 = 2.0;
const OFFSET_FALLBACK_START: f64 = 3.0;
const OFFSET_FALLBACK_END: f64 = 8.0;
const MAX_LINE_DISTANCE: f64 = 32768.0; // 2^(15 - 1) / LINE_DISTANCE_SCALE (1/2)
const LINE_ATLAS_WIDTH: usize = 256;

#[derive(Clone, Copy)]
struct Vertex {
    pos: [f64; 2],
    /// Extrude vector, quantized like the byte attribute.
    extrude: [f64; 2],
    offset: [f64; 2],
    round: bool,
    up: bool,
    linesofar: f64,
    /// Gradient texture coordinates: progress within the clip, and its row (1-based).
    uv_x: f64,
    split: usize,
}

#[derive(Default)]
struct Builder {
    vertices: Vec<Vertex>,
    triangles: Vec<[usize; 3]>,
    e1: Option<usize>,
    e2: Option<usize>,
    distance: f64,
    /// `lineMetrics` clip of the current feature (geojson-vt start/end fractions).
    clip: Option<(f64, f64)>,
    clips: Vec<(f64, f64)>,
    total_distance: f64,
    scaled_distance: f64,
    max_line_length: f64,
}

type P = [f64; 2];

fn sub(a: P, b: P) -> P {
    [a[0] - b[0], a[1] - b[1]]
}
fn add(a: P, b: P) -> P {
    [a[0] + b[0], a[1] + b[1]]
}
fn mult(a: P, k: f64) -> P {
    [a[0] * k, a[1] * k]
}
fn mag(a: P) -> f64 {
    (a[0] * a[0] + a[1] * a[1]).sqrt()
}
fn unit(a: P) -> P {
    let m = mag(a);
    [a[0] / m, a[1] / m]
}
fn perp(a: P) -> P {
    [-a[1], a[0]]
}
fn dist(a: P, b: P) -> f64 {
    mag(sub(a, b))
}
fn js_round(v: f64) -> f64 {
    crate::expression::value::js_round(v)
}

/// `a_data` extrude bytes: `Math.round(63 * v) + 128` stored in a `Uint8Array` (wrapping),
/// decoded as `byte - 128`.
fn q_extrude(v: f64) -> f64 {
    let byte = (js_round(EXTRUDE_SCALE * v) as i64 + 128).rem_euclid(256);
    (byte - 128) as f64 / EXTRUDE_SCALE
}

/// `a_offset_normal`: `Math.round(63 * v)` stored in an `Int8Array` (wrapping).
fn q_offset(v: f64) -> f64 {
    let b = (js_round(EXTRUDE_SCALE * v) as i64 + 128).rem_euclid(256) - 128;
    b as f64 / EXTRUDE_SCALE
}

impl Builder {
    #[allow(clippy::too_many_arguments)]
    fn add_half_vertex(&mut self, p: P, ex: f64, ey: f64, ox: f64, oy: f64, round: bool, up: bool) {
        let total = if self.clip.is_some() { self.scaled_distance * (MAX_LINE_DISTANCE - 1.0) } else { self.scaled_distance };
        // Stored as an integer of half the distance (LINE_DISTANCE_SCALE), decoded times two.
        let linesofar = ((total * 0.5) as i64 as f64) * 2.0;
        let uv_x = self.clip.map_or(0.0, |(s, e)| (self.scaled_distance - s) / (e - s));
        let split = self.clips.len();
        self.vertices.push(Vertex { pos: p, extrude: [q_extrude(ex), q_extrude(ey)], offset: [q_offset(ox), q_offset(oy)], round, up, linesofar, uv_x, split });
        let e = self.vertices.len() - 1;
        if let (Some(e1), Some(e2)) = (self.e1, self.e2) {
            self.triangles.push([e1, e, e2]);
        }
        if up {
            self.e2 = Some(e);
        } else {
            self.e1 = Some(e);
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn add_current_vertex(&mut self, p: P, normal: P, end_left: f64, end_right: f64, round: bool, offset_normal: Option<P>, fallback: f64) {
        let on = offset_normal.unwrap_or(normal);
        let lx = normal[0] + normal[1] * end_left;
        let ly = normal[1] - normal[0] * end_left;
        let rx = -normal[0] + normal[1] * end_right;
        let ry = -normal[1] - normal[0] * end_right;
        let ox = on[0] + (normal[0] - on[0]) * fallback;
        let oy = on[1] + (normal[1] - on[1]) * fallback;
        self.add_half_vertex(p, lx, ly, ox, oy, round, false);
        self.add_half_vertex(p, rx, ry, -ox, -oy, round, true);
        // The distance attribute has limited bits; restart it on long lines.
        if self.distance > MAX_LINE_DISTANCE / 2.0 && self.total_distance == 0.0 {
            self.distance = 0.0;
            self.update_scaled_distance();
            self.add_current_vertex(p, normal, end_left, end_right, round, offset_normal, fallback);
        }
    }

    fn update_scaled_distance(&mut self) {
        self.scaled_distance = match self.clip {
            Some((s, e)) => s + (e - s) * self.distance / self.total_distance,
            None => self.distance,
        };
    }

    fn update_distance(&mut self, a: P, b: P) {
        self.distance += dist(a, b);
        self.update_scaled_distance();
    }

    #[allow(clippy::too_many_arguments)]
    fn add_line(&mut self, vertices: &[P], is_polygon: bool, join: &str, cap: &str, mut miter_limit: f64, round_limit: f64, overscaling: f64) {
        self.distance = 0.0;
        self.scaled_distance = 0.0;
        self.total_distance = 0.0;
        if let Some(c) = self.clip {
            self.clips.push(c);
            self.total_distance = vertices.windows(2).map(|w| dist(w[0], w[1])).sum();
            self.update_scaled_distance();
            self.max_line_length = self.max_line_length.max(self.total_distance);
        }
        let mut len = vertices.len();
        while len >= 2 && vertices[len - 1] == vertices[len - 2] {
            len -= 1;
        }
        let mut first = 0;
        while first < len.saturating_sub(1) && vertices[first] == vertices[first + 1] {
            first += 1;
        }
        if len < first + if is_polygon { 3 } else { 2 } {
            return;
        }
        if join == "bevel" {
            miter_limit = 1.05;
        }
        let sharp_corner_offset = if overscaling <= 16.0 { SHARP_CORNER_OFFSET * EXTENT / (512.0 * overscaling) } else { 0.0 };
        self.e1 = None;
        self.e2 = None;
        let mut current: Option<P> = None;
        let mut prev_vertex: Option<P>;
        let mut prev_normal: Option<P> = None;
        let mut next_normal: Option<P> = None;
        if is_polygon {
            current = Some(vertices[len - 2]);
            next_normal = Some(perp(unit(sub(vertices[first], vertices[len - 2]))));
        }
        let mut prev: Option<P> = None;
        for i in first..len {
            let next_vertex = if i == len - 1 { if is_polygon { Some(vertices[first + 1]) } else { None } } else { Some(vertices[i + 1]) };
            if next_vertex.is_some_and(|n| n == vertices[i]) {
                continue;
            }
            if next_normal.is_some() {
                prev_normal = next_normal;
            }
            if current.is_some() {
                prev = current;
            }
            prev_vertex = prev;
            let mut cur = vertices[i];
            next_normal = match next_vertex {
                Some(n) => Some(perp(unit(sub(n, cur)))),
                None => prev_normal,
            };
            let pn = prev_normal.unwrap_or(next_normal.unwrap());
            prev_normal = Some(pn);
            let nn = next_normal.unwrap();
            let mut join_normal = add(pn, nn);
            if join_normal != [0.0, 0.0] {
                join_normal = unit(join_normal);
            }
            let cos_angle = pn[0] * nn[0] + pn[1] * nn[1];
            let cos_half = join_normal[0] * nn[0] + join_normal[1] * nn[1];
            let miter_length = if cos_half != 0.0 { 1.0 / cos_half } else { f64::INFINITY };
            let approx_angle = 2.0 * (2.0 - 2.0 * cos_half).sqrt();
            let is_sharp = cos_half < COS_HALF_SHARP_CORNER && prev_vertex.is_some() && next_vertex.is_some();
            let turns_left = pn[0] * nn[1] - pn[1] * nn[0] > 0.0;
            let offset_normal = mult(join_normal, miter_length.min(MAX_OFFSET_MITER_LENGTH));
            let fallback = ((miter_length - OFFSET_FALLBACK_START) / (OFFSET_FALLBACK_END - OFFSET_FALLBACK_START)).clamp(0.0, 1.0);

            if is_sharp && i > first {
                let pv = prev_vertex.unwrap();
                let l = dist(cur, pv);
                if l > 2.0 * sharp_corner_offset {
                    let d = mult(sub(cur, pv), sharp_corner_offset / l);
                    let new_prev = sub(cur, [d[0].round(), d[1].round()]);
                    self.update_distance(pv, new_prev);
                    self.add_current_vertex(new_prev, pn, 0.0, 0.0, false, None, 0.0);
                    prev_vertex = Some(new_prev);
                }
            }
            let middle = prev_vertex.is_some() && next_vertex.is_some();
            let mut cj = if middle { join } else if is_polygon { "butt" } else { cap }.to_string();
            if middle && cj == "round" {
                if miter_length < round_limit {
                    cj = "miter".into();
                } else if miter_length <= 2.0 {
                    cj = "fakeround".into();
                }
            }
            if cj == "miter" && miter_length > miter_limit {
                cj = "bevel".into();
            }
            if cj == "bevel" {
                if miter_length > 2.0 {
                    cj = "flipbevel".into();
                }
                if miter_length < miter_limit {
                    cj = "miter".into();
                }
            }
            if let Some(pv) = prev_vertex {
                self.update_distance(pv, cur);
            }
            let on = Some(offset_normal);
            match cj.as_str() {
                "miter" => {
                    join_normal = mult(join_normal, miter_length);
                    self.add_current_vertex(cur, join_normal, 0.0, 0.0, false, on, 0.0);
                }
                "flipbevel" => {
                    if miter_length > 100.0 {
                        join_normal = mult(nn, -1.0);
                    } else {
                        let bevel_length = miter_length * mag(add(pn, nn)) / mag(sub(pn, nn));
                        join_normal = mult(perp(join_normal), bevel_length * if turns_left { -1.0 } else { 1.0 });
                    }
                    self.add_current_vertex(cur, join_normal, 0.0, 0.0, false, on, fallback);
                    self.add_current_vertex(cur, mult(join_normal, -1.0), 0.0, 0.0, false, on, fallback);
                }
                "bevel" | "fakeround" => {
                    let offset = -(miter_length * miter_length - 1.0).sqrt();
                    let (oa, ob) = if turns_left { (offset, 0.0) } else { (0.0, offset) };
                    if prev_vertex.is_some() {
                        self.add_current_vertex(cur, pn, oa, ob, false, on, 0.0);
                    }
                    if cj == "fakeround" {
                        let n = ((approx_angle * 180.0 / std::f64::consts::PI) / DEG_PER_TRIANGLE).round() as i64;
                        for m in 1..n {
                            let mut t = m as f64 / n as f64;
                            if t != 0.5 {
                                let t2 = t - 0.5;
                                let a = 1.0904 + cos_angle * (-3.2452 + cos_angle * (3.55645 - cos_angle * 1.43519));
                                let b = 0.848013 + cos_angle * (-1.06021 + cos_angle * 0.215638);
                                t += t * t2 * (t - 1.0) * (a * t2 * t2 + b);
                            }
                            let e = mult(unit(add(mult(sub(nn, pn), t), pn)), if turns_left { -1.0 } else { 1.0 });
                            let (ox, oy) = if turns_left { (-offset_normal[0], -offset_normal[1]) } else { (offset_normal[0], offset_normal[1]) };
                            self.add_half_vertex(cur, e[0], e[1], ox, oy, false, turns_left);
                        }
                    }
                    if next_vertex.is_some() {
                        self.add_current_vertex(cur, nn, -oa, -ob, false, on, 0.0);
                    }
                }
                "butt" => self.add_current_vertex(cur, join_normal, 0.0, 0.0, false, on, 0.0),
                "square" => {
                    let o = if prev_vertex.is_some() { 1.0 } else { -1.0 };
                    self.add_current_vertex(cur, join_normal, o, o, false, on, 0.0);
                }
                "round" => {
                    if prev_vertex.is_some() {
                        self.add_current_vertex(cur, pn, 0.0, 0.0, false, on, fallback);
                        self.add_current_vertex(cur, pn, 1.0, 1.0, true, on, fallback);
                    }
                    if next_vertex.is_some() {
                        self.add_current_vertex(cur, nn, -1.0, -1.0, true, on, fallback);
                        self.add_current_vertex(cur, nn, 0.0, 0.0, false, on, fallback);
                    }
                }
                _ => {}
            }
            if is_sharp && i < len - 1 {
                let nv = next_vertex.unwrap();
                let l = dist(cur, nv);
                if l > 2.0 * sharp_corner_offset {
                    let d = mult(sub(nv, cur), sharp_corner_offset / l);
                    let new_cur = add(cur, [d[0].round(), d[1].round()]);
                    self.update_distance(cur, new_cur);
                    self.add_current_vertex(new_cur, nn, 0.0, 0.0, false, None, 0.0);
                    cur = new_cur;
                }
            }
            current = Some(cur);
        }
    }
}

/// One line-atlas entry (`LineAtlas.addDash`): a signed-distance row (or 2n+1 rows for
/// round caps) of `LINE_ATLAS_WIDTH` texels, values offset by 128.
struct Dash {
    rows: Vec<Vec<u8>>,
    n: usize,
    /// Sum of the dasharray, in line widths.
    length: f64,
}

struct Range {
    left: f64,
    right: f64,
    is_dash: bool,
    zero_length: bool,
}

fn dash_ranges(dasharray: &[f64], stretch: f64) -> Vec<Range> {
    let odd = dasharray.len() % 2 == 1;
    let mut ranges = vec![Range {
        left: if odd { -dasharray[dasharray.len() - 1] * stretch } else { 0.0 },
        right: dasharray[0] * stretch,
        is_dash: true,
        zero_length: dasharray[0] == 0.0,
    }];
    let mut current = dasharray[0];
    let mut is_dash = true;
    for &d in &dasharray[1..] {
        is_dash = !is_dash;
        let left = current * stretch;
        current += d;
        ranges.push(Range { left, right: current * stretch, is_dash, zero_length: d == 0.0 });
    }
    ranges
}

fn make_dash(dasharray: &[f64], round: bool) -> Dash {
    let n = if round { 7 } else { 0 };
    let length: f64 = dasharray.iter().sum();
    let w = LINE_ATLAS_WIDTH;
    let mut rows = vec![vec![0u8; w]; 2 * n + 1];
    if length != 0.0 && !dasharray.is_empty() {
        let stretch = w as f64 / length;
        let mut ranges = dash_ranges(dasharray, stretch);
        let clamp = |v: f64| v.clamp(0.0, 255.0) as u8;
        if round {
            let half = stretch / 2.0;
            for y in -(n as i64)..=n as i64 {
                let row = &mut rows[(n as i64 + y) as usize];
                let mut ci = 0;
                for (x, out) in row.iter_mut().enumerate() {
                    let x = x as f64;
                    if x / ranges[ci].right > 1.0 && ci + 1 < ranges.len() {
                        ci += 1;
                    }
                    let r = &ranges[ci];
                    let min_dist = (x - r.left).abs().min((x - r.right).abs());
                    let dist_middle = y as f64 / n as f64 * (half + 1.0);
                    let sd = if r.is_dash {
                        let edge = half - dist_middle.abs();
                        (min_dist * min_dist + edge * edge).sqrt()
                    } else {
                        half - (min_dist * min_dist + dist_middle * dist_middle).sqrt()
                    };
                    *out = clamp(sd + 128.0);
                }
            }
        } else {
            let mut i = ranges.len();
            while i > 0 {
                i -= 1;
                if ranges[i].zero_length {
                    ranges.remove(i);
                } else if i + 1 < ranges.len() && ranges[i + 1].is_dash == ranges[i].is_dash {
                    ranges[i + 1].left = ranges[i].left;
                    ranges.remove(i);
                }
            }
            if let (Some(first), Some(last)) = (ranges.first(), ranges.last())
                && first.is_dash == last.is_dash
            {
                let (fl, lr) = (last.left - w as f64, first.right + w as f64);
                let last_i = ranges.len() - 1;
                ranges[0].left = fl;
                ranges[last_i].right = lr;
            }
            let mut ci = 0;
            for (x, out) in rows[0].iter_mut().enumerate() {
                let x = x as f64;
                if x / ranges[ci].right > 1.0 && ci + 1 < ranges.len() {
                    ci += 1;
                }
                let r = &ranges[ci];
                let min_dist = (x - r.left).abs().min((x - r.right).abs());
                *out = clamp(if r.is_dash { min_dist } else { -min_dist } + 128.0);
            }
        }
    }
    Dash { rows, n, length }
}

impl Dash {
    /// Bilinear `REPEAT` sample at texture x `u` (0..1 per period) and row offset `r` in
    /// 0..=2n, returning 0..1.
    fn sample(&self, u: f32, r: f32) -> f32 {
        let w = LINE_ATLAS_WIDTH as f32;
        let tx = u * w - 0.5;
        let x0 = tx.floor();
        let fx = tx - x0;
        let xi = |x: f32| (x as i64).rem_euclid(LINE_ATLAS_WIDTH as i64) as usize;
        let (a, b) = (xi(x0), xi(x0 + 1.0));
        let r = r.clamp(0.0, (2 * self.n) as f32);
        let y0 = r.floor() as usize;
        let y1 = (y0 + 1).min(2 * self.n);
        let fy = r - y0 as f32;
        let row = |y: usize| self.rows[y][a] as f32 * (1.0 - fx) + self.rows[y][b] as f32 * fx;
        (row(y0) * (1.0 - fy) + row(y1) * fy) / 255.0
    }
}

/// A color ramp row per line clip (`renderColorRamp`), stored like MapLibre's texture:
/// unpremultiplied bytes, premultiplied with rounding on upload.
struct Gradient {
    width: usize,
    rows: Vec<Vec<[u8; 4]>>,
    nearest: bool,
}

impl Gradient {
    fn new(layer: &Layer, ctx: &Ctx, clips: &[(f64, f64)], width: usize) -> Gradient {
        let prop = layer.paint("line-gradient");
        let nearest = matches!(prop, crate::style::PropValue::Expr(e) if e.is_step());
        let rows = clips
            .iter()
            .map(|&(start, end)| {
                (0..width)
                    .map(|i| {
                        let t = i as f64 / (width - 1) as f64;
                        let c = match prop.eval_line_progress(start * (1.0 - t) + end * t, ctx.global_state) {
                            Value::Color(c) => c,
                            _ => crate::expression::color::Color::TRANSPARENT,
                        };
                        let a = (c.a * 255.0).round();
                        let un = |v: f64| if c.a == 0.0 { 0.0 } else { (v * 255.0 / c.a).round().clamp(0.0, 255.0) };
                        let pm = |v: f64| (un(v) * a / 255.0).round() as u8;
                        [pm(c.r), pm(c.g), pm(c.b), a as u8]
                    })
                    .collect()
            })
            .collect();
        Gradient { width, rows, nearest }
    }

    /// `CLAMP_TO_EDGE` sample of row `split` (1-based) at `u`.
    fn sample(&self, u: f32, split: usize) -> Rgba {
        let Some(row) = split.checked_sub(1).and_then(|r| self.rows.get(r)) else { return [0.0; 4] };
        let w = self.width as f32;
        let texel = |i: i64| row[i.clamp(0, self.width as i64 - 1) as usize].map(|v| v as f32 / 255.0);
        if self.nearest {
            return texel((u * w).floor() as i64);
        }
        let t = u * w - 0.5;
        let i0 = t.floor();
        let f = t - i0;
        let (a, b) = (texel(i0 as i64), texel(i0 as i64 + 1));
        std::array::from_fn(|k| a[k] * (1.0 - f) + b[k] * f)
    }
}

struct Prepared<'a> {
    f: &'a BucketFeature,
    b: Builder,
}

#[allow(clippy::too_many_arguments)]
pub fn draw_line(target: &mut Target, layer: &Layer, ctx: &Ctx, tiles: &[TileFeatures], source_maxzoom: u8, map_max_zoom: f64, has_gradient: bool, has_pattern: bool) {
    let dpr = ctx.transform.pixel_ratio;
    for tf in tiles {
        let features = ctx.bucket_features(layer, tf, Some("line-sort-key"));
        let to_world = ctx.tile_to_world(&tf.tile);
        let tr = ctx.translate(layer, "line", &tf.tile);
        let overscaling = 2f64.powi(tf.tile.overscaled_z as i32 - tf.tile.canonical.z as i32);
        // Build all features first: the gradient texture covers the whole tile bucket.
        let mut clips: Vec<(f64, f64)> = Vec::new();
        let mut max_line_length: f64 = 0.0;
        let mut prepared = Vec::new();
        for f in features.iter().filter(|f| matches!(f.ty, GeomType::LineString | GeomType::Polygon)) {
            let l = |name: &str| ctx.layout(layer, name, Some(f), &tf.tile);
            let mut b = Builder { clips: std::mem::take(&mut clips), ..Default::default() };
            let props = &f.feature.properties;
            b.clip = match (props.get(crate::geojson::CLIP_START), props.get(crate::geojson::CLIP_END)) {
                (Some(s), Some(e)) => Some((num(s), num(e))),
                _ => None,
            };
            let (join, cap) = (l("line-join"), l("line-cap"));
            for line in &f.geometry {
                b.add_line(
                    line,
                    f.ty == GeomType::Polygon,
                    join.as_str().unwrap_or("miter"),
                    cap.as_str().unwrap_or("butt"),
                    num(&l("line-miter-limit")),
                    num(&l("line-round-limit")),
                    overscaling,
                );
            }
            clips = std::mem::take(&mut b.clips);
            max_line_length = max_line_length.max(b.max_line_length);
            prepared.push(Prepared { f, b });
        }
        let gradient = has_gradient.then(|| {
            let step = matches!(layer.paint("line-gradient"), crate::style::PropValue::Expr(e) if e.is_step());
            let width = if step {
                let overzoom = if tf.tile.canonical.z == source_maxzoom { (2f64.powf(map_max_zoom - tf.tile.canonical.z as f64)).ceil() } else { 1.0 };
                let coverage = max_line_length / EXTENT * 1024.0 * overzoom;
                (coverage.max(1.0) as u64).next_power_of_two().clamp(256, MAX_TEXTURE_SIZE) as usize
            } else {
                256
            };
            Gradient::new(layer, ctx, &clips, width)
        });
        for p in &prepared {
            draw_feature(target, layer, ctx, tf, p.f, &p.b, &to_world, tr, dpr, gradient.as_ref(), has_pattern);
        }
    }
}

const MAX_TEXTURE_SIZE: u64 = 16384;

fn feature_constant(p: &crate::style::PropValue) -> bool {
    match p {
        crate::style::PropValue::Constant(_) => true,
        crate::style::PropValue::Expr(e) => e.is_feature_constant(),
        crate::style::PropValue::Function(f) => f.is_zoom_dependent() && !f.is_composite(),
    }
}

#[allow(clippy::too_many_arguments)]
fn draw_feature(
    target: &mut Target,
    layer: &Layer,
    ctx: &Ctx,
    tf: &TileFeatures,
    f: &BucketFeature,
    b: &Builder,
    to_world: &impl Fn(P) -> P,
    tr: P,
    dpr: f64,
    gradient: Option<&Gradient>,
    has_pattern: bool,
) {
    let p = |name: &str| ctx.paint(layer, name, Some(f), &tf.tile);
    let l = |name: &str| ctx.layout(layer, name, Some(f), &tf.tile);
    let opacity = num(&p("line-opacity"));
    if opacity < 0.01 {
        return;
    }
    let floor_zoom = ctx.transform.zoom.floor();
    // `line-pattern` takes over the whole layer (the pattern program ignores dashes).
    let pattern = if has_pattern {
        let prop = layer.paint("line-pattern");
        let v = if prop.is_feature_constant() {
            prop.eval(floor_zoom, None, Some(Ctx::canonical(&tf.tile)), ctx.global_state)
        } else {
            prop.eval(tf.tile.overscaled_z as f64, Some(&f.feature), Some(Ctx::canonical(&tf.tile)), ctx.global_state)
        };
        match super::pattern::image_name(&v).and_then(|n| ctx.images.get(&n)) {
            Some(img) => Some(img),
            None => return,
        }
    } else {
        None
    };
    let dash = match if pattern.is_some() { Value::Null } else { layer.paint("line-dasharray").eval(floor_zoom, Some(&f.feature), Some(Ctx::canonical(&tf.tile)), ctx.global_state) } {
        Value::Array(a) if !a.is_empty() => {
            let d: Vec<f64> = a.iter().map(num).collect();
            // A non-data-driven dasharray uses the layer's cap only if that is constant too.
            let cap_prop = layer.layout("line-cap");
            let round = if feature_constant(layer.paint("line-dasharray")) {
                feature_constant(cap_prop) && l("line-cap").as_str() == Some("round")
            } else {
                l("line-cap").as_str() == Some("round")
            };
            Some(make_dash(&d, round))
        }
        _ => None,
    };
    let width = num(&p("line-width"));
    let gap = num(&p("line-gap-width"));
    let offset = num(&p("line-offset"));
    let blur = num(&p("line-blur"));
    let c: Rgba = color(&p("line-color"), opacity);
    // Vertex shader.
    let aa = 1.0 / dpr / 2.0;
    let gapwidth = gap / 2.0;
    let halfwidth = width / 2.0;
    let offset = -offset;
    let inset = gapwidth + if gapwidth > 0.0 { aa } else { 0.0 };
    let outset = gapwidth + halfwidth * if gapwidth > 0.0 { 2.0 } else { 1.0 } + if halfwidth == 0.0 { 0.0 } else { aa };
    let screen: Vec<P> = b
        .vertices
        .iter()
        .map(|v| {
            let normal_y = if v.up { 1.0 } else { -1.0 };
            let w = to_world(v.pos);
            let ox = offset * v.offset[0] * normal_y + outset * v.extrude[0];
            let oy = offset * v.offset[1] * normal_y + outset * v.extrude[1];
            ctx.transform.world_to_screen([w[0] + ox + tr[0], w[1] + oy + tr[1]])
        })
        .collect();
    let blur2 = (blur + 1.0 / dpr) as f32;
    let (outset_f, inset_f) = (outset as f32, inset as f32);
    // Dash texture x per vertex: distance in pixels at the integer tile zoom, in dash periods.
    let floorwidth = num(&layer.paint("line-width").eval(floor_zoom, Some(&f.feature), Some(Ctx::canonical(&tf.tile)), ctx.global_state));
    let tileratio = 512.0 * 2f64.powf(floor_zoom.max(0.0) - tf.tile.canonical.z as f64) / EXTENT;
    let (sdfgamma, scale_x) = match (&dash, pattern) {
        // The gradient variant of the shader omits the device pixel ratio.
        (Some(d), _) => ((if gradient.is_some() { 1.0 } else { 1.0 / dpr } / d.length) as f32, tileratio / d.length / floorwidth),
        // Pattern: x = linesofar / pattern_size.x * aspect (in pattern repeats).
        (None, Some(img)) => {
            let ds = super::pattern::display_size(img);
            let pattern_size_x = ds[0] as f64 / tileratio;
            let aspect = ds[1] as f64 / floorwidth;
            (0.0, aspect / pattern_size_x)
        }
        (None, None) => (0.0, 0.0),
    };
    let floorwidth_f = floorwidth as f32;
    let opacity_f = opacity as f32;
    for t in &b.triangles {
        // All three vertices of a triangle share the split row.
        let split = b.vertices[t[0]].split;
        let mut shade = |v: &[f32; 4]| {
            let d = (v[0] * v[0] + v[1] * v[1]).sqrt() * outset_f;
            let mut alpha = ((d - (inset_f - blur2)).min(outset_f - d) / blur2).clamp(0.0, 1.0);
            if let Some(dash) = &dash {
                let r = dash.n as f32 * (1.0 - v[1]);
                let sdf = dash.sample(v[2], r);
                alpha *= raster::smoothstep(0.5 - sdfgamma / floorwidth_f, 0.5 + sdfgamma / floorwidth_f, sdf);
            }
            if let Some(img) = pattern {
                let x = v[2] - v[2].floor();
                let color = super::pattern::sample_line(img, x, 0.5 * v[1] + 0.5);
                return Some(color.map(|k| k * alpha * opacity_f));
            }
            match gradient {
                Some(g) => Some(g.sample(v[3], split).map(|k| k * alpha * opacity_f)),
                None => Some(c.map(|k| k * alpha)),
            }
        };
        let vary = t.map(|i| {
            let v = &b.vertices[i];
            [if v.round { 1.0 } else { 0.0 }, if v.up { 1.0 } else { -1.0 }, (v.linesofar * scale_x) as f32, v.uv_x as f32]
        });
        raster::triangle(target, Some(tf.mask), [screen[t[0]], screen[t[1]], screen[t[2]]], vary, &mut shade);
    }
}
