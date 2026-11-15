import proj4 from 'proj4';

/** What GL JS's `addProjection` takes: `forward([lng, lat])` is `[x, y]` in CRS units, `inverse` the reverse. */
export interface Converter {
  forward(position: number[]): number[];
  inverse(position: number[]): number[];
}

/**
 * proj4js's converter for a PROJJSON CRS, for GL JS on the main thread and in its workers. ml2drender draws with
 * its own formulas; the two agree to micrometres. Positions without an answer are NaN (proj4js throws for some).
 */
export function converter(projjson: any): Converter {
  const { forward, inverse } = proj4(geostationary(projjson) ?? projjson);
  const safe = (convert: (position: number[]) => number[]) => (position: number[]) => {
    try {
      return convert(position);
    } catch {
      return [NaN, NaN];
    }
  };
  return { forward: safe(forward), inverse: safe(inverse) };
}

/**
 * The PROJ string of PROJ's geostationary method, which proj4js does not read from PROJJSON.
 * ponytail: plain metres and degrees, no false origin; read units once a CRS needs them.
 */
function geostationary(projjson: any): string | undefined {
  const sweep = /^Geostationary Satellite \(Sweep ([XY])\)$/.exec(projjson.conversion?.method?.name ?? '')?.[1];
  if (!sweep) return undefined;
  const value = (name: string) => projjson.conversion.parameters?.find((p: any) => p.name === name)?.value ?? 0;
  const { semi_major_axis: a, semi_minor_axis: b, inverse_flattening: rf } = (projjson.base_crs.datum ?? projjson.base_crs.datum_ensemble).ellipsoid;
  return `+proj=geos +sweep=${sweep.toLowerCase()} +h=${value('Satellite Height')} +lon_0=${value('Longitude of natural origin')} +a=${a} ${rf ? `+rf=${rf}` : `+b=${b}`} +units=m`;
}
