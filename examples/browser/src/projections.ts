import { addProjection, type LngLat, removeProjection } from 'maplibre-gl';
import { loadProjection, type Projection } from '@ml2drender/wasm';
import type * as GeoJSON from 'geojson';

/** A CRS for the output pane: ml2drender renders its tile grid, which MapLibre shows through `addProjection`. */
export interface Crs {
  /** MapLibre projection name (with a colon). */
  name: string;
  /** PROJJSON. */
  definition: object;
  /** Top-left of tile 0/0/0 and its width, in CRS units. */
  origin: [number, number];
  extent: number;
  /** ml2drender's own projection, so that MapLibre places the tiles exactly where they were rendered. */
  converter: Projection;
}

type Area = [west: number, south: number, east: number, north: number];
const WORLD: Area = [-180, -90, 180, 90];

/** Registers `definition` with MapLibre, on a square tile grid around its projected area of use. */
async function register(name: string, label: string, definition: object, [west, south, east, north]: Area): Promise<Crs> {
  const converter = await loadProjection(definition);
  if (east < west) east += 360;
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  const n = 64;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      const p = [west + (east - west) * i / n, south + (north - south) * j / n];
      const xy = converter.forward(p);
      const back = converter.inverse(xy);
      // Keep the points the projection takes back to themselves (NaN where it has none).
      const dl = Math.abs(((back[0] - p[0]) % 360 + 540) % 360 - 180);
      if (!(dl < 1e-6 && Math.abs(back[1] - p[1]) < 1e-6)) continue;
      [x0, y0, x1, y1] = [Math.min(x0, xy[0]), Math.min(y0, xy[1]), Math.max(x1, xy[0]), Math.max(y1, xy[1])];
    }
  }
  if (!(x1 > x0 && y1 > y0)) throw new Error(`${label}: no projectable extent`);
  const extent = Math.max(x1 - x0, y1 - y0);
  const origin: [number, number] = [(x0 + x1 - extent) / 2, (y0 + y1 + extent) / 2];
  addProjection({ name, projection: converter, tileMatrixSet: { origin, extentAtZoom0: extent }, definition: JSON.stringify(definition) });
  return { name, definition, origin, extent, converter };
}

let registered = 0;
let previous: string | undefined;

/** Registers a PROJJSON text, replacing the previous one, on a grid around its `bbox` (or the world). */
export async function registerProjJson(text: string): Promise<Crs> {
  const json = JSON.parse(text);
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('PROJJSON must be an object');
  const b = json.bbox;
  const area: Area = b ? [b.west_longitude, b.south_latitude, b.east_longitude, b.north_latitude] : WORLD;
  const crs = await register(`ml2drender:${++registered}`, json.name ?? 'PROJJSON', json, area);
  if (previous) removeProjection(previous);
  previous = crs.name;
  return crs;
}

/** Zoom to add to a Mercator zoom for the same ground resolution in `c` at `center`. */
export function zoomOffset(c: Crs, center: LngLat): number {
  const d = 1e-4;
  const area = (f: (p: number[]) => number[]) => {
    const [a, b, e] = [f([center.lng, center.lat]), f([center.lng + d, center.lat]), f([center.lng, center.lat + d])];
    return Math.abs((b[0] - a[0]) * (e[1] - a[1]) - (b[1] - a[1]) * (e[0] - a[0]));
  };
  // Mercator with a world of 1, like the CRS's tile 0/0/0 scaled by `extent`.
  const mercator = ([lng, lat]: number[]) => [lng / 360, Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) / (2 * Math.PI)];
  return Math.log2(Math.sqrt(area(mercator) / (area(c.converter.forward) / c.extent ** 2)));
}

type Position = number[];

/**
 * `data` cut to the outline of the map `c` draws, for GL JS, which projects GeoJSON vertex by vertex and joins
 * them with straight lines: a vertex the projection cannot place (the far side of a geostationary view) breaks
 * the whole ring, and an edge across the projection's seam (its antimeridian) spans the whole map. Lines end
 * where they leave the map; rings follow its outline from where they leave to where they come back, the way
 * that keeps the ring's inside on the same side.
 */
export function clipToCrs(data: GeoJSON.GeoJSON | string, c: Crs): GeoJSON.GeoJSON | string {
  const forward = (p: Position) => c.converter.forward(p);
  const placed = (p: Position) => forward(p).every(Number.isFinite);
  const wrap = (d: number) => ((d % 360) + 540) % 360 - 180;
  const lerp = (a: Position, b: Position, t: number) => [a[0] + wrap(b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const distance = (a: Position, b: Position) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const tolerance = 1e-6 * c.extent;
  // The last placeable position on the way from the placeable `a` to `b`.
  const edge = (a: Position, b: Position) => {
    let [inside, outside] = [0, 1];
    for (let i = 0; i < 30; i++) {
      const t = (inside + outside) / 2;
      if (placed(lerp(a, b, t))) inside = t; else outside = t;
    }
    return lerp(a, b, inside);
  };
  // Where the map loses the edge from `a` to `b`: the positions on either side of the gap, or none when the
  // projected edge is continuous, found by halving toward the half that moves the most.
  type Gap = { exit?: Position; entry?: Position };
  const gap = (a: Position, b: Position): Gap | undefined => {
    if (!placed(a)) return placed(b) ? { entry: edge(b, a) } : {};
    if (!placed(b)) return { exit: edge(a, b) };
    let [lo, hi, fLo, fHi] = [0, 1, forward(a), forward(b)];
    for (let i = 0; i < 50 && distance(fLo, fHi) > tolerance; i++) {
      const t = (lo + hi) / 2;
      const p = lerp(a, b, t);
      const f = forward(p);
      if (!f.every(Number.isFinite)) return { exit: edge(a, p), entry: edge(b, p) };
      if (distance(fLo, f) >= distance(f, fHi)) [hi, fHi] = [t, f]; else [lo, fLo] = [t, f];
    }
    return distance(fLo, fHi) > tolerance ? { exit: lerp(a, b, lo), entry: lerp(a, b, hi) } : undefined;
  };
  // The pieces of a line (or a closed ring, from a placed vertex back to it) that the map draws unbroken.
  const pieces = (l: Position[], closed: boolean): { arcs: Position[][]; broken: boolean } => {
    const start = closed ? l.findIndex(placed) : 0;
    if (start < 0) return { arcs: [], broken: true };
    const path = closed ? [...l.slice(start), ...l.slice(0, start), l[start]] : l;
    const arcs: Position[][] = [];
    let arc = placed(path[0]) ? [path[0]] : [];
    let broken = false;
    for (let i = 1; i < path.length; i++) {
      const g = gap(path[i - 1], path[i]);
      if (!g) {
        arc.push(path[i]);
        continue;
      }
      broken = true;
      if (g.exit) {
        arcs.push([...arc, g.exit]);
        arc = [];
      }
      if (g.entry) arc = [g.entry, path[i]];
    }
    if (arc.length) arcs.push(arc);
    // A ring's first piece goes on from its last.
    if (closed && broken && arcs.length > 1 && placed(path[0])) arcs[0] = [...arcs.pop()!, ...arcs[0].slice(1)];
    return { arcs: arcs.filter((a) => a.length >= 2), broken };
  };
  // Along the outline of the map, by the angle around the grid's center, from `a` to `b`, both on it.
  const mid = [c.origin[0] + c.extent / 2, c.origin[1] - c.extent / 2];
  const answered = (xy: Position) => {
    const p = c.converter.inverse(xy);
    return p.every(Number.isFinite) && distance(forward(p), xy) <= tolerance ? p : undefined;
  };
  const angle = (p: Position) => {
    const xy = forward(p);
    return Math.atan2(xy[1] - mid[1], xy[0] - mid[0]);
  };
  const turn = (from: number, to: number, dir: number) => (((to - from) * dir) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  // ponytail: assumes an outline every ray from the grid's center crosses once (not the gap of a conic projection).
  const along = (a: Position, b: Position, dir: number): Position[] => {
    if (!answered(mid)) return [];
    const [a0, d] = [angle(a), turn(angle(a), angle(b), dir) * dir];
    const steps = Math.ceil(Math.abs(d) / (Math.PI / 36));
    const out: Position[] = [];
    for (let k = 1; k < steps; k++) {
      const [dx, dy] = [Math.cos(a0 + d * k / steps), Math.sin(a0 + d * k / steps)];
      let [inside, outside] = [0, c.extent];
      for (let i = 0; i < 30; i++) {
        const r = (inside + outside) / 2;
        if (answered([mid[0] + dx * r, mid[1] + dy * r])) inside = r; else outside = r;
      }
      const p = answered([mid[0] + dx * inside, mid[1] + dy * inside]);
      if (p) out.push(p);
    }
    return out;
  };
  // A ring as the rings the map draws: its pieces joined along the outline, keeping the inside on the side
  // it is on in lng/lat (counterclockwise rings turn counterclockwise around the outline).
  // ponytail: a ring with no placed vertex is dropped, even one around the whole map (an ocean).
  const rings = (r: Position[]): Position[][] => {
    const { arcs, broken } = pieces(r, true);
    if (!broken) return arcs.length ? [r] : [];
    let area = 0;
    for (let i = 0; i < r.length; i++) {
      const [p, q] = [r[i], r[(i + 1) % r.length]];
      area += p[0] * q[1] - q[0] * p[1];
    }
    const dir = Math.sign(area) || 1;
    const out: Position[][] = [];
    const used = new Set<number>();
    for (let first = 0; first < arcs.length; first++) {
      if (used.has(first)) continue;
      const ring: Position[] = [];
      for (let i = first; !used.has(i);) {
        used.add(i);
        ring.push(...arcs[i]);
        const end = angle(arcs[i].at(-1)!);
        const next = arcs.reduce((best, a, j) => turn(end, angle(a[0]), dir) < turn(end, angle(arcs[best][0]), dir) ? j : best, i);
        ring.push(...along(arcs[i].at(-1)!, arcs[next][0], dir));
        i = next;
      }
      ring.push(ring[0]);
      if (ring.length >= 4) out.push(ring);
    }
    return out;
  };
  const inside = (p: Position, ring: Position[]) => {
    const [x, y] = forward(p);
    let odd = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [a, b] = [forward(ring[i]), forward(ring[j])];
      if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) odd = !odd;
    }
    return odd;
  };
  // ponytail: holes the map breaks are dropped; the others go to the outer ring around them.
  const polygons = (p: Position[][]): Position[][][] => {
    const outers = rings(p[0]).map((r) => [r]);
    for (const hole of p.slice(1)) {
      if (pieces(hole, true).broken) continue;
      outers.find((o) => inside(hole[0], o[0]))?.push(hole);
    }
    return outers;
  };
  const line = (l: Position[]) => pieces(l, false).arcs;
  const geometry = (g: GeoJSON.Geometry | null): GeoJSON.Geometry | null => {
    switch (g?.type) {
      case 'Point': return placed(g.coordinates) ? g : null;
      case 'MultiPoint': return { ...g, coordinates: g.coordinates.filter(placed) };
      case 'LineString': return { type: 'MultiLineString', coordinates: line(g.coordinates) };
      case 'MultiLineString': return { ...g, coordinates: g.coordinates.flatMap(line) };
      case 'Polygon': return { type: 'MultiPolygon', coordinates: polygons(g.coordinates) };
      case 'MultiPolygon': return { ...g, coordinates: g.coordinates.flatMap(polygons) };
      case 'GeometryCollection': return { ...g, geometries: g.geometries.map(geometry).filter((x) => x !== null) };
      default: return g;
    }
  };
  const any = (d: GeoJSON.GeoJSON): GeoJSON.GeoJSON => {
    switch (d.type) {
      case 'FeatureCollection': return { ...d, features: d.features.map((f) => any(f) as GeoJSON.Feature).filter((f) => f.geometry) };
      case 'Feature': return { ...d, geometry: geometry(d.geometry)! };
      default: return geometry(d) ?? { type: 'GeometryCollection', geometries: [] };
    }
  };
  return typeof data === 'string' ? data : any(data);
}
