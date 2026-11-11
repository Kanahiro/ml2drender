// GeoJSON source tiling with `@maplibre/geojson-vt` itself (convert, simplify, clip, wrap, tile,
// transform, and its `ClusterTileIndex` for `cluster: true`) with MapLibre's options (extent 8192,
// buffer/tolerance scaled by 16), converted to the `mvt.ts` layer shape.

import {GEOJSONVT_CLIP_END, GEOJSONVT_CLIP_START, type GeoJSONVTFeature, GeoJSONVT} from '@maplibre/geojson-vt';
import {type StyleExpression, createExpression} from '@maplibre/maplibre-gl-style-spec';
import type {Feature, GeomType, Layer} from './mvt.ts';
import {asU8, clamp} from './util.ts';

export const EXTENT = 8192;
export const CLIP_START = GEOJSONVT_CLIP_START;
export const CLIP_END = GEOJSONVT_CLIP_END;

/** `clusterProperties`: per property, the map and reduce expressions. */
export type ClusterProperties = [string, StyleExpression, StyleExpression][];

export interface ClusterOptions {
    maxZoom: number;
    minPoints: number;
    /** In tile units of `extent`. */
    radius: number;
    extent: number;
    generateId: boolean;
    properties: ClusterProperties;
}

export interface Options {
    maxzoom: number;
    /** In tile units (extent 8192). */
    buffer: number;
    tolerance: number;
    generateId: boolean;
    promoteId?: string;
    lineMetrics: boolean;
    /** `cluster: true`: point clustering instead of tiling. */
    cluster?: ClusterOptions;
}

type Props = Record<string, unknown>;

const isObject = (v: unknown): v is Props => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Map / reduce expressions see only the properties, at zoom 0 (like MapLibre's `getSuperclusterOptions`). */
const evalCluster = (e: StyleExpression, properties: Props | null, accumulated: unknown): unknown =>
    e.evaluate({zoom: 0, accumulated} as any, {properties: properties ?? {}} as any);

export class GeoJsonIndex {
    options: Options;
    private vt: GeoJSONVT;

    constructor(data: unknown, options: Options) {
        this.options = options;
        const c = options.cluster;
        const props = c?.properties ?? [];
        const vtOptions = {
            maxZoom: options.maxzoom,
            extent: EXTENT,
            buffer: options.buffer,
            tolerance: options.tolerance,
            lineMetrics: options.lineMetrics,
            // `promoteId` wins over `generateId` (geojson-vt refuses both).
            promoteId: options.promoteId ?? null,
            generateId: options.promoteId === undefined && options.generateId,
            cluster: c !== undefined,
            clusterOptions: c && {
                maxZoom: c.maxZoom,
                minPoints: c.minPoints,
                radius: c.radius,
                extent: c.extent,
                generateId: c.generateId,
                map: (p: Props | null) => {
                    const out: Props = {};
                    for (const [k, m] of props) out[k] = evalCluster(m, p, null);
                    return out;
                },
                reduce: props.length
                    ? (acc: Props, p: Props) => {
                          for (const [k, , r] of props) acc[k] = evalCluster(r, p, acc[k]);
                      }
                    : null,
            },
        };
        try {
            this.vt = new GeoJSONVT(data as any, vtOptions);
        } catch {
            // ponytail: geojson-vt throws on an invalid geometry type / malformed input, where the Rust
            // port skipped just that feature; the whole source renders empty instead (upstream errors it).
            this.vt = new GeoJSONVT({type: 'FeatureCollection', features: []} as any, vtOptions);
        }
    }

    maxzoom(): number {
        return this.options.maxzoom;
    }

    /** The tile `z/x/y` as a single vector tile layer with extent 8192. */
    tile(z: number, x: number, y: number): Layer {
        const features: Feature[] = [];
        const t = this.vt.getTile(z, x, y);
        for (const f of (t?.features ?? []) as GeoJSONVTFeature[]) {
            const feature: Feature = {
                type: f.type as GeomType,
                properties: (f.tags as Props | null) ?? {},
                geometry: f.type === 1 ? f.geometry.map(p => [p]) : f.geometry,
            };
            if (f.id != null) feature.id = f.id;
            features.push(feature);
        }
        return {name: '', extent: EXTENT, features};
    }
}

/** `clusterProperties`: `{name: [reduce operator or expression, map expression]}`. */
export function clusterProperties(props: unknown): ClusterProperties {
    const out: ClusterProperties = [];
    if (!isObject(props)) return out;
    for (const [key, v] of Object.entries(props)) {
        if (!Array.isArray(v) || v.length < 2) continue;
        const [op, map] = v;
        const reduce = typeof op === 'string' ? [op, ['accumulated'], ['get', key]] : op;
        const m = createExpression(map, `clusterProperties.${key}`);
        const r = createExpression(reduce, `clusterProperties.${key}`);
        if (m.result === 'success' && r.result === 'success') out.push([key, m.value, r.value]);
    }
    return out;
}

/**
 * The source `filter`: features of a FeatureCollection are kept where it evaluates to true
 * (at zoom 0, against the GeoJSON properties and id).
 */
export function filterGeojson(data: any, filter: unknown): unknown {
    if (data?.type !== 'FeatureCollection' || !(typeof filter === 'boolean' || (Array.isArray(filter) && filter.length > 0))) {
        return undefined;
    }
    const e = createExpression(filter, 'filter', {type: 'boolean'} as any);
    if (e.result !== 'success') return undefined;
    const keep = (f: any) => {
        const feature: {id?: unknown; properties: Props} = {properties: isObject(f?.properties) ? f.properties : {}};
        if (f?.id != null) feature.id = f.id;
        return e.value.evaluate({zoom: 0} as any, feature as any) === true;
    };
    const features = Array.isArray(data.features) ? data.features.filter(keep) : [];
    return {type: 'FeatureCollection', features};
}

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

export function geojsonIndex(data: unknown, src: any): GeoJsonIndex {
    data = filterGeojson(data, src?.filter) ?? data;
    const scale = EXTENT / 512;
    const maxzoom = num(src.maxzoom) ?? 18;
    const generateId = src.generateId === true;
    let cluster: ClusterOptions | undefined;
    if (src.cluster === true) {
        // `clusterMaxZoom` (0 counts as unset), else one below the source maxzoom.
        const cmz = num(src.clusterMaxZoom);
        const minPoints = num(src.clusterMinPoints);
        const radius = num(src.clusterRadius);
        cluster = {
            maxZoom: asU8(clamp(cmz !== undefined && cmz !== 0 ? Math.round(cmz) : maxzoom - 1, 0, 30)),
            minPoints: Math.trunc(Math.max(minPoints !== undefined && minPoints !== 0 ? minPoints : 2, 2)),
            radius: (radius !== undefined && radius !== 0 ? radius : 50) * scale,
            extent: EXTENT,
            generateId,
            properties: clusterProperties(src.clusterProperties),
        };
    }
    return new GeoJsonIndex(data, {
        cluster,
        maxzoom: asU8(maxzoom),
        buffer: (num(src.buffer) ?? 128) * scale,
        tolerance: (num(src.tolerance) ?? 0.375) * scale,
        generateId,
        promoteId: typeof src.promoteId === 'string' ? src.promoteId : undefined,
        lineMetrics: src.lineMetrics === true,
    });
}
