//! Sans-IO MapLibre style renderer (2D, tile-based). See CLAUDE.md for scope and constraints.
//!
//! Host loop: `new` → while `needs()` is non-empty { fetch each; `provide` } → `render`.
//! Minimal use: `Renderer::new(style, View::tile(z, x, y, 512))` → one XYZ tile image.

pub mod expression;
pub(crate) mod geojson;
mod image;
mod sprite;
mod mvt;
mod render;
mod style;
mod tile;

use serde_json::Value as J;
use std::collections::{BTreeSet, HashMap};
use std::rc::Rc;
use tile::{RenderTile, TileId, Transform};

#[derive(Debug)]
pub enum Error {
    Style(String),
    /// `render` called while `needs()` is non-empty.
    NotReady,
    Unsupported(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Style(m) => write!(f, "style error: {m}"),
            Error::NotReady => write!(f, "render called with outstanding needs()"),
            Error::Unsupported(m) => write!(f, "unsupported: {m}"),
        }
    }
}

/// A resource the host must fetch and hand back via [`Renderer::provide`].
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Resource {
    /// URL as written in the style (or derived from it, e.g. a tile URL from a template).
    pub url: String,
}

/// What to render: a Web Mercator camera plus output size.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct View {
    /// `[lng, lat]` in degrees.
    pub center: [f64; 2],
    /// MapLibre zoom (world is `512 * 2^zoom` CSS pixels wide).
    pub zoom: f64,
    /// Degrees, clockwise.
    pub bearing: f64,
    /// CSS pixels; the output is `round(width*pixel_ratio)` × `round(height*pixel_ratio)`.
    pub width: u32,
    pub height: u32,
    pub pixel_ratio: f64,
}

impl View {
    /// The XYZ tile `z/x/y` rendered as a `tile_size`-pixel square image.
    pub fn tile(z: u8, x: u32, y: u32, tile_size: u32) -> Self {
        let n = (1u64 << z) as f64;
        let lng = (x as f64 + 0.5) / n * 360.0 - 180.0;
        let lat = (std::f64::consts::PI * (1.0 - 2.0 * (y as f64 + 0.5) / n)).sinh().atan().to_degrees();
        Self {
            center: [lng, lat],
            zoom: z as f64 + (tile_size as f64 / 512.0).log2(),
            bearing: 0.0,
            width: tile_size,
            height: tile_size,
            pixel_ratio: 1.0,
        }
    }
}

struct TileJson {
    tiles: Vec<String>,
    minzoom: u8,
    maxzoom: u8,
    tms: bool,
    bounds: Option<[f64; 4]>,
}

enum Data {
    /// Waiting for a TileJSON / GeoJSON document at this URL.
    Pending(String),
    Failed,
    Tiled(TileJson),
    GeoJson(geojson::GeoJsonIndex),
    /// Image source: URL, corner coordinates (tl, tr, br, bl) and the decoded image.
    Image { url: String, coordinates: [[f64; 2]; 4], texture: Option<Option<Rc<image::Texture>>> },
}

#[derive(Clone)]
enum TileData {
    Vector(Rc<Vec<mvt::Layer>>),
    Raster(Rc<image::Texture>),
}

struct Source {
    ty: String,
    json: J,
    data: Data,
    /// Decoded tiles; `None` when the host could not fetch (or decode) it.
    tiles: HashMap<TileId, Option<TileData>>,
}

const ZOOM_LEVELS_TO_OVERSCALE: u8 = 4;

pub struct Renderer {
    style: style::Style,
    transform: Transform,
    sources: HashMap<String, Source>,
    sprites: sprite::Sprites,
    view: View,
    /// MapLibre map option `maxZoom` (default 22).
    max_zoom: f64,
}

fn tilejson_from(json: &J, overrides: &J) -> TileJson {
    let get = |k: &str| overrides.get(k).filter(|v| !v.is_null()).or_else(|| json.get(k));
    TileJson {
        tiles: get("tiles").and_then(J::as_array).map(|a| a.iter().filter_map(|t| t.as_str().map(String::from)).collect()).unwrap_or_default(),
        minzoom: get("minzoom").and_then(J::as_f64).unwrap_or(0.0) as u8,
        maxzoom: get("maxzoom").and_then(J::as_f64).unwrap_or(22.0) as u8,
        tms: get("scheme").and_then(J::as_str) == Some("tms"),
        bounds: get("bounds").and_then(J::as_array).and_then(|b| Some([b.first()?.as_f64()?, b.get(1)?.as_f64()?, b.get(2)?.as_f64()?, b.get(3)?.as_f64()?])),
    }
}

fn geojson_index(data: &J, src: &J) -> geojson::GeoJsonIndex {
    let scale = geojson::EXTENT / 512.0;
    geojson::GeoJsonIndex::new(
        data,
        geojson::Options {
            maxzoom: src["maxzoom"].as_f64().unwrap_or(18.0) as u8,
            buffer: src["buffer"].as_f64().unwrap_or(128.0) * scale,
            tolerance: src["tolerance"].as_f64().unwrap_or(0.375) * scale,
            generate_id: src["generateId"].as_bool().unwrap_or(false),
            promote_id: src["promoteId"].as_str().map(String::from),
            line_metrics: src["lineMetrics"].as_bool().unwrap_or(false),
        },
    )
}

/// `getCoordinatesCenterTileID`: the tile an image source is drawn in, and its corners in
/// that tile's units (rounded, like MapLibre).
fn image_tile(coordinates: &[[f64; 2]; 4]) -> (TileId, [[f64; 2]; 4]) {
    let m = coordinates.map(|c| [tile::mercator_x(c[0]), tile::mercator_y(c[1])]);
    let (min_x, max_x) = (m.iter().map(|p| p[0]).fold(f64::INFINITY, f64::min), m.iter().map(|p| p[0]).fold(f64::NEG_INFINITY, f64::max));
    let (min_y, max_y) = (m.iter().map(|p| p[1]).fold(f64::INFINITY, f64::min), m.iter().map(|p| p[1]).fold(f64::NEG_INFINITY, f64::max));
    let d = (max_x - min_x).max(max_y - min_y);
    let z = (-d.ln() / std::f64::consts::LN_2).floor().max(0.0) as u8;
    let n = (1u64 << z) as f64;
    let id = TileId { z, x: ((min_x + max_x) / 2.0 * n).floor() as u32, y: ((min_y + max_y) / 2.0 * n).floor() as u32 };
    let round = expression::value::js_round;
    let corners = m.map(|p| [round((p[0] * n - id.x as f64) * render::EXTENT), round((p[1] * n - id.y as f64) * render::EXTENT)]);
    (id, corners)
}

/// The image warp for the corners (`calculateImageWarp` with warp 'auto').
fn image_warp(c: &[[f64; 2]; 4]) -> [f64; 3] {
    let [tl, tr, br, bl] = *c;
    if tl[0] + br[0] == tr[0] + bl[0] && tl[1] + br[1] == tr[1] + bl[1] {
        return [0.0, 0.0, 1.0];
    }
    let sum = [tl[0] - tr[0] + br[0] - bl[0], tl[1] - tr[1] + br[1] - bl[1]];
    let (rx, ry, dx, dy) = (tr[0] - br[0], tr[1] - br[1], bl[0] - br[0], bl[1] - br[1]);
    let det = rx * dy - dx * ry;
    let px = (sum[0] * dy - dx * sum[1]) / det;
    let py = (rx * sum[1] - sum[0] * ry) / det;
    let dens = [1.0, 1.0 + px, 1.0 + px + py, 1.0 + py];
    let fore = dens.iter().cloned().fold(f64::NEG_INFINITY, f64::max) / dens.iter().cloned().fold(f64::INFINITY, f64::min);
    let blend = ((1.0 - 4.0 / fore) / (1.0 - 4.0 / 512.0)).max(0.0);
    if !(1.0..=512.0).contains(&fore) || blend >= 1.0 {
        return [0.0, 0.0, 1.0];
    }
    [px, py, blend]
}

impl Renderer {
    /// The style's own `center`/`zoom`/`bearing` are ignored; `view` decides the camera.
    pub fn new(style_json: &str, view: View) -> Result<Self, Error> {
        let json: J = serde_json::from_str(style_json).map_err(|e| Error::Style(e.to_string()))?;
        let mut sources = HashMap::new();
        for (id, src) in json["sources"].as_object().into_iter().flatten() {
            let ty = src["type"].as_str().unwrap_or("").to_string();
            let data = match ty.as_str() {
                "vector" | "raster" => match src["url"].as_str() {
                    Some(url) if src.get("tiles").is_none() => Data::Pending(url.to_string()),
                    _ => Data::Tiled(tilejson_from(src, &J::Null)),
                },
                "geojson" => match &src["data"] {
                    J::String(url) => Data::Pending(url.clone()),
                    data => Data::GeoJson(geojson_index(data, src)),
                },
                "image" => {
                    let c = |i: usize| [src["coordinates"][i][0].as_f64().unwrap_or(0.0), src["coordinates"][i][1].as_f64().unwrap_or(0.0)];
                    Data::Image { url: src["url"].as_str().unwrap_or("").to_string(), coordinates: [c(0), c(1), c(2), c(3)], texture: None }
                }
                _ => Data::Failed,
            };
            sources.insert(id.clone(), Source { ty, json: src.clone(), data, tiles: HashMap::new() });
        }
        let sprites = sprite::Sprites::new(&json["sprite"], view.pixel_ratio);
        let mut r = Self {
            style: style::Style::parse(json),
            transform: Transform::new([0.0; 2], 0.0, 0.0, 1.0, 1.0, 1.0),
            sources,
            sprites,
            view,
            max_zoom: 22.0,
        };
        r.set_max_zoom(22.0);
        Ok(r)
    }

    /// MapLibre's `maxZoom` map option: clamps the camera zoom and bounds tile slicing.
    pub fn set_max_zoom(&mut self, max_zoom: f64) {
        self.max_zoom = max_zoom;
        let v = self.view;
        let zoom = v.zoom.clamp(-2.0, max_zoom);
        self.transform = Transform::new(v.center, zoom, v.bearing, v.width as f64, v.height as f64, v.pixel_ratio);
    }

    /// Sources referenced by layers visible at the current zoom.
    fn used_sources(&self) -> BTreeSet<&str> {
        self.style
            .layers
            .iter()
            .filter(|l| !l.is_hidden(self.transform.zoom, &self.style.global_state))
            .filter_map(|l| l.source.as_deref())
            .collect()
    }

    /// Ideal tiles of a tiled source for the current view (MapLibre `coveringTiles`).
    fn covering(&self, src: &Source) -> Vec<RenderTile> {
        let (tile_size, minzoom, maxzoom, bounds) = match &src.data {
            Data::Tiled(tj) => (src.json["tileSize"].as_f64().unwrap_or(512.0), tj.minzoom, tj.maxzoom, tj.bounds),
            Data::GeoJson(g) => (512.0, 0, g.maxzoom(), None),
            _ => return vec![],
        };
        let z = self.transform.covering_zoom(tile_size, src.ty == "raster");
        if z < minzoom as i32 {
            return vec![];
        }
        // MapLibre's default `zoomLevelsToOverscale` (4) below the map maxZoom (22): vector
        // tiles up to that zoom are sliced out of the source's maxzoom tile.
        let maxzoom = if src.ty == "vector" { maxzoom.max((self.max_zoom as i32 - ZOOM_LEVELS_TO_OVERSCALE as i32).max(0) as u8) } else { maxzoom };
        let mut out = BTreeSet::new();
        for (x, y, wrap) in self.transform.covering_tiles(z) {
            let id = TileId { z: z as u8, x: x as u32, y: y as u32 };
            let canonical = if z > maxzoom as i32 { id.parent_at(maxzoom) } else { id };
            if let Some(b) = bounds {
                let n = (1u64 << canonical.z) as f64;
                let (x0, x1) = (canonical.x as f64 / n, (canonical.x + 1) as f64 / n);
                let (y0, y1) = (canonical.y as f64 / n, (canonical.y + 1) as f64 / n);
                let (bx0, bx1) = (tile::mercator_x(b[0]), tile::mercator_x(b[2]));
                let (by0, by1) = (tile::mercator_y(b[3].min(tile::MAX_LAT)), tile::mercator_y(b[1].max(-tile::MAX_LAT)));
                if x1 <= bx0 || x0 >= bx1 || y1 <= by0 || y0 >= by1 {
                    continue;
                }
            }
            out.insert(RenderTile { overscaled_z: z as u8, wrap, canonical });
        }
        out.into_iter().collect()
    }

    /// The tile actually fetched for `id`: its ancestor at the source maxzoom when sliced.
    fn data_tile(tj: &TileJson, id: TileId) -> TileId {
        if id.z > tj.maxzoom { id.parent_at(tj.maxzoom) } else { id }
    }

    /// Tiles to draw: each ideal tile, or for one that failed to load, its nearest loaded
    /// ancestor (MapLibre retains parents for missing tiles). Also returns tiles still to fetch.
    fn resolve(&self, src: &Source) -> (Vec<(RenderTile, TileId)>, BTreeSet<TileId>) {
        let mut draw = BTreeSet::new();
        let mut fetch = BTreeSet::new();
        let Data::Tiled(tj) = &src.data else {
            return (self.covering(src).into_iter().map(|t| (t, t.canonical)).collect(), fetch);
        };
        // `TileManager.maxUnderzooming`: parents are only sought this far below the ideal zoom.
        let covering = self.covering(src);
        let min_z = covering.first().map_or(0, |t| (t.overscaled_z as i32 - 10).max(tj.minzoom as i32)) as u8;
        for t in covering {
            let mut id = Self::data_tile(tj, t.canonical);
            loop {
                match src.tiles.get(&id) {
                    None => {
                        fetch.insert(id);
                        break;
                    }
                    Some(Some(_)) => {
                        let canonical = if id == Self::data_tile(tj, t.canonical) { t.canonical } else { id };
                        let overscaled_z = if canonical == t.canonical { t.overscaled_z } else { canonical.z };
                        draw.insert((RenderTile { overscaled_z, wrap: t.wrap, canonical }, id));
                        break;
                    }
                    Some(None) if id.z > min_z => id = id.parent_at(id.z - 1),
                    Some(None) => break,
                }
            }
        }
        (draw.into_iter().collect(), fetch)
    }

    /// Resources still required before `render` can run. May grow after `provide`
    /// (tiles → glyph ranges → ...), so call it again after every round of `provide`.
    pub fn needs(&self) -> Vec<Resource> {
        let mut out: BTreeSet<String> = self.sprites.needs().into_iter().collect();
        for id in self.used_sources() {
            let Some(src) = self.sources.get(id) else { continue };
            match &src.data {
                Data::Pending(url) => {
                    out.insert(url.clone());
                }
                Data::Tiled(tj) if !tj.tiles.is_empty() => {
                    for id in self.resolve(src).1 {
                        out.insert(tile::tile_url(&tj.tiles, id, tj.tms));
                    }
                }
                Data::Image { url, texture: None, .. } => {
                    out.insert(url.clone());
                }
                _ => {}
            }
        }
        out.into_iter().map(|url| Resource { url }).collect()
    }

    /// Hand over fetched bytes for `url`. `None` means the host could not fetch it
    /// (e.g. 404): a vector tile is then empty, a raster tile is replaced by an ancestor.
    pub fn provide(&mut self, url: &str, bytes: Option<&[u8]>) {
        self.sprites.provide(url, bytes);
        let wanted: Vec<(String, BTreeSet<TileId>)> = self.sources.iter().map(|(id, s)| (id.clone(), self.resolve(s).1)).collect();
        for (id, fetch) in wanted {
            let src = self.sources.get_mut(&id).unwrap();
            match &mut src.data {
                Data::Pending(u) if u == url => {
                    let doc = bytes.and_then(|b| serde_json::from_slice::<J>(b).ok());
                    src.data = match (doc, src.ty.as_str()) {
                        (Some(doc), "geojson") => Data::GeoJson(geojson_index(&doc, &src.json)),
                        (Some(doc), _) => Data::Tiled(tilejson_from(&doc, &src.json)),
                        (None, _) => Data::Failed,
                    };
                }
                Data::Tiled(tj) => {
                    for t in fetch {
                        if tile::tile_url(&tj.tiles, t, tj.tms) == url {
                            // Like MapLibre: a missing vector tile is just empty; a missing raster
                            // tile lets a parent show through, while an empty raster response
                            // (HTTP 204) is a transparent tile.
                            let decoded = match (src.ty.as_str(), bytes) {
                                ("raster", Some([])) => Some(image::Image { w: 1, h: 1, data: vec![0; 4] }),
                                ("raster", Some(b)) => image::Image::decode(b),
                                _ => None,
                            }
                            .map(|i| TileData::Raster(Rc::new(image::Texture::new(&i, true))))
                            .or_else(|| match src.ty.as_str() {
                                "raster" => None,
                                _ => Some(TileData::Vector(Rc::new(bytes.and_then(mvt::decode).unwrap_or_default()))),
                            });
                            src.tiles.insert(t, decoded);
                        }
                    }
                }
                Data::Image { url: u, texture, .. } if u == url && texture.is_none() => {
                    // Image sources are uploaded without mipmaps.
                    *texture = Some(bytes.and_then(image::Image::decode).map(|i| Rc::new(image::Texture::new(&i, false))));
                }
                _ => {}
            }
        }
    }

    /// Clip masks for tiles that may overlap (fallback parents): a tile owns the pixels of its
    /// quad not covered by a higher-zoom tile in the set.
    fn masks(&self, ctx: &render::Ctx, tiles: &[RenderTile], w: usize, h: usize) -> Vec<render::raster::Mask> {
        let quads: Vec<render::raster::Mask> = tiles.iter().map(|t| ctx.tile_mask(t, w, h)).collect();
        tiles
            .iter()
            .enumerate()
            .map(|(i, t)| {
                let mut m = render::raster::Mask { w, bits: quads[i].bits.clone() };
                for (j, u) in tiles.iter().enumerate() {
                    if u.canonical.z > t.canonical.z && u.wrap == t.wrap && u.canonical.parent_at(t.canonical.z) == t.canonical {
                        for (b, &o) in m.bits.iter_mut().zip(&quads[j].bits) {
                            *b = *b && !o;
                        }
                    }
                }
                m
            })
            .collect()
    }

    /// Non-premultiplied RGBA8, row-major.
    pub fn render(&mut self) -> Result<Vec<u8>, Error> {
        if !self.needs().is_empty() {
            return Err(Error::NotReady);
        }
        let t = &self.transform;
        let (w, h) = ((t.width * t.pixel_ratio).round() as usize, (t.height * t.pixel_ratio).round() as usize);
        let mut target = render::raster::Target::new(w, h);
        let ctx = render::Ctx { transform: t, global_state: &self.style.global_state, images: &self.sprites.images };
        let empty = mvt::Layer { name: String::new(), extent: 4096, features: vec![] };
        for layer in &self.style.layers {
            if layer.is_hidden(t.zoom, &self.style.global_state) {
                continue;
            }
            let raw = self.style.layer_json(&layer.id);
            if layer.ty == "background" {
                render::draw_background(&mut target, layer, &ctx, raw);
                continue;
            }
            if !matches!(layer.ty.as_str(), "fill" | "line" | "circle" | "raster") {
                continue;
            }
            let Some(src) = layer.source.as_deref().and_then(|s| self.sources.get(s)) else { continue };
            if layer.ty == "raster" {
                self.draw_raster(&mut target, layer, &ctx, src, w, h);
                continue;
            }
            let resolved = self.resolve(src).0;
            let render_tiles: Vec<RenderTile> = resolved.iter().map(|r| r.0).collect();
            let masks = self.masks(&ctx, &render_tiles, w, h);
            let mut layers_by_tile = Vec::new();
            for (rt, data_id) in &resolved {
                let tile_layer = match &src.data {
                    Data::GeoJson(g) => Some(Rc::new(vec![g.tile(rt.canonical.z, rt.canonical.x, rt.canonical.y)])),
                    Data::Tiled(_) => match src.tiles.get(data_id).cloned().flatten() {
                        Some(TileData::Vector(ls)) if *data_id == rt.canonical => Some(ls),
                        Some(TileData::Vector(ls)) => Some(Rc::new(ls.iter().map(|l| mvt::slice_layer(l, *data_id, rt.canonical)).collect())),
                        _ => None,
                    },
                    _ => None,
                };
                layers_by_tile.push((*rt, tile_layer));
            }
            let tiles: Vec<render::TileFeatures> = layers_by_tile
                .iter()
                .zip(&masks)
                .map(|((rt, tl), mask)| {
                    let l = tl.as_ref().and_then(|ls| match &src.data {
                        Data::GeoJson(_) => ls.first(),
                        _ => ls.iter().find(|l| Some(l.name.as_str()) == layer.source_layer.as_deref()),
                    });
                    render::TileFeatures { tile: *rt, mask, layer: l.unwrap_or(&empty) }
                })
                .collect();
            // `*-layer-opacity`: the layer is drawn offscreen, then composited.
            let layer_opacity = layer.paint.get(&format!("{}-layer-opacity", layer.ty)).map(|p| {
                render::num(&p.eval(t.zoom, None, None, &self.style.global_state))
            });
            if layer_opacity == Some(0.0) {
                continue;
            }
            let mut offscreen = layer_opacity.filter(|o| *o < 1.0).map(|_| render::raster::Target::new(w, h));
            let dest = offscreen.as_mut().unwrap_or(&mut target);
            match layer.ty.as_str() {
                "fill" => render::draw_fill(dest, layer, &ctx, &tiles, raw),
                "line" => {
                    let source_maxzoom = match &src.data {
                        Data::Tiled(tj) => tj.maxzoom,
                        Data::GeoJson(g) => g.maxzoom(),
                        _ => 22,
                    };
                    let has_gradient = raw["paint"].get("line-gradient").is_some();
                    let has_pattern = raw["paint"].get("line-pattern").is_some();
                    render::draw_line(dest, layer, &ctx, &tiles, source_maxzoom, self.max_zoom, has_gradient, has_pattern)
                }
                "circle" => render::draw_circle(dest, layer, &ctx, &tiles),
                _ => {}
            }
            if let (Some(off), Some(o)) = (offscreen, layer_opacity) {
                for (i, p) in off.px.iter().enumerate() {
                    if p[3] != 0 || p[0] != 0 || p[1] != 0 || p[2] != 0 {
                        target.blend(i, p.map(|c| c as f32 / 255.0 * o as f32));
                    }
                }
            }
        }
        Ok(target.to_unpremultiplied())
    }

    fn draw_raster(&self, target: &mut render::raster::Target, layer: &style::Layer, ctx: &render::Ctx, src: &Source, w: usize, h: usize) {
        use render::raster_layer::{draw_quad, Quad, RasterParams};
        let params = RasterParams::new(layer, ctx);
        if let Data::Image { coordinates, texture: Some(Some(tex)), .. } = &src.data {
            let (id, corners) = image_tile(coordinates);
            let warp = image_warp(&corners);
            let parallelogram = warp == [0.0, 0.0, 1.0] && {
                let [tl, tr, br, bl] = corners;
                tl[0] + br[0] == tr[0] + bl[0] && tl[1] + br[1] == tr[1] + bl[1]
            };
            // World copies of the image tile that may be visible.
            let corners_world = [[0.0, 0.0], [w as f64, 0.0], [0.0, h as f64], [w as f64, h as f64]].map(|p| ctx.transform.screen_to_world(p));
            let ws = ctx.transform.world_size;
            let (x0, x1) = corners_world.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(a, b), p| (a.min(p[0]), b.max(p[0])));
            for wrap in (x0 / ws).floor() as i32 - 1..=(x1 / ws).floor() as i32 + 1 {
                let tile = RenderTile { overscaled_z: id.z, wrap, canonical: id };
                let q = Quad { tile, corners, warp, subdivided: warp[2] > 0.0 && !parallelogram };
                draw_quad(target, ctx, &q, tex, &params, None);
            }
            return;
        }
        let resolved = self.resolve(src).0;
        let tiles: Vec<RenderTile> = resolved.iter().map(|r| r.0).collect();
        // Same-zoom tiles abut and are drawn without stencil; mixed zooms (fallback parents) are
        // clipped so that the higher zoom wins.
        let mixed = tiles.iter().any(|t| t.canonical.z != tiles[0].canonical.z);
        let masks = if mixed { Some(self.masks(ctx, &tiles, w, h)) } else { None };
        for (i, (rt, data_id)) in resolved.iter().enumerate() {
            if let Some(Some(TileData::Raster(tex))) = src.tiles.get(data_id) {
                draw_quad(target, ctx, &Quad::tile(*rt), tex, &params, masks.as_ref().map(|m| &m[i]));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tile_view() {
        let v = View::tile(0, 0, 0, 512);
        assert_eq!((v.center, v.zoom), ([0.0, 0.0], 0.0));
        // 256px tiles sit one zoom level below 512px ones.
        let v = View::tile(1, 1, 0, 256);
        assert_eq!(v.zoom, 0.0);
        assert_eq!(v.center[0], 90.0);
        assert!((v.center[1] - 66.51326).abs() < 1e-5);
    }

    #[test]
    fn background_only() {
        let style = r##"{"version":8,"sources":{},"layers":[{"id":"bg","type":"background","paint":{"background-color":"#ff0000"}}]}"##;
        let mut r = Renderer::new(style, View { center: [0.0, 0.0], zoom: 0.0, bearing: 0.0, width: 4, height: 4, pixel_ratio: 1.0 }).unwrap();
        assert!(r.needs().is_empty());
        let px = r.render().unwrap();
        assert_eq!(&px[..4], &[255, 0, 0, 255]);
    }
}
