//! Arabic shaping (`arabic_shaping.ts`): each letter is rewritten as the Presentation Forms-B code
//! point of the shape it takes in its word, since glyphs are looked up one code point at a time.

use std::borrow::Cow;

use super::rtl_data::{JOINING_TYPES, LAM_ALEF, PRESENTATION_FORMS};
use super::unicode;

/// `Joining_Type`: `D` joins on both sides, `R` to the character before, `L` to the one after,
/// `C` joins without being written, `T` is looked through, `U` does not join.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Joining {
    R,
    #[allow(dead_code, reason = "no character of the Arabic blocks is left-joining as of Unicode 17")]
    L,
    D,
    C,
    T,
    U,
}

/// Index into an entry of [`PRESENTATION_FORMS`].
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Form {
    Isolated = 0,
    Final = 1,
    Initial = 2,
    Medial = 3,
}

const LAM: char = '\u{0644}';

fn joining_type(c: char) -> Joining {
    let cp = c as u32;
    let i = JOINING_TYPES.partition_point(|&(_, b, _)| b < cp);
    match JOINING_TYPES.get(i) {
        Some(&(a, _, t)) if a <= cp => t,
        _ => Joining::U,
    }
}

/// The character before reaches forward to this one.
fn joins_forward(t: Joining) -> bool {
    matches!(t, Joining::D | Joining::L | Joining::C)
}

/// The character after reaches back to this one.
fn joins_backward(t: Joining) -> bool {
    matches!(t, Joining::D | Joining::R | Joining::C)
}

fn form_for(t: Joining, before: bool, after: bool) -> Option<Form> {
    match t {
        Joining::D => Some(match (before, after) {
            (true, true) => Form::Medial,
            (true, false) => Form::Final,
            (false, true) => Form::Initial,
            (false, false) => Form::Isolated,
        }),
        Joining::R => Some(if before { Form::Final } else { Form::Isolated }),
        Joining::L => Some(if after { Form::Initial } else { Form::Isolated }),
        _ => None,
    }
}

struct Shaped {
    c: char,
    t: Joining,
    form: Option<Form>,
}

/// `toPresentationForm`: the shape's code point, else the isolated one, else the character itself.
fn presentation_form(s: &Shaped) -> char {
    let Some(form) = s.form else { return s.c };
    let Ok(cp) = u16::try_from(s.c as u32) else { return s.c };
    let Ok(i) = PRESENTATION_FORMS.binary_search_by_key(&cp, |e| e.0) else { return s.c };
    let forms = PRESENTATION_FORMS[i].1;
    let f = if forms[form as usize] != 0 { forms[form as usize] } else { forms[Form::Isolated as usize] };
    if f == 0 { s.c } else { char::from_u32(f as u32).unwrap_or(s.c) }
}

/// The characters a presentation form stands for: the letter or mark of a contextual form, or lam
/// and alef for a lam-alef ligature. `None` for any other character.
pub fn unshaped(c: char) -> Option<(char, Option<char>)> {
    let cp = u16::try_from(c as u32).ok().filter(|cp| (0xFB50..=0xFEFF).contains(cp))?;
    if let Some(&(alef, _)) = LAM_ALEF.iter().find(|e| e.1.contains(&cp)) {
        return Some((LAM, char::from_u32(alef.into())));
    }
    let &(base, _) = PRESENTATION_FORMS.iter().find(|e| e.1.contains(&cp))?;
    char::from_u32(base.into()).map(|b| (b, None))
}

/// A mark that shaping always replaces by a presentation form, so one met after shaping is a
/// fallback from [`unshaped`].
pub fn is_fallback_mark(c: char) -> bool {
    joining_type(c) == Joining::T
        && u16::try_from(c as u32).is_ok_and(|cp| PRESENTATION_FORMS.binary_search_by_key(&cp, |e| e.0).is_ok())
}

/// `applyArabicShaping`: text with no Arabic in it is returned as it is.
pub fn shape(text: &str) -> Cow<'_, str> {
    if !text.chars().any(unicode::is_arabic) {
        return Cow::Borrowed(text);
    }
    let mut chars: Vec<Shaped> = text.chars().map(|c| Shaped { c, t: joining_type(c), form: None }).collect();

    // Letter forms, looking through transparent characters (vowel marks).
    let visible: Vec<usize> = (0..chars.len()).filter(|&i| chars[i].t != Joining::T).collect();
    for (k, &i) in visible.iter().enumerate() {
        let before = k > 0 && joins_forward(chars[visible[k - 1]].t);
        let after = visible.get(k + 1).is_some_and(|&j| joins_backward(chars[j].t));
        chars[i].form = form_for(chars[i].t, before, after);
    }

    // Mark forms: medial over a letter that joins on to the next one, isolated otherwise.
    let mut letter_joins_forward = false;
    for s in &mut chars {
        if s.t == Joining::T {
            s.form = Some(if letter_joins_forward { Form::Medial } else { Form::Isolated });
        } else {
            letter_joins_forward = matches!(s.form, Some(Form::Initial | Form::Medial));
        }
    }

    // Lam-alef ligatures; marks between the two letters follow the ligature.
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        let lam = &chars[i];
        if lam.c == LAM {
            let mut next = i + 1;
            while next < chars.len() && chars[next].t == Joining::T {
                next += 1;
            }
            let ligature = chars
                .get(next)
                .and_then(|alef| u16::try_from(alef.c as u32).ok())
                .and_then(|alef| LAM_ALEF.binary_search_by_key(&alef, |e| e.0).ok());
            if let Some(l) = ligature {
                let joined_before = matches!(lam.form, Some(Form::Medial | Form::Final));
                let cp = LAM_ALEF[l].1[usize::from(joined_before)];
                out.push(char::from_u32(cp as u32).unwrap_or(lam.c));
                for mark in &chars[i + 1..next] {
                    out.push(presentation_form(mark));
                }
                i = next + 1;
                continue;
            }
        }
        out.push(presentation_form(lam));
        i += 1;
    }
    Cow::Owned(out)
}

#[cfg(test)]
mod tests {
    use super::shape;

    // Cases from maplibre-gl-js test/unit/symbol/arabic_shaping.test.ts.
    #[test]
    fn leaves_other_text_alone() {
        assert!(matches!(shape("Hello, world"), std::borrow::Cow::Borrowed(_)));
    }

    #[test]
    fn shapes_letters_by_position() {
        // بيت: beh initial, yeh medial, teh final.
        assert_eq!(shape("بيت"), "\u{FE91}\u{FEF4}\u{FE96}");
        // A letter on its own is isolated.
        assert_eq!(shape("ب"), "\u{FE8F}");
        // Waw does not join forward, so the beh after it starts again.
        assert_eq!(shape("وب"), "\u{FEED}\u{FE8F}");
    }

    #[test]
    fn joins_through_marks() {
        // بَت: fatha medial over the initial beh, and teh still final.
        assert_eq!(shape("بَت"), "\u{FE91}\u{FE77}\u{FE96}");
        // A mark over a word-final letter takes its isolated form.
        assert_eq!(shape("بَ"), "\u{FE8F}\u{FE76}");
    }

    #[test]
    fn forms_lam_alef() {
        // لا on its own, then after a beh that joins to it.
        assert_eq!(shape("لا"), "\u{FEFB}");
        assert_eq!(shape("بلا"), "\u{FE91}\u{FEFC}");
        // A mark between lam and alef follows the ligature, shaped by the lam it was written on.
        assert_eq!(shape("لَا"), "\u{FEFB}\u{FE77}");
    }

    #[test]
    fn unshapes_presentation_forms() {
        use super::unshaped;
        assert_eq!(unshaped('\u{FE91}'), Some(('\u{0628}', None)));
        assert_eq!(unshaped('\u{FE77}'), Some(('\u{064E}', None)));
        assert_eq!(unshaped('\u{FBFD}'), Some(('\u{06CC}', None)));
        assert_eq!(unshaped('\u{FEFC}'), Some(('\u{0644}', Some('\u{0627}'))));
        assert_eq!(unshaped('\u{0628}'), None);
        assert_eq!(unshaped('a'), None);
        assert!(super::is_fallback_mark('\u{064E}'));
        assert!(!super::is_fallback_mark('\u{0670}') && !super::is_fallback_mark('\u{0628}'));
    }

    #[test]
    fn tatweel_joins() {
        // Tatweel (C) makes the beh before it initial.
        assert_eq!(shape("بـ"), "\u{FE91}\u{0640}");
    }
}
