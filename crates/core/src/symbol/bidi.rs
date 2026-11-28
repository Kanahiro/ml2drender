//! `bidi.ts`: right-to-left text put into visual order, one line at a time. The embedding levels are a
//! port of bidi-js 1.1.0 `getEmbeddingLevels`, which GL JS uses, including that it reads UTF-16 code
//! units (a character outside the BMP is two `L` code units) and that a few scans cross paragraphs.

use super::rtl_data::{
    BIDI_TYPES, CANONICAL_BRACKET, CLOSING_TO_OPENING, JOINS_TO_FOLLOWING, MIRRORS, OPENING_TO_CLOSING, SPACING_MARK,
};
use super::unicode::{find_range, in_sorted_ranges};
use std::collections::HashMap;
use unicode_segmentation::UnicodeSegmentation;

// bidi-js character types, one bit each (in the order of `BIDI_TYPES`'s type index).
const L: u32 = 1;
const R: u32 = 1 << 1;
const EN: u32 = 1 << 2;
const ES: u32 = 1 << 3;
const ET: u32 = 1 << 4;
const AN: u32 = 1 << 5;
const CS: u32 = 1 << 6;
const B: u32 = 1 << 7;
const S: u32 = 1 << 8;
const WS: u32 = 1 << 9;
const ON: u32 = 1 << 10;
const BN: u32 = 1 << 11;
const NSM: u32 = 1 << 12;
const AL: u32 = 1 << 13;
const LRO: u32 = 1 << 14;
const RLO: u32 = 1 << 15;
const LRE: u32 = 1 << 16;
const RLE: u32 = 1 << 17;
const PDF: u32 = 1 << 18;
const LRI: u32 = 1 << 19;
const RLI: u32 = 1 << 20;
const FSI: u32 = 1 << 21;
const PDI: u32 = 1 << 22;

const ISOLATE_INIT: u32 = LRI | RLI | FSI;
const STRONG: u32 = L | R | AL;
const NEUTRAL_ISOLATE: u32 = B | S | WS | ON | FSI | LRI | RLI | PDI;
const BN_LIKE: u32 = BN | RLE | LRE | RLO | LRO | PDF;
const TRAILING: u32 = S | WS | B | ISOLATE_INIT | PDI | BN_LIKE;
const MAX_DEPTH: u8 = 125;

fn lookup(table: &[(u32, u32)], cp: u32) -> Option<u32> {
    table.binary_search_by_key(&cp, |&(a, _)| a).ok().map(|i| table[i].1)
}

/// `getBidiCharType` of one code point (or of a lone UTF-16 code unit).
fn char_type(cp: u32) -> u32 {
    find_range(BIDI_TYPES, cp).map_or(L, |t| 1 << t)
}

pub struct Paragraph {
    pub start: usize,
    /// Inclusive.
    pub end: usize,
    pub level: u8,
}

/// `getEmbeddingLevels(string)` (automatic base direction) over UTF-16 code units.
pub fn embedding_levels(units: &[u16]) -> (Vec<u8>, Vec<Paragraph>) {
    let n = units.len();
    let original: Vec<u32> = units.iter().map(|&u| char_type(u as u32)).collect();
    let mut types = original.clone();
    let mut levels = vec![0u8; n];
    let mut isolation_pairs: HashMap<usize, usize> = HashMap::new();

    // 3.3.1 P1-P3.
    let mut paragraphs: Vec<Paragraph> = Vec::new();
    let mut open = false;
    for i in 0..n {
        if !open {
            paragraphs.push(Paragraph { start: i, end: n - 1, level: auto_level(&types, i, false) });
            open = true;
        }
        if types[i] & B != 0 {
            paragraphs.last_mut().unwrap().end = i;
            open = false;
        }
    }

    const FORMATTING: u32 = RLE | LRE | RLO | LRO | ISOLATE_INIT | PDI | PDF | B;
    let next_even = |l: u8| l + if l & 1 != 0 { 1 } else { 2 };
    let next_odd = |l: u8| l + if l & 1 != 0 { 2 } else { 1 };

    struct Status {
        level: u8,
        override_: u32,
        isolate: bool,
        isol_init: Option<usize>,
    }
    struct Run {
        start: usize,
        end: usize,
        level: u8,
        starts_with_pdi: bool,
        ends_with_isol_init: bool,
    }

    for p in &paragraphs {
        let mut stack = vec![Status { level: p.level, override_: 0, isolate: false, isol_init: None }];
        let mut overflow_isolates = 0usize;
        let mut overflow_embeddings = 0usize;
        let mut valid_isolates = 0usize;

        // 3.3.2 Explicit levels and directions.
        for i in p.start..=p.end {
            let mut t = types[i];
            let top = stack.last().unwrap();
            let (top_level, top_override) = (top.level, top.override_);
            if t & FORMATTING != 0 {
                if t & (RLE | LRE) != 0 {
                    levels[i] = top_level;
                    let level = if t == RLE { next_odd(top_level) } else { next_even(top_level) };
                    if level <= MAX_DEPTH && overflow_isolates == 0 && overflow_embeddings == 0 {
                        stack.push(Status { level, override_: 0, isolate: false, isol_init: None });
                    } else if overflow_isolates == 0 {
                        overflow_embeddings += 1;
                    }
                } else if t & (RLO | LRO) != 0 {
                    levels[i] = top_level;
                    let level = if t == RLO { next_odd(top_level) } else { next_even(top_level) };
                    if level <= MAX_DEPTH && overflow_isolates == 0 && overflow_embeddings == 0 {
                        let override_ = if t & RLO != 0 { R } else { L };
                        stack.push(Status { level, override_, isolate: false, isol_init: None });
                    } else if overflow_isolates == 0 {
                        overflow_embeddings += 1;
                    }
                } else if t & ISOLATE_INIT != 0 {
                    if t & FSI != 0 {
                        t = if auto_level(&types, i + 1, true) == 1 { RLI } else { LRI };
                    }
                    levels[i] = top_level;
                    if top_override != 0 {
                        types[i] = top_override;
                    }
                    let level = if t == RLI { next_odd(top_level) } else { next_even(top_level) };
                    if level <= MAX_DEPTH && overflow_isolates == 0 && overflow_embeddings == 0 {
                        valid_isolates += 1;
                        stack.push(Status { level, override_: 0, isolate: true, isol_init: Some(i) });
                    } else {
                        overflow_isolates += 1;
                    }
                } else if t & PDI != 0 {
                    if overflow_isolates > 0 {
                        overflow_isolates -= 1;
                    } else if valid_isolates > 0 {
                        overflow_embeddings = 0;
                        while !stack.last().unwrap().isolate {
                            stack.pop();
                        }
                        if let Some(init) = stack.last().unwrap().isol_init {
                            isolation_pairs.insert(init, i);
                            isolation_pairs.insert(i, init);
                        }
                        stack.pop();
                        valid_isolates -= 1;
                    }
                    let top = stack.last().unwrap();
                    levels[i] = top.level;
                    if top.override_ != 0 {
                        types[i] = top.override_;
                    }
                } else if t & PDF != 0 {
                    if overflow_isolates == 0 {
                        if overflow_embeddings > 0 {
                            overflow_embeddings -= 1;
                        } else if !stack.last().unwrap().isolate && stack.len() > 1 {
                            stack.pop();
                        }
                    }
                    levels[i] = stack.last().unwrap().level;
                } else if t & B != 0 {
                    levels[i] = p.level;
                }
            } else {
                levels[i] = top_level;
                if top_override != 0 && t != BN {
                    types[i] = top_override;
                }
            }
        }

        // 3.3.3 X10: isolating run sequences (BD13).
        let mut runs: Vec<Run> = Vec::new();
        for i in p.start..=p.end {
            let t = types[i];
            if t & BN_LIKE != 0 {
                continue;
            }
            let level = levels[i];
            let isol_init = t & ISOLATE_INIT != 0;
            match runs.last_mut() {
                Some(run) if run.level == level => {
                    run.end = i;
                    run.ends_with_isol_init = isol_init;
                }
                _ => runs.push(Run {
                    start: i,
                    end: i,
                    level,
                    starts_with_pdi: t == PDI,
                    ends_with_isol_init: isol_init,
                }),
            }
        }
        let mut sequences: Vec<(Vec<usize>, u32, u32)> = Vec::new();
        for (run_idx, run) in runs.iter().enumerate() {
            if run.starts_with_pdi && isolation_pairs.contains_key(&run.start) {
                continue;
            }
            let mut seq_runs = vec![run];
            let mut current = run;
            while current.ends_with_isol_init {
                let Some(&pdi) = isolation_pairs.get(&current.end) else { break };
                let Some(next) = runs[run_idx + 1..].iter().find(|r| r.start == pdi) else { break };
                seq_runs.push(next);
                current = next;
            }
            let seq: Vec<usize> = seq_runs.iter().flat_map(|r| r.start..=r.end).collect();
            let first_level = levels[seq[0]];
            let prev_level = (0..seq[0]).rev().find(|&i| types[i] & BN_LIKE == 0).map_or(p.level, |i| levels[i]);
            let last = *seq.last().unwrap();
            let last_level = levels[last];
            let next_level = if types[last] & ISOLATE_INIT == 0 {
                (last + 1..=p.end).find(|&i| types[i] & BN_LIKE == 0).map_or(p.level, |i| levels[i])
            } else {
                p.level
            };
            let sos = if prev_level.max(first_level) % 2 != 0 { R } else { L };
            let eos = if next_level.max(last_level) % 2 != 0 { R } else { L };
            sequences.push((seq, sos, eos));
        }

        for (seq, sos, eos) in &sequences {
            let (sos, eos) = (*sos, *eos);
            let len = seq.len();
            let embed_direction = if levels[seq[0]] & 1 != 0 { R } else { L };

            // W1.
            for si in 0..len {
                let i = seq[si];
                if types[i] & NSM != 0 {
                    let prev = (0..si).rev().map(|sj| types[seq[sj]]).find(|&t| t & BN_LIKE == 0).unwrap_or(sos);
                    types[i] = if prev & (ISOLATE_INIT | PDI) != 0 { ON } else { prev };
                }
            }
            // W2.
            for si in 0..len {
                let i = seq[si];
                if types[i] & EN != 0 {
                    for sj in (-1..si as isize).rev() {
                        let prev = if sj == -1 { sos } else { types[seq[sj as usize]] };
                        if prev & STRONG != 0 {
                            if prev == AL {
                                types[i] = AN;
                            }
                            break;
                        }
                    }
                }
            }
            // W3.
            for &i in seq {
                if types[i] & AL != 0 {
                    types[i] = R;
                }
            }
            // W4.
            for si in 1..len.saturating_sub(1) {
                let i = seq[si];
                if types[i] & (ES | CS) != 0 {
                    let mut prev = 0;
                    for sj in (0..si).rev() {
                        prev = types[seq[sj]];
                        if prev & BN_LIKE == 0 {
                            break;
                        }
                    }
                    let mut next = 0;
                    for &j in &seq[si + 1..] {
                        next = types[j];
                        if next & BN_LIKE == 0 {
                            break;
                        }
                    }
                    if prev == next && (if types[i] == ES { prev == EN } else { prev & (EN | AN) != 0 }) {
                        types[i] = prev;
                    }
                }
            }
            // W5.
            let mut si = 0;
            while si < len {
                if types[seq[si]] & EN != 0 {
                    let mut sj = si as isize - 1;
                    while sj >= 0 && types[seq[sj as usize]] & (ET | BN_LIKE) != 0 {
                        types[seq[sj as usize]] = EN;
                        sj -= 1;
                    }
                    si += 1;
                    while si < len && types[seq[si]] & (ET | BN_LIKE | EN) != 0 {
                        types[seq[si]] = EN;
                        si += 1;
                    }
                }
                si += 1;
            }
            // W6.
            for si in 0..len {
                if types[seq[si]] & (ET | ES | CS) != 0 {
                    types[seq[si]] = ON;
                    for sj in (0..si).rev() {
                        if types[seq[sj]] & BN_LIKE == 0 {
                            break;
                        }
                        types[seq[sj]] = ON;
                    }
                    for &j in &seq[si + 1..] {
                        if types[j] & BN_LIKE == 0 {
                            break;
                        }
                        types[j] = ON;
                    }
                }
            }
            // W7.
            let mut prev_strong = sos;
            for &i in seq {
                let t = types[i];
                if t & EN != 0 {
                    if prev_strong == L {
                        types[i] = L;
                    }
                } else if t & STRONG != 0 {
                    prev_strong = t;
                }
            }

            // N0: bracket pairs (BD16), where EN and AN count as R.
            const R_FOR_N: u32 = R | EN | AN;
            const STRONG_FOR_N: u32 = R_FOR_N | L;
            let mut pairs: Vec<(usize, usize)> = Vec::new();
            let mut openers: Vec<(u32, usize)> = Vec::new();
            for si in 0..len {
                if types[seq[si]] & NEUTRAL_ISOLATE == 0 {
                    continue;
                }
                let c = units[seq[si]] as u32;
                if lookup(OPENING_TO_CLOSING, c).is_some() {
                    if openers.len() < 63 {
                        openers.push((c, si));
                    } else {
                        break;
                    }
                } else if let Some(opposite) = lookup(CLOSING_TO_OPENING, c) {
                    let canonical_opener = lookup(CANONICAL_BRACKET, c).and_then(|k| lookup(CLOSING_TO_OPENING, k));
                    for k in (0..openers.len()).rev() {
                        let opener = openers[k].0;
                        if opener == opposite
                            || Some(opener) == canonical_opener
                            || lookup(CANONICAL_BRACKET, opener).and_then(|k| lookup(OPENING_TO_CLOSING, k)) == Some(c)
                        {
                            pairs.push((openers[k].1, si));
                            openers.truncate(k);
                            break;
                        }
                    }
                }
            }
            pairs.sort_by_key(|&(open, _)| open);
            for &(open, close) in &pairs {
                let mut found_strong = false;
                let mut use_strong = 0;
                for &i in &seq[open + 1..close] {
                    if types[i] & STRONG_FOR_N != 0 {
                        found_strong = true;
                        let lr = if types[i] & R_FOR_N != 0 { R } else { L };
                        if lr == embed_direction {
                            use_strong = lr;
                            break;
                        }
                    }
                }
                if found_strong && use_strong == 0 {
                    use_strong = sos;
                    if let Some(&i) = seq[..open].iter().rev().find(|&&i| types[i] & STRONG_FOR_N != 0) {
                        let lr = if types[i] & R_FOR_N != 0 { R } else { L };
                        use_strong = if lr != embed_direction { lr } else { embed_direction };
                    }
                }
                if use_strong != 0 {
                    types[seq[open]] = use_strong;
                    types[seq[close]] = use_strong;
                    if use_strong != embed_direction {
                        for from in [open, close] {
                            if let Some(&i) = seq[from + 1..].iter().find(|&&i| types[i] & BN_LIKE == 0)
                                && original[i] & NSM != 0
                            {
                                types[i] = use_strong;
                            }
                        }
                    }
                }
            }

            // N1, N2.
            let mut si = 0;
            while si < len {
                if types[seq[si]] & NEUTRAL_ISOLATE != 0 {
                    let (mut run_start, mut run_end) = (si, si);
                    let mut prev = sos;
                    for si2 in (0..si).rev() {
                        if types[seq[si2]] & BN_LIKE != 0 {
                            run_start = si2;
                        } else {
                            prev = if types[seq[si2]] & R_FOR_N != 0 { R } else { L };
                            break;
                        }
                    }
                    let mut next = eos;
                    for (si2, &i) in seq.iter().enumerate().skip(si + 1) {
                        if types[i] & (NEUTRAL_ISOLATE | BN_LIKE) != 0 {
                            run_end = si2;
                        } else {
                            next = if types[i] & R_FOR_N != 0 { R } else { L };
                            break;
                        }
                    }
                    let t = if prev == next { prev } else { embed_direction };
                    for &i in &seq[run_start..=run_end] {
                        types[i] = t;
                    }
                    si = run_end;
                }
                si += 1;
            }
        }

        // 3.3.6 I1, I2, then 5.2 and L1 as bidi-js applies them.
        for i in p.start..=p.end {
            let t = types[i];
            if levels[i] & 1 != 0 {
                if t & (L | EN | AN) != 0 {
                    levels[i] += 1;
                }
            } else if t & R != 0 {
                levels[i] += 1;
            } else if t & (AN | EN) != 0 {
                levels[i] += 2;
            }
            if t & BN_LIKE != 0 {
                levels[i] = if i == 0 { p.level } else { levels[i - 1] };
            }
            if i == p.end || original[i] & (S | B) != 0 {
                for j in (0..=i).rev() {
                    if original[j] & TRAILING == 0 {
                        break;
                    }
                    levels[j] = p.level;
                }
            }
        }
    }
    (levels, paragraphs)
}

/// `determineAutoEmbedLevel` (P2, P3).
fn auto_level(types: &[u32], start: usize, is_fsi: bool) -> u8 {
    let mut i = start;
    while i < types.len() {
        let t = types[i];
        if t & (R | AL) != 0 {
            return 1;
        }
        if t & (B | L) != 0 || (is_fsi && t == PDI) {
            return 0;
        }
        if t & ISOLATE_INIT != 0 {
            i = matching_pdi(types, i).unwrap_or(types.len());
        }
        i += 1;
    }
    0
}

/// `indexOfMatchingPDI` (BD9).
fn matching_pdi(types: &[u32], start: usize) -> Option<usize> {
    let mut depth = 1;
    for (i, &t) in types.iter().enumerate().skip(start + 1) {
        if t & B != 0 {
            break;
        }
        if t & PDI != 0 {
            depth -= 1;
            if depth == 0 {
                return Some(i);
            }
        } else if t & ISOLATE_INIT != 0 {
            depth += 1;
        }
    }
    None
}

/// `BIDI_CONTROLS`: dropped once the text is reordered.
fn is_bidi_control(c: char) -> bool {
    matches!(c as u32, 0x061C | 0x200E | 0x200F | 0x202A..=0x202E | 0x2066..=0x2069)
}

/// `toGraphemes`: extended grapheme clusters, rejoined where `canCombineGraphemes` says (after an
/// invisible stacker or ZWJ, before a spacing mark), as byte ranges of `text`.
fn graphemes(text: &str) -> Vec<(usize, usize)> {
    let mut out: Vec<(usize, usize)> = Vec::new();
    for (start, g) in text.grapheme_indices(true) {
        let end = start + g.len();
        if let Some(last) = out.last_mut() {
            let former_last = text[..start].chars().next_back().map_or(0, |c| c as u32);
            let latter_first = g.chars().next().map_or(0, |c| c as u32);
            if in_sorted_ranges(JOINS_TO_FOLLOWING, former_last) || in_sorted_ranges(SPACING_MARK, latter_first) {
                last.1 = end;
                continue;
            }
        }
        out.push((start, end));
    }
    out
}

struct Cluster {
    /// Byte range in the whole text.
    start: usize,
    end: usize,
    level: u8,
}

/// `processStyledBidirectionalText` over characters: `breaks` are character indices to break the
/// lines at, and each output character carries the section of the cluster it came from.
pub fn process_lines(chars: &[char], sections: &[usize], breaks: &[usize]) -> Vec<(Vec<char>, Vec<usize>)> {
    let text: String = chars.iter().collect();
    let units: Vec<u16> = text.encode_utf16().collect();
    // Code unit and byte offset of each character, plus one past the end.
    let mut unit_at = Vec::with_capacity(chars.len() + 1);
    let mut byte_at = Vec::with_capacity(chars.len() + 1);
    let (mut u, mut b) = (0, 0);
    for &c in chars {
        unit_at.push(u);
        byte_at.push(b);
        u += c.len_utf16();
        b += c.len_utf8();
    }
    unit_at.push(u);
    byte_at.push(b);
    let char_of_unit = |unit: usize| unit_at.partition_point(|&x| x < unit);

    let (levels, paragraphs) = embedding_levels(&units);
    // lineRanges: the requested breaks and every paragraph start, deduplicated.
    let mut bounds: Vec<usize> = breaks.iter().map(|&i| unit_at[i.min(chars.len())]).collect();
    bounds.extend(paragraphs.iter().map(|p| p.start));
    bounds.retain(|&p| p > 0 && p < units.len());
    bounds.push(0);
    bounds.push(units.len());
    bounds.sort_unstable();
    bounds.dedup();

    let mut lines = Vec::new();
    for w in bounds.windows(2) {
        let (start, end) = (char_of_unit(w[0]), char_of_unit(w[1]));
        let paragraph_level = paragraphs.iter().find(|p| w[0] >= p.start && w[0] <= p.end).map_or(0, |p| p.level);
        let (b0, b1) = (byte_at[start], byte_at[end]);
        let mut clusters: Vec<Cluster> = graphemes(&text[b0..b1])
            .into_iter()
            .map(|(s, e)| {
                let level = levels[unit_at[byte_at.partition_point(|&x| x < b0 + s)]];
                Cluster { start: b0 + s, end: b0 + e, level }
            })
            .collect();

        // resetTrailingNeutrals (L1), by the type of each cluster's first code unit.
        let mut trailing = true;
        for c in clusters.iter_mut().rev() {
            let t = char_type(units[unit_at[byte_at.partition_point(|&x| x < c.start)]] as u32);
            if t & (S | B) != 0 {
                c.level = paragraph_level;
                trailing = true;
            } else if trailing && t & (WS | FSI | LRI | RLI | PDI) != 0 {
                c.level = paragraph_level;
            } else {
                trailing = false;
            }
        }

        // reorder (L2).
        let highest = clusters.iter().map(|c| c.level).max().unwrap_or(0).max(paragraph_level);
        let lowest_odd = clusters.iter().map(|c| c.level | 1).min().unwrap_or(u8::MAX);
        let mut level = highest;
        while level >= lowest_odd {
            let mut s = 0;
            while s < clusters.len() {
                if clusters[s].level < level {
                    s += 1;
                    continue;
                }
                let mut e = s;
                while e + 1 < clusters.len() && clusters[e + 1].level >= level {
                    e += 1;
                }
                clusters[s..=e].reverse();
                s = e + 1;
            }
            level -= 1;
        }

        let mut line = (Vec::new(), Vec::new());
        for c in &clusters {
            let s = &text[c.start..c.end];
            if s.chars().any(is_bidi_control) {
                continue;
            }
            let section = sections[byte_at.partition_point(|&x| x < c.start)];
            let mut it = s.chars();
            let mirrored = match (it.next(), it.next()) {
                (Some(ch), None) if c.level % 2 == 1 => lookup(MIRRORS, ch as u32).and_then(char::from_u32),
                _ => None,
            };
            match mirrored {
                Some(m) => {
                    line.0.push(m);
                    line.1.push(section);
                }
                None => {
                    for ch in s.chars() {
                        line.0.push(ch);
                        line.1.push(section);
                    }
                }
            }
        }
        lines.push(line);
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::process_lines;

    fn lines(text: &str, breaks: &[usize]) -> Vec<String> {
        let chars: Vec<char> = text.chars().collect();
        process_lines(&chars, &vec![0; chars.len()], breaks).into_iter().map(|(l, _)| l.into_iter().collect()).collect()
    }

    /// The cases of GL JS `bidi.test.ts` (breaks are character indices here).
    #[test]
    fn reorders_as_gl_js() {
        assert_eq!(lines("hello world", &[]), ["hello world"]);
        assert_eq!(lines("שלום", &[]), ["םולש"]);
        assert_eq!(lines("hello שלום world", &[]), ["hello םולש world"]);
        assert_eq!(lines("שלום hello עולם", &[]), ["םלוע hello םולש"]);
        assert_eq!(lines("שלום 123", &[]), ["123 םולש"]);
        assert_eq!(lines("שלום (עולם)", &[]), ["(םלוע) םולש"]);
        assert_eq!(lines("שלום עולם טוב", &[5, 10]), [" םולש", " םלוע", "בוט"]);
        assert_eq!(lines("שלום ", &[]), [" םולש"]);
        assert_eq!(lines("hello\u{200f}world", &[]), ["helloworld"]);
        assert_eq!(lines("שלום 😀 עולם", &[]), ["םלוע 😀 םולש"]);
        assert_eq!(lines("", &[]), Vec::<String>::new());
    }

    #[test]
    fn carries_sections() {
        let section_of = |text: &str, breaks: &[usize]| {
            let chars: Vec<char> = text.chars().collect();
            let sections: Vec<usize> = (0..chars.len()).collect();
            process_lines(&chars, &sections, breaks)
                .into_iter()
                .map(|(l, s)| (l.into_iter().collect::<String>(), s))
                .collect::<Vec<_>>()
        };
        assert_eq!(section_of("ab שלום", &[]), [("ab םולש".to_string(), vec![0, 1, 2, 6, 5, 4, 3])]);
        assert_eq!(section_of("😀ש", &[]), [("😀ש".to_string(), vec![0, 1])]);
        assert_eq!(section_of("ab\u{200f}cd", &[]), [("abcd".to_string(), vec![0, 1, 3, 4])]);
        // A mark moves with its letter.
        assert_eq!(lines("\u{5e9}\u{5c1}\u{5dc}", &[]), ["\u{5dc}\u{5e9}\u{5c1}"]);
        // bidi-js reads a character outside the BMP as left to right.
        assert_eq!(lines("🕌 مسجد", &[]), ["🕌 دجسم"]);
    }
}
