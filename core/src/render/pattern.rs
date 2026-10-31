//! Image patterns (`*-pattern`): MapLibre's `get_pattern_pos` and pattern texture lookups.

use super::{Ctx, EXTENT};
use crate::expression::Value;
use crate::image::Filter;
use crate::sprite::StyleImage;
use crate::tile::RenderTile;

/// GLSL `mod`.
fn gmod(x: f32, y: f32) -> f32 {
    x - y * (x / y).floor()
}

/// Name of the image a pattern property evaluated to.
pub fn image_name(v: &Value) -> Option<String> {
    match v {
        Value::ResolvedImage(i) => Some(i.name.clone()),
        Value::String(s) if !s.is_empty() => Some(s.to_string()),
        _ => None,
    }
}

/// Per-tile pattern uniforms (`patternUniformValues`).
pub struct TilePattern {
    /// Pixels per tile unit at the integer tile zoom (`u_scale.x` / `u_tile_units_to_pixels`).
    pub tile_ratio: f64,
    pixel_upper: [f32; 2],
    pixel_lower: [f32; 2],
}

impl TilePattern {
    pub fn new(ctx: &Ctx, tile: &RenderTile) -> TilePattern {
        let tile_zoom = ctx.transform.zoom.floor().max(0.0);
        let size_at_nearest = 512.0 * 2f64.powf(tile_zoom - tile.canonical.z as f64);
        let num_tiles = (1u64 << tile.overscaled_z) as f64;
        let px = size_at_nearest * (tile.canonical.x as f64 + tile.wrap as f64 * num_tiles);
        let py = size_at_nearest * tile.canonical.y as f64;
        // Split like the shader uniforms: `x >> 16` and `x & 0xFFFF` on int32.
        let split = |v: f64| {
            let i = v as i64 as i32;
            ((i >> 16) as f32, (i & 0xFFFF) as f32)
        };
        let ((ux, lx), (uy, ly)) = (split(px), split(py));
        TilePattern { tile_ratio: size_at_nearest / EXTENT, pixel_upper: [ux, uy], pixel_lower: [lx, ly] }
    }

    /// `get_pattern_pos` for a vertex at tile position `pos` and pattern display size `size`.
    pub fn pattern_pos(&self, size: [f32; 2], pos: [f64; 2]) -> [f32; 2] {
        std::array::from_fn(|i| {
            let offset = gmod(gmod(gmod(self.pixel_upper[i], size[i]) * 256.0, size[i]) * 256.0 + self.pixel_lower[i], size[i]);
            ((self.tile_ratio as f32) * pos[i] as f32 + offset) / size[i]
        })
    }
}

pub fn display_size(img: &StyleImage) -> [f32; 2] {
    [(img.image.w as f64 / img.pixel_ratio) as f32, (img.image.h as f64 / img.pixel_ratio) as f32]
}

/// `texture(u_image, mix(tl / texsize, br / texsize, mod(v_pos, 1)))` on the padded image.
pub fn sample_fill(img: &StyleImage, v_pos: [f32; 2]) -> [f32; 4] {
    let (pw, ph) = img.pattern.size();
    let (w, h) = (img.image.w as f32, img.image.h as f32);
    let u = (1.0 + gmod(v_pos[0], 1.0) * w) / pw as f32;
    let v = (1.0 + gmod(v_pos[1], 1.0) * h) / ph as f32;
    img.pattern.sample(u, v, Filter::Linear, Filter::Linear, 0.0)
}

/// The line pattern lookup spans the padding: normalized `(x, y)` over the padded image.
pub fn sample_line(img: &StyleImage, x: f32, y: f32) -> [f32; 4] {
    img.pattern.sample(x, y, Filter::Linear, Filter::Linear, 0.0)
}
