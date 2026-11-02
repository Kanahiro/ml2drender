//! Mapbox Vector Tile (protobuf) decoding.

use crate::expression::Value;
use std::rc::Rc;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GeomType {
    Unknown = 0,
    Point = 1,
    LineString = 2,
    Polygon = 3,
}

impl GeomType {
    pub fn name(self) -> &'static str {
        match self {
            GeomType::Unknown => "Unknown",
            GeomType::Point => "Point",
            GeomType::LineString => "LineString",
            GeomType::Polygon => "Polygon",
        }
    }
}

/// A decoded feature in tile coordinates of its layer's extent. Rings/lines are explicit
/// (polygon rings closed by repeating the first point, like vector-tile-js).
#[derive(Debug, Clone)]
pub struct Feature {
    pub id: Option<Value>,
    pub ty: GeomType,
    pub properties: Rc<crate::expression::Object>,
    pub geometry: Vec<Vec<[i32; 2]>>,
}

#[derive(Debug, Clone)]
pub struct Layer {
    pub name: String,
    pub extent: u32,
    pub features: Vec<Feature>,
}

pub(crate) struct Reader<'a> {
    pub buf: &'a [u8],
    pub pos: usize,
}

impl<'a> Reader<'a> {
    pub fn varint(&mut self) -> Option<u64> {
        let mut v = 0u64;
        for shift in (0..64).step_by(7) {
            let b = *self.buf.get(self.pos)?;
            self.pos += 1;
            v |= ((b & 0x7f) as u64) << shift;
            if b < 0x80 {
                return Some(v);
            }
        }
        None
    }

    pub fn bytes(&mut self) -> Option<&'a [u8]> {
        let len = self.varint()? as usize;
        let s = self.buf.get(self.pos..self.pos + len)?;
        self.pos += len;
        Some(s)
    }

    /// Next (field, wire type); `None` at end.
    pub fn field(&mut self) -> Option<(u64, u8)> {
        if self.pos >= self.buf.len() {
            return None;
        }
        let k = self.varint()?;
        Some((k >> 3, (k & 7) as u8))
    }

    pub fn skip(&mut self, wire: u8) -> Option<()> {
        match wire {
            0 => {
                self.varint()?;
            }
            1 => self.pos += 8,
            2 => {
                self.bytes()?;
            }
            5 => self.pos += 4,
            _ => return None,
        }
        (self.pos <= self.buf.len()).then_some(())
    }

    fn fixed<const N: usize>(&mut self) -> Option<[u8; N]> {
        let s = self.buf.get(self.pos..self.pos + N)?;
        self.pos += N;
        s.try_into().ok()
    }
}

fn packed(data: &[u8]) -> Option<Vec<u32>> {
    let mut r = Reader { buf: data, pos: 0 };
    let mut out = Vec::new();
    while r.pos < data.len() {
        out.push(r.varint()? as u32);
    }
    Some(out)
}

fn decode_value(data: &[u8]) -> Option<Value> {
    let mut r = Reader { buf: data, pos: 0 };
    let mut v = Value::Null;
    while let Some((f, w)) = r.field() {
        v = match (f, w) {
            (1, 2) => Value::str(std::str::from_utf8(r.bytes()?).ok()?),
            (2, 5) => Value::Number(f32::from_le_bytes(r.fixed()?) as f64),
            (3, 1) => Value::Number(f64::from_le_bytes(r.fixed()?)),
            (4, 0) => Value::Number(r.varint()? as i64 as f64),
            (5, 0) => Value::Number(r.varint()? as f64),
            (6, 0) => {
                let n = r.varint()?;
                Value::Number(((n >> 1) as i64 ^ -((n & 1) as i64)) as f64)
            }
            (7, 0) => Value::Bool(r.varint()? != 0),
            _ => {
                r.skip(w)?;
                continue;
            }
        };
    }
    Some(v)
}

fn decode_geometry(cmds: &[u32]) -> Vec<Vec<[i32; 2]>> {
    let mut lines: Vec<Vec<[i32; 2]>> = Vec::new();
    let mut line: Option<Vec<[i32; 2]>> = None;
    let (mut x, mut y) = (0i32, 0i32);
    let mut i = 0;
    let zz = |v: u32| ((v >> 1) as i32) ^ -((v & 1) as i32);
    while i < cmds.len() {
        let cmd = cmds[i] & 7;
        let count = cmds[i] >> 3;
        i += 1;
        match cmd {
            1 | 2 => {
                for _ in 0..count {
                    let (Some(&dx), Some(&dy)) = (cmds.get(i), cmds.get(i + 1)) else { return lines };
                    i += 2;
                    x += zz(dx);
                    y += zz(dy);
                    if cmd == 1 {
                        lines.extend(line.take());
                        line = Some(Vec::new());
                    }
                    line.get_or_insert_with(Vec::new).push([x, y]);
                }
            }
            7 => {
                if let Some(l) = line.as_mut()
                    && let Some(&first) = l.first()
                {
                    l.push(first);
                }
            }
            _ => return lines,
        }
    }
    lines.extend(line);
    lines
}

fn layer_name(data: &[u8]) -> Option<&[u8]> {
    let mut r = Reader { buf: data, pos: 0 };
    while let Some((f, w)) = r.field() {
        if (f, w) == (1, 2) {
            return r.bytes();
        }
        r.skip(w)?;
    }
    Some(&[])
}

fn decode_layer(data: &[u8]) -> Option<Layer> {
    let mut r = Reader { buf: data, pos: 0 };
    let mut name = String::new();
    let mut extent = 4096;
    let mut keys: Vec<String> = Vec::new();
    let mut values: Vec<Value> = Vec::new();
    let mut raw_features: Vec<&[u8]> = Vec::new();
    while let Some((f, w)) = r.field() {
        match (f, w) {
            (1, 2) => name = String::from_utf8_lossy(r.bytes()?).into_owned(),
            (2, 2) => raw_features.push(r.bytes()?),
            (3, 2) => keys.push(String::from_utf8_lossy(r.bytes()?).into_owned()),
            (4, 2) => values.push(decode_value(r.bytes()?)?),
            (5, 0) => extent = r.varint()? as u32,
            _ => r.skip(w)?,
        }
    }
    let mut features = Vec::with_capacity(raw_features.len());
    for fd in raw_features {
        let mut r = Reader { buf: fd, pos: 0 };
        let (mut id, mut ty, mut tags, mut geom) = (None, GeomType::Unknown, Vec::new(), Vec::new());
        while let Some((f, w)) = r.field() {
            match (f, w) {
                (1, 0) => id = Some(Value::Number(r.varint()? as f64)),
                (2, 2) => tags = packed(r.bytes()?)?,
                (3, 0) => {
                    ty = match r.varint()? {
                        1 => GeomType::Point,
                        2 => GeomType::LineString,
                        3 => GeomType::Polygon,
                        _ => GeomType::Unknown,
                    }
                }
                (4, 2) => geom = packed(r.bytes()?)?,
                _ => r.skip(w)?,
            }
        }
        let mut properties = crate::expression::Object::default();
        for kv in tags.chunks_exact(2) {
            if let (Some(k), Some(v)) = (keys.get(kv[0] as usize), values.get(kv[1] as usize)) {
                properties.insert(k.clone(), v.clone());
            }
        }
        features.push(Feature { id, ty, properties: Rc::new(properties), geometry: decode_geometry(&geom) });
    }
    Some(Layer { name, extent, features })
}

/// Decode a (possibly gzip/zlib-compressed) vector tile, keeping only the layers whose name
/// passes `keep` (the others are skipped undecoded).
pub fn decode(data: &[u8], keep: impl Fn(&[u8]) -> bool) -> Option<Vec<Layer>> {
    let inflated;
    let data = if data.starts_with(&[0x1f, 0x8b]) {
        inflated = inflate_gzip(data)?;
        &inflated[..]
    } else {
        data
    };
    let mut r = Reader { buf: data, pos: 0 };
    let mut layers = Vec::new();
    while let Some((f, w)) = r.field() {
        if (f, w) == (3, 2) {
            let bytes = r.bytes()?;
            if keep(layer_name(bytes)?) {
                layers.push(decode_layer(bytes)?);
            }
        } else {
            r.skip(w)?;
        }
    }
    Some(layers)
}

fn inflate_gzip(data: &[u8]) -> Option<Vec<u8>> {
    // Header: magic(2) method(1) flags(1) mtime(4) xfl(1) os(1), then optional fields.
    let flags = *data.get(3)?;
    let mut pos = 10;
    if flags & 4 != 0 {
        let len = u16::from_le_bytes([*data.get(pos)?, *data.get(pos + 1)?]) as usize;
        pos += 2 + len;
    }
    for bit in [8, 16] {
        if flags & bit != 0 {
            pos += data.get(pos..)?.iter().position(|&b| b == 0)? + 1;
        }
    }
    if flags & 2 != 0 {
        pos += 2;
    }
    miniz_oxide::inflate::decompress_to_vec(data.get(pos..)?).ok()
}

/// MapLibre's overzoom slicing (`sliceVectorTileLayer`): a child tile below the source's
/// maxzoom is cut out of the parent tile, rescaled to the same extent, clipped with a buffer
/// and round-tripped through MVT encoding (whose deltas are truncated to integers).
pub fn slice_layer(layer: &Layer, parent: crate::tile::TileId, target: crate::tile::TileId) -> Layer {
    let extent = layer.extent as f64;
    let scale = (1u64 << (target.z - parent.z)) as f64;
    let ox = (target.x as f64 - parent.x as f64 * scale) * extent;
    let oy = (target.y as f64 - parent.y as f64 * scale) * extent;
    let buffer = 128f64.max((128.0 * extent / 4096.0).round());
    let (lo, hi) = (-buffer, extent + buffer);
    let mut features = Vec::new();
    for f in &layer.features {
        let geom: Vec<Vec<[f64; 2]>> =
            f.geometry.iter().map(|r| r.iter().map(|p| [p[0] as f64 * scale - ox, p[1] as f64 * scale - oy]).collect()).collect();
        let clipped = clip_axis(&clip_axis(&geom, f.ty, lo, hi, 0), f.ty, lo, hi, 1);
        if clipped.is_empty() {
            continue;
        }
        features.push(Feature { id: f.id.clone(), ty: f.ty, properties: f.properties.clone(), geometry: reencode(&clipped, f.ty) });
    }
    Layer { name: layer.name.clone(), extent: layer.extent, features }
}

/// vt-pbf `writeGeometry` + decode: each delta is truncated (`zigzag` uses int32 ops)
/// while the encoder's cursor tracks the exact float position.
fn reencode(geom: &[Vec<[f64; 2]>], ty: GeomType) -> Vec<Vec<[i32; 2]>> {
    let (mut fx, mut fy) = (0.0f64, 0.0f64);
    let (mut ix, mut iy) = (0i64, 0i64);
    let mut out = Vec::new();
    for ring in geom {
        let closed = ty == GeomType::Polygon && ring.len() > 1 && ring[0] == ring[ring.len() - 1];
        let n = if closed { ring.len() - 1 } else { ring.len() };
        let mut r = Vec::with_capacity(ring.len());
        for p in &ring[..n] {
            let (dx, dy) = (p[0] - fx, p[1] - fy);
            ix += dx as i32 as i64;
            iy += dy as i32 as i64;
            fx += dx;
            fy += dy;
            r.push([ix as i32, iy as i32]);
        }
        if ty == GeomType::Polygon
            && let Some(&first) = r.first()
        {
            r.push(first);
        }
        if ty == GeomType::Point {
            out.extend(r.into_iter().map(|p| vec![p]));
        } else {
            out.push(r);
        }
    }
    out
}

/// `clipGeometryOnAxis` (symbol/clip_line.ts).
fn clip_axis(geom: &[Vec<[f64; 2]>], ty: GeomType, start: f64, end: f64, axis: usize) -> Vec<Vec<[f64; 2]>> {
    let mut out = Vec::new();
    match ty {
        GeomType::Point => {
            for p in geom.iter().flatten() {
                if p[axis] >= start && p[axis] <= end {
                    out.push(vec![*p]);
                }
            }
        }
        GeomType::LineString | GeomType::Polygon => {
            let is_polygon = ty == GeomType::Polygon;
            let at = |p: [f64; 2], q: [f64; 2], v: f64| -> [f64; 2] {
                let t = (v - p[axis]) / (q[axis] - p[axis]);
                if axis == 0 { [v, p[1] + (q[1] - p[1]) * t] } else { [p[0] + (q[0] - p[0]) * t, v] }
            };
            for line in geom {
                let mut slice: Vec<[f64; 2]> = Vec::new();
                for w in line.windows(2) {
                    let (p1, p2) = (w[0], w[1]);
                    let (a, b) = (p1[axis], p2[axis]);
                    let mut exited = false;
                    if a < start {
                        if b >= start {
                            slice.push(at(p1, p2, start));
                        }
                    } else if a > end {
                        if b <= end {
                            slice.push(at(p1, p2, end));
                        }
                    } else {
                        slice.push(p1);
                    }
                    if b < start && a >= start {
                        slice.push(at(p1, p2, start));
                        exited = true;
                    }
                    if b > end && a <= end {
                        slice.push(at(p1, p2, end));
                        exited = true;
                    }
                    if !is_polygon && exited {
                        out.push(std::mem::take(&mut slice));
                    }
                }
                if let Some(&last) = line.last()
                    && last[axis] >= start
                    && last[axis] <= end
                {
                    slice.push(last);
                }
                if is_polygon && !slice.is_empty() && slice[0] != slice[slice.len() - 1] {
                    slice.push(slice[0]);
                }
                if !slice.is_empty() {
                    out.push(slice);
                }
            }
        }
        GeomType::Unknown => {}
    }
    out
}
