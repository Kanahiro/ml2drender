//! Sans-IO MapLibre style renderer (2D, tile-based). See CLAUDE.md for scope and constraints.
//!
//! Host loop: `new` → while `needs()` is non-empty { fetch each; `provide` } → `render`.
//! Minimal use: `Renderer::new(style, View::tile(z, x, y, 512))` → one XYZ tile image.

mod hash;
pub mod expression;
pub(crate) mod geojson;
mod image;
mod sprite;
mod mvt;
mod render;
mod style;
mod supercluster;
mod symbol;
mod tile;

use serde_json::Value as J;
use hash::HashMap;
use std::collections::BTreeSet;
use std::rc::Rc;
use tile::{RenderTile, TileId, Transform};

#[derive(Debug)]
pub enum Error {
    Style(String),
    ImageEncoding(String),
    /// `render` called while `needs()` is non-empty.
    NotReady,
    Unsupported(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Style(m) => write!(f, "style error: {m}"),
            Error::ImageEncoding(m) => write!(f, "image encoding error: {m}"),
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
    /// CSS pixels rendered around the view before cropping to the requested output size.
    pub margin: u32,
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
            margin: 0,
        }
    }
}

struct TileJson {
    tiles: Vec<String>,
    minzoom: u8,
    maxzoom: u8,
    tms: bool,
    bounds: Option<[f64; 4]>,
    tile_size: f64,
    /// raster-dem `encoding`.
    encoding: Option<String>,
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
    Dem(Rc<render::dem::Dem>),
}

struct Source {
    ty: String,
    json: J,
    data: Data,
    /// Decoded tiles; `None` when the host could not fetch (or decode) it.
    tiles: HashMap<TileId, Option<TileData>>,
    /// GeoJSON tiles and overzoom slices shared by glyph discovery and all style layers.
    /// Include the data tile so fallback parents cannot share the wrong slice.
    vector_layers: std::cell::RefCell<HashMap<(TileId, TileId), Rc<Vec<mvt::Layer>>>>,
    /// Layer buckets by (data tile, canonical tile, overscaled zoom), kept across views.
    buckets: std::cell::RefCell<HashMap<(TileId, TileId, u8), Rc<render::TileBuckets>>>,
    /// When each data tile (GeoJSON: canonical tile) was last needed, in `Renderer::clock` ticks.
    last_used: std::cell::RefCell<HashMap<TileId, u64>>,
}

const ZOOM_LEVELS_TO_OVERSCALE: u8 = 4;
// ponytail: a tile count, not bytes. Dense low-zoom tiles cost far more; bound by size if
// memory becomes the constraint.
const MAX_CACHED_TILES: usize = 8;

/// Lossless PNG of row-major RGBA8 pixels, e.g. the output of [`Renderer::render`].
pub fn encode_png(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, Error> {
    let mut bytes = Vec::new();
    let mut encode = || -> Result<(), png::EncodingError> {
        let mut encoder = png::Encoder::new(&mut bytes, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        // Encoding is on the request's CPU budget; favor speed over minimum file size.
        encoder.set_compression(png::Compression::Fast);
        let mut writer = encoder.write_header()?;
        writer.write_image_data(rgba)?;
        writer.finish()
    };
    encode().map_err(|e| Error::ImageEncoding(e.to_string()))?;
    Ok(bytes)
}

/// Lossless WebP of row-major RGBA8 pixels, e.g. the output of [`Renderer::render`].
pub fn encode_webp(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, Error> {
    // The encoder panics (a WASM trap) on a size mismatch instead of returning an error.
    if rgba.len() as u64 != width as u64 * height as u64 * 4 {
        return Err(Error::ImageEncoding(format!("{} bytes is not {width}x{height} RGBA", rgba.len())));
    }
    let mut bytes = Vec::new();
    image_webp::WebPEncoder::new(&mut bytes)
        .encode(rgba, width, height, image_webp::ColorType::Rgba8)
        .map_err(|e| Error::ImageEncoding(e.to_string()))?;
    Ok(bytes)
}

pub struct Renderer {
    style: style::Style,
    transform: Transform,
    sources: HashMap<String, Source>,
    sprites: sprite::Sprites,
    /// The style's `sprite`, to pick the sheet again when the pixel ratio changes.
    sprite: J,
    glyphs: symbol::glyphs::Glyphs,
    /// Glyph range URLs last returned by `needs()`, so `provide()` need not re-evaluate text.
    glyph_urls: std::cell::RefCell<HashMap<String, (String, u32)>>,
    /// Text dependencies depend on source data and camera, not on downloaded glyphs.
    glyph_dependencies: std::cell::RefCell<Option<BTreeSet<(String, u32)>>>,
    /// Tile URLs returned by `needs()` and not yet provided, with the (source, tile) they fill.
    /// `provide` matches against these, so a view change in between does not lose them.
    requested: std::cell::RefCell<HashMap<String, Vec<(String, TileId)>>>,
    /// Advances with every view change; orders tiles for eviction.
    clock: u64,
    view: View,
    /// MapLibre map option `maxZoom` (default 22).
    max_zoom: f64,
    /// MapLibre map option `crossSourceCollisions` (default true).
    cross_source_collisions: bool,
}

fn tilejson_from(json: &J, overrides: &J) -> TileJson {
    let get = |k: &str| overrides.get(k).filter(|v| !v.is_null()).or_else(|| json.get(k));
    TileJson {
        tiles: get("tiles").and_then(J::as_array).map(|a| a.iter().filter_map(|t| t.as_str().map(String::from)).collect()).unwrap_or_default(),
        minzoom: get("minzoom").and_then(J::as_f64).unwrap_or(0.0) as u8,
        maxzoom: get("maxzoom").and_then(J::as_f64).unwrap_or(22.0) as u8,
        tms: get("scheme").and_then(J::as_str) == Some("tms"),
        bounds: get("bounds").and_then(J::as_array).and_then(|b| Some([b.first()?.as_f64()?, b.get(1)?.as_f64()?, b.get(2)?.as_f64()?, b.get(3)?.as_f64()?])),
        // Like MapLibre's `loadTileJSON`, `tileSize` and `encoding` may come from the TileJSON
        // too (the style's source options win).
        tile_size: get("tileSize").and_then(J::as_f64).unwrap_or(512.0),
        encoding: get("encoding").and_then(J::as_str).map(String::from),
    }
}

/// `clusterProperties`: `{name: [reduce operator or expression, map expression]}`.
fn cluster_properties(props: &J) -> supercluster::ClusterProperties {
    let mut out = Vec::new();
    for (key, v) in props.as_object().into_iter().flatten() {
        let (Some(op), Some(map)) = (v.get(0), v.get(1)) else { continue };
        let reduce = match op {
            J::String(op) => serde_json::json!([op, ["accumulated"], ["get", key]]),
            e => e.clone(),
        };
        let parse = |e: &J| expression::create_expression(e, &J::Null, None).ok();
        if let (Some(m), Some(r)) = (parse(map), parse(&reduce)) {
            out.push((key.as_str().into(), m, r));
        }
    }
    out
}

/// The source `filter`: features of a FeatureCollection are kept where it evaluates to true
/// (at zoom 0, against the GeoJSON properties and id).
fn filter_geojson(data: &J, filter: &J) -> Option<J> {
    if data["type"] != "FeatureCollection" || !(filter.is_boolean() || filter.as_array().is_some_and(|a| !a.is_empty())) {
        return None;
    }
    let e = expression::create_expression(filter, &serde_json::json!({"type": "boolean"}), None).ok()?;
    let keep = |f: &J| {
        let properties = match expression::Value::from_json(&f["properties"]) {
            expression::Value::Object(o) => o,
            _ => Default::default(),
        };
        let feature = expression::Feature { id: f.get("id").filter(|v| !v.is_null()).map(expression::Value::from_json), properties, ..Default::default() };
        let mut ctx = expression::EvalCtx { globals: expression::Globals { zoom: 0.0, ..Default::default() }, feature: Some(&feature), ..Default::default() };
        matches!(e.evaluate(&mut ctx), expression::Value::Bool(true))
    };
    let features: Vec<J> = data["features"].as_array().into_iter().flatten().filter(|f| keep(f)).cloned().collect();
    Some(serde_json::json!({"type": "FeatureCollection", "features": features}))
}

fn geojson_index(data: &J, src: &J) -> geojson::GeoJsonIndex {
    let filtered = filter_geojson(data, &src["filter"]);
    let data = filtered.as_ref().unwrap_or(data);
    let scale = geojson::EXTENT / 512.0;
    let maxzoom = src["maxzoom"].as_f64().unwrap_or(18.0);
    let cluster = src["cluster"].as_bool().unwrap_or(false).then(|| supercluster::Options {
        // `clusterMaxZoom` (0 counts as unset), else one below the source maxzoom.
        max_zoom: src["clusterMaxZoom"].as_f64().filter(|&z| z != 0.0).map_or(maxzoom - 1.0, expression::value::js_round).clamp(0.0, 30.0) as u8,
        min_points: src["clusterMinPoints"].as_f64().filter(|&v| v != 0.0).unwrap_or(2.0).max(2.0) as u32,
        radius: src["clusterRadius"].as_f64().filter(|&v| v != 0.0).unwrap_or(50.0) * scale,
        extent: geojson::EXTENT,
        generate_id: src["generateId"].as_bool().unwrap_or(false),
        properties: cluster_properties(&src["clusterProperties"]),
    });
    geojson::GeoJsonIndex::new(
        data,
        geojson::Options {
            cluster,
            maxzoom: maxzoom as u8,
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
        let mut json: J = serde_json::from_str(style_json).map_err(|e| Error::Style(e.to_string()))?;
        let mut sources = HashMap::default();
        // Moved out of the style, which keeps only what layers need; an inline GeoJSON `data`
        // (which can be large) is dropped once indexed.
        let sources_json = match json.get_mut("sources").map(J::take) {
            Some(J::Object(o)) => o,
            _ => Default::default(),
        };
        for (id, mut src) in sources_json {
            let inline = src.as_object_mut().and_then(|o| o.shift_remove("data")).unwrap_or(J::Null);
            let ty = src["type"].as_str().unwrap_or("").to_string();
            let data = match ty.as_str() {
                "vector" | "raster" | "raster-dem" => match src["url"].as_str() {
                    Some(url) if src.get("tiles").is_none() => Data::Pending(url.to_string()),
                    _ => Data::Tiled(tilejson_from(&src, &J::Null)),
                },
                "geojson" => match inline {
                    J::String(url) => Data::Pending(url),
                    data => Data::GeoJson(geojson_index(&data, &src)),
                },
                "image" => {
                    let c = |i: usize| [src["coordinates"][i][0].as_f64().unwrap_or(0.0), src["coordinates"][i][1].as_f64().unwrap_or(0.0)];
                    Data::Image { url: src["url"].as_str().unwrap_or("").to_string(), coordinates: [c(0), c(1), c(2), c(3)], texture: None }
                }
                _ => Data::Failed,
            };
            sources.insert(id, Source { ty, json: src, data, tiles: HashMap::default(), vector_layers: Default::default(), buckets: Default::default(), last_used: Default::default() });
        }
        let sprites = sprite::Sprites::new(&json["sprite"], view.pixel_ratio);
        let glyphs = symbol::glyphs::Glyphs::new(json["glyphs"].as_str());
        let sprite = json["sprite"].clone();
        let mut r = Self {
            style: style::Style::parse(json),
            transform: Transform::new([0.0; 2], 0.0, 0.0, 1.0, 1.0, 1.0),
            sources,
            sprites,
            sprite,
            glyphs,
            glyph_urls: Default::default(),
            glyph_dependencies: Default::default(),
            requested: Default::default(),
            clock: 0,
            view,
            max_zoom: 22.0,
            cross_source_collisions: true,
        };
        r.set_max_zoom(22.0);
        Ok(r)
    }

    /// MapLibre's `maxZoom` map option: clamps the camera zoom and bounds tile slicing.
    pub fn set_max_zoom(&mut self, max_zoom: f64) {
        *self.glyph_dependencies.get_mut() = None;
        self.max_zoom = max_zoom;
        let v = self.view;
        let zoom = v.zoom.clamp(-2.0, max_zoom);
        self.transform = Transform::new(v.center, zoom, v.bearing, v.width as f64, v.height as f64, v.pixel_ratio);
        self.transform.set_margin(v.margin);
    }

    /// Moves the camera. Fetched resources and the layer buckets built from them are kept (up
    /// to `MAX_CACHED_TILES` per source), so one renderer can draw many views of its style.
    /// Call `needs()` again afterwards. A new pixel ratio refetches the sprite.
    pub fn set_view(&mut self, view: View) {
        if view == self.view {
            return;
        }
        if view.pixel_ratio != self.view.pixel_ratio && !self.sprite.is_null() {
            self.sprites = sprite::Sprites::new(&self.sprite, view.pixel_ratio);
        }
        self.view = view;
        self.clock += 1;
        self.set_max_zoom(self.max_zoom);
    }

    /// Drops the least recently needed tiles of each source beyond `MAX_CACHED_TILES`, with
    /// everything built from them. Tiles of the current view stay.
    fn evict(&mut self) {
        for src in self.sources.values_mut() {
            let last_used = src.last_used.get_mut();
            let Some(excess) = last_used.len().checked_sub(MAX_CACHED_TILES).filter(|&n| n > 0) else { continue };
            let mut old: Vec<(u64, TileId)> = last_used.iter().filter(|&(_, &t)| t < self.clock).map(|(&id, &t)| (t, id)).collect();
            old.sort_unstable();
            let evicted: hash::HashSet<TileId> = old.into_iter().take(excess).map(|(_, id)| id).collect();
            last_used.retain(|id, _| !evicted.contains(id));
            src.tiles.retain(|id, _| !evicted.contains(id));
            src.vector_layers.get_mut().retain(|(data, _), _| !evicted.contains(data));
            src.buckets.get_mut().retain(|(data, _, _), _| !evicted.contains(data));
        }
    }

    /// MapLibre's `crossSourceCollisions` map option: when off, symbols only collide with
    /// symbols of the same source.
    pub fn set_cross_source_collisions(&mut self, enabled: bool) {
        self.cross_source_collisions = enabled;
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
            Data::Tiled(tj) => (tj.tile_size, tj.minzoom, tj.maxzoom, tj.bounds),
            Data::GeoJson(g) => (512.0, 0, g.maxzoom(), None),
            _ => return vec![],
        };
        let z = self.transform.covering_zoom(tile_size, matches!(src.ty.as_str(), "raster" | "raster-dem"));
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
        let mut last_used = src.last_used.borrow_mut();
        let Data::Tiled(tj) = &src.data else {
            let covering = self.covering(src);
            if matches!(src.data, Data::GeoJson(_)) {
                last_used.extend(covering.iter().map(|t| (t.canonical, self.clock)));
            }
            return (covering.into_iter().map(|t| (t, t.canonical)).collect(), fetch);
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
                        last_used.insert(id, self.clock);
                        let canonical = if id == Self::data_tile(tj, t.canonical) { t.canonical } else { id };
                        let overscaled_z = if canonical == t.canonical { t.overscaled_z } else { canonical.z };
                        draw.insert((RenderTile { overscaled_z, wrap: t.wrap, canonical }, id));
                        break;
                    }
                    Some(None) => {
                        last_used.insert(id, self.clock);
                        if id.z <= min_z {
                            break;
                        }
                        id = id.parent_at(id.z - 1);
                    }
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
                    for t in self.resolve(src).1 {
                        let url = tile::tile_url(&tj.tiles, t, tj.tms);
                        let mut requested = self.requested.borrow_mut();
                        let targets = requested.entry(url.clone()).or_default();
                        if !targets.iter().any(|(s, u)| s == id && *u == t) {
                            targets.push((id.to_string(), t));
                        }
                        out.insert(url);
                    }
                }
                Data::Image { url, texture: None, .. } => {
                    out.insert(url.clone());
                }
                _ => {}
            }
        }
        let glyphs = self.glyph_needs();
        out.extend(glyphs.iter().map(|(url, _)| url.clone()));
        self.glyph_urls.borrow_mut().extend(glyphs);
        out.into_iter().map(|url| Resource { url }).collect()
    }

    fn ctx(&self) -> render::Ctx<'_> {
        render::Ctx::new(&self.transform, &self.style.global_state, &self.sprites.images)
    }

    /// Glyph ranges still to fetch for the text of the loaded tiles. Text is only known once
    /// its tiles are decoded, so this grows as tiles arrive.
    fn glyph_needs(&self) -> Vec<(String, (String, u32))> {
        if self.glyphs.url.is_none() {
            return vec![];
        }
        if let Some(deps) = self.glyph_dependencies.borrow().as_ref() {
            return self.glyphs.needs(deps);
        }
        let ctx = self.ctx();
        let mut deps = BTreeSet::new();
        let no_mask = render::raster::Mask::empty();
        for layer in &self.style.layers {
            if layer.ty != "symbol" || layer.is_hidden(self.transform.zoom, &self.style.global_state) {
                continue;
            }
            let Some(src) = layer.source.as_deref().and_then(|s| self.sources.get(s)) else { continue };
            let raw = self.style.layer_json(&layer.id);
            for (rt, tl, _) in self.tile_layers(src) {
                let Some(l) = self.source_layer(src, layer, tl.as_deref()) else { continue };
                let tf = render::TileFeatures { tile: rt, mask: &no_mask, layer: l, buckets: None };
                symbol::layout::glyph_dependencies(layer, &ctx, &tf, raw, &mut deps);
            }
        }
        let needs = self.glyphs.needs(&deps);
        *self.glyph_dependencies.borrow_mut() = Some(deps);
        needs
    }

    /// Resolved tiles of a vector/GeoJSON source with their decoded layers (sliced when
    /// overzoomed).
    /// Each also gets its bucket cache.
    /// Calls `f` with the source's resolved tiles: their clip masks and `layer`'s features.
    fn with_tiles<R>(&self, ctx: &render::Ctx, src: &Source, layer: &style::Layer, w: usize, h: usize, f: impl FnOnce(&[render::TileFeatures]) -> R) -> R {
        let empty = mvt::Layer { name: String::new(), extent: 4096, features: vec![] };
        let layers_by_tile = self.tile_layers(src);
        let render_tiles: Vec<RenderTile> = layers_by_tile.iter().map(|r| r.0).collect();
        let masks = ctx.masks(&render_tiles, w, h);
        let tiles: Vec<render::TileFeatures> = layers_by_tile
            .iter()
            .zip(masks.iter())
            .map(|((rt, tl, buckets), mask)| render::TileFeatures { tile: *rt, mask, layer: self.source_layer(src, layer, tl.as_deref()).unwrap_or(&empty), buckets: Some(buckets) })
            .collect();
        f(&tiles)
    }

    /// `*-layer-opacity`, if the layer type has one.
    fn layer_opacity(&self, layer: &style::Layer) -> Option<f64> {
        let p = layer.paint.get(&format!("{}-layer-opacity", layer.ty))?;
        Some(render::num(&p.eval(self.transform.zoom, None, None, &self.style.global_state)))
    }

    fn tile_layers(&self, src: &Source) -> Vec<(RenderTile, Option<Rc<Vec<mvt::Layer>>>, Rc<render::TileBuckets>)> {
        self.resolve(src)
            .0
            .into_iter()
            .map(|(rt, data_id)| {
                let layers = match &src.data {
                    Data::GeoJson(g) => Some(Rc::clone(
                        src.vector_layers.borrow_mut().entry((rt.canonical, rt.canonical))
                            .or_insert_with(|| Rc::new(vec![g.tile(rt.canonical.z, rt.canonical.x, rt.canonical.y)])),
                    )),
                    Data::Tiled(_) => match src.tiles.get(&data_id).cloned().flatten() {
                        Some(TileData::Vector(ls)) if data_id == rt.canonical => Some(ls),
                        Some(TileData::Vector(ls)) => Some(Rc::clone(
                            src.vector_layers.borrow_mut().entry((data_id, rt.canonical))
                                .or_insert_with(|| Rc::new(ls.iter().map(|l| mvt::slice_layer(l, data_id, rt.canonical)).collect())),
                        )),
                        _ => None,
                    },
                    _ => None,
                };
                let buckets = Rc::clone(src.buckets.borrow_mut().entry((data_id, rt.canonical, rt.overscaled_z)).or_default());
                (rt, layers, buckets)
            })
            .collect()
    }

    /// The style layer's source layer within a tile.
    fn source_layer<'a>(&self, src: &Source, layer: &style::Layer, layers: Option<&'a Vec<mvt::Layer>>) -> Option<&'a mvt::Layer> {
        let ls = layers?;
        match &src.data {
            Data::GeoJson(_) => ls.first(),
            _ => ls.iter().find(|l| Some(l.name.as_str()) == layer.source_layer.as_deref()),
        }
    }

    /// Hand over fetched bytes for `url` (as returned by `needs()`). `None` means the host could
    /// not fetch it (e.g. 404): a vector tile is then empty, a raster tile is replaced by an
    /// ancestor, a glyph range leaves its glyphs missing.
    pub fn provide(&mut self, url: &str, bytes: Option<&[u8]>) {
        let image_count = self.sprites.images.len();
        self.sprites.provide(url, bytes);
        let mut changed = self.sprites.images.len() != image_count;
        // Glyph ranges are recognized from the last `needs()` (evaluating text is costly).
        let glyph_key = self.glyph_urls.get_mut().remove(url);
        if let Some(key) = glyph_key {
            self.glyphs.provide(key, bytes);
        }
        let requested = self.requested.get_mut().remove(url).unwrap_or_default();
        for (id, src) in self.sources.iter_mut() {
            match &mut src.data {
                Data::Pending(u) if u == url => {
                    changed = true;
                    let doc = bytes.and_then(|b| serde_json::from_slice::<J>(b).ok());
                    src.data = match (doc, src.ty.as_str()) {
                        (Some(doc), "geojson") => Data::GeoJson(geojson_index(&doc, &src.json)),
                        (Some(doc), _) => Data::Tiled(tilejson_from(&doc, &src.json)),
                        (None, _) => Data::Failed,
                    };
                }
                Data::Tiled(tj) => {
                    for &(_, t) in requested.iter().filter(|(s, _)| s == id) {
                        if src.tiles.contains_key(&t) {
                            continue;
                        }
                        changed = true;
                        // Like MapLibre: a missing vector tile is just empty; a missing raster
                        // tile lets a parent show through, while an empty raster response
                        // (HTTP 204) is a transparent tile.
                        // A DEM tile that fails to decode also lets a parent show through.
                        let raster = src.ty == "raster" || src.ty == "raster-dem";
                        let decoded = match (src.ty.as_str(), bytes) {
                            (_, Some([])) if raster => Some(TileData::Raster(Rc::new(image::Texture::new(&image::Image { w: 1, h: 1, data: vec![0; 4] }, true)))),
                            ("raster", Some(b)) => image::Image::decode(b).map(|i| TileData::Raster(Rc::new(image::Texture::new(&i, true)))),
                            ("raster-dem", Some(b)) => image::Image::decode(b).and_then(|i| dem_from(&i, &src.json, tj.encoding.as_deref())).map(|d| TileData::Dem(Rc::new(d))),
                            _ if raster => None,
                            _ => {
                                let used = |name: &[u8]| {
                                    let name = String::from_utf8_lossy(name);
                                    self.style.layers.iter().any(|l| l.source.as_deref() == Some(id) && l.source_layer.as_deref() == Some(&*name))
                                };
                                Some(TileData::Vector(Rc::new(bytes.and_then(|b| mvt::decode(b, used)).unwrap_or_default())))
                            }
                        };
                        src.tiles.insert(t, decoded);
                        src.last_used.get_mut().insert(t, self.clock);
                    }
                }
                Data::Image { url: u, texture, .. } if u == url && texture.is_none() => {
                    changed = true;
                    // Image sources are uploaded without mipmaps.
                    *texture = Some(bytes.and_then(image::Image::decode).map(|i| Rc::new(image::Texture::new(&i, false))));
                }
                _ => {}
            }
        }
        if changed {
            *self.glyph_dependencies.get_mut() = None;
        }
    }

    /// Non-premultiplied RGBA8, row-major.
    pub fn render(&mut self) -> Result<Vec<u8>, Error> {
        if !self.needs().is_empty() {
            return Err(Error::NotReady);
        }
        self.evict();
        let t = &self.transform;
        let (w, h) = ((t.width * t.pixel_ratio).round() as usize, (t.height * t.pixel_ratio).round() as usize);
        let mut target = render::raster::Target::new(w, h);
        let ctx = self.ctx();
        let empty = mvt::Layer { name: String::new(), extent: 4096, features: vec![] };
        // Symbols are laid out and placed for all layers before drawing (placement runs from
        // the top layer down).
        let no_mask = render::raster::Mask::empty();
        // Layers with identical layout share one bucket (`groupByLayout`): it is laid out and
        // placed once, for the first layer, and drawn by each with its own paint.
        let mut symbol_layers: Vec<(&style::Layer, &serde_json::Value, Vec<Rc<symbol::layout::SymbolBucket>>)> = Vec::new();
        let mut leader_of: HashMap<&str, usize> = HashMap::default();
        for layer in &self.style.layers {
            if layer.ty != "symbol" || layer.is_hidden(t.zoom, &self.style.global_state) {
                continue;
            }
            let Some(src) = layer.source.as_deref().and_then(|s| self.sources.get(s)) else { continue };
            let raw = self.style.layer_json(&layer.id);
            const REF: [&str; 7] = ["type", "source", "source-layer", "minzoom", "maxzoom", "filter", "layout"];
            if let Some(i) = symbol_layers.iter().position(|(_, r, _)| REF.iter().all(|k| r.get(*k) == raw.get(*k))) {
                leader_of.insert(&layer.id, i);
                continue;
            }
            let builder = symbol::layout::Builder { layer, ctx: &ctx, glyphs: &self.glyphs, raw };
            let mut buckets = Vec::new();
            for (rt, tl, tile_buckets) in self.tile_layers(src) {
                let l = self.source_layer(src, layer, tl.as_deref()).unwrap_or(&empty);
                let tf = render::TileFeatures { tile: rt, mask: &no_mask, layer: l, buckets: Some(&tile_buckets) };
                // The layout is camera-independent except for the world copy (in its tile) and the
                // pixel ratio (icon scaling and the sprite); placement is redone each render.
                let key = format!("{}\0{}\0{}", layer.layout_group, rt.wrap, t.pixel_ratio);
                buckets.push(tf.bucket_keyed(&key, || builder.build(&tf)));
            }
            leader_of.insert(&layer.id, symbol_layers.len());
            symbol_layers.push((layer, raw, buckets));
        }
        let mut groups: Vec<&str> = Vec::new();
        let placement_input: Vec<symbol::placement::LayerBuckets> = symbol_layers
            .iter()
            .map(|(layer, raw, buckets)| {
                let mut group = 0;
                if !self.cross_source_collisions {
                    let src = layer.source.as_deref().unwrap_or("");
                    group = groups.iter().position(|g| *g == src).unwrap_or_else(|| {
                        groups.push(src);
                        groups.len() - 1
                    }) as u32
                        + 1;
                }
                symbol::placement::LayerBuckets { layer, raw, buckets, group }
            })
            .collect();
        let placements = symbol::placement::place(&ctx, &placement_input);
        // Heatmaps drawn so far: MapLibre draws them without depth test, so they stay on top of
        // the opaque-pass pixels (opaque backgrounds and fill interiors) of layers above them.
        let mut heatmaps: Vec<Vec<render::raster::Rgba>> = Vec::new();
        let visible: Vec<bool> = self.style.layers.iter().map(|l| !l.is_hidden(t.zoom, &self.style.global_state)).collect();
        // Opaque pass, top-down (see `render::Pass`). Heatmaps stay on top of the opaque pixels of
        // the layers above them, which the occlusion buffer can't express, so they draw all
        // layers in style order.
        let mut opaque_drawn = vec![false; self.style.layers.len()];
        // Only a background or fill above another visible layer can hide anything.
        let lowest = visible.iter().position(|v| *v);
        let occlusion = self.style.layers.len() < u16::MAX as usize
            && !self.style.layers.iter().zip(&visible).any(|(l, v)| *v && l.ty == "heatmap")
            && self.style.layers.iter().zip(&visible).enumerate().any(|(i, (l, v))| *v && Some(i) > lowest && matches!(l.ty.as_str(), "background" | "fill"));
        if occlusion {
            target.occ = vec![0; w * h];
            target.cull = true;
            for (i, layer) in self.style.layers.iter().enumerate().rev() {
                if !visible[i] {
                    continue;
                }
                target.layer = i as u16 + 1;
                let raw = self.style.layer_json(&layer.id);
                opaque_drawn[i] = match layer.ty.as_str() {
                    "background" => render::draw_background(&mut target, layer, &ctx, raw, render::Pass::Opaque),
                    "fill" if self.layer_opacity(layer).is_none_or(|o| o >= 1.0) => {
                        let Some(src) = layer.source.as_deref().and_then(|s| self.sources.get(s)) else { continue };
                        self.with_tiles(&ctx, src, layer, w, h, |tiles| render::draw_fill(&mut target, layer, &ctx, tiles, raw, render::Pass::Opaque))
                    }
                    _ => false,
                };
            }
            target.cull = opaque_drawn.iter().rposition(|d| *d) > lowest;
        }
        for (i, layer) in self.style.layers.iter().enumerate() {
            if !visible[i] {
                continue;
            }
            target.layer = i as u16 + 1;
            if !heatmaps.is_empty() {
                render::heatmap::reapply(&mut target, &heatmaps);
                target.opaque = vec![false; w * h];
            }
            let raw = self.style.layer_json(&layer.id);
            if layer.ty == "background" {
                if !opaque_drawn[i] {
                    render::draw_background(&mut target, layer, &ctx, raw, render::Pass::All);
                }
                continue;
            }
            if layer.ty == "symbol" {
                if let Some(&i) = leader_of.get(layer.id.as_str()) {
                    symbol::draw::draw_symbol_layer(&mut target, layer, &ctx, raw, &symbol_layers[i].2, &placements[i]);
                }
                continue;
            }
            if layer.ty == "hillshade" || layer.ty == "color-relief" {
                if let Some(src) = layer.source.as_deref().and_then(|s| self.sources.get(s)) {
                    self.draw_dem_layer(&mut target, layer, &ctx, src, w, h);
                }
                continue;
            }
            if !matches!(layer.ty.as_str(), "fill" | "line" | "circle" | "raster" | "heatmap") {
                continue;
            }
            let Some(src) = layer.source.as_deref().and_then(|s| self.sources.get(s)) else { continue };
            if layer.ty == "raster" {
                self.draw_raster(&mut target, layer, &ctx, src, w, h);
                continue;
            }
            // `*-layer-opacity`: the layer is drawn offscreen, then composited.
            let layer_opacity = self.layer_opacity(layer);
            if layer_opacity == Some(0.0) {
                continue;
            }
            let mut offscreen = layer_opacity.filter(|o| *o < 1.0).map(|_| render::raster::Target::new(w, h));
            let dest = offscreen.as_mut().unwrap_or(&mut target);
            self.with_tiles(&ctx, src, layer, w, h, |tiles| match layer.ty.as_str() {
                "fill" => {
                    render::draw_fill(dest, layer, &ctx, tiles, raw, if opaque_drawn[i] { render::Pass::Translucent } else { render::Pass::All });
                }
                "line" => {
                    let source_maxzoom = match &src.data {
                        Data::Tiled(tj) => tj.maxzoom,
                        Data::GeoJson(g) => g.maxzoom(),
                        _ => 22,
                    };
                    let has_gradient = raw["paint"].get("line-gradient").is_some();
                    let has_pattern = raw["paint"].get("line-pattern").is_some();
                    render::draw_line(dest, layer, &ctx, tiles, source_maxzoom, self.max_zoom, has_gradient, has_pattern)
                }
                "circle" => render::draw_circle(dest, layer, &ctx, tiles),
                "heatmap" => {
                    let colors = render::heatmap::draw_heatmap(dest, layer, &ctx, tiles);
                    render::heatmap::blend(dest, &colors, None);
                    heatmaps.push(colors);
                }
                _ => {}
            });
            if let (Some(off), Some(o)) = (offscreen, layer_opacity) {
                for (i, p) in off.px.iter().enumerate() {
                    if (p[3] != 0 || p[0] != 0 || p[1] != 0 || p[2] != 0) && target.visible(i) {
                        target.blend(i, p.map(|c| c as f32 / 255.0 * o as f32));
                    }
                }
            }
        }
        render::heatmap::reapply(&mut target, &heatmaps);
        let mut rgba = target.into_unpremultiplied();
        let margin = (self.view.margin as f64 * t.pixel_ratio).round() as usize;
        if margin == 0 {
            return Ok(rgba);
        }
        let width = (self.view.width as f64 * t.pixel_ratio).round() as usize;
        let height = (self.view.height as f64 * t.pixel_ratio).round() as usize;
        for (row, y) in (margin..margin + height).enumerate() {
            let start = (y * w + margin) * 4;
            rgba.copy_within(start..start + width * 4, row * width * 4);
        }
        rgba.truncate(width * height * 4);
        Ok(rgba)
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
        let masks = if mixed { Some(ctx.masks(&tiles, w, h)) } else { None };
        for (i, (rt, data_id)) in resolved.iter().enumerate() {
            if let Some(Some(TileData::Raster(tex))) = src.tiles.get(data_id) {
                draw_quad(target, ctx, &Quad::tile(*rt), tex, &params, masks.as_ref().map(|m| &m[i]));
            }
        }
    }

    /// Hillshade / color-relief: each drawn DEM tile takes its 2px border from the drawn tiles
    /// around it (MapLibre's `backfillDEM` over the renderable tiles), then is drawn.
    fn draw_dem_layer(&self, target: &mut render::raster::Target, layer: &style::Layer, ctx: &render::Ctx, src: &Source, w: usize, h: usize) {
        let hillshade = (layer.ty == "hillshade").then(|| render::dem::HillshadeParams::new(layer, ctx));
        let ramp = (layer.ty == "color-relief").then(|| render::dem::ColorRamp::new(layer, ctx));
        let resolved = self.resolve(src).0;
        let tiles: Vec<RenderTile> = resolved.iter().map(|r| r.0).collect();
        // The resolved tiles of a source are fixed for one render, so the source id keys them.
        let dems = ctx.dem_tiles(layer.source.as_deref().unwrap_or_default(), || {
            let raw: Vec<Option<&Rc<render::dem::Dem>>> =
                resolved.iter().map(|(_, id)| match src.tiles.get(id) {
                    Some(Some(TileData::Dem(d))) => Some(d),
                    _ => None,
                }).collect();
            tiles.iter().enumerate().map(|(i, t)| {
                let mut dem = (**raw[i]?).clone();
                let n = 1i64 << t.canonical.z;
                let world_x = |t: &RenderTile| t.wrap as i64 * n + t.canonical.x as i64;
                for (j, u) in tiles.iter().enumerate() {
                    let (dx, dy) = (world_x(u) - world_x(t), u.canonical.y as i64 - t.canonical.y as i64);
                    let neighbor = u.overscaled_z == t.overscaled_z && u.canonical.z == t.canonical.z && dx.abs() <= 1 && dy.abs() <= 1 && (dx, dy) != (0, 0);
                    if let (true, Some(b)) = (neighbor, raw[j]) {
                        dem.backfill(b, dx as isize, dy as isize);
                    }
                }
                Some(render::dem::DemTile::new(dem))
            }).collect()
        });
        let mixed = tiles.iter().any(|t| t.canonical.z != tiles[0].canonical.z);
        let masks = if mixed { Some(ctx.masks(&tiles, w, h)) } else { None };
        for (i, t) in tiles.iter().enumerate() {
            let Some(dem) = &dems[i] else { continue };
            let mask = masks.as_ref().map(|m| &m[i]);
            if let Some(params) = &hillshade {
                // Raster sources are not reparsed when overzoomed: their tiles keep
                // `overscaledZ` = the canonical zoom.
                let tex = dem.slopes(t.canonical.z as f64);
                render::dem::draw_hillshade_tile(target, ctx, t, tex, params, mask);
            }
            if let Some(ramp) = &ramp {
                render::dem::draw_color_relief_tile(target, ctx, t, &dem.dem, ramp, mask);
            }
        }
    }
}

/// Decode a raster-dem tile with the source's `encoding` (and custom factors).
fn dem_from(img: &image::Image, src: &J, encoding: Option<&str>) -> Option<render::dem::Dem> {
    let f = |k: &str, d: f64| src[k].as_f64().unwrap_or(d);
    let factors = [f("redFactor", 1.0), f("greenFactor", 1.0), f("blueFactor", 1.0), f("baseShift", 0.0)];
    render::dem::Dem::new(img, encoding.unwrap_or("mapbox"), factors)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glyph_requests_follow_staged_sources_and_failed_ranges() {
        let style = r#"{"version":8,"glyphs":"/glyphs/{fontstack}/{range}","sources":{"a":{"type":"geojson","data":"/a"},"b":{"type":"geojson","data":"/b"}},"layers":[{"id":"a","type":"symbol","source":"a","layout":{"text-field":["get","name"],"text-font":["Test Font"]}},{"id":"b","type":"symbol","source":"b","layout":{"text-field":["get","name"],"text-font":["Test Font"]}}]}"#;
        let mut renderer = Renderer::new(style, View::tile(0, 0, 0, 128)).unwrap();
        let urls = |r: &Renderer| r.needs().into_iter().map(|n| n.url).collect::<Vec<_>>();
        assert_eq!(urls(&renderer), ["/a", "/b"]);
        renderer.provide("/a", Some(br#"{"type":"Feature","properties":{"name":"A"},"geometry":{"type":"Point","coordinates":[0,0]}}"#));
        let expected = ["/b", "/glyphs/Test Font/0-255"];
        assert_eq!(urls(&renderer), expected);
        assert_eq!(urls(&renderer), expected);
        renderer.provide("/glyphs/Test Font/0-255", None);
        assert_eq!(urls(&renderer), ["/b"]);
        // Later source data can introduce a range after earlier glyphs have settled.
        renderer.provide("/b", Some(r#"{"type":"Feature","properties":{"name":"あ"},"geometry":{"type":"Point","coordinates":[0,0]}}"#.as_bytes()));
        assert_eq!(urls(&renderer), ["/glyphs/Test Font/12288-12543"]);
        renderer.provide("/glyphs/Test Font/12288-12543", None);
        assert!(renderer.needs().is_empty());
        assert!(renderer.render().is_ok());
    }

    #[test]
    fn glyph_requests_follow_camera_clamping_after_discovery() {
        let style = r#"{"version":8,"glyphs":"/glyphs/{fontstack}/{range}","sources":{"a":{"type":"geojson","data":{"type":"Point","coordinates":[0,0]}}},"layers":[{"id":"a","type":"symbol","source":"a","layout":{"text-field":["step",["zoom"],"A",1,"あ"],"text-font":["Test Font"]}}]}"#;
        let view = View { center: [0.0, 0.0], zoom: 2.0, width: 128, height: 128, ..View::tile(0, 0, 0, 128) };
        let mut renderer = Renderer::new(style, view).unwrap();
        assert_eq!(renderer.needs()[0].url, "/glyphs/Test Font/12288-12543");
        renderer.provide("/glyphs/Test Font/12288-12543", None);
        assert!(renderer.needs().is_empty());
        renderer.set_max_zoom(0.0);
        assert_eq!(renderer.needs()[0].url, "/glyphs/Test Font/0-255");
    }

    #[test]
    fn overzoom_slices_are_shared_but_sources_and_children_are_distinct() {
        let style = r#"{"version":8,"sources":{"a":{"type":"vector","tiles":["/a/{z}/{x}/{y}"],"maxzoom":1},"b":{"type":"vector","tiles":["/b/{z}/{x}/{y}"],"maxzoom":1}},"layers":[]}"#;
        let view = View { width: 1024, ..View::tile(2, 1, 1, 512) };
        let mut renderer = Renderer::new(style, view).unwrap();
        let parent = TileId { z: 1, x: 0, y: 0 };
        let child = TileId { z: 2, x: 1, y: 1 };
        for (id, x) in [("a", 3072), ("b", 2560)] {
            let layer = mvt::Layer { name: "points".into(), extent: 4096, features: vec![mvt::Feature {
                id: None, ty: mvt::GeomType::Point, properties: Default::default(), geometry: vec![vec![[x, 3072]]],
            }] };
            renderer.sources.get_mut(id).unwrap().tiles.insert(parent, Some(TileData::Vector(Rc::new(vec![layer]))));
        }
        let layers = |id: &str, tile: TileId| {
            renderer.tile_layers(&renderer.sources[id]).into_iter().find(|(t, _, _)| t.canonical == tile).unwrap().1.unwrap()
        };
        let a = layers("a", child);
        assert!(Rc::ptr_eq(&a, &layers("a", child)));
        assert_eq!(a[0].features[0].geometry, vec![vec![[2048, 2048]]]);
        let b = layers("b", child);
        assert!(!Rc::ptr_eq(&a, &b));
        assert_eq!(b[0].features[0].geometry, vec![vec![[1024, 2048]]]);

        // A sibling uses the same parent but needs its own clipping and coordinates.
        let sibling = layers("a", TileId { z: 2, x: 0, y: 1 });
        assert!(!Rc::ptr_eq(&a, &sibling));
        assert!(sibling[0].features.is_empty());

        // Once zoom is clamped to the source zoom, use the original decoded tile.
        renderer.set_max_zoom(1.0);
        let unsliced = renderer.tile_layers(&renderer.sources["a"]).into_iter()
            .find(|(t, _, _)| t.canonical == parent).unwrap().1.unwrap();
        assert_eq!(unsliced[0].features[0].geometry, vec![vec![[3072, 3072]]]);
    }

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
    fn png_roundtrip_preserves_rgba_dimensions_and_margin_crop() {
        let style = r##"{"version":8,"sources":{"p":{"type":"geojson","data":{"type":"Point","coordinates":[0,0]}}},"layers":[{"id":"bg","type":"background","paint":{"background-color":"rgba(32,64,128,0.5)"}},{"id":"point","type":"circle","source":"p","paint":{"circle-radius":10,"circle-color":"rgba(255,0,0,0.5)"}}]}"##;
        for pixel_ratio in [1.0, 1.5, 2.0] {
            for margin in [0, 8] {
                let view = View { center: [0.0, 0.0], zoom: 1.0, bearing: 0.0, width: 63, height: 47, pixel_ratio, margin };
                let mut renderer = Renderer::new(style, view).unwrap();
                let rgba = renderer.render().unwrap();
                let (width, height) = ((view.width as f64 * pixel_ratio).round() as u32, (view.height as f64 * pixel_ratio).round() as u32);
                let png = encode_png(&rgba, width, height).unwrap();
                let mut reader = png::Decoder::new(std::io::Cursor::new(png)).read_info().unwrap();
                let mut decoded = vec![0; reader.output_buffer_size().unwrap()];
                let info = reader.next_frame(&mut decoded).unwrap();
                assert_eq!((info.width, info.height), (width, height));
                assert_eq!(info.color_type, png::ColorType::Rgba);
                assert_eq!(&decoded[..info.buffer_size()], &rgba);
            }
        }
    }

    #[test]
    fn png_rejects_mismatched_dimensions() {
        assert!(matches!(encode_png(&[0; 16], 3, 1), Err(Error::ImageEncoding(_))));
    }

    #[test]
    fn webp_roundtrip_is_lossless() {
        let rgba: Vec<u8> = (0..5 * 3 * 4).map(|i| (i * 37 % 256) as u8).collect();
        let webp = encode_webp(&rgba, 5, 3).unwrap();
        let mut decoder = image_webp::WebPDecoder::new(std::io::Cursor::new(webp)).unwrap();
        assert_eq!(decoder.dimensions(), (5, 3));
        let mut decoded = vec![0; decoder.output_buffer_size().unwrap()];
        decoder.read_image(&mut decoded).unwrap();
        assert_eq!(decoded, rgba);
        assert!(matches!(encode_webp(&rgba, 4, 3), Err(Error::ImageEncoding(_))));
    }

    #[test]
    fn source_filter_precedes_clustering_and_property_reduction() {
        let data = serde_json::json!({
            "type": "FeatureCollection",
            "features": [
                {"type":"Feature","properties":{"keep":true,"amount":3},"geometry":{"type":"Point","coordinates":[0,0]}},
                {"type":"Feature","properties":{"keep":true,"amount":5},"geometry":{"type":"Point","coordinates":[0.1,0]}},
                {"type":"Feature","properties":{"keep":false,"amount":100},"geometry":{"type":"Point","coordinates":[0.2,0]}}
            ]
        });
        let mut source = serde_json::json!({
            "type": "geojson", "filter": ["==", ["get", "keep"], true],
            "cluster": true, "clusterProperties": {"total": ["+", ["get", "amount"]]}
        });
        let clustered = geojson_index(&data, &source).tile(0, 0, 0);
        assert_eq!(clustered.features.len(), 1);
        let props = &clustered.features[0].properties;
        assert_eq!(props.get("point_count").and_then(expression::Value::as_f64), Some(2.0));
        assert_eq!(props.get("total").and_then(expression::Value::as_f64), Some(8.0));
        // Source filtering also applies when clustering is disabled.
        source["cluster"] = J::Bool(false);
        let unclustered = geojson_index(&data, &source).tile(0, 0, 0);
        assert_eq!(unclustered.features.len(), 2);
    }

    #[test]
    fn tilejson_tile_size_and_encoding() {
        // The TileJSON may carry `tileSize`/`encoding` (e.g. terrarium DEMs); the style wins.
        let tj = serde_json::json!({"tiles": ["t/{z}/{x}/{y}.webp"], "tileSize": 512, "encoding": "terrarium"});
        let from_tilejson = tilejson_from(&tj, &serde_json::json!({"type": "raster-dem", "url": "x"}));
        assert_eq!((from_tilejson.tile_size, from_tilejson.encoding.as_deref()), (512.0, Some("terrarium")));
        let overridden = tilejson_from(&tj, &serde_json::json!({"tileSize": 256, "encoding": "mapbox"}));
        assert_eq!((overridden.tile_size, overridden.encoding.as_deref()), (256.0, Some("mapbox")));
    }

    #[test]
    fn hillshade_requests_dem_and_renders_with_margin() {
        let style = r##"{"version":8,"sources":{"dem":{"type":"raster-dem","tiles":["/dem/{z}/{x}/{y}.png"],"tileSize":64,"maxzoom":10}},"layers":[{"id":"bg","type":"background","paint":{"background-color":"white"}},{"id":"shade","type":"hillshade","source":"dem"}]}"##;
        // A curved elevation surface must produce visible, varying shading. This exercises
        // the entire source/provide/draw path, rather than only the DEM slope calculation.
        let data: Vec<u8> = (0..64).flat_map(|_| (0..64).flat_map(|x| {
            let elevation = (x as f64 / 63.0 * std::f64::consts::PI).sin() * 4000.0;
            let packed = ((elevation + 10000.0) * 10.0).round() as u32;
            [(packed >> 16) as u8, (packed >> 8) as u8, packed as u8, 255]
        })).collect();
        let mut png = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut png, 64, 64);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            encoder.write_header().unwrap().write_image_data(&data).unwrap();
        }
        for margin in [0, 8] {
            let view = View { margin, ..View::tile(10, 512, 512, 64) };
            let mut renderer = Renderer::new(style, view).unwrap();
            assert!(!renderer.needs().is_empty(), "DEM tiles must be requested");
            for resource in renderer.needs() {
                renderer.provide(&resource.url, Some(&png));
            }
            assert!(renderer.needs().is_empty());
            let rgba = renderer.render().unwrap();
            assert_eq!(rgba.len(), 64 * 64 * 4);
            let center_row = &rgba[32 * 64 * 4..33 * 64 * 4];
            assert!(center_row.chunks_exact(4).any(|p| p != [255; 4]), "Hillshade must change the white background");
            assert!(center_row.chunks_exact(4).any(|p| p != &center_row[..4]), "A curved DEM must have varying shading");
        }
    }

    #[test]
    fn background_only() {
        let style = r##"{"version":8,"sources":{},"layers":[{"id":"bg","type":"background","paint":{"background-color":"#ff0000"}}]}"##;
        let mut r = Renderer::new(style, View { center: [0.0, 0.0], zoom: 0.0, bearing: 0.0, width: 4, height: 4, pixel_ratio: 1.0, margin: 0 }).unwrap();
        assert!(r.needs().is_empty());
        let px = r.render().unwrap();
        assert_eq!(&px[..4], &[255, 0, 0, 255]);
    }

    #[test]
    fn reused_renderer_matches_fresh_renders() {
        // Polygons and round-joined lines over the whole world, so that every tile has buckets.
        let mut features = Vec::new();
        for i in 0..64 {
            let (x, y) = (-178.0 + (i % 8) as f64 * 45.0, -82.0 + (i / 8) as f64 * 21.0);
            features.push(serde_json::json!({"type": "Feature", "properties": {"k": i % 3}, "geometry": {"type": "Polygon", "coordinates": [[[x, y], [x + 40.0, y + 3.0], [x + 15.0, y + 19.0], [x, y]]]}}));
            features.push(serde_json::json!({"type": "Feature", "properties": {"k": i % 3}, "geometry": {"type": "LineString", "coordinates": [[x, y], [x + 50.0, y + 15.0], [x + 10.0, y + 25.0]]}}));
        }
        let style = serde_json::json!({"version": 8, "sprite": "/sprite", "sources": {"g": {"type": "geojson", "maxzoom": 3, "data": {"type": "FeatureCollection", "features": features}}}, "layers": [
            {"id": "f", "type": "fill", "source": "g", "paint": {"fill-color": ["match", ["get", "k"], 0, "#c33", 1, "#3c3", "#33c"], "fill-opacity": 0.7}},
            {"id": "l", "type": "line", "source": "g", "layout": {"line-join": "round", "line-cap": "round"}, "paint": {"line-width": 3}},
            // Line labels depend on the world copy; icon sizes on the sprite's pixel ratio.
            {"id": "s", "type": "symbol", "source": "g", "layout": {"icon-image": "marker", "symbol-placement": "line", "symbol-spacing": 40}},
        ]})
        .to_string();
        let mut png = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut png, 8, 8);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            encoder.write_header().unwrap().write_image_data(&[0, 0, 0, 255].repeat(64)).unwrap();
        }
        let render = |r: &mut Renderer| {
            for need in r.needs() {
                let ratio = if need.url.contains("@2x") { 2 } else { 1 };
                let json = format!(r#"{{"marker":{{"x":0,"y":0,"width":8,"height":8,"pixelRatio":{ratio}}}}}"#);
                r.provide(&need.url, Some(if need.url.ends_with(".json") { json.as_bytes() } else { &png }));
            }
            assert!(r.needs().is_empty());
            r.render().unwrap()
        };
        // The 64 z3 tiles exceed MAX_CACHED_TILES and are revisited after eviction. z4 views
        // overzoom the same z3 tiles, whose buckets differ by zoom.
        let tile = |z: u8, x: u32, y: u32| View { margin: 16, pixel_ratio: 0.25, ..View::tile(z, x, y, 512) };
        let mut views: Vec<View> = (0..64).map(|i| tile(3, i % 8, i / 8)).collect();
        views.extend((0..16).map(|i| tile(4, 4 + i % 4, 4 + i / 4)));
        views.extend((0..64).map(|i| tile(3, i % 8, i / 8)));
        views.push(View { pixel_ratio: 0.5, ..views[9] });
        views.push(View { pixel_ratio: 2.0, ..views[9] });
        // Another world copy of a cached tile.
        views.push(View { center: [views[9].center[0] + 360.0, views[9].center[1]], ..views[9] });
        let mut shared = Renderer::new(&style, views[0]).unwrap();
        let mut drawn = 0;
        for (i, &view) in views.iter().enumerate() {
            shared.set_view(view);
            let rgba = render(&mut shared);
            assert_eq!(rgba, render(&mut Renderer::new(&style, view).unwrap()), "view {i}");
            drawn += rgba.chunks_exact(4).any(|p| p[3] > 0) as usize;
        }
        assert!(drawn > views.len() / 2);
        let src = &shared.sources["g"];
        assert!(src.last_used.borrow().len() <= MAX_CACHED_TILES + 16);
        assert!(src.buckets.borrow().len() <= MAX_CACHED_TILES + 16);
    }

    #[test]
    fn provide_accepts_tiles_requested_before_a_view_change() {
        let style = r#"{"version":8,"sources":{"v":{"type":"vector","tiles":["/{z}/{x}/{y}"],"maxzoom":2}},"layers":[{"id":"l","type":"line","source":"v","source-layer":"lines"}]}"#;
        let (a, b) = (View::tile(2, 0, 0, 512), View::tile(2, 3, 3, 512));
        let mut renderer = Renderer::new(style, a).unwrap();
        let requested = renderer.needs();
        assert!(!requested.is_empty());
        renderer.set_view(b);
        for r in &requested {
            renderer.provide(&r.url, None);
        }
        renderer.set_view(a);
        assert!(renderer.needs().is_empty());
    }

    #[test]
    fn margin_fetches_neighbor_tiles_without_moving_camera() {
        let style = r#"{"version":8,"sources":{"v":{"type":"vector","tiles":["/{z}/{x}/{y}"],"maxzoom":2}},"layers":[{"id":"s","type":"symbol","source":"v","source-layer":"points","layout":{"text-field":"label"}}]}"#;
        let view = View::tile(2, 1, 0, 512);
        let plain = Renderer::new(style, view).unwrap();
        let mut padded = Renderer::new(style, View { margin: 32, ..view }).unwrap();
        assert_eq!(plain.transform.center, padded.transform.center);
        assert!(!plain.needs().iter().any(|r| r.url == "/2/2/0"));
        assert!(padded.needs().iter().any(|r| r.url == "/2/2/0"));
        padded.set_max_zoom(20.0);
        assert_eq!(plain.transform.center, padded.transform.center);
    }

    #[test]
    fn margin_renders_icon_anchored_in_neighbor_tile_and_crops_output() {
        // The anchor is just east of this view's right edge (longitude 0). With no
        // GeoJSON tile buffer, only loading the neighboring tile can recover the icon.
        let style = r#"{"version":8,"sprite":"/sprite","sources":{"p":{"type":"geojson","buffer":0,"maxzoom":2,"data":{"type":"Point","coordinates":[1,40]}}},"layers":[{"id":"s","type":"symbol","source":"p","layout":{"icon-image":"marker","icon-allow-overlap":true}}]}"#;
        let mut png = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut png, 32, 32);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            encoder.write_header().unwrap().write_image_data(&[255, 0, 0, 255].repeat(32 * 32)).unwrap();
        }
        for ratio in [1.0, 1.25, 1.5, 2.0] {
            for margin in [0, 31] {
                let view = View { margin, pixel_ratio: ratio, ..View::tile(2, 1, 1, 512) };
                let mut renderer = Renderer::new(style, view).unwrap();
                let suffix = if ratio > 1.0 { "@2x" } else { "" };
                renderer.provide(&format!("/sprite{suffix}.json"), Some(br#"{"marker":{"x":0,"y":0,"width":32,"height":32,"pixelRatio":1}}"#));
                renderer.provide(&format!("/sprite{suffix}.png"), Some(&png));
                assert!(renderer.needs().is_empty());
                let rgba = renderer.render().unwrap();
                let size = (512.0 * ratio).round() as usize;
                assert_eq!(rgba.len(), size * size * 4);
                let visible = rgba.chunks_exact(4).any(|p| p[3] > 0);
                assert_eq!(visible, margin > 0, "ratio={ratio}, margin={margin}");
                if margin > 0 {
                    assert!(rgba.chunks_exact(size * 4).any(|row| row[(size - 1) * 4 + 3] > 0));
                }
            }
        }
    }
}
