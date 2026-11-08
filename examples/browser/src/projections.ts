import { addProjection, type LngLat, removeProjection } from 'maplibre-gl';
import { loadProjection, type Projection } from 'ml2drender';
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
 * `data` cut to where `c` places positions (forward is finite), for GL JS, which projects GeoJSON vertex by
 * vertex: a vertex it cannot place, like the far side of a geostationary view, breaks the whole ring. A cut
 * line ends where it leaves; a cut ring follows the edge of the placeable area (as seen from the grid's
 * center, the shorter way) from where it leaves to where it comes back.
 */
export function clipToCrs(data: GeoJSON.GeoJSON | string, c: Crs): GeoJSON.GeoJSON | string {
  const forward = (p: Position) => c.converter.forward(p);
  const placed = (p: Position) => forward(p).every(Number.isFinite);
  const wrap = (d: number) => ((d % 360) + 540) % 360 - 180;
  const lerp = (a: Position, b: Position, t: number) => [a[0] + wrap(b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  // The last placeable position on the way from the placeable `a` to `b`.
  const edge = (a: Position, b: Position) => {
    let [inside, outside] = [0, 1];
    for (let i = 0; i < 30; i++) {
      const t = (inside + outside) / 2;
      if (placed(lerp(a, b, t))) inside = t; else outside = t;
    }
    return lerp(a, b, inside);
  };
  // Positions along the edge of the placeable area from `a` to `b`, both on it, by the angle around the center.
  const mid = [c.origin[0] + c.extent / 2, c.origin[1] - c.extent / 2];
  const center = c.converter.inverse(mid);
  const answered = (xy: Position) => {
    const p = c.converter.inverse(xy);
    if (!p.every(Number.isFinite)) return undefined;
    const back = forward(p);
    return Math.hypot(back[0] - xy[0], back[1] - xy[1]) <= 1e-6 * c.extent ? p : undefined;
  };
  const along = (a: Position, b: Position): Position[] => {
    if (!center.every(Number.isFinite) || !answered(mid)) return [];
    const [xa, xb] = [forward(a), forward(b)];
    const angle = (xy: Position) => Math.atan2(xy[1] - mid[1], xy[0] - mid[0]);
    const a0 = angle(xa);
    const d = ((angle(xb) - a0) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
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
  // ponytail: rings with no placeable vertex are dropped, even one around the whole placeable area (an ocean).
  const ring = (r: Position[]): Position[] | undefined => {
    const open = r.length > 1 && r[0][0] === r.at(-1)![0] && r[0][1] === r.at(-1)![1] ? r.slice(0, -1) : r;
    const start = open.findIndex(placed);
    if (start < 0) return undefined;
    const out: Position[] = [];
    let left: Position | undefined;
    for (let i = 0; i <= open.length; i++) {
      const [p, q] = [open[(start + i - 1 + open.length) % open.length], open[(start + i) % open.length]];
      if (placed(q)) {
        if (left) {
          const back = edge(q, p);
          out.push(...along(left, back), back);
          left = undefined;
        }
        out.push(q);
      } else if (!left) {
        left = edge(p, q);
        out.push(left);
      }
    }
    return out.length >= 4 ? out : undefined;
  };
  const line = (l: Position[]): Position[][] => {
    const parts: Position[][] = [];
    let part: Position[] = [];
    l.forEach((q, i) => {
      if (placed(q)) {
        if (i > 0 && !placed(l[i - 1])) part.push(edge(q, l[i - 1]));
        part.push(q);
      } else if (part.length) {
        part.push(edge(l[i - 1], q));
        parts.push(part);
        part = [];
      }
    });
    if (part.length) parts.push(part);
    return parts.filter((p) => p.length >= 2);
  };
  const polygon = (rings: Position[][]) => {
    const outer = ring(rings[0]);
    return outer && [outer, ...rings.slice(1).map(ring).filter((r) => r !== undefined)];
  };
  const geometry = (g: GeoJSON.Geometry | null): GeoJSON.Geometry | null => {
    switch (g?.type) {
      case 'Point': return placed(g.coordinates) ? g : null;
      case 'MultiPoint': return { ...g, coordinates: g.coordinates.filter(placed) };
      case 'LineString': return { type: 'MultiLineString', coordinates: line(g.coordinates) };
      case 'MultiLineString': return { ...g, coordinates: g.coordinates.flatMap(line) };
      case 'Polygon': {
        const p = polygon(g.coordinates);
        return p ? { ...g, coordinates: p } : null;
      }
      case 'MultiPolygon': return { ...g, coordinates: g.coordinates.map(polygon).filter((p) => p !== undefined) };
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
