//! Script properties used by shaping (`unicode_properties.g.ts` / `script_detection.ts`),
//! as code point ranges. Characters are one-code-point strings.

const cpOf = (c: string): number => c.codePointAt(0)!;

/** `ranges` are ascending and disjoint. */
function inRanges(cp: number, ranges: readonly (readonly [number, number])[]): boolean {
  for (const [a, b] of ranges) {
    if (cp < a) return false;
    if (cp <= b) return true;
  }
  return false;
}

const WHITESPACE = /^[\p{White_Space}﻿]$/u;
/** JS `/\s/u` (Rust `char::is_whitespace` plus U+FEFF). */
export function isWhitespace(c: string): boolean {
  return WHITESPACE.test(c);
}

const IDEOGRAPHIC: readonly [number, number][] = [
  [0x02ea, 0x02eb], [0x2e80, 0x2fdf], [0x2ff0, 0x303f], [0x3041, 0x3096], [0x309d, 0x309f],
  [0x30a1, 0x30fa], [0x30fd, 0x30ff], [0x3105, 0x312f], [0x31a0, 0x4dbf], [0x4e00, 0xa48c],
  [0xa490, 0xa4c6], [0xf900, 0xfa6d], [0xfa70, 0xfad9], [0xfe10, 0xfe1f], [0xfe30, 0xfe4f],
  [0xff00, 0xffef], [0x16fe0, 0x18cd5], [0x1aff0, 0x1b2fb], [0x1f200, 0x1f2ff], [0x20000, 0x323af],
];
/** `codePointAllowsIdeographicBreaking`. */
export function allowsIdeographicBreaking(c: string): boolean {
  return inRanges(cpOf(c), IDEOGRAPHIC);
}

const UPRIGHT: readonly [number, number][] = [
  [0x02ea, 0x02eb], [0x1100, 0x11ff], [0x1401, 0x167f], [0x18b0, 0x18ff], [0x2065, 0x2065],
  [0x20dd, 0x20e0], [0x20e2, 0x20e4], [0x2b97, 0x2b97], [0x2bf0, 0x2bff], [0x2e50, 0x2e51],
  [0x2e80, 0x3007], [0x3012, 0x3013], [0x3020, 0x302f], [0x3031, 0x30fb], [0x30fd, 0xa4cf],
  [0xa960, 0xa97f], [0xac00, 0xd7ff], [0xf900, 0xfaff], [0xfe10, 0xfe1f], [0xfe30, 0xfe48],
  [0xfe50, 0xfe57], [0xfe5f, 0xfe62], [0xfe67, 0xfe6f], [0xff00, 0xff07], [0xff0a, 0xff0c],
  [0xff0e, 0xff19], [0xff1f, 0xff3a], [0xff3c, 0xff3c], [0xff3e, 0xff3e], [0xff40, 0xff5a],
  [0xffe0, 0xffe2], [0xffe4, 0xffe7], [0xfff0, 0xfff8], [0x1f000, 0x1faff], [0x20000, 0x3fffd],
];
/** `codePointHasUprightVerticalOrientation`. */
export function hasUprightVerticalOrientation(c: string): boolean {
  return inRanges(cpOf(c), UPRIGHT);
}

const CURSIVE: readonly [number, number][] = [
  [0x0600, 0x0604], [0x0606, 0x060b], [0x060d, 0x061a], [0x061c, 0x061e], [0x0620, 0x063f],
  [0x0641, 0x064a], [0x0656, 0x066f], [0x0671, 0x06dc], [0x06de, 0x070d], [0x070f, 0x074a],
  [0x074d, 0x077f], [0x07c0, 0x07fa], [0x07fd, 0x07ff], [0x0840, 0x085b], [0x085e, 0x085e],
  [0x0860, 0x086a], [0x0870, 0x0891], [0x0897, 0x08e1], [0x08e3, 0x08ff], [0x1800, 0x1801],
  [0x1804, 0x1804], [0x1806, 0x1819], [0x1820, 0x1878], [0x1880, 0x18aa], [0xa840, 0xa877],
  [0xfb50, 0xfd3d], [0xfd40, 0xfdcf], [0xfdf0, 0xfdff], [0xfe70, 0xfe74], [0xfe76, 0xfefc],
];
/** `codePointIsInCursiveScript` (letter spacing is not applied to such text). */
export function isCursive(c: string): boolean {
  return inRanges(cpOf(c), CURSIVE);
}

export function allowsLetterSpacing(text: string): boolean {
  for (const c of text) if (isCursive(c)) return false;
  return true;
}

export function allowsVerticalWritingMode(text: string): boolean {
  for (const c of text) if (hasUprightVerticalOrientation(c)) return true;
  return false;
}

const NEUTRAL: readonly [number, number][] = [
  [0xa7, 0xa7], [0xa9, 0xa9], [0xae, 0xae], [0xb1, 0xb1], [0xbc, 0xbe], [0xd7, 0xd7], [0xf7, 0xf7],
  [0x2016, 0x2016], [0x2020, 0x2021], [0x2030, 0x2031], [0x203b, 0x203c], [0x2042, 0x2042],
  [0x2047, 0x2049], [0x2051, 0x2051], [0x2100, 0x218f], [0x221e, 0x221e], [0x2234, 0x2235],
  [0x2300, 0x2307], [0x230c, 0x231f], [0x2324, 0x2328], [0x232b, 0x232b], [0x237d, 0x239a],
  [0x23be, 0x23cd], [0x23cf, 0x23cf], [0x23d1, 0x23db], [0x23e2, 0x2422], [0x2424, 0x24ff],
  [0x25a0, 0x2619], [0x2620, 0x2767], [0x2776, 0x2793], [0x2b12, 0x2b2f], [0x2b50, 0x2b59],
  [0x2bb8, 0x2beb], [0x3000, 0x303f], [0x30a0, 0x30ff], [0xe000, 0xf8ff], [0xfe30, 0xfe6f],
  [0xff00, 0xffef], [0xfffc, 0xfffd], [0xf0000, 0x10ffff],
];
/** `codePointHasNeutralVerticalOrientation`. */
export function hasNeutralVerticalOrientation(c: string): boolean {
  return inRanges(cpOf(c), NEUTRAL);
}

/** `charHasRotatedVerticalOrientation`. */
export function hasRotatedVerticalOrientation(c: string): boolean {
  return !(hasUprightVerticalOrientation(c) || hasNeutralVerticalOrientation(c));
}

const ARABIC: readonly [number, number][] = [[0x0600, 0x06ff], [0x0750, 0x077f], [0x0870, 0x08ff], [0xfb50, 0xfdff], [0xfe70, 0xfeff]];
/** `\p{sc=Arab}` (complex shaping for vertical placement). */
export function isArabic(c: string): boolean {
  return inRanges(cpOf(c), ARABIC);
}

// Rust `is_alphanumeric` / `is_whitespace` / `is_control` / `is_combining_mark`.
const NOT_SYMBOL = /^[\p{Alphabetic}\p{N}\p{White_Space}\p{Cc}\p{M}]$/u;
/** `[\p{P}\p{S}]`, approximated as anything that is not a letter, number, mark, space or control. */
export function isSymbolOrPunctuation(c: string): boolean {
  return !NOT_SYMBOL.test(c);
}

const NUMERIC = /^\p{N}$/u;
/** `\p{Nd}` (approximated by numeric characters with a decimal value or in digit blocks). */
export function isDecimalDigit(c: string): boolean {
  const cp = cpOf(c);
  if ((cp >= 0x30 && cp <= 0x39) || (cp >= 0xff10 && cp <= 0xff19)) return true;
  if (!NUMERIC.test(c)) return false;
  return !(
    cp === 0xb2 || cp === 0xb3 || cp === 0xb9 || (cp >= 0xbc && cp <= 0xbe) || (cp >= 0x2150 && cp <= 0x218f) ||
    (cp >= 0x2460 && cp <= 0x24ff) || cp === 0x3007 || (cp >= 0x3021 && cp <= 0x3029) || (cp >= 0x4e00 && cp <= 0x9fff)
  );
}

const UPPERCASE_LETTER = /^(?=\p{Uppercase})\p{Alphabetic}$/u;
/** `\p{Lu}`. */
export function isUppercaseLetter(c: string): boolean {
  return UPPERCASE_LETTER.test(c);
}

const VERTICALIZED = new Map<string, string>([
  ['!', '︕'], ['#', '＃'], ['$', '＄'], ['%', '％'], ['&', '＆'], ['(', '︵'], [')', '︶'], ['*', '＊'], ['+', '＋'],
  [',', '︐'], ['-', '︲'], ['.', '・'], ['/', '／'], [':', '︓'], [';', '︔'], ['<', '︿'], ['=', '＝'], ['>', '﹀'],
  ['?', '︖'], ['@', '＠'], ['[', '﹇'], ['\\', '＼'], [']', '﹈'], ['^', '＾'], ['_', '︳'], ['`', '｀'], ['{', '︷'],
  ['|', '―'], ['}', '︸'], ['~', '～'], ['¢', '￠'], ['£', '￡'], ['¥', '￥'], ['¦', '￤'], ['¬', '￢'], ['¯', '￣'],
  ['–', '︲'], ['—', '︱'], ['‘', '﹃'], ['’', '﹄'], ['“', '﹁'], ['”', '﹂'], ['…', '︙'], ['⋯', '︙'], ['‧', '・'],
  ['₩', '￦'], ['、', '︑'], ['。', '︒'], ['〈', '︿'], ['〉', '﹀'], ['《', '︽'], ['》', '︾'], ['「', '﹁'],
  ['」', '﹂'], ['『', '﹃'], ['』', '﹄'], ['【', '︻'], ['】', '︼'], ['〔', '︹'], ['〕', '︺'], ['〖', '︗'],
  ['〗', '︘'], ['！', '︕'], ['（', '︵'], ['）', '︶'], ['，', '︐'], ['－', '︲'], ['．', '・'], ['：', '︓'],
  ['；', '︔'], ['＜', '︿'], ['＞', '﹀'], ['？', '︖'], ['［', '﹇'], ['］', '﹈'], ['＿', '︳'], ['｛', '︷'],
  ['｜', '―'], ['｝', '︸'], ['｟', '︵'], ['｠', '︶'], ['｡', '︒'], ['｢', '﹁'], ['｣', '﹂'],
]);
/** `verticalizedCharacterMap`. */
export function verticalized(c: string): string | undefined {
  return VERTICALIZED.get(c);
}

/** `verticalizePunctuation`: punctuation between upright characters takes its vertical form. */
export function verticalizePunctuation(chars: readonly string[]): string[] {
  const keeps = (c: string | undefined) => c === undefined || !hasRotatedVerticalOrientation(c) || verticalized(c) !== undefined;
  return chars.map((c, i) => {
    const v = verticalized(c);
    return v !== undefined && keeps(chars[i - 1]) && keeps(chars[i + 1]) ? v : c;
  });
}
