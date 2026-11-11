// Style parsing: layers, compiled layout/paint properties and filters, on top of
// @maplibre/maplibre-gl-style-spec (expressions, legacy functions, filters are upstream's own).
import {
    Formatted,
    Interpolate,
    derefLayers,
    featureFilter,
    isExpression,
    latest,
    normalizePropertyExpression,
} from '@maplibre/maplibre-gl-style-spec';

export type Kind = 'constant' | 'source' | 'camera' | 'composite';
/** style-spec `InterpolationType`: `{name: 'linear' | 'exponential' | 'cubic-bezier', base?, controlPoints?}`. */
export type Interpolation = {name: string; base?: number; controlPoints?: number[]};
/** Runtime values are style-spec's: null, boolean, number, string, Color, Formatted, Padding, ... */
export type Value = any;
export type Properties = Record<string, unknown>;
export type CanonicalTileId = {z: number; x: number; y: number};
export type GeomTypeName = 'Unknown' | 'Point' | 'LineString' | 'Polygon';

/** The feature an expression sees (`ex::Feature` in the Rust port). */
export interface Feature {
    id?: unknown;
    geomType?: GeomTypeName;
    properties: Properties;
    /** Tile coordinates (EXTENT units); only set when the layer `needsGeometry`. */
    geometry?: [number, number][][];
}

/** Expression globals; `zoom` is NaN when absent. */
export interface Globals {
    zoom: number;
    heatmapDensity?: number;
    elevation?: number;
    lineProgress?: number;
}

export function interpolationFactor(interp: Interpolation | undefined, input: number, lower: number, upper: number): number {
    return interp ? Interpolate.interpolationFactor(interp as any, input, lower, upper) : 0;
}

const specFeatures = new WeakMap<Feature, object>();
// style-spec reads `type` (geometry type name), `id` only when present, and `geometry` as {x, y} points.
function specFeature(f: Feature): object {
    let s = specFeatures.get(f);
    if (!s) {
        const o: any = {type: f.geomType ?? 'Unknown', properties: f.properties};
        if (f.id !== undefined && f.id !== null) o.id = f.id;
        if (f.geometry) o.geometry = f.geometry.map((r) => r.map(([x, y]) => ({x, y})));
        specFeatures.set(f, (s = o));
    }
    return s;
}

/** A compiled layout/paint property (`PropValue`): constant, expression or legacy function. */
export class PropValue {
    readonly kind: Kind;
    /** Top-level zoom curve stops (camera / composite). */
    readonly zoomStops: number[];
    readonly interpolation: Interpolation | undefined;
    /** Top-level `step` (MapLibre's "step interpolant"). */
    readonly isStep: boolean;
    private readonly fn: (globals: any, feature: object | null, canonical: CanonicalTileId | null) => Value;

    private constructor(kind: Kind, fn: PropValue['fn'], zoomStops: number[] = [], interpolation?: Interpolation, isStep = false) {
        this.kind = kind;
        this.fn = fn;
        this.zoomStops = zoomStops;
        this.interpolation = interpolation;
        this.isStep = isStep;
    }

    static constant(v: Value): PropValue {
        return new PropValue('constant', () => v);
    }

    /** `normalizePropertyExpression`; `undefined` when the value does not compile. */
    static compile(value: unknown, spec: any, rootKey: string, globalState: Properties): PropValue | undefined {
        let n: any;
        try {
            n = normalizePropertyExpression(value as any, rootKey, spec, globalState);
        } catch {
            return undefined;
        }
        if (n.kind === 'constant' && !n._styleExpression) {
            let v = n.evaluate();
            if (spec.type === 'formatted' && typeof v === 'string') v = Formatted.fromString(v);
            if (v === undefined) v = null;
            return PropValue.constant(v);
        }
        if (n._styleExpression) {
            // StyleExpression.evaluate, without its console warnings.
            const se = n._styleExpression;
            const fallback = se._defaultValue;
            const enums = se._enumValues;
            const fn = (g: any, f: object | null, c: CanonicalTileId | null) => {
                try {
                    const v = se.evaluateWithoutErrorHandling(g, f, {}, c, null, null);
                    if (v === null || v === undefined || (typeof v === 'number' && v !== v)) return fallback;
                    if (enums && !(v in enums)) return fallback;
                    return v;
                } catch {
                    return fallback;
                }
            };
            const isStep = se.expression?.constructor?.name === 'Step';
            const stops = n.zoomStops ?? [];
            return new PropValue(n.kind, fn, stops, n.interpolationType, isStep);
        }
        // Legacy function (StylePropertyFunction).
        const fallback = n._defaultValue;
        const fn = (g: any, f: object | null) => {
            try {
                return n._innerEvaluate(g, f);
            } catch {
                return fallback;
            }
        };
        return new PropValue(n.kind, fn, n.zoomStops ?? [], n.interpolationType);
    }

    isConstant(): boolean {
        return this.kind === 'constant';
    }

    isFeatureConstant(): boolean {
        return this.kind === 'constant' || this.kind === 'camera';
    }

    /** Expression kind with the top-level zoom stops and interpolation. */
    curve(): {kind: Kind; stops: number[]; interpolation: Interpolation | undefined} {
        return {kind: this.kind, stops: this.zoomStops, interpolation: this.interpolation};
    }

    eval(zoom: number, feature?: Feature, canonical?: CanonicalTileId): Value {
        return this.fn({zoom}, feature ? specFeature(feature) : null, canonical ?? null);
    }

    /** Evaluate with given globals (e.g. `heatmapDensity`, `elevation`). */
    evalGlobals(globals: Globals): Value {
        return this.fn(globals, null, null);
    }

    /** A color ramp (`line-gradient`) at a line progress. */
    evalLineProgress(progress: number): Value {
        return this.fn({zoom: NaN, lineProgress: progress}, null, null);
    }
}

export type Filter = (zoom: number, feature: Feature, canonical?: CanonicalTileId) => boolean;

export interface Layer {
    id: string;
    type: string;
    source?: string;
    sourceLayer?: string;
    minzoom: number;
    maxzoom: number;
    filter?: Filter;
    layout: Map<string, PropValue>;
    paint: Map<string, PropValue>;
    /** Whether expressions need feature geometry (`within` / `distance`). */
    needsGeometry: boolean;
    /** Id of the first layer with the same source data, filter and layout (like `groupByLayout`,
     * ignoring zoom ranges); layers in one group build identical buckets. */
    layoutGroup: string;
    /** Raw layer JSON (after `ref` resolution). */
    json: any;
}

export function paint(layer: Layer, name: string): PropValue {
    return layer.paint.get(name)!;
}

export function layout(layer: Layer, name: string): PropValue {
    return layer.layout.get(name)!;
}

/** Hidden by `visibility` or zoom range at `zoom`. */
export function isHidden(layer: Layer, zoom: number): boolean {
    if (zoom < layer.minzoom || zoom >= layer.maxzoom) return true;
    return layer.layout.get('visibility')?.eval(zoom) === 'none';
}

function containsOp(v: unknown, ops: string[]): boolean {
    if (Array.isArray(v)) return (typeof v[0] === 'string' && ops.includes(v[0])) || v.some((x) => containsOp(x, ops));
    if (v && typeof v === 'object') return Object.values(v).some((x) => containsOp(x, ops));
    return false;
}

function compileFilter(filter: unknown, rootKey: string, globalState: Properties): Filter | undefined {
    if (filter === undefined || filter === null) return undefined;
    let f: any;
    try {
        f = featureFilter(filter as any, rootKey, globalState);
    } catch {
        return undefined;
    }
    return (zoom, feature, canonical) => !!f.filter({zoom, globalState} as any, specFeature(feature) as any, canonical as any);
}

export interface Style {
    json: any;
    layers: Layer[];
    globalState: Properties;
}

const GROUP = ['type', 'source', 'source-layer', 'filter', 'layout'];
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function parseStyle(json: any): Style {
    const globalState: Properties = {};
    for (const [k, v] of Object.entries<any>(json.state ?? {})) globalState[k] = v?.default ?? null;
    const layers: Layer[] = [];
    const spec = latest as any;
    for (const [i, l] of (derefLayers(json.layers ?? []) as any[]).entries()) {
        const type = l.type;
        if (typeof type !== 'string') continue;
        const props = {layout: new Map<string, PropValue>(), paint: new Map<string, PropValue>()};
        for (const kind of ['layout', 'paint'] as const) {
            const specs = spec[`${kind}_${type}`];
            if (!specs) continue;
            for (const [name, pspec] of Object.entries<any>(specs)) {
                const rootKey = `layers[${i}].${kind}.${name}`;
                const given = l[kind]?.[name];
                const value =
                    (given !== undefined ? PropValue.compile(given, pspec, rootKey, globalState) : undefined) ??
                    PropValue.compile(pspec.default, pspec, rootKey, globalState) ??
                    PropValue.constant(null);
                props[kind].set(name, value);
            }
        }
        const id = typeof l.id === 'string' ? l.id : '';
        const needsGeometry = containsOp(l, ['within', 'distance']);
        // Zoom ranges only decide visibility. Paint expressions see the bucket's features, so
        // `needsGeometry` must agree.
        const group = layers.find((g) => g.needsGeometry === needsGeometry && GROUP.every((k) => same(g.json[k], l[k])));
        layers.push({
            id,
            type,
            source: typeof l.source === 'string' ? l.source : undefined,
            sourceLayer: typeof l['source-layer'] === 'string' ? l['source-layer'] : undefined,
            minzoom: typeof l.minzoom === 'number' ? l.minzoom : -Infinity,
            maxzoom: typeof l.maxzoom === 'number' ? l.maxzoom : Infinity,
            filter: compileFilter(l.filter, `layers[${i}].filter`, globalState),
            layout: props.layout,
            paint: props.paint,
            needsGeometry,
            layoutGroup: group ? group.layoutGroup : id,
            json: l,
        });
    }
    return {json, layers, globalState};
}

export {isExpression};
