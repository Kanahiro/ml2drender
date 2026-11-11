//! SDF glyph ranges (`glyphs` URL, PBF): parsing and the per-fontstack store.
//!
//! Like MapLibre's `GlyphManager` with a glyphs URL and no `font-faces`/local fonts: each
//! codepoint comes from the 256-codepoint range file of its font stack. A range that fails to
//! load leaves its glyphs missing (MapLibre would draw them with the browser's fonts instead).

use crate::mvt::Reader;
use crate::hash::HashMap;
use std::collections::BTreeSet;
use std::rc::Rc;

/// SDF border around each glyph bitmap (`GLYPH_PBF_BORDER`).
pub const BORDER: i32 = 3;

#[derive(Debug, Clone, Copy, Default)]
pub struct Metrics {
    pub width: f64,
    pub height: f64,
    pub left: f64,
    pub top: f64,
    pub advance: f64,
}

#[derive(Debug)]
pub struct Glyph {
    /// Alpha SDF, `(width + 2*BORDER) x (height + 2*BORDER)`.
    pub bitmap: Vec<u8>,
    pub bw: usize,
    pub bh: usize,
    pub metrics: Metrics,
}

fn zigzag(v: u64) -> i64 {
    ((v >> 1) as i64) ^ -((v & 1) as i64)
}

fn parse_glyph(data: &[u8]) -> Option<(u32, Glyph)> {
    let mut r = Reader { buf: data, pos: 0 };
    let (mut id, mut bitmap, mut m) = (0u32, Vec::new(), Metrics::default());
    while let Some((field, wire)) = r.field() {
        match (field, wire) {
            (1, 0) => id = r.varint()? as u32,
            (2, 2) => bitmap = r.bytes()?.to_vec(),
            (3, 0) => m.width = r.varint()? as f64,
            (4, 0) => m.height = r.varint()? as f64,
            (5, 0) => m.left = zigzag(r.varint()?) as f64,
            (6, 0) => m.top = zigzag(r.varint()?) as f64,
            (7, 0) => m.advance = r.varint()? as f64,
            (_, w) => r.skip(w)?,
        }
    }
    let (bw, bh) = (m.width as usize + 2 * BORDER as usize, m.height as usize + 2 * BORDER as usize);
    // Even an empty glyph (a space) gets a zero-filled bitmap and so an atlas rect and a quad.
    bitmap.resize(bw * bh, 0);
    Some((id, Glyph { bitmap, bw, bh, metrics: m }))
}

/// `parseGlyphPbf`: glyphs → stacks (field 1) → glyph (field 3).
pub fn parse(data: &[u8]) -> HashMap<u32, Rc<Glyph>> {
    let mut out = HashMap::default();
    let mut r = Reader { buf: data, pos: 0 };
    while let Some((field, wire)) = r.field() {
        let Some(stack) = (if (field, wire) == (1, 2) { r.bytes() } else { r.skip(wire).map(|_| &[][..]) }) else { break };
        let mut s = Reader { buf: stack, pos: 0 };
        while let Some((field, wire)) = s.field() {
            if (field, wire) == (3, 2) {
                if let Some((id, g)) = s.bytes().and_then(parse_glyph) {
                    out.insert(id, Rc::new(g));
                }
            } else if s.skip(wire).is_none() {
                break;
            }
        }
    }
    out
}

/// Glyphs of one range by code point.
type Range = HashMap<u32, Rc<Glyph>>;

/// Loaded glyph ranges by font stack (`"Font A,Font B"`) and range index (`codepoint / 256`).
/// `None` = the range failed to load.
#[derive(Default)]
pub struct Glyphs {
    pub url: Option<String>,
    ranges: HashMap<(String, u32), Option<Range>>,
}

impl Glyphs {
    pub fn new(url: Option<&str>) -> Glyphs {
        Glyphs { url: url.map(String::from), ranges: HashMap::default() }
    }

    pub fn range_url(&self, stack: &str, range: u32) -> Option<String> {
        let begin = range * 256;
        Some(self.url.as_ref()?.replace("{fontstack}", stack).replace("{range}", &format!("{begin}-{}", begin + 255)))
    }

    /// URLs of the ranges in `deps` not provided yet, with their keys.
    pub fn needs(&self, deps: &BTreeSet<(String, u32)>) -> Vec<(String, (String, u32))> {
        deps.iter().filter(|k| !self.ranges.contains_key(*k)).filter_map(|k| Some((self.range_url(&k.0, k.1)?, k.clone()))).collect()
    }

    pub fn provide(&mut self, key: (String, u32), bytes: Option<&[u8]>) {
        self.ranges.entry(key).or_insert_with(|| bytes.map(parse));
    }

    pub fn get(&self, stack: &str, c: char) -> Option<&Rc<Glyph>> {
        let cp = c as u32;
        self.ranges.get(&(stack.to_string(), cp / 256))?.as_ref()?.get(&cp)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_fixture_range() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/render/assets/glyphs/Open Sans Semibold,Arial Unicode MS Bold/0-255.pbf");
        let Ok(bytes) = std::fs::read(path) else { return };
        let glyphs = parse(&bytes);
        let a = &glyphs[&('A' as u32)];
        assert!(a.metrics.advance > 0.0 && a.bitmap.iter().any(|&v| v > 192));
        assert_eq!(a.bitmap.len(), a.bw * a.bh);
        assert_eq!(glyphs[&(' ' as u32)].bw, 6);
    }
}
