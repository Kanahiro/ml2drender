//! Text and icon shaping (`shaping.ts`, `tagged_string.ts`): line breaking, justification and
//! anchor alignment from PBF glyph metrics. Grapheme clusters are taken one code point at a time,
//! which is what MapLibre does for clusters no glyph file covers.

import type {Formatted} from '@maplibre/maplibre-gl-style-spec';
import type {StyleImage} from '../sprite.ts';
import {BORDER, type Glyph, type Glyphs, type Metrics} from './glyphs.ts';
import * as unicode from './unicode.ts';

export const ONE_EM = 24.0;
export const SHAPING_DEFAULT_OFFSET = -17.0;
/** `IMAGE_PADDING` of the image atlas. */
export const IMAGE_PADDING = 1.0;

/** `HorizontalOnly`: horizontal text without a vertical alternative. */
export type WritingMode = 'Horizontal' | 'Vertical' | 'HorizontalOnly';

export type SectionKind = {kind: 'Text'; fontStack: string} | {kind: 'Image'; name: string};

export interface Section {
  scale: number;
  /** `verticalAlign` factor: top 0, center 0.5, bottom 1. */
  valign: number;
  kind: SectionKind;
}

export type Tex = {kind: 'Glyph'; glyph: Glyph} | {kind: 'Image'; image: StyleImage};

/** `Tex::rect_size`: atlas rect size (with the 1px atlas padding). */
export function texRectSize(tex: Tex): [number, number] {
  return tex.kind === 'Glyph' ? [tex.glyph.bw + 2, tex.glyph.bh + 2] : [tex.image.image.w + 2, tex.image.image.h + 2];
}

export interface PositionedGlyph {
  x: number;
  y: number;
  vertical: boolean;
  scale: number;
  section: number;
  metrics: Metrics;
  tex: Tex;
}

export interface PositionedLine {
  glyphs: PositionedGlyph[];
  lineOffset: number;
}

export interface Shaping {
  lines: PositionedLine[];
  top: number;
  bottom: number;
  left: number;
  right: number;
  text: string;
  iconsInText: boolean;
  verticalizable: boolean;
}

/** Rust `f64::max` / `f64::min`: a NaN operand yields the other one. */
const fmax = (a: number, b: number): number => (a !== a ? b : b !== b ? a : Math.max(a, b));

/** `getAnchorAlignment`: (horizontal, vertical) in 0..1. */
export function anchorAlignment(anchor: string): [number, number] {
  let h = 0.5;
  if (anchor === 'right' || anchor === 'top-right' || anchor === 'bottom-right') h = 1.0;
  else if (anchor === 'left' || anchor === 'top-left' || anchor === 'bottom-left') h = 0.0;
  let v = 0.5;
  if (anchor === 'bottom' || anchor === 'bottom-right' || anchor === 'bottom-left') v = 1.0;
  else if (anchor === 'top' || anchor === 'top-right' || anchor === 'top-left') v = 0.0;
  return [h, v];
}

/** `getAnchorJustification`. */
export function anchorJustification(anchor: string): 'right' | 'left' | 'center' {
  if (anchor === 'right' || anchor === 'top-right' || anchor === 'bottom-right') return 'right';
  if (anchor === 'left' || anchor === 'top-left' || anchor === 'bottom-left') return 'left';
  return 'center';
}

/** Display size of a style image in CSS px (`ImagePosition.displaySize`). */
export function displaySize(img: StyleImage): [number, number] {
  return [img.image.w / img.pixelRatio, img.image.h / img.pixelRatio];
}

/** A line of text: characters (one code point each) and the section of each. */
interface Tagged {
  chars: string[];
  section: number[];
}

interface Break {
  index: number;
  x: number;
  prior: number | undefined;
  badness: number;
}

class Ctx {
  glyphs: Glyphs;
  images: Map<string, StyleImage>;
  sections: Section[];

  constructor(glyphs: Glyphs, images: Map<string, StyleImage>, sections: Section[]) {
    this.glyphs = glyphs;
    this.images = images;
    this.sections = sections;
  }

  glyph(s: Section, c: string): Glyph | undefined {
    return s.kind.kind === 'Text' ? this.glyphs.get(s.kind.fontStack, c) : undefined;
  }

  image(s: Section): StyleImage | undefined {
    return s.kind.kind === 'Image' ? this.images.get(s.kind.name) : undefined;
  }

  /** `getGlyphAdvance`. */
  advance(c: string, s: Section, spacing: number, layoutTextSize: number): number {
    if (s.kind.kind === 'Text') {
      const g = this.glyph(s, c);
      return g === undefined ? 0.0 : g.metrics.advance * s.scale + spacing;
    }
    const img = this.image(s);
    return img === undefined ? 0.0 : (displaySize(img)[0] * s.scale * ONE_EM) / layoutTextSize + spacing;
  }

  totalWidth(t: Tagged, spacing: number, layoutTextSize: number): number {
    let sum = 0;
    for (let i = 0; i < t.chars.length; i++) sum += this.advance(t.chars[i], this.sections[t.section[i]], spacing, layoutTextSize);
    return sum;
  }

  /** `determineLineBreaks`: indices to break at, chosen by least badness. */
  lineBreaks(t: Tagged, spacing: number, maxWidth: number, layoutTextSize: number): number[] {
    const total = this.totalWidth(t, spacing, layoutTextSize);
    if (spacing >= 0.0 && total > 0.0 && total <= maxWidth && !t.chars.some((c) => c === '\n' || c === '\r')) {
      return [t.chars.length];
    }
    const target = total / fmax(Math.ceil(total / maxWidth), 1.0);
    const hasZwsp = t.chars.includes('​');
    const breaks: Break[] = [];
    const evaluate = (index: number, x: number, penalty: number, last: boolean): Break => {
      const badness = (w: number) => {
        const raggedness = (w - target) ** 2;
        if (last) return w < target ? raggedness / 2.0 : raggedness * 2.0;
        return raggedness + Math.abs(penalty) * penalty;
      };
      let best: number | undefined;
      let bestBadness = badness(x);
      for (let i = 0; i < breaks.length; i++) {
        const b = breaks[i];
        const v = badness(x - b.x) + b.badness;
        if (v <= bestBadness) {
          best = i;
          bestBadness = v;
        }
      }
      return {index, x, prior: best, badness: bestBadness};
    };
    let x = 0.0;
    for (let i = 0; i < t.chars.length; i++) {
      const c = t.chars[i];
      if (i > 0) {
        const prev = t.chars[i - 1];
        const ideographic = unicode.allowsIdeographicBreaking(prev);
        const breakable = BREAKABLE.has(prev.codePointAt(0)!);
        const imageBefore = this.sections[t.section[i - 1]].kind.kind === 'Image';
        // ponytail: no word segmenter, so scripts written without spaces (Thai, ...) only
        // break at the characters above.
        if (breakable || ideographic || imageBefore || (i + 1 < t.chars.length && c === '(')) {
          let penalty = 0.0;
          if (prev === '\n' || prev === '\r') penalty -= 10000.0;
          if (ideographic && hasZwsp) penalty += 150.0;
          if (prev === '(' || prev === '（') penalty += 50.0;
          if (c === ')' || c === '）') penalty += 50.0;
          breaks.push(evaluate(i, x, penalty, false));
        }
      }
      if (!unicode.isWhitespace(c)) x += this.advance(c, this.sections[t.section[i]], spacing, layoutTextSize);
    }
    const last = evaluate(t.chars.length, x, 0.0, true);
    const out = [last.index];
    let prior = last.prior;
    while (prior !== undefined) {
      out.push(breaks[prior].index);
      prior = breaks[prior].prior;
    }
    out.reverse();
    return out;
  }
}

const BREAKABLE = new Set([0x0a, 0x0d, 0x20, 0x26, 0x29, 0x2b, 0x2d, 0x2f, 0xad, 0xb7, 0x200b, 0x2010, 0x2013, 0x2027]);

/** `shapeText`. `undefined` when nothing could be placed (no glyphs available). */
export function shapeText(
  text: Formatted,
  glyphs: Glyphs,
  images: Map<string, StyleImage>,
  defaultFontStack: string,
  maxWidth: number,
  lineHeight: number,
  textAnchor: string,
  textJustify: string,
  spacing: number,
  translate: [number, number],
  writingMode: WritingMode,
  allowVerticalPlacement: boolean,
  layoutTextSize: number,
  layoutTextSizeThisZoom: number,
): Shaping | undefined {
  const ctx = new Ctx(glyphs, images, []);
  const input: Tagged = {chars: [], section: []};
  let imageCp = 0xe000;
  for (const s of text.sections) {
    const valign = s.verticalAlign === 'top' ? 0.0 : s.verticalAlign === 'center' ? 0.5 : 1.0;
    let kind: SectionKind;
    let chars: string[];
    if (s.image) {
      if (s.image.name === '') continue;
      // Each image takes a private-use code point.
      chars = [String.fromCodePoint(imageCp)];
      imageCp += 1;
      kind = {kind: 'Image', name: s.image.name};
    } else {
      kind = {kind: 'Text', fontStack: s.fontStack ?? defaultFontStack};
      chars = Array.from(s.text);
    }
    const scale = kind.kind === 'Image' ? 1.0 : s.scale != null && s.scale !== 0 ? s.scale : 1.0;
    ctx.sections.push({scale, valign, kind});
    for (const c of chars) {
      input.chars.push(c);
      input.section.push(ctx.sections.length - 1);
    }
  }
  if (writingMode === 'Vertical') {
    // No font provides vertical glyph variants (PBF glyphs), so compatibility forms are used.
    input.chars = unicode.verticalizePunctuation(input.chars);
  }
  // ponytail: no bidi reordering; right-to-left text is laid out in logical order.
  const breaks = ctx.lineBreaks(input, spacing, maxWidth, layoutTextSize);
  const lines: Tagged[] = [];
  let start = 0;
  for (const b of breaks) {
    lines.push({chars: input.chars.slice(start, b), section: input.section.slice(start, b)});
    start = b;
  }
  if (start < input.chars.length) {
    lines.push({chars: input.chars.slice(start), section: input.section.slice(start)});
  }
  const shaping: Shaping = {
    lines: [],
    top: translate[1],
    bottom: translate[1],
    left: translate[0],
    right: translate[0],
    text: input.chars.join(''),
    iconsInText: false,
    verticalizable: false,
  };
  shapeLines(shaping, ctx, lines, lineHeight, textAnchor, textJustify, writingMode, allowVerticalPlacement, spacing, layoutTextSizeThisZoom);
  if (shaping.lines.every((l) => l.glyphs.length === 0)) return undefined;
  return shaping;
}

function shapeLines(
  shaping: Shaping,
  ctx: Ctx,
  lines: Tagged[],
  lineHeight: number,
  textAnchor: string,
  textJustify: string,
  writingMode: WritingMode,
  allowVerticalPlacement: boolean,
  spacing: number,
  layoutTextSizeThisZoom: number,
): void {
  let x = 0.0;
  let y = 0.0;
  let maxLineLength = 0.0;
  let maxLineHeight = 0.0;
  const justify = textJustify === 'right' ? 1.0 : textJustify === 'left' ? 0.0 : 0.5;
  const sizeFactor = ONE_EM / layoutTextSizeThisZoom;
  const nLines = lines.length;
  for (const line of lines) {
    // trim()
    let a = 0;
    let b = line.chars.length;
    while (a < b && unicode.isWhitespace(line.chars[a])) a++;
    while (b > a && unicode.isWhitespace(line.chars[b - 1])) b--;
    line.chars = line.chars.slice(a, b);
    line.section = line.section.slice(a, b);
    let lineMaxScale = 0.0;
    for (const s of line.section) lineMaxScale = fmax(lineMaxScale, ctx.sections[s].scale);
    const positioned: PositionedLine = {glyphs: [], lineOffset: 0};
    let imageOffset = 0.0;
    if (line.chars.length === 0) {
      y += lineHeight;
      shaping.lines.push(positioned);
      continue;
    }
    // calculateLineContentSize
    const maxImage = (k: number) => {
      let m = 0.0;
      for (const s of line.section) {
        const img = ctx.image(ctx.sections[s]);
        if (img !== undefined) m = fmax(m, displaySize(img)[k]);
      }
      return m;
    };
    const contentHeight = fmax(lineMaxScale * ONE_EM, maxImage(1) * sizeFactor);
    const contentWidth = fmax(lineMaxScale * ONE_EM, maxImage(0) * sizeFactor);
    const verticals = writingMode === 'Vertical' && !allowVerticalPlacement ? lineVerticals(line, ctx.sections) : undefined;
    for (let i = 0; i < line.chars.length; i++) {
      const c = line.chars[i];
      const si = line.section[i];
      const vertical = verticals !== undefined ? verticals[i] : isLineVertical(writingMode, allowVerticalPlacement, c);
      if (ctx.sections[si].kind.kind === 'Image') {
        shaping.iconsInText = true;
        ctx.sections[si].scale *= sizeFactor;
      }
      const section = ctx.sections[si];
      let tex: Tex;
      let metrics: Metrics;
      let baselineOffset: number;
      if (section.kind.kind === 'Text') {
        const g = ctx.glyph(section, c);
        if (g === undefined) continue;
        baselineOffset = vertical ? contentWidth - section.scale * ONE_EM : (contentHeight - section.scale * ONE_EM) * section.valign;
        tex = {kind: 'Glyph', glyph: g};
        metrics = g.metrics;
      } else {
        const img = ctx.image(section);
        if (img === undefined) continue;
        const size = displaySize(img);
        metrics = {width: size[0], height: size[1], left: IMAGE_PADDING, top: -BORDER, advance: vertical ? size[1] : size[0]};
        baselineOffset = vertical ? contentWidth - size[1] * section.scale : (contentHeight - size[1] * section.scale) * section.valign;
        imageOffset = fmax(imageOffset, (vertical ? size[0] : size[1]) * section.scale - ONE_EM * lineMaxScale);
        tex = {kind: 'Image', image: img};
      }
      const isImage = tex.kind === 'Image';
      positioned.glyphs.push({
        x,
        y: y + SHAPING_DEFAULT_OFFSET + baselineOffset,
        vertical,
        scale: section.scale,
        section: si,
        metrics,
        tex,
      });
      if (vertical) {
        shaping.verticalizable = true;
        x += (isImage ? metrics.advance : ONE_EM) * section.scale + spacing;
      } else {
        x += metrics.advance * section.scale + spacing;
      }
    }
    if (positioned.glyphs.length > 0) {
      maxLineLength = fmax(maxLineLength, x - spacing);
      // justifyLine
      if (justify !== 0.0) {
        const last = positioned.glyphs[positioned.glyphs.length - 1];
        const indent = (last.x + last.metrics.advance * last.scale) * justify;
        for (const g of positioned.glyphs) g.x -= indent;
      }
    }
    x = 0.0;
    positioned.lineOffset = fmax(imageOffset, (lineMaxScale - 1.0) * ONE_EM);
    const currentLineHeight = lineHeight * lineMaxScale + imageOffset;
    y += currentLineHeight;
    maxLineHeight = fmax(maxLineHeight, currentLineHeight);
    shaping.lines.push(positioned);
  }
  const [hAlign, vAlign] = anchorAlignment(textAnchor);
  // align()
  const shiftX = (justify - hAlign) * maxLineLength;
  const shiftY = maxLineHeight !== lineHeight ? -y * vAlign - SHAPING_DEFAULT_OFFSET : -vAlign * nLines * lineHeight + 0.5 * lineHeight;
  for (const l of shaping.lines) {
    for (const g of l.glyphs) {
      g.x += shiftX;
      g.y += shiftY;
    }
  }
  shaping.top += -vAlign * y;
  shaping.bottom = shaping.top + y;
  shaping.left += -hAlign * maxLineLength;
  shaping.right = shaping.left + maxLineLength;
}

/** `isLineVertical`. */
function isLineVertical(mode: WritingMode, allowVerticalPlacement: boolean, c: string): boolean {
  return !(
    mode !== 'Vertical' ||
    (!allowVerticalPlacement && !unicode.hasUprightVerticalOrientation(c)) ||
    (allowVerticalPlacement && (unicode.isWhitespace(c) || unicode.isArabic(c)))
  );
}

/** `runIsUpright`: numbers (with symbols) and short uppercase codes stand upright. */
function runIsUpright(run: string[]): boolean {
  const number = run.some(unicode.isDecimalDigit) && run.every((c) => unicode.isDecimalDigit(c) || unicode.isSymbolOrPunctuation(c));
  const code = run.length <= 3 && run.every((c) => unicode.isUppercaseLetter(c) || unicode.isDecimalDigit(c));
  return number || code;
}

function uprightInRun(c: string): boolean {
  return (unicode.isDecimalDigit(c) || unicode.isUppercaseLetter(c)) && !unicode.isArabic(c);
}

/**
 * `determineLineVerticals` (line labels): which characters stand upright, replacing
 * punctuation surrounded by upright characters with its vertical form.
 */
function lineVerticals(line: Tagged, sections: Section[]): boolean[] {
  const cps = line.chars.slice();
  const verticals = cps.map(unicode.hasUprightVerticalOrientation);
  const isImage = (i: number) => sections[line.section[i]].kind.kind === 'Image';
  const runChar = (i: number) => !verticals[i] && !unicode.isWhitespace(cps[i]) && !isImage(i);
  let start = 0;
  while (start < cps.length) {
    if (!runChar(start)) {
      start += 1;
      continue;
    }
    let end = start;
    while (end + 1 < cps.length && runChar(end + 1)) end += 1;
    const upright = runIsUpright(cps.slice(start, end + 1));
    for (let i = start; i <= end; i++) verticals[i] = upright && uprightInRun(cps[i]);
    start = end + 1;
  }
  // verticalizeSurroundedPunctuation
  for (let i = 0; i < cps.length; i++) {
    if (verticals[i]) continue;
    const v = unicode.verticalized(line.chars[i]);
    if (v === undefined) continue;
    if ((i === 0 || verticals[i - 1]) && (i === cps.length - 1 || verticals[i + 1])) {
      verticals[i] = true;
      line.chars[i] = v;
    }
  }
  return verticals;
}

export interface PositionedIcon {
  image: StyleImage;
  top: number;
  bottom: number;
  left: number;
  right: number;
  collisionPadding: [number, number, number, number] | undefined;
}

/** `shapeIcon`. */
export function shapeIcon(image: StyleImage, offset: [number, number], anchor: string): PositionedIcon {
  const [h, v] = anchorAlignment(anchor);
  const size = displaySize(image);
  const x1 = offset[0] - size[0] * h;
  const y1 = offset[1] - size[1] * v;
  return {image, top: y1, bottom: y1 + size[1], left: x1, right: x1 + size[0], collisionPadding: undefined};
}

/** `applyTextFit`: the icon box `[x1, y1, x2, y2]` honoring `textFitWidth/Height`. */
export function applyTextFit(icon: PositionedIcon): [number, number, number, number] {
  let left = icon.left;
  let top = icon.top;
  let width = icon.right - left;
  let height = icon.bottom - top;
  const c = icon.image.content ?? [0.0, 0.0, 0.0, 0.0];
  const cw = c[2] - c[0];
  const ch = c[3] - c[1];
  const fitW = icon.image.textFitWidth ?? 'stretchOrShrink';
  const fitH = icon.image.textFitHeight ?? 'stretchOrShrink';
  const ratio = cw / ch;
  if (fitH === 'proportional') {
    if ((fitW === 'stretchOnly' && width / height < ratio) || fitW === 'proportional') {
      const w = Math.ceil(height * ratio);
      left *= w / width;
      width = w;
    }
  } else if (fitW === 'proportional' && fitH === 'stretchOnly' && ratio !== 0.0 && width / height > ratio) {
    const h = Math.ceil(width / ratio);
    top *= h / height;
    height = h;
  }
  return [left, top, left + width, top + height];
}

/** `fitIconToText`. */
export function fitIconToText(
  icon: PositionedIcon,
  text: Shaping,
  fit: string,
  padding: [number, number, number, number],
  offset: [number, number],
  fontScale: number,
): PositionedIcon {
  const image = icon.image;
  const size = displaySize(image);
  const c = image.content;
  const r = image.pixelRatio;
  const collisionPadding: PositionedIcon['collisionPadding'] =
    c == null ? undefined : [c[0] / r, c[1] / r, size[0] - c[2] / r, size[1] - c[3] / r];
  const tl = text.left * fontScale;
  const tr = text.right * fontScale;
  let left: number;
  let right: number;
  if (fit === 'width' || fit === 'both') {
    left = offset[0] + tl - padding[3];
    right = offset[0] + tr + padding[1];
  } else {
    left = offset[0] + (tl + tr - size[0]) / 2.0;
    right = left + size[0];
  }
  const tt = text.top * fontScale;
  const tb = text.bottom * fontScale;
  let top: number;
  let bottom: number;
  if (fit === 'height' || fit === 'both') {
    top = offset[1] + tt - padding[0];
    bottom = offset[1] + tb + padding[2];
  } else {
    top = offset[1] + (tt + tb - size[1]) / 2.0;
    bottom = top + size[1];
  }
  return {image, top, right, bottom, left, collisionPadding};
}
