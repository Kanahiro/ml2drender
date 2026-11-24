//! Bidirectional reordering of a label's lines (`bidi.ts`). Embedding levels come from the
//! `unicode-bidi` crate (UAX #9 up to rule I2); line rules L1 and L2 and mirroring are applied here,
//! one cluster at a time so that a letter and the marks written on it move together (rule L3).

use unicode_bidi::{BidiClass, BidiInfo};

use super::rtl_data::{MIRRORED, RTL_SCRIPTS};

/// `codePointIsInRTLScript`.
pub fn is_rtl(c: char) -> bool {
    let cp = c as u32;
    in_ranges(cp, RTL_SCRIPTS)
}

/// Whether `cp` is in one of the sorted, disjoint inclusive `ranges`.
pub fn in_ranges(cp: u32, ranges: &[(u32, u32)]) -> bool {
    let i = ranges.partition_point(|&(_, b)| b < cp);
    ranges.get(i).is_some_and(|&(a, _)| a <= cp)
}

/// `stringContainsRTLText`.
pub fn contains_rtl(chars: &[char]) -> bool {
    chars.iter().any(|&c| is_rtl(c))
}

/// Characters that steer the algorithm without being drawn.
fn is_bidi_control(c: char) -> bool {
    matches!(c, '\u{061c}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
}

fn is_regional_indicator(c: char) -> bool {
    matches!(c, '\u{1f1e6}'..='\u{1f1ff}')
}

/// Whether `c` belongs to the cluster of the character before it, `prev`. `open_flag` is whether
/// the cluster so far is a single regional indicator, which pairs with the next one.
// ponytail: an approximation of extended grapheme clusters (marks, joiners and what a ZWJ joins,
// emoji modifiers, flags and CR LF), which is what keeps a right-to-left letter and its marks together.
fn extends_cluster(prev: char, c: char, open_flag: bool) -> bool {
    // A bidi control is dropped with its cluster, so nothing is attached to it.
    !is_bidi_control(prev) && unicode_normalization::char::is_combining_mark(c)
        || matches!(c, '\u{200c}' | '\u{200d}' | '\u{1f3fb}'..='\u{1f3ff}')
        || prev == '\u{200d}'
        || (open_flag && is_regional_indicator(c))
        || (prev == '\r' && c == '\n')
}

fn mirror(c: char) -> char {
    match MIRRORED.binary_search_by_key(&(c as u32), |e| e.0) {
        Ok(i) => char::from_u32(MIRRORED[i].1).unwrap_or(c),
        Err(_) => c,
    }
}

struct Cluster {
    start: usize,
    end: usize,
    level: u8,
}

/// Rule L1: separators, and whitespace and isolates before them or at the end of the line, take
/// the paragraph level.
fn reset_trailing_neutrals(clusters: &mut [Cluster], classes: &[BidiClass], paragraph_level: u8) {
    let mut trailing = true;
    for cl in clusters.iter_mut().rev() {
        match classes[cl.start] {
            BidiClass::S | BidiClass::B => {
                cl.level = paragraph_level;
                trailing = true;
            }
            // Embedding controls and boundary neutrals count as well: rule X9 takes them out of the text.
            BidiClass::WS
            | BidiClass::FSI
            | BidiClass::LRI
            | BidiClass::RLI
            | BidiClass::PDI
            | BidiClass::BN
            | BidiClass::LRE
            | BidiClass::RLE
            | BidiClass::LRO
            | BidiClass::RLO
            | BidiClass::PDF
                if trailing =>
            {
                cl.level = paragraph_level;
            }
            _ => trailing = false,
        }
    }
}

/// Rule L2: from the highest level down to the lowest odd one, reverse every run at that level or above.
fn reorder(clusters: &mut [Cluster], paragraph_level: u8) {
    let highest = clusters.iter().map(|c| c.level).max().unwrap_or(0).max(paragraph_level);
    let Some(lowest_odd) = clusters.iter().map(|c| c.level | 1).min() else { return };
    let mut level = highest;
    while level >= lowest_odd {
        let mut start = 0;
        while start < clusters.len() {
            if clusters[start].level < level {
                start += 1;
                continue;
            }
            let mut end = start;
            while end + 1 < clusters.len() && clusters[end + 1].level >= level {
                end += 1;
            }
            clusters[start..=end].reverse();
            start = end + 1;
        }
        level -= 1;
    }
}

/// `processLines`: breaks `chars` at `breaks` and at every paragraph start, and puts each line in
/// visual order. Each output character comes with the index of the input character it came from
/// (the start of its cluster).
pub fn reorder_lines(chars: &[char], breaks: &[usize]) -> Vec<Vec<(char, usize)>> {
    let text: String = chars.iter().collect();
    let info = BidiInfo::new(&text, None);
    let byte_of: Vec<usize> = text.char_indices().map(|(b, _)| b).collect();
    let levels: Vec<u8> = byte_of.iter().map(|&b| info.levels[b].number()).collect();
    let classes: Vec<BidiClass> = byte_of.iter().map(|&b| info.original_classes[b]).collect();
    let char_at = |byte: usize| byte_of.partition_point(|&b| b < byte);
    let paragraphs: Vec<(usize, usize, u8)> =
        info.paragraphs.iter().map(|p| (char_at(p.range.start), char_at(p.range.end), p.level.number())).collect();

    let n = chars.len();
    let mut bounds: Vec<usize> =
        breaks.iter().copied().chain(paragraphs.iter().map(|p| p.0)).filter(|&b| b > 0 && b < n).collect();
    bounds.push(0);
    bounds.push(n);
    bounds.sort_unstable();
    bounds.dedup();

    bounds
        .windows(2)
        .map(|w| {
            let (start, end) = (w[0], w[1]);
            let paragraph_level = paragraphs.iter().find(|p| start >= p.0 && start < p.1).map_or(0, |p| p.2);
            let mut clusters = Vec::new();
            let mut i = start;
            while i < end {
                let mut j = i + 1;
                let mut open_flag = is_regional_indicator(chars[i]);
                while j < end && extends_cluster(chars[j - 1], chars[j], open_flag) {
                    open_flag = false;
                    j += 1;
                }
                clusters.push(Cluster { start: i, end: j, level: levels[i] });
                i = j;
            }
            reset_trailing_neutrals(&mut clusters, &classes, paragraph_level);
            reorder(&mut clusters, paragraph_level);
            let mut line = Vec::with_capacity(end - start);
            for cl in &clusters {
                let text = &chars[cl.start..cl.end];
                if text.iter().any(|&c| is_bidi_control(c)) {
                    continue;
                }
                // Only a cluster of one character has a mirror image (`getMirroredCharacter`).
                let mirrored = cl.level % 2 == 1 && text.len() == 1;
                line.extend(text.iter().map(|&c| (if mirrored { mirror(c) } else { c }, cl.start)));
            }
            line
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(text: &str, breaks: &[usize]) -> Vec<String> {
        let chars: Vec<char> = text.chars().collect();
        reorder_lines(&chars, breaks).into_iter().map(|l| l.into_iter().map(|(c, _)| c).collect()).collect()
    }

    #[test]
    fn detects_rtl() {
        assert!(is_rtl('א') && is_rtl('ب') && is_rtl('\u{fefb}'));
        // Marks are of the Inherited script, so they do not make text right to left on their own.
        assert!(!is_rtl('a') && !is_rtl('1') && !is_rtl(' ') && !is_rtl('\u{064e}'));
    }

    // Cases from maplibre-gl-js test/unit/symbol/bidi.test.ts.
    #[test]
    fn reverses_rtl_runs() {
        assert_eq!(lines("שלום", &[]), ["םולש"]);
        assert_eq!(lines("abc שלום def", &[]), ["abc םולש def"]);
        // Numbers keep their order inside right-to-left text.
        assert_eq!(lines("שלום 123", &[]), ["123 םולש"]);
    }

    #[test]
    fn mirrors_brackets() {
        assert_eq!(lines("(שלום)", &[]), ["(םולש)"]);
    }

    #[test]
    fn breaks_then_reorders_each_line() {
        // Broken after the space, each line is reordered on its own; the trailing space takes the
        // paragraph's direction (L1) and ends up on the left.
        assert_eq!(lines("אבג דהו", &[4]), [" גבא", "והד"]);
    }

    #[test]
    fn paragraphs_take_their_own_direction() {
        assert_eq!(lines("abc\nשלום", &[]), ["abc\n", "םולש"]);
    }

    #[test]
    fn keeps_marks_after_their_letter() {
        // שָׁ (shin, qamats, shin dot) then lamed: the marks stay after the shin.
        assert_eq!(lines("\u{05e9}\u{05b8}\u{05c1}\u{05dc}", &[]), ["\u{05dc}\u{05e9}\u{05b8}\u{05c1}"]);
    }

    #[test]
    fn keeps_emoji_sequences_and_flags_whole() {
        // A family (ZWJ sequence), a thumbs up with a skin tone and two flags inside right-to-left text.
        let family = "\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}";
        let thumbs = "\u{1f44d}\u{1f3fd}";
        let flags = "\u{1f1ef}\u{1f1f5}\u{1f1eb}\u{1f1f7}";
        assert_eq!(lines(&format!("א{family}ב"), &[]), [format!("ב{family}א")]);
        assert_eq!(lines(&format!("א{thumbs}ב"), &[]), [format!("ב{thumbs}א")]);
        // Regional indicators are left to right, so the flags also keep their order.
        assert_eq!(lines(&format!("א{flags}ב"), &[]), [format!("ב{flags}א")]);
    }

    #[test]
    fn orders_mixed_arabic_numbers_and_latin() {
        // Numbers and Latin keep their own order inside a right-to-left paragraph.
        assert_eq!(lines("12 - شارع", &[]), ["عراش - 12"]);
        assert_eq!(lines("شارع Cafe", &[]), ["Cafe عراش"]);
        assert_eq!(lines("Cafe شارع", &[]), ["Cafe عراش"]);
    }

    #[test]
    fn resets_whitespace_before_trailing_controls() {
        // The space before the closing PDF is trailing whitespace once the control is taken out.
        assert_eq!(lines("abc \u{202b}אבג \u{202c}", &[]), ["abc גבא "]);
        // A mark after a control is kept when the control is dropped.
        assert_eq!(lines("ב\u{200f}\u{05b8}", &[]), ["\u{05b8}ב"]);
    }

    #[test]
    fn drops_controls_and_tracks_sources() {
        let chars: Vec<char> = "a\u{200f}בג".chars().collect();
        let line = &reorder_lines(&chars, &[])[0];
        assert_eq!(line, &[('a', 0), ('ג', 3), ('ב', 2)]);
    }
}
