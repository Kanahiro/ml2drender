//! `bidi.ts`: right-to-left text put into visual order, one line at a time. Embedding levels and rule
//! L1 come from `unicode-bidi`, which follows UAX #9 (GL JS's bidi-js reads characters outside the BMP
//! as left to right and carries levels across paragraphs); L2 and mirroring are applied here a grapheme
//! cluster at a time, so a letter and its marks move together.

use super::rtl_data::{JOINS_TO_FOLLOWING, MIRRORS, SPACING_MARK};
use super::unicode::in_sorted_ranges;
use unicode_bidi::BidiInfo;
use unicode_segmentation::UnicodeSegmentation;

/// `BIDI_CONTROLS`: dropped once the text is reordered.
fn is_bidi_control(c: char) -> bool {
    matches!(c as u32, 0x061C | 0x200E | 0x200F | 0x202A..=0x202E | 0x2066..=0x2069)
}

fn mirror(c: char) -> Option<char> {
    let i = MIRRORS.binary_search_by_key(&(c as u32), |&(a, _)| a).ok()?;
    char::from_u32(MIRRORS[i].1)
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

/// `processStyledBidirectionalText` over characters: `breaks` are character indices to break the
/// lines at (lines also break at every paragraph start), and each output character carries the
/// section of the cluster it came from.
pub fn process_lines(chars: &[char], sections: &[usize], breaks: &[usize]) -> Vec<(Vec<char>, Vec<usize>)> {
    let text: String = chars.iter().collect();
    // Byte offset of each character, plus one past the end.
    let byte_at: Vec<usize> = std::iter::once(0)
        .chain(chars.iter().scan(0, |b, c| {
            *b += c.len_utf8();
            Some(*b)
        }))
        .collect();
    let char_at = |byte: usize| byte_at.partition_point(|&x| x < byte);
    let info = BidiInfo::new(&text, None);

    let mut bounds: Vec<usize> = breaks
        .iter()
        .map(|&i| byte_at[i.min(chars.len())])
        .chain(info.paragraphs.iter().map(|p| p.range.start))
        .filter(|&b| b > 0 && b < text.len())
        .collect();
    bounds.push(0);
    bounds.push(text.len());
    bounds.sort_unstable();
    bounds.dedup();

    let mut lines = Vec::new();
    for w in bounds.windows(2) {
        let Some(para) = info.paragraphs.iter().find(|p| p.range.contains(&w[0])) else { continue };
        let paragraph_level = para.level.number();
        let levels = info.reordered_levels(para, w[0]..w[1]);
        let mut clusters: Vec<(usize, usize, u8)> = graphemes(&text[w[0]..w[1]])
            .into_iter()
            .map(|(s, e)| (w[0] + s, w[0] + e, levels[w[0] + s].number()))
            .collect();

        // L2: from the highest level down to the lowest odd one, reverse every run at that level or above.
        let highest = clusters.iter().map(|c| c.2).max().unwrap_or(0).max(paragraph_level);
        let lowest_odd = clusters.iter().map(|c| c.2 | 1).min().unwrap_or(u8::MAX);
        let mut level = highest;
        while level >= lowest_odd {
            let mut s = 0;
            while s < clusters.len() {
                if clusters[s].2 < level {
                    s += 1;
                    continue;
                }
                let mut e = s;
                while e + 1 < clusters.len() && clusters[e + 1].2 >= level {
                    e += 1;
                }
                clusters[s..=e].reverse();
                s = e + 1;
            }
            level -= 1;
        }

        let mut line = (Vec::new(), Vec::new());
        for &(start, end, level) in &clusters {
            let s = &text[start..end];
            if s.chars().any(is_bidi_control) {
                continue;
            }
            let section = sections[char_at(start)];
            let mut it = s.chars();
            let mirrored = match (it.next(), it.next()) {
                (Some(c), None) if level % 2 == 1 => mirror(c),
                _ => None,
            };
            match mirrored {
                Some(m) => {
                    line.0.push(m);
                    line.1.push(section);
                }
                None => {
                    for c in s.chars() {
                        line.0.push(c);
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
        let section_of = |text: &str| {
            let chars: Vec<char> = text.chars().collect();
            let sections: Vec<usize> = (0..chars.len()).collect();
            process_lines(&chars, &sections, &[])
                .into_iter()
                .map(|(l, s)| (l.into_iter().collect::<String>(), s))
                .collect::<Vec<_>>()
        };
        assert_eq!(section_of("ab שלום"), [("ab םולש".to_string(), vec![0, 1, 2, 6, 5, 4, 3])]);
        // GL JS (bidi-js) keeps this left to right; the emoji is neutral, so the paragraph is right to left.
        assert_eq!(section_of("😀ש"), [("ש😀".to_string(), vec![1, 0])]);
        assert_eq!(section_of("ab\u{200f}cd"), [("abcd".to_string(), vec![0, 1, 3, 4])]);
    }

    /// Where GL JS's bidi-js departs from UAX #9.
    #[test]
    fn follows_uax9() {
        // A mark moves with its letter.
        assert_eq!(lines("\u{5e9}\u{5c1}\u{5dc}", &[]), ["\u{5dc}\u{5e9}\u{5c1}"]);
        // An emoji is neutral, not left to right, so the paragraph is right to left.
        assert_eq!(lines("🕌 مسجد", &[]), ["دجسم 🕌"]);
        // A paragraph's level does not leak into the next one.
        assert_eq!(lines("شارع\n12 34", &[]), ["\nعراش", "12 34"]);
        // Whitespace before a trailing control goes to the paragraph's side (L1 with X9 retained).
        assert_eq!(lines("abc \u{202b}אבג \u{202c}", &[]), ["abc גבא "]);
    }
}
