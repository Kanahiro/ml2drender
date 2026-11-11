// Drawing symbol layers (`draw_symbol.ts` + the `symbol_sdf` / `symbol_icon` /
// `symbol_text_and_icon` shaders): glyph and icon quads rasterized with the GL rules.

import {int16} from './layout.ts';
import type {PlacedSymbol, SizeData, SymbolBucket} from './layout.ts';
import {Resolved} from './layout.ts';
import {sortedSymbolIndexes} from './placement.ts';
import type {InstancePlacement, VariableOffset} from './placement.ts';
import {LineProjector} from './projection.ts';
import type {Glyph} from './glyphs.ts';
import * as shaping from './shaping.ts';
import {ONE_EM} from './shaping.ts';
import type {Tex} from './shaping.ts';
import type {Filter} from '../image.ts';
import * as raster from '../render/raster.ts';
import type {Rgba, Target} from '../render/raster.ts';
import {EXTENT, color, num} from '../render/mod.ts';
import type {Ctx} from '../render/mod.ts';
import {layout, paint} from '../style.ts';
import type {Layer, Value} from '../style.ts';

type P = [number, number];

/** One placed symbol to draw: bucket, symbol and where its quads go. */
interface Item {
    bucket: number;
    symbol: number;
    sortKey: number;
    /** Per-quad label-plane point and angle (line labels); otherwise the anchor for all quads. */
    positions: [P, number][];
}

/** Fragment paint of a symbol (per feature/section). */
interface Paint {
    fill: Rgba;
    halo: Rgba;
    opacity: number;
    haloWidth: number;
    haloBlur: number;
}

interface Mode {
    halo: boolean;
    plain: boolean;
    isText: boolean;
    filter: Filter;
}

/** `Ordering` of `f64::total_cmp` for the finite/infinite values tile positions take. */
const totalCmp = (a: number, b: number) => (a < b ? -1 : a > b ? 1 : 0);

export function drawSymbolLayer(target: Target, layer: Layer, ctx: Ctx, raw: any, buckets: SymbolBucket[], placements: InstancePlacement[][]): void {
    const first = buckets[0];
    if (!first) return;
    const res = new Resolved(layer, ctx, first.tile);
    const constantOr = (name: string, def: number) => (paint(layer, name).isFeatureConstant() ? num(ctx.paint(layer, name, undefined, first.tile)) : def);
    // Draw order: tiles by zoom (high first), then by y and x rotated with the map.
    const angle = -ctx.transform.bearingRad;
    const sin = Math.sin(angle);
    const cos = Math.cos(angle);
    const rotated = (i: number): P => {
        const c = buckets[i].tile.canonical;
        return [cos * c.x - sin * c.y, sin * c.x + cos * c.y];
    };
    const order = buckets.map((_, i) => i);
    order.sort((a, b) => {
        const ra = rotated(a);
        const rb = rotated(b);
        return buckets[b].tile.overscaledZ - buckets[a].tile.overscaledZ || totalCmp(ra[1], rb[1]) || totalCmp(ra[0], rb[0]);
    });
    if (constantOr('icon-opacity', 1.0) !== 0) drawPass(target, layer, ctx, raw, res, buckets, placements, order, false);
    if (constantOr('text-opacity', 1.0) !== 0) drawPass(target, layer, ctx, raw, res, buckets, placements, order, true);
}

function drawPass(
    target: Target,
    layer: Layer,
    ctx: Ctx,
    raw: any,
    res: Resolved,
    buckets: SymbolBucket[],
    placements: InstancePlacement[][],
    order: number[],
    isText: boolean,
): void {
    const t = ctx.transform;
    const prefix = isText ? 'text' : 'icon';
    const rotationAlignment = isText ? res.textRotationAlignment : res.iconRotationAlignment;
    const rotateWithMap = rotationAlignment === 'map';
    const pitchWithMap = isText ? res.textPitchAlignment === 'map' : res.iconPitchAlignment === 'map';
    const alongLine = rotationAlignment !== 'viewport' && res.placement !== 'point';
    const hasVariable = ['text-variable-anchor', 'text-variable-anchor-offset'].some((k) => raw?.layout?.[k] != null);
    // Layer-level layout values are evaluated at the map zoom (bucket values at the tile zoom).
    const layNow = (n: string): Value => layout(layer, n).eval(t.zoom);
    const keepUpright = !!layNow(`${prefix}-keep-upright`);
    const hasSortKey = !layout(layer, 'symbol-sort-key').isConstant();
    let sortByKey = false;
    // Screen angle of the tile x axis (`u_rotate_symbol` / rotate-with-map label planes).
    const mapAngle = t.bearingRad;
    const fitNow = layNow('icon-text-fit');
    const hasIconTextFit = typeof fitNow === 'string' && fitNow !== 'none';
    const items: Item[] = [];
    for (const bi of order) {
        const bucket = buckets[bi];
        const symbols = isText ? bucket.text : bucket.icon;
        if (symbols.length === 0) continue;
        const tile = bucket.tile;
        const toTile = EXTENT / ctx.tilePx(tile);
        const tr = ctx.translate(layer, prefix, tile);
        const translation: P = [tr[0] * toTile, tr[1] * toTile];
        const projector = new LineProjector(ctx, bucket, translation);
        const sizeData = isText ? bucket.textSize : bucket.iconSize;
        const updateTextFitIcon = !isText && hasVariable && hasIconTextFit && bucket.text.length > 0;
        const textSize = bucket.textSize;
        // Symbol index → (instance, whether this symbol is the one drawn for it).
        const owner: ([number, boolean] | undefined)[] = new Array(symbols.length).fill(undefined);
        bucket.instances.forEach((inst, ii) => {
            const p = placements[bi][ii];
            const horizontalHidden = p.orientation === 'Vertical';
            const verticalHidden = p.orientation === 'Horizontal' || p.orientation === 'HorizontalOnly';
            if (isText) {
                // `markUsedJustification`: the shaping of the placed anchor's justification (or
                // the vertical one); without such a shaping every shaping stays in use.
                const hasUsed = p.variable !== undefined;
                let used: number | undefined = undefined;
                if (p.variable !== undefined) {
                    const j = shaping.anchorJustification(p.variable.anchor);
                    if (p.orientation === 'Vertical') used = inst.verticalText;
                    else if (j === 'right') used = inst.text[0];
                    else if (j === 'center') used = inst.text[1];
                    else used = inst.text[2];
                }
                const inUse = (s: number) => !hasVariable || (hasUsed && used === undefined) || (hasUsed && used === s);
                for (const s of inst.text) {
                    if (s === undefined) continue;
                    const visible = p.text && !horizontalHidden && inUse(s);
                    owner[s] = [ii, visible || (owner[s]?.[1] ?? false)];
                }
                if (inst.verticalText !== undefined) {
                    const s = inst.verticalText;
                    owner[s] = [ii, p.text && !verticalHidden && inUse(s)];
                }
            } else {
                const useHorizontal = !(hasIconTextFit && inst.verticalIcon !== undefined && horizontalHidden);
                if (inst.icon !== undefined) owner[inst.icon] = [ii, p.icon && useHorizontal];
                if (inst.verticalIcon !== undefined) owner[inst.verticalIcon] = [ii, p.icon && !useHorizontal];
            }
        });
        // `updateLineLabels`: in symbol order, a horizontal label too steep for its line hands
        // over to the vertical one that follows it.
        const linePositions: ([P, number][] | undefined)[] = new Array(alongLine ? symbols.length : 0).fill(undefined);
        if (alongLine) {
            let useVertical = false;
            const rotateToLine = res.textRotationAlignment === 'map';
            const buf = 256.0 / t.pixelRatio;
            for (let si = 0; si < symbols.length; si++) {
                const sym = symbols[si];
                const visible = owner[si]?.[1] ?? false;
                if (!visible || (sym.writingMode === 'Vertical' && !useVertical)) continue;
                useVertical = false;
                const a = projector.project([int16(sym.anchor[0]), int16(sym.anchor[1])]);
                if (a[0] < -buf || a[0] > t.width + buf || a[1] < -buf || a[1] > t.height + buf) continue;
                const size = sizeData.forFeature(t.zoom, sym.size);
                const r = projector.placeSymbol(sym, size, keepUpright, rotateToLine);
                if (r.kind === 'Placed') linePositions[si] = r.positions;
                else if (r.kind === 'UseVertical') useVertical = true;
            }
        }
        let symbolOrder: number[];
        if (bucket.sortFeaturesByY) {
            symbolOrder = [];
            for (const ii of sortedSymbolIndexes(bucket, mapAngle)) {
                const inst = bucket.instances[ii];
                if (isText) {
                    for (let k = 0; k < 3; k++) {
                        const s = inst.text[k];
                        if (s !== undefined && !inst.text.slice(0, k).includes(s)) symbolOrder.push(s);
                    }
                    if (inst.verticalText !== undefined) symbolOrder.push(inst.verticalText);
                } else {
                    if (inst.icon !== undefined) symbolOrder.push(inst.icon);
                    if (inst.verticalIcon !== undefined) symbolOrder.push(inst.verticalIcon);
                }
            }
        } else {
            symbolOrder = symbols.map((_, i) => i);
        }
        for (const si of symbolOrder) {
            const own = owner[si];
            if (own === undefined || !own[1]) continue;
            const ii = own[0];
            const sym = symbols[si];
            const inst = bucket.instances[ii];
            const placement = placements[bi][ii];
            let positions: [P, number][];
            if (alongLine) {
                const p = linePositions[si];
                if (p === undefined) continue;
                linePositions[si] = undefined;
                positions = p;
            } else {
                const base = projector.project(sym.anchor);
                const angle = rotateWithMap ? mapAngle : 0;
                // `Option<Option<&VariableOffset>>`: `shiftSet` is the outer `Some`.
                let shiftSet = false;
                let shiftV: VariableOffset | undefined = undefined;
                if (isText) {
                    if (hasVariable) {
                        shiftSet = true;
                        shiftV = placement.variable;
                    }
                } else if (updateTextFitIcon) {
                    shiftSet = true;
                    shiftV = placement.variable;
                }
                // Vertical point labels are turned a quarter (`addDynamicAttributes`).
                const verticalAngle = (vertical: boolean) => (bucket.allowVerticalPlacement && vertical ? Math.PI / 2 : 0);
                let point: P;
                let glyphAngle: number;
                if (shiftSet && shiftV === undefined) continue;
                if (shiftV !== undefined) {
                    const v = shiftV;
                    const textSym = inst.text.find((s) => s !== undefined) ?? inst.verticalText;
                    const renderSize = textSize.forFeature(t.zoom, textSym !== undefined ? bucket.text[textSym].size : sym.size) / ONE_EM;
                    const [h, vv] = shaping.anchorAlignment(v.anchor);
                    let shift: P = [
                        (-(h - 0.5) * v.width / v.textBoxScale + v.textOffset[0]) * renderSize,
                        (-(vv - 0.5) * v.height / v.textBoxScale + v.textOffset[1]) * renderSize,
                    ];
                    if (rotateWithMap) shift = rotate(shift, angle);
                    const b = projector.project([int16(sym.anchor[0]), int16(sym.anchor[1])]);
                    point = [b[0] + shift[0], b[1] + shift[1]];
                    glyphAngle = verticalAngle(placement.orientation === 'Vertical');
                } else {
                    point = base;
                    glyphAngle = verticalAngle(sym.writingMode === 'Vertical');
                }
                positions = sym.quads.map(() => [point, glyphAngle]);
            }
            const sortKey = bucket.features[sym.feature].sortKey ?? 0;
            if (hasSortKey && bucket.canOverlap) sortByKey = true;
            items.push({bucket: bi, symbol: si, sortKey, positions});
        }
    }
    if (sortByKey) items.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));

    const haloWidthProp = paint(layer, `${prefix}-halo-width`);
    const haloConst = haloWidthProp.isFeatureConstant() ? num(ctx.paint(layer, `${prefix}-halo-width`, undefined, buckets[0].tile)) : undefined;
    const letterSpacing = layout(layer, 'text-letter-spacing').isFeatureConstant() ? num(layNow('text-letter-spacing')) : 0;
    const glyphOverlap = letterSpacing * ONE_EM < 0 || (haloConst ?? Infinity) > 1;
    const iconSizeConst = layout(layer, 'icon-size').isFeatureConstant() ? num(layNow('icon-size')) : 0;

    // Each tile is drawn (halo pass, then fill pass) before the next; with sort keys the
    // segments of all tiles interleave.
    let i = 0;
    while (i < items.length) {
        let j = i + 1;
        while (j < items.length && items[j].bucket === items[i].bucket && !sortByKey) j++;
        if (sortByKey) {
            while (j < items.length && items[j].bucket === items[i].bucket && items[j].sortKey === items[i].sortKey) j++;
        }
        const bucket = buckets[items[i].bucket];
        const isSdf = isText || bucket.sdfIcons;
        const hasHalo = isSdf && (haloConst ?? 1) !== 0;
        const iconLinear = isSdf || iconSizeConst !== 1 || bucket.iconsNeedLinear || pitchWithMap;
        const sizeData = isText ? bucket.textSize : bucket.iconSize;
        // Glyphs are always LINEAR; images inside text only when transformed or sized by zoom.
        const zoomSized = sizeData.kind === 'Camera' || sizeData.kind === 'Composite';
        const filter: Filter = isText ? (pitchWithMap || zoomSized ? 'Linear' : 'Nearest') : iconLinear ? 'Linear' : 'Nearest';
        const mode = (halo: boolean, plain: boolean): Mode => ({halo, plain, isText, filter});
        const passes: Mode[] = hasHalo && glyphOverlap ? [mode(true, false), mode(false, true)] : [mode(hasHalo, true)];
        for (const m of passes) {
            for (let k = i; k < j; k++) {
                const item = items[k];
                const symbols = isText ? bucket.text : bucket.icon;
                const sym = symbols[item.symbol];
                drawSymbol(target, layer, ctx, bucket, sym, item.positions, sizeData, rotateWithMap && !alongLine, mapAngle, m);
            }
        }
        i = j;
    }
}

function rotate(v: P, a: number): P {
    const s = Math.sin(a);
    const c = Math.cos(a);
    return [v[0] * c - v[1] * s, v[0] * s + v[1] * c];
}

function paintFor(layer: Layer, ctx: Ctx, bucket: SymbolBucket, sym: PlacedSymbol, section: number, isText: boolean): Paint {
    const prefix = isText ? 'text' : 'icon';
    const feature = bucket.features[sym.feature];
    const p = (n: string) => ctx.paint(layer, `${prefix}-${n}`, feature.f, bucket.tile);
    let fill = p('color');
    if (isText) {
        const overrideColor = feature.text?.sections[section]?.textColor;
        if (overrideColor) fill = overrideColor;
    }
    return {
        fill: color(fill, 1.0),
        halo: color(p('halo-color'), 1.0),
        opacity: num(p('opacity')),
        haloWidth: num(p('halo-width')),
        haloBlur: num(p('halo-blur')),
    };
}

/** Bilinear sample of a glyph SDF (alpha) at texel coordinates of its padded rect. */
function sampleGlyph(g: Glyph, tx: number, ty: number): number {
    const texel = (x: number, y: number): number => {
        // The padded rect has a 1px empty border around the bitmap.
        const bx = x - 1;
        const by = y - 1;
        if (bx < 0 || by < 0 || bx >= g.bw || by >= g.bh) return 0;
        return g.bitmap[by * g.bw + bx] / 255.0;
    };
    const x = tx - 0.5;
    const y = ty - 0.5;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const a = texel(x0, y0);
    const b = texel(x0 + 1, y0);
    const c = texel(x0, y0 + 1);
    const d = texel(x0 + 1, y0 + 1);
    return (a * (1.0 - fx) + b * fx) * (1.0 - fy) + (c * (1.0 - fx) + d * fx) * fy;
}

/** Sample a quad's texture at texel coordinates of the padded rect: (sdf alpha, rgba). */
function sample(tex: Tex, tx: number, ty: number, filter: Filter): Rgba {
    if (tex.kind === 'Glyph') return [0, 0, 0, sampleGlyph(tex.glyph, tx, ty)];
    const img = tex.image;
    const [w, h] = img.icon.size();
    const f: Filter = img.sdf ? 'Linear' : filter;
    return img.icon.sample(tx / w, ty / h, f, f, 0.0);
}

function drawSymbol(
    target: Target,
    layer: Layer,
    ctx: Ctx,
    bucket: SymbolBucket,
    sym: PlacedSymbol,
    positions: [P, number][],
    sizeData: SizeData,
    rotateSymbol: boolean,
    mapAngle: number,
    m: Mode,
): void {
    const t = ctx.transform;
    const dpr = t.pixelRatio;
    const size = sizeData.shaderSize(t.zoom, sym.size);
    const fontScale = m.isText ? size / 24.0 : size;
    let paintCache: [number, Paint] | undefined = undefined;
    const out: Rgba = [0, 0, 0, 0];
    for (let qi = 0; qi < sym.quads.length; qi++) {
        const q = sym.quads[qi];
        const at = positions[qi];
        if (at === undefined) continue;
        const [pos, glyphAngle] = at;
        if (paintCache === undefined || paintCache[0] !== q.section) paintCache = [q.section, paintFor(layer, ctx, bucket, sym, q.section, m.isText)];
        const pt = paintCache[1];
        const totalOpacity = pt.opacity;
        if (totalOpacity < 0.1) continue;
        const angle = glyphAngle + (rotateSymbol ? mapAngle : 0);
        const sin = Math.sin(angle);
        const cos = Math.cos(angle);
        const pxo = (v: number) => int16(v * 16.0) / 16.0;
        const mfs = [int16(q.minFontScale[0] * 256.0) / 256.0, int16(q.minFontScale[1] * 256.0) / 256.0];
        const scale = [Math.max(mfs[0], fontScale), Math.max(mfs[1], fontScale)];
        const y = q.glyphOffset[1];
        const corner = (i: number, px: P): P => {
            const o = q.corners[i];
            const off = [int16(Math.round(o[0] * 32.0)) / 32.0, int16(Math.round((y + o[1]) * 32.0)) / 32.0];
            const v = [off[0] * scale[0] + pxo(px[0]), off[1] * scale[1] + pxo(px[1])];
            const r = [v[0] * cos - v[1] * sin, v[0] * sin + v[1] * cos];
            return [(pos[0] + r[0]) * dpr, (pos[1] + r[1]) * dpr];
        };
        const tl = q.pixelOffsetTl;
        const br = q.pixelOffsetBr;
        const pts: P[] = [corner(0, tl), corner(1, [br[0], tl[1]]), corner(2, [tl[0], br[1]]), corner(3, br)];
        const [rx, ry, rw, rh] = q.rect;
        const uv: [number, number][] = [
            [rx, ry],
            [rx + rw, ry],
            [rx, ry + rh],
            [rx + rw, ry + rh],
        ];
        const gammaBase = 0.105 / dpr;
        const fs = fontScale;
        const sdf = q.isSdf;
        // The fragment shader; its result is reused by the next fragment.
        const shade = (v: ArrayLike<number>): Rgba | undefined => {
            const tex = q.tex;
            if (!sdf) {
                const s = sample(tex, v[0], v[1], m.filter);
                for (let j = 0; j < 4; j++) out[j] = s[j] * totalOpacity;
                return out;
            }
            const dist = tex.kind === 'Glyph' ? sampleGlyph(tex.glyph, v[0], v[1]) : sample(tex, v[0], v[1], m.filter)[3];
            const gamma = gammaBase / fs;
            // `text` and `halo` colors are `color * k`; a disabled one is transparent.
            const kText = m.plain ? totalOpacity * raster.smoothstep(0.75 - gamma, 0.75 + gamma, dist) : 0;
            let kHalo = 0;
            if (m.halo) {
                const gammaHalo = ((pt.haloBlur * 1.19) / 8.0 + gammaBase) / fs;
                const inner = 0.75 + gammaHalo;
                const alphaHalo = raster.smoothstep(inner - gammaHalo, inner + gammaHalo, dist);
                const edge = (6.0 - pt.haloWidth / fs) / 8.0;
                kHalo = totalOpacity * Math.min(raster.smoothstep(edge - gammaHalo, edge + gammaHalo, dist), 1.0 - alphaHalo);
            }
            if (m.plain && m.halo) {
                const r = 1.0 - pt.fill[3] * kText;
                for (let j = 0; j < 4; j++) out[j] = pt.fill[j] * kText + r * (pt.halo[j] * kHalo);
            } else if (m.halo) {
                for (let j = 0; j < 4; j++) out[j] = pt.halo[j] * kHalo;
            } else if (m.plain) {
                for (let j = 0; j < 4; j++) out[j] = pt.fill[j] * kText;
            } else {
                out.fill(0);
            }
            return out;
        };
        // Index order (0, 2, 1), (1, 2, 3).
        raster.triangle(target, undefined, [pts[0], pts[2], pts[1]], [uv[0], uv[2], uv[1]], shade);
        raster.triangle(target, undefined, [pts[1], pts[2], pts[3]], [uv[1], uv[2], uv[3]], shade);
    }
}
