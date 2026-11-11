// Collision detection and placement (`grid_index.ts`, `collision_index.ts`, `placement.ts`) for
// a static, unpitched camera: one placement pass, no fading (render tests use `fadeDuration: 0`,
// where the settled state is "visible iff placed").

import * as anchors from './anchors.ts';
import type {P} from './anchors.ts';
import {Resolved, overlapMode} from './layout.ts';
import type {CollisionBox, PlacedSymbol, SymbolBucket} from './layout.ts';
import {labelPath} from './projection.ts';
import * as shaping from './shaping.ts';
import type {WritingMode} from './shaping.ts';
import {EXTENT, num} from '../render/mod.ts';
import type {Ctx} from '../render/mod.ts';
import type {Layer} from '../style.ts';
import type {RenderTile, Transform} from '../tile.ts';

export const VIEWPORT_PADDING = 100.0;

export type Overlap = 'Never' | 'Always' | 'Cooperative';

/** `Overlap::from`. */
export function overlapFrom(s: string): Overlap {
    return s === 'always' ? 'Always' : s === 'cooperative' ? 'Cooperative' : 'Never';
}

function overlapAllowed(a: Overlap, b: Overlap): boolean {
    return a === 'Always' || (a !== 'Never' && b !== 'Never');
}

/** `x as usize` of a cell coordinate: floor, clamped to `[0, n - 1]` (NaN → 0). */
function cell(x: number, s: number, n: number): number {
    const f = Math.floor(x * s);
    return Math.min(f > 0 ? f : 0, n - 1);
}

/** `GridIndex` (boxes and circles in 25px cells). */
export class GridIndex {
    private boxCells: number[][];
    private circleCells: number[][];
    private boxes: {b: [number, number, number, number]; mode: Overlap; group: number}[] = [];
    private circles: {c: [number, number, number]; mode: Overlap; group: number}[] = [];
    private xCells: number;
    private yCells: number;
    private width: number;
    private height: number;
    private xScale: number;
    private yScale: number;

    constructor(width: number, height: number, cellSize: number) {
        const xCells = Math.max(0, Math.ceil(width / cellSize));
        const yCells = Math.max(0, Math.ceil(height / cellSize));
        this.boxCells = Array.from({length: xCells * yCells}, () => []);
        this.circleCells = Array.from({length: xCells * yCells}, () => []);
        this.xCells = xCells;
        this.yCells = yCells;
        this.width = width;
        this.height = height;
        this.xScale = xCells / width;
        this.yScale = yCells / height;
    }

    /** Cell index range `[cx1, cy1, cx2, cy2]` (inclusive) of a box. */
    private cells(x1: number, y1: number, x2: number, y2: number): [number, number, number, number] {
        return [cell(x1, this.xScale, this.xCells), cell(y1, this.yScale, this.yCells), cell(x2, this.xScale, this.xCells), cell(y2, this.yScale, this.yCells)];
    }

    insert(mode: Overlap, group: number, b: [number, number, number, number]): void {
        const uid = this.boxes.length;
        const [cx1, cy1, cx2, cy2] = this.cells(b[0], b[1], b[2], b[3]);
        for (let x = cx1; x <= cx2; x++) for (let y = cy1; y <= cy2; y++) this.boxCells[this.xCells * y + x].push(uid);
        this.boxes.push({b, mode, group});
    }

    insertCircle(mode: Overlap, group: number, x: number, y: number, r: number): void {
        const uid = this.circles.length;
        const [cx1, cy1, cx2, cy2] = this.cells(x - r, y - r, x + r, y + r);
        for (let cx = cx1; cx <= cx2; cx++) for (let cy = cy1; cy <= cy2; cy++) this.circleCells[this.xCells * cy + cx].push(uid);
        this.circles.push({c: [x, y, r], mode, group});
    }

    /** `group` 0 collides with everything; otherwise only within the same group (collision
     * groups per source when `crossSourceCollisions` is off). */
    hitTest(b: [number, number, number, number], mode: Overlap, group: number): boolean {
        const [x1, y1, x2, y2] = b;
        if (x2 < 0 || x1 > this.width || y2 < 0 || y1 > this.height) return false;
        if (x1 <= 0 && y1 <= 0 && this.width <= x2 && this.height <= y2) return true;
        const eps = 1e-6;
        const seenBox = new Uint8Array(this.boxes.length);
        const seenCircle = new Uint8Array(this.circles.length);
        const [cx1, cy1, cx2, cy2] = this.cells(x1, y1, x2, y2);
        for (let cx = cx1; cx <= cx2; cx++) {
            for (let cy = cy1; cy <= cy2; cy++) {
                const c = this.xCells * cy + cx;
                for (const uid of this.boxCells[c]) {
                    if (seenBox[uid]) continue;
                    seenBox[uid] = 1;
                    const {b: o, mode: key, group: g} = this.boxes[uid];
                    if (
                        x1 <= o[2] + eps &&
                        y1 <= o[3] + eps &&
                        x2 >= o[0] - eps &&
                        y2 >= o[1] - eps &&
                        (group === 0 || g === group) &&
                        !overlapAllowed(mode, key)
                    ) {
                        return true;
                    }
                }
                for (const uid of this.circleCells[c]) {
                    if (seenCircle[uid]) continue;
                    seenCircle[uid] = 1;
                    const {c: k, mode: key, group: g} = this.circles[uid];
                    if (circleAndRect(k[0], k[1], k[2], x1, y1, x2, y2) && (group === 0 || g === group) && !overlapAllowed(mode, key)) return true;
                }
            }
        }
        return false;
    }

    hitTestCircle(x: number, y: number, r: number, mode: Overlap, group: number): boolean {
        const x1 = x - r;
        const y1 = y - r;
        const x2 = x + r;
        const y2 = y + r;
        if (x2 < 0 || x1 > this.width || y2 < 0 || y1 > this.height) return false;
        const seenBox = new Uint8Array(this.boxes.length);
        const seenCircle = new Uint8Array(this.circles.length);
        const [cx1, cy1, cx2, cy2] = this.cells(x1, y1, x2, y2);
        for (let cx = cx1; cx <= cx2; cx++) {
            for (let cy = cy1; cy <= cy2; cy++) {
                const c = this.xCells * cy + cx;
                for (const uid of this.boxCells[c]) {
                    if (seenBox[uid]) continue;
                    seenBox[uid] = 1;
                    const {b: o, mode: key, group: g} = this.boxes[uid];
                    if (circleAndRect(x, y, r, o[0], o[1], o[2], o[3]) && (group === 0 || g === group) && !overlapAllowed(mode, key)) return true;
                }
                for (const uid of this.circleCells[c]) {
                    if (seenCircle[uid]) continue;
                    seenCircle[uid] = 1;
                    const {c: k, mode: key, group: g} = this.circles[uid];
                    const dx = x - k[0];
                    const dy = y - k[1];
                    const rr = r + k[2];
                    if (rr * rr > dx * dx + dy * dy && (group === 0 || g === group) && !overlapAllowed(mode, key)) return true;
                }
            }
        }
        return false;
    }
}

function circleAndRect(cx: number, cy: number, r: number, x1: number, y1: number, x2: number, y2: number): boolean {
    const hw = (x2 - x1) / 2.0;
    const dx = Math.abs(cx - (x1 + hw));
    if (dx > hw + r) return false;
    const hh = (y2 - y1) / 2.0;
    const dy = Math.abs(cy - (y1 + hh));
    if (dy > hh + r) return false;
    if (dx <= hw || dy <= hh) return true;
    const ex = dx - hw;
    const ey = dy - hh;
    return ex * ex + ey * ey <= r * r;
}

export class CollisionIndex {
    grid: GridIndex;
    ignored: GridIndex;
    screenRight: number;
    screenBottom: number;
    private gridRight: number;
    private gridBottom: number;

    constructor(width: number, height: number) {
        const w = width + 2.0 * VIEWPORT_PADDING;
        const h = height + 2.0 * VIEWPORT_PADDING;
        this.grid = new GridIndex(w, h, 25.0);
        this.ignored = new GridIndex(w, h, 25.0);
        this.screenRight = width + VIEWPORT_PADDING;
        this.screenBottom = height + VIEWPORT_PADDING;
        this.gridRight = w;
        this.gridBottom = h;
    }

    insideGrid(b: [number, number, number, number]): boolean {
        return b[2] >= 0 && b[0] < this.gridRight && b[3] >= 0 && b[1] < this.gridBottom;
    }

    offscreen(b: [number, number, number, number]): boolean {
        return b[2] < VIEWPORT_PADDING || b[0] >= this.screenRight || b[3] < VIEWPORT_PADDING || b[1] > this.screenBottom;
    }

    insert(b: [number, number, number, number], mode: Overlap, group: number, ignore: boolean): void {
        (ignore ? this.ignored : this.grid).insert(mode, group, b);
    }

    /** `placeCollisionBox` at pitch 0. Returns (box, placeable). */
    placeBox(b: CollisionBox, mode: Overlap, p: BoxParams, shift: P | undefined): [[number, number, number, number], boolean] {
        const x = b.anchor[0] + p.translation[0];
        const y = b.anchor[1] + p.translation[1];
        const pt = p.proj.project([x, y]);
        const m = p.textPixelRatio;
        let bx: [number, number, number, number];
        if (!p.rotateWithMap) {
            const sx = shift ? shift[0] * m : 0;
            const sy = shift ? shift[1] * m : 0;
            bx = [pt[0] + sx + b.x1 * m, pt[1] + sy + b.y1 * m, pt[0] + sx + b.x2 * m, pt[1] + sy + b.y2 * m];
        } else {
            // `_projectCollisionBox` with the screen direction of the tile's x axis.
            const east = p.proj.project([x + 1.0, y]);
            const tx = east[0] - pt[0];
            const ty = east[1] - pt[1];
            const angle = Math.atan(ty / tx) + (tx < 0 ? Math.PI : 0);
            const sin = Math.sin(angle);
            const cos = Math.cos(angle);
            const ex = cos;
            const ey = sin;
            const sx = -sin;
            const sy = cos;
            let px = pt[0];
            let py = pt[1];
            if (shift) {
                px += ex * shift[0] * m + sx * shift[1] * m;
                py += ey * shift[0] * m + sy * shift[1] * m;
            }
            const x1 = b.x1 * m;
            const x2 = b.x2 * m;
            const y1 = b.y1 * m;
            const y2 = b.y2 * m;
            const xh = (x1 + x2) / 2.0;
            const yh = (y1 + y2) / 2.0;
            const offsets: P[] = [
                [x1, y1],
                [xh, y1],
                [x2, y1],
                [x2, yh],
                [x2, y2],
                [xh, y2],
                [x1, y2],
                [x1, yh],
            ];
            const pts = offsets.map((o) => [px + ex * o[0] + sx * o[1], py + ey * o[0] + sy * o[1]]);
            bx = [
                Math.min(...pts.map((q) => q[0])),
                Math.min(...pts.map((q) => q[1])),
                Math.max(...pts.map((q) => q[0])),
                Math.max(...pts.map((q) => q[1])),
            ];
        }
        if (!this.insideGrid(bx) || (mode !== 'Always' && this.grid.hitTest(bx, mode, p.group))) return [bx, false];
        return [bx, true];
    }
}

/** Where a variable-anchor label was placed (`VariableOffset`). */
export interface VariableOffset {
    textOffset: P;
    width: number;
    height: number;
    anchor: string;
    textBoxScale: number;
}

/** Placement result of one symbol instance. */
export interface InstancePlacement {
    text: boolean;
    icon: boolean;
    variable: VariableOffset | undefined;
    /** Writing mode the text was placed in. */
    orientation: WritingMode | undefined;
}

const defaultPlacement = (): InstancePlacement => ({text: false, icon: false, variable: undefined, orientation: undefined});

/** Per-tile projection for collision boxes (CSS px, shifted by the viewport padding). */
export class TileProjection {
    private origin: P;
    private scale: number;
    private transform: Transform;

    constructor(ctx: Ctx, tile: RenderTile) {
        this.origin = ctx.tileOrigin(tile);
        this.scale = ctx.tilePx(tile) / EXTENT;
        this.transform = ctx.transform;
    }

    /** Whether a tile point is on the map (see `Transform.inDomain`). */
    inDomain(p: P): boolean {
        return this.transform.inDomain([this.origin[0] + p[0] * this.scale, this.origin[1] + p[1] * this.scale]);
    }

    /** Tile units → CSS px of the collision grid. */
    project(p: P): P {
        const s = this.transform.worldToScreen([this.origin[0] + p[0] * this.scale, this.origin[1] + p[1] * this.scale]);
        const r = this.transform.pixelRatio;
        return [s[0] / r + VIEWPORT_PADDING, s[1] / r + VIEWPORT_PADDING];
    }
}

/** `calculateVariableLayoutShift`. */
export function variableLayoutShift(anchor: string, width: number, height: number, textOffset: P, textBoxScale: number): P {
    const [h, v] = shaping.anchorAlignment(anchor);
    return [-(h - 0.5) * width + textOffset[0] * textBoxScale, -(v - 0.5) * height + textOffset[1] * textBoxScale];
}

interface BoxParams {
    proj: TileProjection;
    textPixelRatio: number;
    rotateWithMap: boolean;
    translation: P;
    group: number;
}

/** One symbol layer's buckets, as handed to placement. */
export interface LayerBuckets {
    layer: Layer;
    raw: any;
    buckets: SymbolBucket[];
    /** Collision group (0 = collides across sources). */
    group: number;
}

/** Place all symbol layers (top-most first). Returns, per layer and bucket, the placement of
 * each instance. */
export function place(ctx: Ctx, layers: LayerBuckets[]): InstancePlacement[][][] {
    const t = ctx.transform;
    const index = new CollisionIndex(t.width, t.height);
    const out: InstancePlacement[][][] = layers.map((l) => l.buckets.map((b) => b.instances.map(defaultPlacement)));
    for (let li = layers.length - 1; li >= 0; li--) {
        const lb = layers[li];
        const first = lb.buckets[0];
        if (!first) continue;
        const res = new Resolved(lb.layer, ctx, first.tile);
        // Tiles in placement order: higher zoom first, then wrap, z, x, y.
        const order = lb.buckets.map((_, i) => i);
        order.sort((a, b) => {
            const ta = lb.buckets[a].tile;
            const tb = lb.buckets[b].tile;
            return (
                tb.overscaledZ - ta.overscaledZ ||
                ta.wrap - tb.wrap ||
                ta.overscaledZ - tb.overscaledZ ||
                ta.canonical.x - tb.canonical.x ||
                ta.canonical.y - tb.canonical.y
            );
        });
        // Bucket parts: whole buckets, or sort-key ranges sorted across tiles.
        const parts: [number, number, number, number][] = [];
        for (const bi of order) {
            const b = lb.buckets[bi];
            if (res.sortByKey) {
                for (const r of b.sortKeyRanges) parts.push([r[0], bi, r[1], r[2]]);
            } else {
                parts.push([0, bi, 0, b.instances.length]);
            }
        }
        if (res.sortByKey) parts.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
        for (const [, bi, start, end] of parts) {
            placeBucketPart(ctx, lb, res, lb.buckets[bi], start, end, index, out[li][bi]);
        }
    }
    return out;
}

function placeBucketPart(
    ctx: Ctx,
    lb: LayerBuckets,
    res: Resolved,
    bucket: SymbolBucket,
    start: number,
    end: number,
    index: CollisionIndex,
    out: InstancePlacement[],
): void {
    const layer = lb.layer;
    const tile = bucket.tile;
    const lay = (n: string) => ctx.layout(layer, n, undefined, tile);
    const textOptional = !!lay('text-optional');
    const iconOptional = !!lay('icon-optional');
    const textMode = overlapFrom(overlapMode(layer, ctx, tile, lb.raw, 'text'));
    const iconMode = overlapFrom(overlapMode(layer, ctx, tile, lb.raw, 'icon'));
    const hasTextData = bucket.text.length > 0;
    const hasIconData = bucket.icon.length > 0;
    const alwaysShowText = textMode === 'Always' && (iconMode === 'Always' || !hasIconData || iconOptional);
    const alwaysShowIcon = iconMode === 'Always' && (textMode === 'Always' || !hasTextData || textOptional);
    const rotateWithMap = res.textRotationAlignment === 'map';
    const fitValue = lay('icon-text-fit');
    const hasIconTextFit = typeof fitValue === 'string' && fitValue !== 'none';
    const textIgnore = !!lay('text-ignore-placement');
    const iconIgnore = !!lay('icon-ignore-placement');
    const overscale = 2 ** (tile.overscaledZ - tile.canonical.z);
    const proj = new TileProjection(ctx, tile);
    const toTile = EXTENT / ctx.tilePx(tile);
    const trText = ctx.translate(layer, 'text', tile);
    const trIcon = ctx.translate(layer, 'icon', tile);
    const group = lb.group;
    const params = (translation: P): BoxParams => ({
        proj,
        textPixelRatio: (512.0 * overscale) / EXTENT,
        rotateWithMap,
        translation: [translation[0] * toTile, translation[1] * toTile],
        group,
    });
    const textParams = params(trText);
    const iconParams = params(trIcon);
    const textPadding = num(lay('text-padding'));

    const placeSymbol = (i: number, o: InstancePlacement) => {
        const inst = bucket.instances[i];
        // A world copy past a projection's antimeridian (also drawn on the map's other side).
        if (!proj.inDomain(inst.anchor)) return;
        let placedText: [[number, number, number, number], boolean] | undefined = undefined;
        let placedVertical = false;
        let shift: P | undefined = undefined;
        if (inst.textBox) {
            const textBox = inst.textBox;
            // Variable anchors: try each anchor, first without overlap, then with the layer's
            // overlap mode.
            const placeVariable = (tb: CollisionBox, iconBoxIn: CollisionBox | undefined): [[number, number, number, number], boolean] | undefined => {
                const width = tb.x2 - tb.x1;
                const height = tb.y2 - tb.y1;
                const iconBox = hasIconTextFit && iconMode === 'Never' ? iconBoxIn : undefined;
                const passes = textMode === 'Never' ? 1 : 2;
                let mode: Overlap = 'Never';
                let last: [[number, number, number, number], boolean] | undefined = undefined;
                for (let pass = 0; pass < passes; pass++) {
                    for (const [anchor, offset] of inst.anchorOffsets) {
                        const s = variableLayoutShift(anchor, width, height, offset, inst.textBoxScale);
                        const r = index.placeBox(tb, mode, textParams, s);
                        if (iconBox && !index.placeBox(iconBox, mode, iconParams, s)[1]) continue;
                        if (r[1]) {
                            o.variable = {textOffset: offset, width, height, anchor, textBoxScale: inst.textBoxScale};
                            shift = s;
                            return r;
                        }
                        last = [r[0], false];
                    }
                    mode = textMode;
                }
                return last;
            };
            const verticalBox = bucket.allowVerticalPlacement && inst.numVerticalGlyphVertices > 0 ? inst.verticalTextBox : undefined;
            const modes: WritingMode[] = verticalBox ? bucket.writingModes : ['Horizontal'];
            for (const m of modes) {
                let r: [[number, number, number, number], boolean] | undefined;
                if (m === 'Vertical' && verticalBox) {
                    if (inst.anchorOffsets.length === 0) r = index.placeBox(verticalBox, textMode, textParams, undefined);
                    else if (!(placedText !== undefined && placedText[1])) r = placeVariable(verticalBox, inst.verticalIconBox);
                    else r = undefined;
                    placedVertical = r !== undefined && r[1];
                } else if (inst.anchorOffsets.length === 0) {
                    r = index.placeBox(textBox, textMode, textParams, undefined);
                } else {
                    r = placeVariable(textBox, inst.iconBox);
                }
                placedText = r;
                if (r !== undefined && r[1]) {
                    o.orientation = m;
                    break;
                }
            }
        }
        let placeText = placedText !== undefined && placedText[1];
        let circles: [[number, number, number][], boolean] | undefined = undefined;
        const sym = inst.text[1];
        if (inst.collisionCircleDiameter !== undefined && sym !== undefined) {
            const c = placeCircles(ctx, bucket, bucket.text[sym], index, textMode, group, inst.collisionCircleDiameter, textPadding, textParams.translation);
            placeText = textMode === 'Always' || (c[0].length > 0 && !c[1]);
            circles = c;
        }
        let placedIcon: [[number, number, number, number], boolean] | undefined = undefined;
        if (inst.iconBox) {
            const b = placedVertical ? (inst.verticalIconBox ?? inst.iconBox) : inst.iconBox;
            placedIcon = index.placeBox(b, iconMode, iconParams, hasIconTextFit ? shift : undefined);
        }
        let placeIcon = placedIcon !== undefined && placedIcon[1];
        const iconWithoutText = textOptional || (inst.numGlyphVertices === 0 && inst.numVerticalGlyphVertices === 0);
        const textWithoutIcon = iconOptional || inst.numIconVertices === 0;
        if (!iconWithoutText && !textWithoutIcon) {
            placeText = placeText && placeIcon;
            placeIcon = placeText;
        } else if (!textWithoutIcon) {
            placeText = placeIcon && placeText;
        } else if (!iconWithoutText) {
            placeIcon = placeIcon && placeText;
        }
        if (placeText && placedText !== undefined && placedText[1]) index.insert(placedText[0], textMode, group, textIgnore);
        if (placeIcon && placedIcon !== undefined && placedIcon[1]) index.insert(placedIcon[0], iconMode, group, iconIgnore);
        if (circles !== undefined && placeText) {
            const grid = textIgnore ? index.ignored : index.grid;
            for (const c of circles[0]) grid.insertCircle(textMode, group, c[0], c[1], c[2]);
        }
        o.text = placeText || alwaysShowText;
        o.icon = placeIcon || alwaysShowIcon;
    };

    if (res.zOrder === 'viewport-y') {
        const idx = sortedSymbolIndexes(bucket, ctx.transform.bearingRad);
        for (let k = idx.length - 1; k >= 0; k--) placeSymbol(idx[k], out[idx[k]]);
    } else {
        for (let i = start; i < Math.min(end, out.length); i++) placeSymbol(i, out[i]);
    }
}

/** `getSortedSymbolIndexes`: by rotated anchor y, then feature index (descending). */
export function sortedSymbolIndexes(bucket: SymbolBucket, angle: number): number[] {
    const sin = Math.sin(angle);
    const cos = Math.cos(angle);
    // `js_round(..) as i64`: NaN → 0.
    const ys = bucket.instances.map((s) => Math.round(sin * s.anchor[0] + cos * s.anchor[1]) || 0);
    const idx = bucket.instances.map((_, i) => i);
    idx.sort((a, b) => (ys[a] < ys[b] ? -1 : ys[a] > ys[b] ? 1 : bucket.instances[b].featureIndex - bucket.instances[a].featureIndex));
    return idx;
}

/** `placeCollisionCircles` at pitch 0: circles along the label's path on screen. Returns the
 * circles (x, y, r in grid px) and whether one collided. */
function placeCircles(
    ctx: Ctx,
    bucket: SymbolBucket,
    symbol: PlacedSymbol,
    index: CollisionIndex,
    mode: Overlap,
    group: number,
    diameter: number,
    padding: number,
    translation: P,
): [[number, number, number][], boolean] {
    const fontSize = bucket.textSize.forFeature(ctx.transform.zoom, symbol.size);
    const path = labelPath(ctx, bucket, symbol, fontSize, translation);
    if (path === undefined) return [[], false];
    const radius = diameter * 0.5 + padding;
    const min: P = [-VIEWPORT_PADDING, -VIEWPORT_PADDING];
    const max: P = [index.screenRight, index.screenBottom];
    const lo: P = [Infinity, Infinity];
    const hi: P = [-Infinity, -Infinity];
    for (const p of path) {
        lo[0] = Math.min(lo[0], p[0]);
        lo[1] = Math.min(lo[1], p[1]);
        hi[0] = Math.max(hi[0], p[0]);
        hi[1] = Math.max(hi[1], p[1]);
    }
    let segments: P[][];
    if (lo[0] >= min[0] && hi[0] <= max[0] && lo[1] >= min[1] && hi[1] <= max[1]) segments = [path];
    else if (hi[0] < min[0] || lo[0] > max[0] || hi[1] < min[1] || lo[1] > max[1]) segments = [];
    else segments = anchors.clipLine([path], min[0], min[1], max[0], max[1]);
    const circles: [number, number, number][] = [];
    let inGrid = false;
    for (const seg of segments) {
        const interp = new anchors.PathInterpolator(seg, radius * 0.25);
        // `as usize`: truncating, negative/NaN → 0.
        const steps = interp.paddedLength / (radius * 2.5);
        const n = interp.length <= 0.5 * radius ? 1 : (Math.ceil(steps) > 0 ? Math.ceil(steps) : 0) + 1;
        for (let i = 0; i < n; i++) {
            const t = i / (Math.max(n, 2) - 1);
            const p = interp.lerp(t);
            const cx = p[0] + VIEWPORT_PADDING;
            const cy = p[1] + VIEWPORT_PADDING;
            circles.push([cx, cy, radius]);
            inGrid = inGrid || index.insideGrid([cx - radius, cy - radius, cx + radius, cy + radius]);
            if (mode !== 'Always' && index.grid.hitTestCircle(cx, cy, radius, mode, group)) return [[], true];
        }
    }
    return [inGrid ? circles : [], false];
}
