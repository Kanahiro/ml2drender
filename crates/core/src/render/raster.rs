//! A tiny software stand-in for the GL pipeline MapLibre uses: aliased triangle and
//! line rasterization at pixel centers, linear varyings, and premultiplied "over"
//! blending into an 8-bit framebuffer. Anti-aliasing comes from the emulated shaders,
//! exactly as in MapLibre (which renders without MSAA).

/// Premultiplied RGBA8 framebuffer, row-major, top row first.
pub struct Target {
    pub w: usize,
    pub h: usize,
    pub px: Vec<[u8; 4]>,
    /// When non-empty, pixels written by MapLibre's opaque pass (opaque backgrounds and fill
    /// interiors), which depth-test-free layers drawn later (heatmaps) end up on top of.
    pub opaque: Vec<bool>,
}

/// Premultiplied color in 0..1.
pub type Rgba = [f32; 4];

impl Target {
    pub fn new(w: usize, h: usize) -> Target {
        Target { w, h, px: vec![[0; 4]; w * h], opaque: Vec::new() }
    }

    /// `gl.blendFunc(ONE, ONE_MINUS_SRC_ALPHA)` into a unorm8 target.
    #[inline]
    pub fn blend(&mut self, i: usize, c: Rgba) {
        let d = &mut self.px[i];
        let inv = 1.0 - c[3].clamp(0.0, 1.0);
        for k in 0..4 {
            let v = c[k].clamp(0.0, 1.0) + d[k] as f32 / 255.0 * inv;
            d[k] = (v * 255.0).round().clamp(0.0, 255.0) as u8;
        }
    }

    pub fn mark_opaque(&mut self, i: usize) {
        if let Some(o) = self.opaque.get_mut(i) {
            *o = true;
        }
    }

    /// Non-premultiplied RGBA like the render-test harness produces from `readPixels`:
    /// each channel divided by alpha and truncated into a `Uint8Array`.
    pub fn to_unpremultiplied(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.px.len() * 4);
        for p in &self.px {
            let a = p[3] as f64 / 255.0;
            for k in 0..3 {
                out.push(if a == 0.0 { p[k] } else { ((p[k] as f64 / a) as u32 & 0xff) as u8 });
            }
            out.push(p[3]);
        }
        out
    }
}

/// Pixel coverage mask (like the stencil clip of a tile).
#[derive(Clone)]
pub struct Mask {
    w: usize,
    h: usize,
    coverage: Coverage,
}

#[derive(Clone)]
enum Coverage {
    Rectangle { x: [usize; 2], y: [usize; 2] },
    Pixels(Vec<bool>),
}

impl Mask {
    pub fn empty() -> Mask {
        Mask { w: 0, h: 0, coverage: Coverage::Rectangle { x: [0, 0], y: [0, 0] } }
    }

    #[inline]
    pub fn get(&self, x: usize, y: usize) -> bool {
        match &self.coverage {
            Coverage::Rectangle { x: xs, y: ys } => x >= xs[0] && x < xs[1] && y >= ys[0] && y < ys[1],
            Coverage::Pixels(bits) => bits[y * self.w + x],
        }
    }

    pub fn subtract(&mut self, other: &Mask) {
        if let Coverage::Rectangle { x, y } = self.coverage {
            let mut bits = vec![false; self.w * self.h];
            for row in y[0]..y[1] {
                bits[row * self.w + x[0]..row * self.w + x[1]].fill(true);
            }
            self.coverage = Coverage::Pixels(bits);
        }
        let Coverage::Pixels(bits) = &mut self.coverage else { unreachable!() };
        match &other.coverage {
            Coverage::Rectangle { x, y } => {
                for row in y[0]..y[1] {
                    bits[row * self.w + x[0]..row * self.w + x[1]].fill(false);
                }
            }
            Coverage::Pixels(other) => {
                for (b, &o) in bits.iter_mut().zip(other) {
                    *b = *b && !o;
                }
            }
        }
    }

    /// Coverage of a straight-edged screen-space quad. Geographic projection and any
    /// tessellation of curved boundaries belong before this operation.
    pub fn from_quad(w: usize, h: usize, q: [[f64; 2]; 4]) -> Mask {
        // Decide from screen geometry, never from the geographic projection
        // or camera bearing. Rotated/warped quads keep the general coverage path.
        let area = (q[1][0] - q[0][0]) * (q[3][1] - q[0][1]);
        if area != 0.0 && area.is_finite() && q.iter().flatten().all(|v| v.is_finite())
            && q[0][1] == q[1][1] && q[2][1] == q[3][1] && q[0][0] == q[3][0] && q[1][0] == q[2][0] {
            let (left, right) = (q[0][0].min(q[1][0]), q[0][0].max(q[1][0]));
            let (top, bottom) = (q[0][1].min(q[3][1]), q[0][1].max(q[3][1]));
            // GL includes the left and bottom boundaries, excludes the right and top.
            let x = [(left - 0.5).ceil().max(0.0).min(w as f64) as usize, (right - 0.5).ceil().max(0.0).min(w as f64) as usize];
            let y = [((top - 0.5).floor() + 1.0).max(0.0).min(h as f64) as usize, ((bottom - 0.5).floor() + 1.0).max(0.0).min(h as f64) as usize];
            return Mask { w, h, coverage: Coverage::Rectangle { x, y } };
        }
        let mut bits = vec![false; w * h];
        for tri in [[q[0], q[1], q[2]], [q[0], q[2], q[3]]] {
            for_each_pixel(w, h, tri, |x, y, _| bits[y * w + x] = true);
        }
        Mask { w, h, coverage: Coverage::Pixels(bits) }
    }
}

/// Visit pixels whose centers are covered by the triangle (top-left fill rule), with
/// barycentric weights.
pub fn for_each_pixel(w: usize, h: usize, p: [[f64; 2]; 3], mut f: impl FnMut(usize, usize, [f64; 3])) {
    let area = (p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[1][1] - p[0][1]) * (p[2][0] - p[0][0]);
    if area == 0.0 || !area.is_finite() {
        return;
    }
    // Normalize to positive orientation.
    let (p, flip) = if area < 0.0 { ([p[0], p[2], p[1]], true) } else { (p, false) };
    let area = area.abs();
    let min_x = p.iter().map(|v| v[0]).fold(f64::INFINITY, f64::min);
    let max_x = p.iter().map(|v| v[0]).fold(f64::NEG_INFINITY, f64::max);
    let min_y = p.iter().map(|v| v[1]).fold(f64::INFINITY, f64::min);
    let max_y = p.iter().map(|v| v[1]).fold(f64::NEG_INFINITY, f64::max);
    let x0 = (min_x - 0.5).ceil().max(0.0) as i64;
    let x1 = ((max_x - 0.5).floor() as i64).min(w as i64 - 1);
    let y0 = (min_y - 0.5).ceil().max(0.0) as i64;
    let y1 = ((max_y - 0.5).floor() as i64).min(h as i64 - 1);
    if x0 > x1 || y0 > y1 {
        return;
    }
    // Edge i is opposite vertex i: from p[(i+1)%3] to p[(i+2)%3]. Each edge is evaluated from
    // its lexicographically smaller endpoint so that a shared edge yields exactly negated
    // values in both triangles (no gaps or double hits from rounding).
    let edge = |i: usize| {
        let a = p[(i + 1) % 3];
        let b = p[(i + 2) % 3];
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        // GL's top-left rule applies in y-up window space; in our y-down buffer that
        // includes left edges and *bottom* horizontal edges.
        let include = dy < 0.0 || (dy == 0.0 && dx < 0.0);
        let flip = (b[0], b[1]) < (a[0], a[1]);
        let (base, ddx, ddy) = if flip { (b, -dx, -dy) } else { (a, dx, dy) };
        (base, ddx, ddy, if flip { -1.0 } else { 1.0 }, include)
    };
    let edges = [edge(0), edge(1), edge(2)];
    'rows: for y in y0..=y1 {
        let cy = y as f64 + 0.5;
        let (mut row_x0, mut row_x1) = (x0, x1);
        // Direct testing is cheaper than span setup for short rows (e.g. glyph quads).
        if x1 - x0 >= 16 {
            // Each edge is monotone along a scanline. An intersection suggests its pixel
            // boundary, but only the original edge predicate can confirm it. Binary search
            // handles rounding/cancellation without changing coverage or shared-edge rules.
            for &(a, dx, dy, sign, include) in &edges {
                let value = |x: i64| sign * (dx * (cy - a[1]) - dy * (x as f64 + 0.5 - a[0]));
                let outside = |e: f64| e < 0.0 || (e == 0.0 && !include);
                let (left, right) = (value(row_x0), value(row_x1));
                // Non-finite edge intermediates need the original per-pixel behavior.
                if !left.is_finite() || !right.is_finite() {
                    continue;
                }
                let (left_out, right_out) = (outside(left), outside(right));
                if left_out == right_out {
                    if left_out {
                        continue 'rows;
                    }
                    continue;
                }
                let (mut lo, mut hi) = (row_x0, row_x1);
                let crossing = a[0] + dx * (cy - a[1]) / dy - 0.5;
                let hint = (if left_out { crossing.ceil() } else { crossing.floor() + 1.0 }) as i64;
                if hint > lo && hint <= hi && outside(value(hint - 1)) == left_out && outside(value(hint)) != left_out {
                    lo = hint - 1;
                    hi = hint;
                }
                while hi - lo > 1 {
                    let mid = lo + (hi - lo) / 2;
                    if outside(value(mid)) == left_out {
                        lo = mid;
                    } else {
                        hi = mid;
                    }
                }
                if left_out {
                    row_x0 = hi;
                } else {
                    row_x1 = lo;
                }
            }
        }
        for x in row_x0..=row_x1 {
            let cx = x as f64 + 0.5;
            let mut wts = [0.0; 3];
            let mut inside = true;
            for (i, (a, dx, dy, sign, include)) in edges.iter().enumerate() {
                let e = sign * (dx * (cy - a[1]) - dy * (cx - a[0]));
                if e < 0.0 || (e == 0.0 && !include) {
                    inside = false;
                    break;
                }
                wts[i] = e / area;
            }
            if inside {
                if flip {
                    wts.swap(1, 2);
                }
                f(x as usize, y as usize, wts);
            }
        }
    }
}

/// Rasterize a triangle with `N` varyings; `shade` returns the premultiplied fragment color.
pub fn triangle<const N: usize>(
    t: &mut Target,
    mask: Option<&Mask>,
    p: [[f64; 2]; 3],
    v: [[f32; N]; 3],
    shade: &mut impl FnMut(&[f32; N]) -> Option<Rgba>,
) {
    let (w, h) = (t.w, t.h);
    for_each_pixel(w, h, p, |x, y, b| {
        if mask.is_some_and(|m| !m.get(x, y)) {
            return;
        }
        let mut vary = [0f32; N];
        for (k, out) in vary.iter_mut().enumerate() {
            *out = (v[0][k] as f64 * b[0] + v[1][k] as f64 * b[1] + v[2][k] as f64 * b[2]) as f32;
        }
        if let Some(c) = shade(&vary) {
            t.blend(y * w + x, c);
        }
    });
}

/// Aliased 1px GL line (`gl.LINES`); `shade` gets the distance of the fragment center from
/// the line and the position along it (0 at `a`, 1 at `b`) for interpolating varyings.
pub fn line(t: &mut Target, accept: &dyn Fn(usize, usize) -> bool, a: [f64; 2], b: [f64; 2], shade: &mut impl FnMut(f64, f64) -> Option<Rgba>) {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    if dx == 0.0 && dy == 0.0 {
        return;
    }
    let x_major = dx.abs() >= dy.abs();
    let (major_a, major_b) = if x_major { (a[0], b[0]) } else { (a[1], b[1]) };
    let (lo, hi) = if major_a <= major_b { (major_a, major_b) } else { (major_b, major_a) };
    let start = (lo - 0.5).ceil() as i64;
    let end = (hi - 0.5).ceil() as i64; // exclusive: diamond-exit drops the last pixel
    for i in start..end {
        let c = i as f64 + 0.5;
        let t_param = (c - major_a) / (major_b - major_a);
        let minor = if x_major { a[1] + dy * t_param } else { a[0] + dx * t_param };
        let j = minor.floor() as i64;
        let (x, y) = if x_major { (i, j) } else { (j, i) };
        if x < 0 || y < 0 || x >= t.w as i64 || y >= t.h as i64 {
            continue;
        }
        let (x, y) = (x as usize, y as usize);
        if !accept(x, y) {
            continue;
        }
        let dist = (j as f64 + 0.5 - minor).abs();
        if let Some(col) = shade(dist, t_param) {
            t.blend(y * t.w + x, col);
        }
    }
}

/// Screen-space gradients (d/dx, d/dy) of linearly interpolated varyings over a triangle,
/// for emulating `fwidth`.
pub fn varying_gradients<const N: usize>(p: [[f64; 2]; 3], v: [[f32; N]; 3]) -> [[f32; N]; 2] {
    let (e1, e2) = ([p[1][0] - p[0][0], p[1][1] - p[0][1]], [p[2][0] - p[0][0], p[2][1] - p[0][1]]);
    let det = e1[0] * e2[1] - e1[1] * e2[0];
    let mut out = [[0f32; N]; 2];
    if det == 0.0 {
        return out;
    }
    for k in 0..N {
        let (d1, d2) = ((v[1][k] - v[0][k]) as f64, (v[2][k] - v[0][k]) as f64);
        out[0][k] = ((d1 * e2[1] - d2 * e1[1]) / det) as f32;
        out[1][k] = ((d2 * e1[0] - d1 * e2[0]) / det) as f32;
    }
    out
}

pub fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
    let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Brute-force oracle: test every pixel, with no scanline bounds or incremental edges.
    // Keep weights as bits so changing interpolation arithmetic cannot hide behind tolerances.
    fn reference_pixels(w: usize, h: usize, p: [[f64; 2]; 3]) -> Vec<Option<[u64; 3]>> {
        let mut out = vec![None; w * h];
        let area = (p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[1][1] - p[0][1]) * (p[2][0] - p[0][0]);
        if area == 0.0 || !area.is_finite() {
            return out;
        }
        let flip = area < 0.0;
        let p = if flip { [p[0], p[2], p[1]] } else { p };
        for y in 0..h {
            for x in 0..w {
                let center = [x as f64 + 0.5, y as f64 + 0.5];
                if (0..2).any(|k| center[k] < p.iter().map(|v| v[k]).fold(f64::INFINITY, f64::min)
                    || center[k] > p.iter().map(|v| v[k]).fold(f64::NEG_INFINITY, f64::max)) {
                    continue;
                }
                let mut weights = [0.0; 3];
                let mut inside = true;
                for i in 0..3 {
                    let (a, b) = (p[(i + 1) % 3], p[(i + 2) % 3]);
                    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
                    let include = dy < 0.0 || (dy == 0.0 && dx < 0.0);
                    let (base, dx, dy, sign) = if (b[0], b[1]) < (a[0], a[1]) { (b, -dx, -dy, -1.0) } else { (a, dx, dy, 1.0) };
                    let e = sign * (dx * (center[1] - base[1]) - dy * (center[0] - base[0]));
                    if e < 0.0 || (e == 0.0 && !include) {
                        inside = false;
                        break;
                    }
                    weights[i] = e / area.abs();
                }
                if inside {
                    if flip {
                        weights.swap(1, 2);
                    }
                    out[y * w + x] = Some(weights.map(f64::to_bits));
                }
            }
        }
        out
    }

    #[test]
    fn compact_masks_preserve_quad_coverage_and_subtracted_holes() {
        let (w, h) = (64, 32);
        let coverage = |q: [[f64; 2]; 4]| {
            let a = reference_pixels(w, h, [q[0], q[1], q[2]]);
            let b = reference_pixels(w, h, [q[0], q[2], q[3]]);
            a.iter().zip(b).map(|(a, b)| a.is_some() || b.is_some()).collect::<Vec<_>>()
        };
        let quads = [
            [[0.5, 0.5], [16.5, 0.5], [16.5, 16.5], [0.5, 16.5]],
            [[65.25, 33.75], [-5.5, 33.75], [-5.5, -5.5], [65.25, -5.5]],
            [[-10.2, 4.4], [40.3, -20.1], [80.9, 30.7], [25.7, 60.2]],
            [[20.5, -5.0], [20.5, -5.0], [20.5, 40.0], [20.5, 40.0]],
        ];
        for q in quads {
            let mask = Mask::from_quad(w, h, q);
            let expected = coverage(q);
            for y in 0..h {
                for x in 0..w {
                    assert_eq!(mask.get(x, y), expected[y * w + x], "quad {q:?}, {x},{y}");
                }
            }
        }
        let base = [[-1.0, -1.0], [65.0, -1.0], [65.0, 33.0], [-1.0, 33.0]];
        let holes = [
            [[16.5, 8.5], [48.5, 8.5], [48.5, 24.5], [16.5, 24.5]],
            quads[2],
        ];
        let mut mask = Mask::from_quad(w, h, base);
        let mut expected = coverage(base);
        for q in holes {
            mask.subtract(&Mask::from_quad(w, h, q));
            for (b, hole) in expected.iter_mut().zip(coverage(q)) {
                *b &= !hole;
            }
            for y in 0..h {
                for x in 0..w {
                    assert_eq!(mask.get(x, y), expected[y * w + x]);
                }
            }
        }
    }

    #[test]
    fn scanlines_preserve_coverage_and_weight_bits() {
        let (w, h) = (64, 32);
        let check = |p| {
            let mut actual = vec![None; w * h];
            for_each_pixel(w, h, p, |x, y, b| {
                assert!(actual[y * w + x].is_none());
                actual[y * w + x] = Some(b.map(f64::to_bits));
            });
            assert_eq!(actual, reference_pixels(w, h, p), "triangle {p:?}");
        };
        let triangles = [
            [[0.5, 0.5], [63.5, 31.5], [63.5, 31.50000000001]],
            [[-100.0, -100.0], [300.0, 32.5], [0.5, 32.5]],
            [[0.5, 0.5], [63.5, 0.5], [0.5, 31.5]],
            [[0.0, 0.0], [0.0, 32.0], [0.0, 16.0]],
            [[-1e150, -1e150], [1e150, 1e150], [1e150, -1e150]],
            [[0.0, 0.0], [1e200, 1e200], [0.0, 1e200]],
        ];
        for p in triangles {
            check(p);
            check([p[0], p[2], p[1]]);
        }
        // Deterministic fractional and half-pixel coordinates exercise clipped triangles,
        // both windings, thin slivers, horizontal edges, and exact boundary ties.
        let mut seed = 0x12345678u32;
        for i in 0..2000 {
            let p = std::array::from_fn(|_| std::array::from_fn(|_| {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                if i % 2 == 0 { (seed % 256) as f64 - 64.5 } else { seed as f64 / u32::MAX as f64 * 256.0 - 64.0 }
            }));
            check(p);
        }
    }

    #[test]
    fn shared_edge_no_overlap_no_gap() {
        // Two triangles sharing a diagonal must cover each pixel of the square exactly once.
        let (w, h) = (16, 16);
        let mut count = vec![0u8; w * h];
        let q = [[1.3, 2.1], [13.7, 1.9], [14.2, 12.6], [0.8, 13.3]];
        for tri in [[q[0], q[1], q[2]], [q[0], q[2], q[3]]] {
            for_each_pixel(w, h, tri, |x, y, _| count[y * w + x] += 1);
        }
        assert!(count.iter().all(|&c| c <= 1));
        assert!(count.iter().filter(|&&c| c == 1).count() > 100);
    }

    #[test]
    fn blend_over() {
        let mut t = Target::new(1, 1);
        t.blend(0, [0.5, 0.0, 0.0, 0.5]);
        assert_eq!(t.px[0], [128, 0, 0, 128]);
        assert_eq!(t.to_unpremultiplied(), vec![255, 0, 0, 128]);
    }
}
