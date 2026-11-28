//! `arabic_shaping.ts`: Arabic letters rewritten as the Presentation Forms code point of the shape they
//! take in their word, so that PBF glyphs (one per code point) draw them joined. Unlike GL JS, the marks
//! of a lam in a lam-alef ligature stay bare (GL JS gives them the medial form, drawn on a tatweel that
//! the ligature does not join, so it shows as a dash), and `unshaped` lets a font that lacks a
//! presentation form draw the letter it stands for instead of nothing.

use super::rtl_data::{JOINING_TYPES, LAM_ALEF, PRESENTATION_FORMS};
use std::borrow::Cow;

const LAM: u32 = 0x0644;

/// Indices into a `PRESENTATION_FORMS` entry.
const ISOLATED: usize = 0;
const FINAL: usize = 1;
const INITIAL: usize = 2;
const MEDIAL: usize = 3;

/// `ARABIC`: the blocks that make shaping worth doing.
fn is_arabic_block(c: char) -> bool {
    matches!(c as u32, 0x0600..=0x06FF | 0x0750..=0x077F | 0x0870..=0x08FF | 0xFB50..=0xFDFF | 0xFE70..=0xFEFF)
}

fn joining_type(cp: u32) -> u8 {
    super::unicode::find_range(JOINING_TYPES, cp).unwrap_or(b'U')
}

fn joins_forward(t: u8) -> bool {
    matches!(t, b'D' | b'L' | b'C')
}

fn joins_backward(t: u8) -> bool {
    matches!(t, b'D' | b'R' | b'C')
}

/// `formFor`.
fn form_for(t: u8, before: bool, after: bool) -> Option<usize> {
    match t {
        b'D' => Some(match (before, after) {
            (true, true) => MEDIAL,
            (true, false) => FINAL,
            (false, true) => INITIAL,
            (false, false) => ISOLATED,
        }),
        b'R' => Some(if before { FINAL } else { ISOLATED }),
        b'L' => Some(if after { INITIAL } else { ISOLATED }),
        _ => None,
    }
}

#[derive(Clone, Copy)]
struct Shaped {
    cp: u32,
    t: u8,
    form: Option<usize>,
}

/// `toPresentationForm`.
fn presentation_form(c: &Shaped) -> u32 {
    let Some(form) = c.form else { return c.cp };
    let Ok(i) = PRESENTATION_FORMS.binary_search_by_key(&c.cp, |&(base, _)| base) else { return c.cp };
    let forms = PRESENTATION_FORMS[i].1;
    [forms[form], forms[ISOLATED], c.cp].into_iter().find(|&v| v != 0).unwrap_or(c.cp)
}

/// The letter a presentation form stands for (lam and alef for a lam-alef ligature).
pub fn unshaped(c: char) -> Option<(char, Option<char>)> {
    let cp = c as u32;
    if !(0xFB50..=0xFEFF).contains(&cp) {
        return None;
    }
    let to_char = |cp: u32| char::from_u32(cp);
    if let Some(&(alef, _)) = LAM_ALEF.iter().find(|(_, forms)| forms.contains(&cp)) {
        return Some((to_char(LAM)?, to_char(alef)));
    }
    let &(base, _) = PRESENTATION_FORMS.iter().find(|(_, forms)| forms.contains(&cp))?;
    Some((to_char(base)?, None))
}

/// An Arabic mark written as itself rather than as a presentation form: it has no advance and, with no
/// GPOS in PBF glyphs, no anchor either.
pub fn is_bare_mark(c: char) -> bool {
    joining_type(c as u32) == b'T' && PRESENTATION_FORMS.binary_search_by_key(&(c as u32), |&(base, _)| base).is_ok()
}

/// `applyArabicShaping`. Text with no Arabic is returned as it is.
pub fn apply_arabic_shaping(text: &str) -> Cow<'_, str> {
    if !text.chars().any(is_arabic_block) {
        return Cow::Borrowed(text);
    }
    let mut chars: Vec<Shaped> =
        text.chars().map(|c| Shaped { cp: c as u32, t: joining_type(c as u32), form: None }).collect();

    // assignLetterForms: transparent characters are looked through.
    let visible: Vec<usize> = (0..chars.len()).filter(|&i| chars[i].t != b'T').collect();
    for (k, &i) in visible.iter().enumerate() {
        let before = k > 0 && joins_forward(chars[visible[k - 1]].t);
        let after = k + 1 < visible.len() && joins_backward(chars[visible[k + 1]].t);
        chars[i].form = form_for(chars[i].t, before, after);
    }

    // assignMarkForms.
    let mut letter_joins_forward = false;
    for c in &mut chars {
        if c.t == b'T' {
            c.form = Some(if letter_joins_forward { MEDIAL } else { ISOLATED });
        } else {
            letter_joins_forward = matches!(c.form, Some(INITIAL | MEDIAL));
        }
    }

    // applyLigatures, then toPresentationForm.
    let mut out = String::with_capacity(text.len());
    let mut push = |c: &Shaped| out.push(char::from_u32(presentation_form(c)).unwrap_or('\u{fffd}'));
    let mut i = 0;
    while i < chars.len() {
        let lam = &chars[i];
        if lam.cp != LAM {
            push(lam);
            i += 1;
            continue;
        }
        let mut next = i + 1;
        while next < chars.len() && chars[next].t == b'T' {
            next += 1;
        }
        let ligature = chars.get(next).and_then(|alef| LAM_ALEF.binary_search_by_key(&alef.cp, |&(a, _)| a).ok());
        let Some(l) = ligature else {
            push(lam);
            i += 1;
            continue;
        };
        let joined_before = matches!(lam.form, Some(MEDIAL | FINAL));
        let cp = LAM_ALEF[l].1[if joined_before { 1 } else { 0 }];
        push(&Shaped { cp, t: b'R', form: Some(ISOLATED) });
        for mark in &chars[i + 1..next] {
            push(&Shaped { form: None, ..*mark });
        }
        i = next + 1;
    }
    Cow::Owned(out)
}

#[cfg(test)]
mod tests {
    use super::apply_arabic_shaping;

    /// The cases of GL JS `arabic_shaping.test.ts`.
    fn cps(text: &str) -> Vec<u32> {
        apply_arabic_shaping(text).chars().map(|c| c as u32).collect()
    }

    #[test]
    fn shapes_as_gl_js() {
        const BEH: &str = "\u{0628}";
        const LAM: &str = "\u{0644}";
        const ALEF: &str = "\u{0627}";
        assert_eq!(apply_arabic_shaping("hello world"), "hello world");
        assert_eq!(apply_arabic_shaping("שלום"), "שלום");
        assert_eq!(apply_arabic_shaping(""), "");
        assert_eq!(cps(BEH), [0xFE8F]);
        assert_eq!(cps(&[BEH, BEH, BEH].concat()), [0xFE91, 0xFE92, 0xFE90]);
        assert_eq!(cps(&[BEH, ALEF, BEH].concat()), [0xFE91, 0xFE8E, 0xFE8F]);
        assert_eq!(cps(&[BEH, "\u{0621}", BEH].concat()), [0xFE8F, 0x0621, 0xFE8F]);
        assert_eq!(cps(&[LAM, ALEF].concat()), [0xFEFB]);
        assert_eq!(cps(&[BEH, LAM, ALEF].concat()), [0xFE91, 0xFEFC]);
        assert_eq!(cps(&[BEH, "\u{064E}", BEH].concat()), [0xFE91, 0xFE77, 0xFE90]);
        assert_eq!(cps(&[BEH, "\u{064E}"].concat()), [0xFE8F, 0xFE76]);
        assert_eq!(cps(&[BEH, "\u{064C}", BEH].concat()), [0xFE91, 0xFE72, 0xFE90]);
        assert_eq!(cps(&[BEH, "\u{200C}", BEH].concat()), [0xFE8F, 0x200C, 0xFE8F]);
        assert_eq!(apply_arabic_shaping("hello مرحبا 123"), "hello ﻣﺮﺣﺒﺎ 123");
        // A mark between lam and alef stays bare (GL JS: the medial form 0xFE77).
        assert_eq!(cps(&[BEH, LAM, "\u{064E}", ALEF].concat()), [0xFE91, 0xFEFC, 0x064E]);
    }

    #[test]
    fn unshapes() {
        use super::{is_bare_mark, unshaped};
        assert_eq!(unshaped('\u{FE91}'), Some(('\u{0628}', None)));
        assert_eq!(unshaped('\u{FE77}'), Some(('\u{064E}', None)));
        assert_eq!(unshaped('\u{FEFC}'), Some(('\u{0644}', Some('\u{0627}'))));
        assert_eq!(unshaped('\u{0628}'), None);
        assert!(is_bare_mark('\u{064E}') && !is_bare_mark('\u{0628}') && !is_bare_mark('\u{FE77}'));
    }
}
