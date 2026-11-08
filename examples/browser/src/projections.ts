import { addProjection, type LngLat, removeProjection } from 'maplibre-gl';
import { loadProjection, type Projection } from 'ml2drender';

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
