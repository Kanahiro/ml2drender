// Symbol bucket construction (`SymbolBucket.populate` + `performSymbolLayout`): text and icon
// evaluation, shaping, anchors, quads and collision boxes for one tile of one layer.

import {Formatted, FormattedSection, Padding, ResolvedImage, VariableAnchorOffsetCollection} from '@maplibre/maplibre-gl-style-spec';
import * as anchors from './anchors.ts';
import type {Anchor, P} from './anchors.ts';
import {BORDER} from './glyphs.ts';
import type {Glyphs} from './glyphs.ts';
import * as shaping from './shaping.ts';
import {IMAGE_PADDING, ONE_EM, SHAPING_DEFAULT_OFFSET} from './shaping.ts';
import type {PositionedIcon, Shaping, Tex, WritingMode} from './shaping.ts';
import * as unicode from './unicode.ts';
import {Ctx, EXTENT, classifyRings, num, num2} from '../render/mod.ts';
import type {BucketFeature, TileFeatures} from '../render/mod.ts';
import {interpolationFactor, isExpression, layout} from '../style.ts';
import type {Interpolation, Layer, PropValue, Properties, Value} from '../style.ts';
import type {RenderTile} from '../tile.ts';
import {clamp, wrapI16} from '../util.ts';

const SIZE_PACK_FACTOR = 128.0;
const MAX_PACKED_SIZE = 255.0 * SIZE_PACK_FACTOR;
const BASELINE_OFFSET = 7.0;

/** JS typed-array store into an Int16 slot. */
export function int16(v: number): number {
    if (!Number.isFinite(v)) return 0;
    return wrapI16(Math.trunc(v));
}

const str = (v: Value): string | undefined => (typeof v === 'string' ? v : undefined);
/** JS truthiness (`Boolean(v)`). */
const truthy = (v: Value): boolean => !!v;

/** `Value::to_js_string` of the Rust port (null → empty). */
function jsString(v: Value): string {
    if (v === null || v === undefined) return '';
    if (Array.isArray(v) || (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype)) return JSON.stringify(v);
    return String(v);
}

export type SizeKind = 'Constant' | 'Source' | 'Camera' | 'Composite';

/** `SizeData` for `text-size` / `icon-size`. */
export class SizeData {
    kind: SizeKind;
    /** Constant size. */
    size = 0;
    /** Camera. */
    stops: number[] = [];
    sizes: number[] = [];
    layoutSize = 0;
    /** Camera / composite. */
    interp: Interpolation | undefined = undefined;
    /** Composite. */
    minZoom = 0;
    maxZoom = 0;

    constructor(p: PropValue, tileZoom: number) {
        const {kind, stops, interpolation: interp} = p.curve();
        const evalAt = (z: number) => num(p.eval(z));
        if (kind === 'constant') {
            this.kind = 'Constant';
            this.size = evalAt(tileZoom + 1);
        } else if (kind === 'source') {
            this.kind = 'Source';
        } else if (kind === 'composite') {
            this.kind = 'Composite';
            let lower = 0;
            while (lower < stops.length && stops[lower] <= tileZoom) lower++;
            lower = Math.max(lower - 1, 0);
            let upper = lower;
            while (upper < stops.length && stops[upper] < tileZoom + 1) upper++;
            upper = Math.min(upper, Math.max(stops.length - 1, 0));
            this.minZoom = stops[lower] ?? 0;
            this.maxZoom = stops[upper] ?? 0;
            this.interp = interp;
        } else {
            this.kind = 'Camera';
            this.stops = stops;
            this.sizes = stops.map((z) => evalAt(z === -Infinity ? stops[1] - 1 : z));
            this.layoutSize = evalAt(tileZoom + 1);
            this.interp = interp;
        }
    }

    /** `evaluateSizeForZoom`: (`u_size_t`, `u_size`). */
    forZoom(zoom: number): [number, number] {
        switch (this.kind) {
            case 'Constant':
                return [0, this.size];
            case 'Source':
                return [0, 0];
            case 'Camera': {
                const {stops, sizes} = this;
                let lower = stops.length - 1;
                while (lower > 0 && stops[lower] > zoom) lower--;
                const upper = Math.min(lower + 1, stops.length - 1);
                const t = this.interp ? clamp(interpolationFactor(this.interp, zoom, stops[lower], stops[upper]), 0, 1) : 0;
                return [0, Math.min(sizes[lower] + (sizes[upper] - sizes[lower]) * t, this.layoutSize)];
            }
            case 'Composite':
                return [this.interp ? clamp(interpolationFactor(this.interp, zoom, this.minZoom, this.maxZoom), 0, 1) : 0, 0];
        }
    }

    /** The size a vertex gets in the shader (`a_size` / `u_size`). */
    shaderSize(zoom: number, packed: [number, number]): number {
        const [t, u] = this.forZoom(zoom);
        if (this.kind === 'Source') return packed[0] / SIZE_PACK_FACTOR;
        if (this.kind === 'Composite') return (packed[0] + (packed[1] - packed[0]) * t) / SIZE_PACK_FACTOR;
        return u;
    }

    /** `evaluateSizeForFeature` (CPU side, unpacked like the placed symbol arrays). */
    forFeature(zoom: number, packed: [number, number]): number {
        const [t, u] = this.forZoom(zoom);
        if (this.kind === 'Source') return packed[0] / SIZE_PACK_FACTOR;
        if (this.kind === 'Composite') return packed[0] / SIZE_PACK_FACTOR + (packed[1] / SIZE_PACK_FACTOR - packed[0] / SIZE_PACK_FACTOR) * t;
        return u;
    }
}

/** A glyph or icon quad (`SymbolQuad`), offsets in em/px space as packed into the vertex buffer. */
export interface Quad {
    /** tl, tr, bl, br. */
    corners: [P, P, P, P];
    tex: Tex;
    /** Texture rect within the padded image: x, y, w, h. */
    rect: [number, number, number, number];
    pixelOffsetTl: P;
    pixelOffsetBr: P;
    minFontScale: P;
    glyphOffset: P;
    section: number;
    isSdf: boolean;
}

/** `PlacedSymbol`: one text justification or one icon of a symbol instance. */
export interface PlacedSymbol {
    anchor: P;
    quads: Quad[];
    /** Packed sizes (`SIZE_PACK_FACTOR`), for source/composite sizes. */
    size: [number, number];
    lineOffset: P;
    lineStart: number;
    lineLength: number;
    segment: number | undefined;
    writingMode: WritingMode;
    /** Index into `SymbolBucket.features`. */
    feature: number;
}

export interface CollisionBox {
    anchor: P;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
}

export interface SymbolInstance {
    /** Int16 anchor. */
    anchor: P;
    /** right, center, left justified text symbols. */
    text: [number | undefined, number | undefined, number | undefined];
    verticalText: number | undefined;
    icon: number | undefined;
    verticalIcon: number | undefined;
    textBox: CollisionBox | undefined;
    verticalTextBox: CollisionBox | undefined;
    iconBox: CollisionBox | undefined;
    verticalIconBox: CollisionBox | undefined;
    featureIndex: number;
    numGlyphVertices: number;
    numVerticalGlyphVertices: number;
    numIconVertices: number;
    collisionCircleDiameter: number | undefined;
    textBoxScale: number;
    /** `text-variable-anchor(-offset)`: anchors with their offsets (em units). */
    anchorOffsets: [string, P][];
}

export interface SymbolFeature {
    f: BucketFeature;
    text: Formatted | undefined;
    fontStack: string;
    icon: string | undefined;
    sortKey: number | undefined;
}

export interface SymbolBucket {
    tile: RenderTile;
    features: SymbolFeature[];
    instances: SymbolInstance[];
    text: PlacedSymbol[];
    icon: PlacedSymbol[];
    /** Line vertices (Int16 x, y, distance from anchor) for line labels. */
    lineVertices: [P, number][];
    textSize: SizeData;
    iconSize: SizeData;
    sdfIcons: boolean;
    iconsNeedLinear: boolean;
    iconsInText: boolean;
    /** `(sort key, first instance, end instance)`. */
    sortKeyRanges: [number, number, number][];
    tilePixelRatio: number;
    canOverlap: boolean;
    sortFeaturesByY: boolean;
    /** `text-writing-mode` (point placement) includes vertical. */
    allowVerticalPlacement: boolean;
    /** `text-writing-mode` in order (point placement). */
    writingModes: WritingMode[];
}

/** Layout properties with `auto` resolved (`SymbolStyleLayer.recalculate`). */
export class Resolved {
    placement: string;
    textRotationAlignment: string;
    textPitchAlignment: string;
    iconRotationAlignment: string;
    iconPitchAlignment: string;
    zOrder: string;
    sortByKey: boolean;

    constructor(layer: Layer, ctx: Ctx, tile: RenderTile) {
        const s = (n: string) => str(ctx.layout(layer, n, undefined, tile)) ?? '';
        const placement = s('symbol-placement');
        const auto = (v: string) => (v === 'auto' ? (placement !== 'point' ? 'map' : 'viewport') : v);
        const textRotationAlignment = auto(s('text-rotation-alignment'));
        const iconRotationAlignment = layout(layer, 'icon-rotation-alignment').isConstant() ? auto(s('icon-rotation-alignment')) : auto('auto');
        const pitch = (v: string, rot: string) => (v === 'auto' ? (rot === 'map' ? 'map' : 'viewport') : v);
        this.placement = placement;
        this.textRotationAlignment = textRotationAlignment;
        this.textPitchAlignment = pitch(s('text-pitch-alignment'), textRotationAlignment);
        this.iconRotationAlignment = iconRotationAlignment;
        this.iconPitchAlignment = pitch(s('icon-pitch-alignment'), iconRotationAlignment);
        this.zOrder = s('symbol-z-order');
        this.sortByKey = this.zOrder !== 'viewport-y' && !layout(layer, 'symbol-sort-key').isConstant();
    }

    textAlongLine(): boolean {
        return this.textRotationAlignment !== 'viewport' && this.placement !== 'point';
    }
}

/** `getOverlapMode`. */
export function overlapMode(layer: Layer, ctx: Ctx, tile: RenderTile, raw: any, kind: string): 'always' | 'cooperative' | 'never' {
    if (raw?.layout?.[`${kind}-overlap`] != null) {
        const v = ctx.layout(layer, `${kind}-overlap`, undefined, tile);
        if (v === 'always' || v === 'cooperative' || v === 'never') return v;
    }
    return truthy(ctx.layout(layer, `${kind}-allow-overlap`, undefined, tile)) ? 'always' : 'never';
}

/** `resolveTokens`: `{name}` → the feature property (JS `String()`), or empty. */
function resolveTokens(props: Properties, s: string): string {
    return s.replace(/{([^{}]+)}/g, (_, key: string) => (Object.hasOwn(props, key) ? jsString(props[key]) : ''));
}

/** Whether a layout value is resolved for `{token}`s (a plain or camera-function string). */
function resolvesTokens(raw: any, prop: PropValue): boolean {
    return !isExpression(raw) && prop.isFeatureConstant();
}

export interface FeatureText {
    text: Formatted | undefined;
    fontStack: string;
}

/** The text of a feature (`text-field` with tokens and `text-transform`), if the layer has text. */
export function featureText(layer: Layer, ctx: Ctx, tile: RenderTile, raw: any, f: BucketFeature): FeatureText {
    const font = ctx.layout(layer, 'text-font', f, tile);
    const fontStack = Array.isArray(font) ? font.map((v) => str(v) ?? '').join(',') : '';
    const field = layout(layer, 'text-field');
    const constField = field.isConstant() ? ctx.layout(layer, 'text-field', undefined, tile) : undefined;
    const hasText =
        !(field.isConstant() && constField instanceof Formatted && constField.isEmpty()) &&
        !(layout(layer, 'text-font').isConstant() && fontStack === '' && Array.isArray(font) && font.length === 0);
    if (!hasText) return {text: undefined, fontStack};
    const v = ctx.layout(layer, 'text-field', f, tile);
    // A copy: the evaluated value may be shared (constants).
    let sections: FormattedSection[];
    if (v instanceof Formatted) {
        sections = v.sections.map((s) => new FormattedSection(s.text, s.image, s.scale, s.fontStack, s.textColor, s.verticalAlign));
    } else if (v === null || v === undefined) {
        sections = [];
    } else {
        sections = Formatted.fromString(jsString(v)).sections;
    }
    if (resolvesTokens(raw?.layout?.['text-field'], field)) {
        for (const s of sections) s.text = resolveTokens(f.feature.properties, s.text);
    }
    const transform = ctx.layout(layer, 'text-transform', f, tile);
    for (const s of sections) {
        if (transform === 'uppercase') s.text = s.text.toUpperCase();
        else if (transform === 'lowercase') s.text = s.text.toLowerCase();
    }
    return {text: new Formatted(sections), fontStack};
}

function featureIcon(layer: Layer, ctx: Ctx, tile: RenderTile, raw: any, f: BucketFeature): string | undefined {
    const prop = layout(layer, 'icon-image');
    const v = ctx.layout(layer, 'icon-image', f, tile);
    let name: string;
    if (v instanceof ResolvedImage) name = v.name;
    else if (typeof v === 'string') name = resolvesTokens(raw?.layout?.['icon-image'], prop) ? resolveTokens(f.feature.properties, v) : v;
    else return undefined;
    return name !== '' ? name : undefined;
}

/** Glyph ranges a tile's features need: `(font stack, range)`, keyed `${stack}\0${range}`. */
export function glyphDependencies(layer: Layer, ctx: Ctx, tf: TileFeatures, raw: any, out: Map<string, [string, number]>): void {
    const res = new Resolved(layer, ctx, tf.tile);
    const keepUpright = truthy(ctx.layout(layer, 'text-keep-upright', undefined, tf.tile));
    const modes = ctx.layout(layer, 'text-writing-mode', undefined, tf.tile);
    const allowVertical = res.placement === 'point' && Array.isArray(modes) && modes.some((m) => m === 'vertical');
    // Most characters repeat: skip building the key for ranges already added for the stack.
    const seen = new Map<string, Set<number>>();
    const add = (stack: string, range: number) => {
        let ranges = seen.get(stack);
        if (!ranges) seen.set(stack, (ranges = new Set()));
        if (ranges.has(range)) return;
        ranges.add(range);
        out.set(`${stack}\0${range}`, [stack, range]);
    };
    for (const f of ctx.filteredFeatures(layer, tf, undefined, false)) {
        const ft = featureText(layer, ctx, tf.tile, raw, f);
        const text = ft.text;
        if (!text) continue;
        const unformatted = text.sections.map((s) => s.text).join('');
        // Vertical labels may swap punctuation for its vertical form.
        const verticalForms = ((res.textAlongLine() && keepUpright) || allowVertical) && unicode.allowsVerticalWritingMode(unformatted);
        for (const s of text.sections) {
            if (s.image) continue;
            const stack = s.fontStack ?? ft.fontStack;
            for (const ch of s.text) {
                const c = ch.codePointAt(0)!;
                add(stack, Math.floor(c / 256));
                if (verticalForms) {
                    const v = unicode.verticalized(ch);
                    if (v !== undefined) add(stack, Math.floor(v.codePointAt(0)! / 256));
                }
            }
        }
    }
}

interface Sizes {
    text: PropValue;
    icon: PropValue;
}

interface AddSymbol {
    fi: number;
    horizontal: [string, Shaping][];
    vertical: Shaping | undefined;
    shapedIcon: PositionedIcon | undefined;
    verticalIcon: PositionedIcon | undefined;
    isSdfIcon: boolean;
    textBoxScale: number;
    textPadding: number;
    textAlongLine: boolean;
    textOffset: P;
    iconBoxScale: number;
    iconPadding: [number, number, number, number];
    iconOffset: P;
    layoutTextSize: number;
    sizes: Sizes;
    hasIconTextFit: boolean;
    variable: [string, P][] | undefined;
}

export class Builder {
    layer: Layer;
    ctx: Ctx;
    glyphs: Glyphs;
    raw: any;

    constructor(layer: Layer, ctx: Ctx, glyphs: Glyphs, raw: any) {
        this.layer = layer;
        this.ctx = ctx;
        this.glyphs = glyphs;
        this.raw = raw;
    }

    private lay(name: string, f: BucketFeature | undefined, tile: RenderTile): Value {
        return this.ctx.layout(this.layer, name, f, tile);
    }

    private layAt(name: string, zoom: number, f: BucketFeature, tile: RenderTile): number {
        return num(layout(this.layer, name).eval(zoom, f.feature, Ctx.canonical(tile)));
    }

    build(tf: TileFeatures): SymbolBucket {
        const layer = this.layer;
        const tile = tf.tile;
        const zoom = tile.overscaledZ;
        const overscaling = 2 ** (tile.overscaledZ - tile.canonical.z);
        const tilePixelRatio = EXTENT / (512.0 * overscaling);
        const res = new Resolved(layer, this.ctx, tile);
        const canOverlap =
            overlapMode(layer, this.ctx, tile, this.raw, 'text') !== 'never' ||
            overlapMode(layer, this.ctx, tile, this.raw, 'icon') !== 'never' ||
            truthy(this.lay('text-ignore-placement', undefined, tile)) ||
            truthy(this.lay('icon-ignore-placement', undefined, tile));
        const byY = res.zOrder === 'viewport-y' || (res.zOrder === 'auto' && !res.sortByKey);
        const bucket: SymbolBucket = {
            tile,
            features: [],
            instances: [],
            text: [],
            icon: [],
            lineVertices: [],
            textSize: new SizeData(layout(layer, 'text-size'), zoom),
            iconSize: new SizeData(layout(layer, 'icon-size'), zoom),
            sdfIcons: false,
            iconsNeedLinear: false,
            iconsInText: false,
            sortKeyRanges: [],
            tilePixelRatio,
            canOverlap,
            sortFeaturesByY: byY && canOverlap,
            allowVerticalPlacement: false,
            writingModes: [],
        };
        if (res.placement === 'point') {
            const modes: WritingMode[] = [];
            const a = this.lay('text-writing-mode', undefined, tile);
            if (Array.isArray(a)) {
                for (const v of a) {
                    if (typeof v !== 'string') continue;
                    const m: WritingMode = v === 'vertical' ? 'Vertical' : 'Horizontal';
                    if (!modes.includes(m)) modes.push(m);
                }
            }
            if (modes.length === 0) modes.push('Horizontal');
            bucket.allowVerticalPlacement = modes.includes('Vertical');
            bucket.writingModes = modes;
        }
        this.populate(bucket, tf, res);
        const sizes: Sizes = {text: layout(layer, 'text-size'), icon: layout(layer, 'icon-size')};
        const compareText = new Map<string, P[]>();
        const sdfIcons: {v: boolean | undefined} = {v: undefined};
        const features = bucket.features;
        for (let fi = 0; fi < features.length; fi++) {
            this.layoutFeature(bucket, features[fi], fi, res, sizes, compareText, sdfIcons, overscaling);
        }
        bucket.sdfIcons = sdfIcons.v ?? false;
        return bucket;
    }

    private populate(bucket: SymbolBucket, tf: TileFeatures, res: Resolved): void {
        const tile = tf.tile;
        const constIcon = this.lay('icon-image', undefined, tile);
        const hasIcon =
            !layout(this.layer, 'icon-image').isConstant() || (typeof constIcon === 'string' && constIcon !== '') || constIcon instanceof ResolvedImage;
        const point = res.placement === 'point';
        const sortProp = res.sortByKey ? 'symbol-sort-key' : undefined;
        let features: SymbolFeature[] = [];
        for (const f of this.ctx.bucketFeatures(this.layer, tf, undefined)) {
            if (point && f.ty === 1 && f.geometry.every((l) => l.every((p) => isOutside(p)))) continue;
            const {text, fontStack} = featureText(this.layer, this.ctx, tile, this.raw, f);
            const icon = hasIcon ? featureIcon(this.layer, this.ctx, tile, this.raw, f) : undefined;
            if (text === undefined && icon === undefined) continue;
            const sortKey = sortProp !== undefined ? num(this.ctx.layout(this.layer, sortProp, f, tile)) : undefined;
            features.push({f, text, fontStack, icon, sortKey});
        }
        if (res.placement === 'line') {
            const items: [string | undefined, P[]][] = features.map((s) => [
                s.text ? s.text.sections.map((x) => x.text).join('') : undefined,
                s.f.geometry[0] ? s.f.geometry[0].slice() : [],
            ]);
            const merged = anchors.mergeLines(items);
            const kept: SymbolFeature[] = [];
            for (let i = 0; i < features.length && i < merged.length; i++) {
                const line = merged[i];
                if (line === undefined) continue;
                const s = features[i];
                if (s.f.geometry.length > 0) s.f.geometry[0] = line;
                kept.push(s);
            }
            features = kept;
        }
        if (res.sortByKey) {
            // `Option<f64>::partial_cmp`: None first; NaN compares equal.
            features.sort((a, b) => cmpOptF64(a.sortKey, b.sortKey));
        }
        bucket.features = features;
    }

    private layoutFeature(
        bucket: SymbolBucket,
        feature: SymbolFeature,
        fi: number,
        res: Resolved,
        sizes: Sizes,
        compareText: Map<string, P[]>,
        sdfIcons: {v: boolean | undefined},
        overscaling: number,
    ): void {
        const tile = bucket.tile;
        const zoom = tile.overscaledZ;
        const f = feature.f;
        const lay = (n: string) => this.lay(n, f, tile);
        const layoutTextSizeThisZoom = num(lay('text-size'));
        const layoutTextSize = this.layAt('text-size', zoom + 1, f, tile);
        const layoutIconSize = this.layAt('icon-size', zoom + 1, f, tile);
        const lineHeight = num(lay('text-line-height')) * ONE_EM;
        const alongLine = res.textAlongLine();
        const fontstack = feature.fontStack;

        // (justification, shaping) in insertion order.
        const horizontal: [string, Shaping][] = [];
        let vertical: Shaping | undefined = undefined;
        const keepUpright = truthy(this.lay('text-keep-upright', undefined, tile));
        let textOffset: P = [0, 0];
        const variable = this.variableAnchorOffset(f, tile);
        const text = feature.text;
        if (text) {
            const unformatted = text.sections.map((s) => s.text).join('');
            let spacing = num(lay('text-letter-spacing')) * ONE_EM;
            spacing = unicode.allowsLetterSpacing(unformatted) ? spacing : 0;
            const textAnchor = str(lay('text-anchor')) ?? 'center';
            if (variable === undefined) {
                const radial = num(lay('text-radial-offset'));
                if (radial !== 0) {
                    textOffset = evaluateVariableOffset(textAnchor, [radial * ONE_EM, Infinity]);
                } else {
                    const o = num2(lay('text-offset'));
                    textOffset = [o[0] * ONE_EM, o[1] * ONE_EM];
                }
            }
            let justify = alongLine ? 'center' : (str(lay('text-justify')) ?? 'center');
            const maxWidth = res.placement === 'point' ? num(lay('text-max-width')) * ONE_EM : Infinity;
            const shapeMode = (anchor: string, justify: string, mode: WritingMode, allowVertical: boolean) =>
                shaping.shapeText(
                    text,
                    this.glyphs,
                    this.ctx.images,
                    fontstack,
                    maxWidth,
                    lineHeight,
                    anchor,
                    justify,
                    spacing,
                    textOffset,
                    mode,
                    allowVertical,
                    layoutTextSize,
                    layoutTextSizeThisZoom,
                );
            const shape = (anchor: string, justify: string) => shapeMode(anchor, justify, 'Horizontal', false);
            const canVertical = unicode.allowsVerticalWritingMode(unformatted);
            // Vertical point labels (`text-writing-mode`) use left justification.
            const pointVertical = () => (bucket.allowVerticalPlacement && canVertical ? shapeMode(textAnchor, 'left', 'Vertical', true) : undefined);
            const staticJ = (j: string) => (j === 'left' ? 'left' : j === 'right' ? 'right' : 'center');
            if (!alongLine && variable !== undefined) {
                const justifications: string[] = [];
                if (justify === 'auto') {
                    for (const [a] of variable) {
                        const j = shaping.anchorJustification(a);
                        if (!justifications.includes(j)) justifications.push(j);
                    }
                } else {
                    justifications.push(staticJ(justify));
                }
                let singleLine = false;
                for (const j of justifications) {
                    if (singleLine) {
                        horizontal.push([j, horizontal[0][1]]);
                    } else {
                        const s = shape('center', j);
                        if (s) {
                            singleLine = s.lines.length === 1;
                            horizontal.push([j, s]);
                        }
                    }
                }
                vertical = pointVertical();
            } else {
                if (justify === 'auto') justify = shaping.anchorJustification(textAnchor);
                const s = shape(textAnchor, justify);
                if (s) horizontal.push([staticJ(justify), s]);
                vertical = pointVertical();
                // Verticalized line label.
                if (canVertical && alongLine && keepUpright) {
                    vertical = shapeMode(textAnchor, justify, 'Vertical', false);
                }
            }
        }

        let shapedIcon: PositionedIcon | undefined = undefined;
        let isSdfIcon = false;
        const img = feature.icon !== undefined ? this.ctx.images.get(feature.icon) : undefined;
        if (img) {
            const offset = num2(lay('icon-offset'));
            shapedIcon = shaping.shapeIcon(img, offset, str(lay('icon-anchor')) ?? 'center');
            isSdfIcon = img.sdf;
            if (sdfIcons.v === undefined) sdfIcons.v = isSdfIcon;
            // `icon-rotate`.constantOr(1) at the tile zoom.
            const rotateProp = layout(this.layer, 'icon-rotate');
            const rotate = rotateProp.isFeatureConstant() ? num(this.lay('icon-rotate', undefined, tile)) : 1;
            if (img.pixelRatio !== this.ctx.transform.pixelRatio || rotate !== 0) bucket.iconsNeedLinear = true;
        }
        const firstShaping = horizontal.length > 0 ? horizontal[0][1] : vertical;
        if (firstShaping) bucket.iconsInText = bucket.iconsInText || firstShaping.iconsInText;
        if (horizontal.length === 0 && vertical === undefined && shapedIcon === undefined) return;

        // addFeature
        const textMaxSize = this.layAt('text-size', 18, f, tile);
        const iconOffset = num2(lay('icon-offset'));
        const fontScale = layoutTextSize / 24.0;
        const tpr = bucket.tilePixelRatio;
        const textBoxScale = tpr * fontScale;
        const textMaxBoxScale = (tpr * textMaxSize) / 24.0;
        const iconBoxScale = tpr * layoutIconSize;
        const symbolMinDistance = tpr * num(lay('symbol-spacing'));
        const textPadding = num(lay('text-padding')) * tpr;
        const ip = lay('icon-padding');
        const iconPadding: [number, number, number, number] =
            ip instanceof Padding
                ? [ip.values[0] * tpr, ip.values[1] * tpr, ip.values[2] * tpr, ip.values[3] * tpr]
                : [num(ip) * tpr, num(ip) * tpr, num(ip) * tpr, num(ip) * tpr];
        const textMaxAngle = (num(lay('text-max-angle')) / 180.0) * Math.PI;
        const textRepeatDistance = symbolMinDistance / 2.0;
        const fit = str(lay('icon-text-fit')) ?? 'none';
        let verticalIcon: PositionedIcon | undefined = undefined;
        if (shapedIcon && fit !== 'none') {
            const icon = shapedIcon;
            const a = lay('icon-text-fit-padding');
            const padding: [number, number, number, number] =
                Array.isArray(a) && a.length === 4 ? [num(a[0]), num(a[1]), num(a[2]), num(a[3])] : [0, 0, 0, 0];
            if (bucket.allowVerticalPlacement && vertical) {
                verticalIcon = shaping.fitIconToText(icon, vertical, fit, padding, iconOffset, fontScale);
            }
            if (horizontal.length > 0) {
                shapedIcon = shaping.fitIconToText(icon, horizontal[0][1], fit, padding, iconOffset, fontScale);
            }
        }
        const defaultShaping = horizontal.length > 0 ? horizontal[0][1] : undefined;
        // Anchors along lines measure the vertical shaping when there is one.
        const anchorShaping = vertical ?? defaultShaping;
        const labelLength = shapedLabelLength(anchorShaping, shapedIcon);
        const window = anchorShaping ? (3.0 / 5.0) * 24.0 * textMaxBoxScale : 0;

        const c: AddSymbol = {
            fi,
            horizontal,
            vertical,
            shapedIcon,
            verticalIcon,
            isSdfIcon,
            textBoxScale,
            textPadding,
            textAlongLine: alongLine,
            textOffset,
            iconBoxScale,
            iconPadding,
            iconOffset,
            layoutTextSize,
            sizes,
            hasIconTextFit: fit !== 'none',
            variable,
        };
        const add = (line: P[], anchor: Anchor) => {
            if (isOutside([anchor.x, anchor.y])) return;
            this.addSymbol(bucket, feature, anchor, line, c);
        };
        const geometry = f.geometry;
        const ty = f.ty;
        if (res.placement === 'line') {
            for (const line of anchors.clipLine(geometry, 0, 0, EXTENT, EXTENT)) {
                const found = anchors.lineAnchors(line, symbolMinDistance, textMaxAngle, window, labelLength, textMaxBoxScale, overscaling, EXTENT);
                for (const anchor of found) {
                    let tooClose = false;
                    if (defaultShaping) {
                        let others = compareText.get(defaultShaping.text);
                        if (!others) compareText.set(defaultShaping.text, (others = []));
                        tooClose = others.some((o) => anchors.dist(o, [anchor.x, anchor.y]) < textRepeatDistance);
                        if (!tooClose) others.push([anchor.x, anchor.y]);
                    }
                    if (!tooClose) add(line, anchor);
                }
            }
        } else if (res.placement === 'line-center') {
            for (const line of geometry) {
                if (line.length <= 1) continue;
                const anchor = anchors.centerAnchor(line, textMaxAngle, window, labelLength * textMaxBoxScale);
                if (anchor) add(line, anchor);
            }
        } else if (ty === 3) {
            for (const polygon of classifyRings(geometry, 0)) {
                const poi = anchors.poleOfInaccessibility(polygon, 16.0);
                const ring = polygon[0].slice();
                if (ring.length >= 2 && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])) ring.push(ring[0]);
                add(ring, {x: poi[0], y: poi[1], segment: undefined});
            }
        } else if (ty === 2) {
            for (const line of geometry) {
                if (line.length < 2) continue;
                add(line, {x: line[0][0], y: line[0][1], segment: undefined});
            }
        } else if (ty === 1) {
            for (const l of geometry) {
                for (const p of l) add([p], {x: p[0], y: p[1], segment: undefined});
            }
        }
    }

    /** `getTextVariableAnchorOffset`: anchors with offsets in em*ONE_EM units. */
    private variableAnchorOffset(f: BucketFeature, tile: RenderTile): [string, P][] | undefined {
        const raw = this.raw?.layout;
        if (raw?.['text-variable-anchor-offset'] != null) {
            const v = this.lay('text-variable-anchor-offset', f, tile);
            if (v instanceof VariableAnchorOffsetCollection) {
                const out: [string, P][] = [];
                const vals = v.values as unknown[];
                for (let i = 0; i < vals.length; i += 2) {
                    const anchor = str(vals[i]) ?? 'center';
                    const o = num2(vals[i + 1]);
                    const offset: P = [o[0] * ONE_EM, o[1] * ONE_EM];
                    if (anchor.startsWith('top')) offset[1] -= BASELINE_OFFSET;
                    else if (anchor.startsWith('bottom')) offset[1] += BASELINE_OFFSET;
                    out.push([anchor, offset]);
                }
                return out;
            }
        }
        if (raw?.['text-variable-anchor'] == null) return undefined;
        const a = this.lay('text-variable-anchor', f, tile);
        if (!Array.isArray(a)) return undefined;
        const anchorNames = a.filter((v): v is string => typeof v === 'string');
        let offset: P;
        if (raw?.['text-radial-offset'] != null) {
            offset = [num(this.lay('text-radial-offset', f, tile)) * ONE_EM, Infinity];
        } else {
            const o = num2(this.lay('text-offset', f, tile));
            offset = [o[0] * ONE_EM, o[1] * ONE_EM];
        }
        return anchorNames.map((n) => [n, evaluateVariableOffset(n, offset)]);
    }

    private addSymbol(bucket: SymbolBucket, feature: SymbolFeature, anchor: Anchor, line: P[], c: AddSymbol): void {
        const tile = bucket.tile;
        const zoom = tile.overscaledZ;
        const f = feature.f;
        const textRotate = num(this.lay('text-rotate', f, tile));
        const iconRotate = num(this.lay('icon-rotate', f, tile));
        const textSize = this.packedSize(bucket.textSize, c.sizes.text, f, tile, zoom);
        const iconSize = this.packedSize(bucket.iconSize, c.sizes.icon, f, tile, zoom);
        const [lineStart, lineLength] = addLineVertices(bucket, anchor, line);
        const allowVertical = bucket.allowVerticalPlacement;
        const circle: Circle = {d: undefined};
        let verticalTextBox: CollisionBox | undefined = undefined;
        let verticalIconBox: CollisionBox | undefined = undefined;
        if (allowVertical && c.vertical) {
            const rot = textRotate + 90.0;
            const tp = c.textPadding;
            verticalTextBox = collisionBox(anchor, {kind: 'Text', shaping: c.vertical}, c.textBoxScale, [tp, tp, tp, tp], c.textAlongLine, rot, circle);
            if (c.verticalIcon) {
                verticalIconBox = collisionBox(anchor, {kind: 'Icon', icon: c.verticalIcon}, c.iconBoxScale, c.iconPadding, c.textAlongLine, rot, circle);
            }
        }
        const symbol = (quads: Quad[], size: [number, number], lineOffset: P, writingMode: WritingMode): PlacedSymbol => ({
            anchor: [anchor.x, anchor.y],
            quads,
            size,
            lineOffset,
            lineStart,
            lineLength,
            segment: anchor.segment,
            writingMode,
            feature: c.fi,
        });
        let iconIndex: number | undefined = undefined;
        let verticalIconIndex: number | undefined = undefined;
        let iconBox: CollisionBox | undefined = undefined;
        let numIconVertices = 0;
        if (c.shapedIcon) {
            const quads = iconQuads(c.shapedIcon, iconRotate, c.isSdfIcon, c.hasIconTextFit);
            iconBox = collisionBox(anchor, {kind: 'Icon', icon: c.shapedIcon}, c.iconBoxScale, c.iconPadding, false, iconRotate, circle);
            numIconVertices = quads.length * 4;
            bucket.icon.push(symbol(quads, iconSize, c.iconOffset, 'Horizontal'));
            iconIndex = bucket.icon.length - 1;
            if (c.verticalIcon) {
                const vquads = iconQuads(c.verticalIcon, iconRotate, c.isSdfIcon, c.hasIconTextFit);
                bucket.icon.push(symbol(vquads, iconSize, c.iconOffset, 'Vertical'));
                verticalIconIndex = bucket.icon.length - 1;
            }
        }
        const textIdx: [number | undefined, number | undefined, number | undefined] = [undefined, undefined, undefined];
        let textBox: CollisionBox | undefined = undefined;
        let numGlyphVertices = 0;
        let numVerticalGlyphVertices = 0;
        const all = c.horizontal.map((h) => h[0]);
        const horizontalMode: WritingMode = c.vertical ? 'Horizontal' : 'HorizontalOnly';
        let textCircleSet = false;
        let textCircle: number | undefined = undefined;
        for (const [j, shapingH] of c.horizontal) {
            if (textBox === undefined && !textCircleSet) {
                const d: Circle = {d: undefined};
                const tp = c.textPadding;
                textBox = collisionBox(anchor, {kind: 'Text', shaping: shapingH}, c.textBoxScale, [tp, tp, tp, tp], c.textAlongLine, textRotate, d);
                textCircleSet = true;
                textCircle = d.d;
            }
            const single = shapingH.lines.length === 1;
            const quads = glyphQuads(shapingH, c.textOffset, c.textAlongLine, textRotate, allowVertical);
            numGlyphVertices += quads.length * 4;
            bucket.text.push(symbol(quads, textSize, c.textOffset, horizontalMode));
            const idx = bucket.text.length - 1;
            const targets = single ? all : [j];
            for (const t of targets) {
                const slot = t === 'right' ? 0 : t === 'center' ? 1 : 2;
                textIdx[slot] = idx;
            }
            if (single) break;
        }
        let verticalText: number | undefined = undefined;
        if (c.vertical) {
            const quads = glyphQuads(c.vertical, c.textOffset, c.textAlongLine, textRotate, allowVertical);
            numVerticalGlyphVertices = quads.length * 4;
            bucket.text.push(symbol(quads, textSize, c.textOffset, 'Vertical'));
            verticalText = bucket.text.length - 1;
        }
        // The tallest circle diameter of all collision features.
        if (textCircle !== undefined) circle.d = circle.d === undefined ? textCircle : Math.max(circle.d, textCircle);
        const circleDiameter = circle.d === undefined ? undefined : (circle.d * c.layoutTextSize) / ONE_EM;
        if (feature.sortKey !== undefined) {
            const key = feature.sortKey;
            const i = bucket.instances.length;
            const last = bucket.sortKeyRanges[bucket.sortKeyRanges.length - 1];
            if (last !== undefined && last[0] === key) last[2] = i + 1;
            else bucket.sortKeyRanges.push([key, i, i + 1]);
        }
        bucket.instances.push({
            anchor: [int16(anchor.x), int16(anchor.y)],
            text: textIdx,
            verticalText,
            icon: iconIndex,
            verticalIcon: verticalIconIndex,
            textBox,
            verticalTextBox,
            iconBox,
            verticalIconBox,
            featureIndex: f.index,
            numGlyphVertices,
            numVerticalGlyphVertices,
            numIconVertices,
            collisionCircleDiameter: circleDiameter,
            textBoxScale: c.textBoxScale,
            anchorOffsets: c.variable ?? [],
        });
    }

    /** Packed `a_size` for source/composite sizes. */
    private packedSize(data: SizeData, prop: PropValue, f: BucketFeature, tile: RenderTile, zoom: number): [number, number] {
        // `f64::min`: NaN yields the other operand.
        const pack = (v: number) => {
            const r = Math.round(v * SIZE_PACK_FACTOR);
            return r !== r ? MAX_PACKED_SIZE : Math.min(r, MAX_PACKED_SIZE);
        };
        const at = (z: number) => num(prop.eval(z, f.feature, Ctx.canonical(tile)));
        if (data.kind === 'Source') return [pack(at(zoom)), 0];
        if (data.kind === 'Composite') return [pack(at(data.minZoom)), pack(at(data.maxZoom))];
        return [0, 0];
    }
}

/** `Option<f64>::partial_cmp(..).unwrap_or(Equal)`. */
function cmpOptF64(a: number | undefined, b: number | undefined): number {
    if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
}

function isOutside(p: P): boolean {
    return p[0] < 0 || p[0] >= EXTENT || p[1] < 0 || p[1] >= EXTENT;
}

function shapedLabelLength(text: Shaping | undefined, icon: PositionedIcon | undefined): number {
    return Math.max(text ? text.right - text.left : 0, icon ? icon.right - icon.left : 0);
}

/** `evaluateVariableOffset`: radial offsets come as `[r, INFINITY]`. */
export function evaluateVariableOffset(anchor: string, offset: P): P {
    let x = 0;
    let y = 0;
    if (offset[1] !== Infinity) {
        const ox = Math.abs(offset[0]);
        const oy = Math.abs(offset[1]);
        if (anchor === 'top-right' || anchor === 'top-left' || anchor === 'top') y = oy - BASELINE_OFFSET;
        else if (anchor === 'bottom-right' || anchor === 'bottom-left' || anchor === 'bottom') y = -oy + BASELINE_OFFSET;
        if (anchor === 'top-right' || anchor === 'bottom-right' || anchor === 'right') x = -ox;
        else if (anchor === 'top-left' || anchor === 'bottom-left' || anchor === 'left') x = ox;
    } else {
        const r = Math.max(offset[0], 0);
        const hyp = r / Math.SQRT2;
        if (anchor === 'top-right' || anchor === 'top-left') y = hyp - BASELINE_OFFSET;
        else if (anchor === 'bottom-right' || anchor === 'bottom-left') y = -hyp + BASELINE_OFFSET;
        else if (anchor === 'bottom') y = -r + BASELINE_OFFSET;
        else if (anchor === 'top') y = r - BASELINE_OFFSET;
        if (anchor === 'top-right' || anchor === 'bottom-right') x = -hyp;
        else if (anchor === 'top-left' || anchor === 'bottom-left') x = hyp;
        else if (anchor === 'left') x = r;
        else if (anchor === 'right') x = -r;
    }
    return [x, y];
}

/** `addToLineVertexArray`: the line with Int16 coordinates and distances from the anchor. */
function addLineVertices(bucket: SymbolBucket, anchor: Anchor, line: P[]): [number, number] {
    const start = bucket.lineVertices.length;
    const seg = anchor.segment;
    if (seg !== undefined) {
        const a: P = [anchor.x, anchor.y];
        const dists = new Array<number>(line.length).fill(0);
        let forward = anchors.dist(a, line[seg + 1]);
        for (let i = seg + 1; i < line.length; i++) {
            dists[i] = forward;
            if (i < line.length - 1) forward += anchors.dist(line[i + 1], line[i]);
        }
        let backward = anchors.dist(a, line[seg]);
        for (let i = seg; i >= 0; i--) {
            dists[i] = backward;
            if (i > 0) backward += anchors.dist(line[i - 1], line[i]);
        }
        for (let i = 0; i < line.length; i++) {
            bucket.lineVertices.push([[int16(line[i][0]), int16(line[i][1])], int16(dists[i])]);
        }
    }
    return [start, bucket.lineVertices.length - start];
}

type CollisionShape = {kind: 'Text'; shaping: Shaping} | {kind: 'Icon'; icon: PositionedIcon};
/** The running collision circle diameter (`Option<f64>` out-parameter). */
type Circle = {d: number | undefined};

/** `CollisionFeature`: one Int16 box, or (along lines) just the circle diameter. */
function collisionBox(
    anchor: Anchor,
    shape: CollisionShape,
    scale: number,
    padding: [number, number, number, number],
    alignLine: boolean,
    rotate: number,
    circle: Circle,
): CollisionBox | undefined {
    let b: [number, number, number, number];
    let collisionPadding: [number, number, number, number] | undefined;
    if (shape.kind === 'Text') {
        const s = shape.shaping;
        b = [s.left, s.top, s.right, s.bottom];
        collisionPadding = undefined;
    } else {
        const i = shape.icon;
        b =
            i.image.content !== undefined && (i.image.textFitWidth !== undefined || i.image.textFitHeight !== undefined)
                ? shaping.applyTextFit(i)
                : [i.left, i.top, i.right, i.bottom];
        collisionPadding = i.collisionPadding;
    }
    if (alignLine) {
        let top = b[1];
        let bottom = b[3];
        if (collisionPadding) {
            top -= collisionPadding[1];
            bottom += collisionPadding[3];
        }
        const height = bottom - top;
        if (height > 0) {
            const d = Math.max(height, 10);
            circle.d = circle.d === undefined ? d : Math.max(circle.d, d);
        }
        return undefined;
    }
    b = [b[0] * scale - padding[3], b[1] * scale - padding[0], b[2] * scale + padding[1], b[3] * scale + padding[2]];
    if (collisionPadding) {
        b[0] -= collisionPadding[0] * scale;
        b[1] -= collisionPadding[1] * scale;
        b[2] += collisionPadding[2] * scale;
        b[3] += collisionPadding[3] * scale;
    }
    if (rotate !== 0) {
        const r = rotate * (Math.PI / 180);
        const s = Math.sin(r);
        const c = Math.cos(r);
        const pts = [
            [b[0], b[1]],
            [b[2], b[1]],
            [b[0], b[3]],
            [b[2], b[3]],
        ].map((p) => [p[0] * c - p[1] * s, p[0] * s + p[1] * c]);
        b = [
            Math.min(...pts.map((p) => p[0])),
            Math.min(...pts.map((p) => p[1])),
            Math.max(...pts.map((p) => p[0])),
            Math.max(...pts.map((p) => p[1])),
        ];
    }
    return {anchor: [int16(anchor.x), int16(anchor.y)], x1: int16(b[0]), y1: int16(b[1]), x2: int16(b[2]), y2: int16(b[3])};
}

function rotateQuad(corners: [P, P, P, P], radians: number): void {
    if (radians === 0) return;
    const s = Math.sin(radians);
    const c = Math.cos(radians);
    // `_matMult([cos, -sin, sin, cos])`
    for (let i = 0; i < 4; i++) {
        const p = corners[i];
        corners[i] = [c * p[0] - s * p[1], s * p[0] + c * p[1]];
    }
}

/** `getGlyphQuads`: vertical glyphs are pre-rotated -90° (the label is turned at render). */
function glyphQuads(shapingIn: Shaping, textOffset: P, alongLine: boolean, textRotateDeg: number, allowVerticalPlacement: boolean): Quad[] {
    const rotate = (textRotateDeg * Math.PI) / 180.0;
    const quads: Quad[] = [];
    for (const line of shapingIn.lines) {
        for (const g of line.glyphs) {
            let rectBuffer = BORDER + 1.0;
            let isSdf = true;
            let pixelRatio = 1.0;
            const isImage = g.tex.kind === 'Image';
            if (g.tex.kind === 'Image') {
                isSdf = g.tex.image.sdf;
                pixelRatio = g.tex.image.pixelRatio;
                rectBuffer = IMAGE_PADDING / pixelRatio;
            }
            const rotateVertical = (alongLine || allowVerticalPlacement) && g.vertical;
            const halfAdvance = (g.metrics.advance * g.scale) / 2.0;
            let lineOffset = 0;
            if (allowVerticalPlacement && shapingIn.verticalizable) {
                const scaledGlyphOffset = (g.scale - 1) * ONE_EM;
                const imageOffset = (ONE_EM - g.metrics.width * g.scale) / 2.0;
                lineOffset = line.lineOffset / 2.0 - (isImage ? -imageOffset : scaledGlyphOffset);
            }
            const glyphOffset: P = alongLine ? [g.x + halfAdvance, g.y] : [0, 0];
            let builtIn: P = alongLine ? [0, 0] : [g.x + halfAdvance + textOffset[0], g.y + textOffset[1] - lineOffset];
            let verticalizedOffset: P = [0, 0];
            if (rotateVertical) {
                verticalizedOffset = builtIn;
                builtIn = [0, 0];
            }
            const [rw, rh] = shaping.texRectSize(g.tex);
            const x1 = (g.metrics.left - rectBuffer) * g.scale - halfAdvance + builtIn[0];
            const y1 = (-g.metrics.top - rectBuffer) * g.scale + builtIn[1];
            const x2 = x1 + (rw * g.scale) / pixelRatio;
            const y2 = y1 + (rh * g.scale) / pixelRatio;
            const corners: [P, P, P, P] = [
                [x1, y1],
                [x2, y1],
                [x1, y2],
                [x2, y2],
            ];
            if (rotateVertical) {
                const center: P = [-halfAdvance, halfAdvance - SHAPING_DEFAULT_OFFSET];
                const s = Math.sin(-Math.PI / 2);
                const c = Math.cos(-Math.PI / 2);
                const xHalf = ONE_EM / 2.0 - halfAdvance;
                const yImage = isImage ? xHalf : 0;
                const correction: P = [5.0 - SHAPING_DEFAULT_OFFSET - xHalf, -yImage];
                for (let i = 0; i < 4; i++) {
                    const p = corners[i];
                    // `_rotateAround(-PI/2, center)`, then the offsets.
                    const dx = p[0] - center[0];
                    const dy = p[1] - center[1];
                    corners[i] = [
                        center[0] + c * dx - s * dy + correction[0] + verticalizedOffset[0],
                        center[1] + s * dx + c * dy + correction[1] + verticalizedOffset[1],
                    ];
                }
            }
            rotateQuad(corners, rotate);
            quads.push({
                corners,
                tex: g.tex,
                rect: [0, 0, rw, rh],
                pixelOffsetTl: [0, 0],
                pixelOffsetBr: [0, 0],
                minFontScale: [0, 0],
                glyphOffset,
                section: g.section,
                isSdf,
            });
        }
    }
    return quads;
}

interface Cut {
    fixed: number;
    stretch: number;
}

/** `getIconQuads`, including nine-patch stretching for `icon-text-fit`. */
function iconQuads(icon: PositionedIcon, rotateDeg: number, isSdf: boolean, hasIconTextFit: boolean): Quad[] {
    const image = icon.image;
    const pixelRatio = image.pixelRatio;
    const imageW = image.image.w;
    const imageH = image.image.h;
    let b: [number, number, number, number] = [icon.left, icon.top, icon.right, icon.bottom];
    const stretchX: [number, number][] = image.stretchX ?? [[0, imageW]];
    const stretchY: [number, number][] = image.stretchY ?? [[0, imageH]];
    const sum = (r: [number, number][]) => r.reduce((acc, z) => acc + (z[1] - z[0]), 0);
    const stretchW = sum(stretchX);
    const stretchH = sum(stretchY);
    const fixedW = imageW - stretchW;
    const fixedH = imageH - stretchH;
    let soX = 0;
    let scW = stretchW;
    let soY = 0;
    let scH = stretchH;
    let foX = 0;
    let fcW = fixedW;
    let foY = 0;
    let fcH = fixedH;
    const c = image.content;
    if (c !== undefined && hasIconTextFit) {
        const cw = c[2] - c[0];
        const ch = c[3] - c[1];
        if (image.textFitWidth !== undefined || image.textFitHeight !== undefined) b = shaping.applyTextFit(icon);
        const within = (r: [number, number][], min: number, max: number) =>
            r.reduce((acc, z) => acc + (Math.max(min, Math.min(max, z[1])) - Math.max(min, Math.min(max, z[0]))), 0);
        soX = within(stretchX, 0, c[0]);
        soY = within(stretchY, 0, c[1]);
        scW = within(stretchX, c[0], c[2]);
        scH = within(stretchY, c[1], c[3]);
        foX = c[0] - soX;
        foY = c[1] - soY;
        fcW = cw - scW;
        fcH = ch - scH;
    }
    const iconLeft = b[0];
    const iconTop = b[1];
    const iconW = b[2] - b[0];
    const iconH = b[3] - b[1];
    const em = (stretchOffset: number, stretchSize: number, size: number, offset: number) => (stretchOffset / stretchSize) * size + offset;
    const px = (fixedOffset: number, fixedSize: number, stretchOffset: number, stretchSize: number) =>
        fixedOffset - (fixedSize * stretchOffset) / stretchSize;
    const make = (l: Cut, t: Cut, r: Cut, bo: Cut): Quad => {
        const leftEm = em(l.stretch - soX, scW, iconW, iconLeft);
        const leftPx = px(l.fixed - foX, fcW, l.stretch, stretchW);
        const topEm = em(t.stretch - soY, scH, iconH, iconTop);
        const topPx = px(t.fixed - foY, fcH, t.stretch, stretchH);
        const rightEm = em(r.stretch - soX, scW, iconW, iconLeft);
        const rightPx = px(r.fixed - foX, fcW, r.stretch, stretchW);
        const bottomEm = em(bo.stretch - soY, scH, iconH, iconTop);
        const bottomPx = px(bo.fixed - foY, fcH, bo.stretch, stretchH);
        const corners: [P, P, P, P] = [
            [leftEm, topEm],
            [rightEm, topEm],
            [leftEm, bottomEm],
            [rightEm, bottomEm],
        ];
        rotateQuad(corners, (rotateDeg * Math.PI) / 180.0);
        const x1 = l.stretch + l.fixed;
        const x2 = r.stretch + r.fixed;
        const y1 = t.stretch + t.fixed;
        const y2 = bo.stretch + bo.fixed;
        return {
            corners,
            tex: {kind: 'Image', image},
            rect: [IMAGE_PADDING + x1, IMAGE_PADDING + y1, x2 - x1, y2 - y1],
            pixelOffsetTl: [leftPx / pixelRatio, topPx / pixelRatio],
            pixelOffsetBr: [rightPx / pixelRatio, bottomPx / pixelRatio],
            minFontScale: [fcW / pixelRatio / iconW, fcH / pixelRatio / iconH],
            glyphOffset: [0, 0],
            section: 0,
            isSdf,
        };
    };
    if (!hasIconTextFit || (image.stretchX === undefined && image.stretchY === undefined)) {
        const cut = (stretch: number): Cut => ({fixed: 0, stretch});
        return [make(cut(-1), cut(-1), cut(imageW + 1), cut(imageH + 1))];
    }
    const cuts = (zones: [number, number][], fixed: number, stretch: number): Cut[] => {
        const out: Cut[] = [{fixed: -IMAGE_PADDING, stretch: 0}];
        for (const z of zones) {
            const last = out[out.length - 1];
            out.push({fixed: z[0] - last.stretch, stretch: last.stretch});
            out.push({fixed: z[0] - last.stretch, stretch: last.stretch + (z[1] - z[0])});
        }
        out.push({fixed: fixed + IMAGE_PADDING, stretch});
        return out;
    };
    const xc = cuts(stretchX, fixedW, stretchW);
    const yc = cuts(stretchY, fixedH, stretchH);
    const quads: Quad[] = [];
    for (let xi = 0; xi < xc.length - 1; xi++) {
        for (let yi = 0; yi < yc.length - 1; yi++) quads.push(make(xc[xi], yc[yi], xc[xi + 1], yc[yi + 1]));
    }
    return quads;
}
