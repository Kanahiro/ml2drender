// Map projections for `reproject`, from PROJJSON (read through the PROJ string parameters it maps
// to): a few common methods on an ellipsoid, without datum shifts (geodetic coordinates are taken
// as WGS84). Coordinates are always (easting, northing) / (longitude, latitude), whatever the
// CRS's axis order.

const FRAC_PI_2 = Math.PI / 2;
const FRAC_PI_4 = Math.PI / 4;
/** Rust `to_radians` / `to_degrees` multiply by these. */
const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/**
 * `√(a² + b²)`: libm's `hypot` rounds correctly through a software `fma` on wasm32, which costs
 * more than the rest of a projection. The arguments here are far from overflowing.
 */
const hypot = (a: number, b: number): number => Math.sqrt(a * a + b * b);

/** Rust `f64::signum` (±1 for ±0, NaN for NaN). */
const signum = (x: number): number => (x !== x ? NaN : x > 0 || Object.is(x, 0) ? 1 : -1);
/** Rust `f64::copysign` (the sign of a NaN `sign` taken as positive). */
const copysign = (m: number, sign: number): number => (sign < 0 || Object.is(sign, -0) ? -Math.abs(m) : Math.abs(m));
/** Rust `f64::rem_euclid`. */
const remEuclid = (a: number, b: number): number => {
  const r = a % b;
  return r < 0 ? r + Math.abs(b) : r;
};
/** Rust `f64::powi` (compiler-rt's `__powidf2`: repeated squaring). */
const powi = (a: number, b: number): number => {
  const recip = b < 0;
  let r = 1;
  for (;;) {
    if (b & 1) r *= a;
    b = Math.trunc(b / 2);
    if (b === 0) break;
    a *= a;
  }
  return recip ? 1 / r : r;
};

const unsupported = (m: string): Error => new Error(`unsupported: ${m}`);

type Method = Tmerc | Merc | Lcc | Stere | Laea | EqEarth | Geos;

/** A CRS's projection from and to longitude/latitude, as `ProjectedView` in `reproject.ts` uses it. */
export class Projection {
  /** The projected method; `undefined` for longlat. */
  method: Method | undefined;
  constructor(method: Method | undefined) {
    this.method = method;
  }

  /** PROJJSON of a geographic or projected CRS. */
  static parse(projjson: string): Projection {
    let json: unknown;
    try {
      json = JSON.parse(projjson);
    } catch (e) {
      throw unsupported(`PROJJSON: ${(e as Error).message}`);
    }
    return Projection.fromProjString(projString(json));
  }

  /** The PROJ string `projString` makes of a PROJJSON CRS. */
  static fromProjString(def: string): Projection {
    const params: [string, string][] = def
      .split(/\s+/)
      .filter((t) => t !== '')
      .map((t) => t.replace(/^\++/, ''))
      .map((t) => {
        const i = t.indexOf('=');
        return i < 0 ? [t, ''] : [t.slice(0, i), t.slice(i + 1)];
      });
    const get = (k: string): string | undefined => params.find((p) => p[0] === k)?.[1];
    const num = (k: string): number | undefined => {
      const v = get(k);
      if (v === undefined) return undefined;
      const n = parseF64(v);
      if (n === undefined) throw unsupported(`+${k}=${v}`);
      return n;
    };
    let a: number;
    let f: number;
    const r = num('R');
    const sa = num('a');
    if (r !== undefined) {
      [a, f] = [r, 0];
    } else if (sa !== undefined) {
      a = sa;
      const [rf, ff, b] = [num('rf'), num('f'), num('b')];
      // WKT's inverse flattening 0 is a sphere.
      f = rf !== undefined ? (rf === 0 ? 0 : 1 / rf) : ff !== undefined ? ff : b !== undefined ? 1 - b / a : 0;
    } else {
      throw unsupported('no ellipsoid');
    }
    const el = new Ellipsoid(a, Math.sqrt(f * (2 - f)));
    const lat0 = num('lat_0') ?? 0;
    const lon0 = num('lon_0') ?? 0;
    const k0 = num('k_0') ?? 1;
    const p = new Origin(lon0, [num('x_0') ?? 0, num('y_0') ?? 0]);
    const proj = get('proj') ?? '';
    switch (proj) {
      case 'longlat':
        return new Projection(undefined);
      case 'tmerc':
        return new Projection(new Tmerc(el, lat0, k0, p));
      case 'merc':
        return new Projection(new Merc(el, num('lat_ts'), k0, p));
      // Web Mercator: spherical formulas with the ellipsoid's semi-major axis.
      case 'webmerc':
        return new Projection(new Merc(new Ellipsoid(a, 0), undefined, 1, p));
      case 'lcc': {
        const lat1 = num('lat_1') ?? lat0;
        return new Projection(new Lcc(el, lat0, lat1, num('lat_2') ?? lat1, k0, p));
      }
      case 'stere': {
        const latTs = num('lat_ts');
        // Variant B gives the pole by the sign of its standard parallel.
        const lat0 = num('lat_0') ?? (latTs !== undefined ? copysign(90, latTs) : 0);
        // Within rounding: degrees converted from radians may miss 90 by an ulp or two.
        if (Math.abs(Math.abs(lat0) - 90) > 1e-9) throw unsupported('oblique stereographic');
        return new Projection(new Stere(el, lat0, latTs, k0, p));
      }
      case 'laea':
        return new Projection(new Laea(el, lat0, p));
      case 'eqearth':
        return new Projection(new EqEarth(el, p));
      case 'geos': {
        if (lat0 !== 0) throw unsupported('geos with +lat_0 other than 0');
        const h = num('h');
        if (h === undefined) throw unsupported('geos without +h');
        const sweep = get('sweep') ?? 'y';
        if (sweep !== 'x' && sweep !== 'y') throw unsupported(`+sweep=${sweep}`);
        return new Projection(new Geos(el, h, sweep === 'x', p));
      }
      default:
        throw unsupported(`projection ${JSON.stringify(proj)}`);
    }
  }

  /** Degrees → CRS units. */
  forward(lng: number, lat: number): [number, number] {
    const lon0 = this.lon0();
    // Like PROJ's `adjlon`, only longitudes beyond lon_0 ± 180° fold: the antimeridian itself stays on
    // its own side (+180° on the east edge), so rings that end at ±180° do not jump across the map.
    const l =
      this.method === undefined || Math.abs(lng - lon0) <= 180 ? lng : lon0 + remEuclid(lng - lon0 + 540, 360) - 180;
    return this.forwardContinuous(l, lat);
  }

  /**
   * `forward` without folding the longitude into `lon_0` ± 180°: past the projection's
   * antimeridian its formulas continue beyond the edge of the map, so geometry crossing it
   * stays continuous.
   */
  forwardContinuous(lng: number, lat: number): [number, number] {
    // Rust `clamp` passes NaN through.
    const phi = (lat < -90 ? -90 : lat > 90 ? 90 : lat) * RAD;
    const m = this.method;
    if (m === undefined) return [lng, phi * DEG];
    return m.p.out(m.forward(m.p.lam(lng), phi));
  }

  /**
   * The center of the longitudes the projection maps (its antimeridian is 180° away), or
   * `undefined` for longlat, which maps any longitude.
   */
  centralMeridian(): number | undefined {
    return this.method === undefined ? undefined : this.lon0();
  }

  /** CRS units → degrees, `undefined` outside the projection's domain. */
  inverse(xy: [number, number]): [number, number] | undefined {
    const m = this.method;
    if (m === undefined) return Math.abs(xy[1]) <= 90 && Number.isFinite(xy[0]) ? xy : undefined;
    const [lam, phi] = m.inverse(m.p.local(xy));
    const r: [number, number] = [remEuclid(this.lon0() + lam * DEG + 540, 360) - 180, phi * DEG];
    return Number.isFinite(r[0]) && Number.isFinite(r[1]) ? r : undefined;
  }

  lon0(): number {
    return this.method === undefined ? 0 : this.method.p.lon0;
  }
}

/** Rust `str::parse::<f64>`: no empty or padded strings, `inf`/`infinity`/`nan` in any case. */
function parseF64(v: string): number | undefined {
  const s = v.toLowerCase().replace(/^[+-]/, '');
  if (s === 'inf' || s === 'infinity') return v[0] === '-' ? -Infinity : Infinity;
  if (s === 'nan') return NaN;
  return /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(v) ? Number(v) : undefined;
}

/**
 * Central meridian and false origin, shared by the projected methods: they work in radians
 * relative to `lon_0` and in units relative to `origin`.
 */
class Origin {
  lon0: number;
  origin: [number, number];
  constructor(lon0: number, origin: [number, number]) {
    this.lon0 = lon0;
    this.origin = origin;
  }
  /** Longitude difference from the central meridian, in radians. */
  lam(lng: number): number {
    return (lng - this.lon0) * RAD;
  }
  out(p: [number, number]): [number, number] {
    return [this.origin[0] + p[0], this.origin[1] + p[1]];
  }
  local(p: [number, number]): [number, number] {
    return [p[0] - this.origin[0], p[1] - this.origin[1]];
  }
}

class Ellipsoid {
  a: number;
  e: number;
  constructor(a: number, e: number) {
    this.a = a;
    this.e = e;
  }

  /** τ′, the tangent of the conformal latitude, from τ = tan φ (Karney 2011). */
  taup(tau: number): number {
    const s = Math.sinh(this.e * Math.atanh((this.e * tau) / hypot(tau, 1)));
    return tau * hypot(s, 1) - s * hypot(tau, 1);
  }

  /** τ from τ′ by Newton's method (Karney 2011, eq. 19–21). */
  tau(taup: number): number {
    const e2m = 1 - this.e * this.e;
    let tau = taup / e2m;
    for (let i = 0; i < 5; i++) {
      const tp = this.taup(tau);
      const d = (((taup - tp) / hypot(tp, 1)) * (1 + e2m * tau * tau)) / (e2m * hypot(tau, 1));
      tau += d;
      if (Math.abs(d) < 1e-14 * Math.max(Math.abs(tau), 1)) break;
    }
    return tau;
  }

  /** `tan(π/4 − χ/2)` for the conformal latitude χ of `phi` (Snyder's t). */
  t(phi: number): number {
    const s = this.e * Math.sin(phi);
    return Math.tan(FRAC_PI_4 - phi / 2) / Math.pow((1 - s) / (1 + s), this.e / 2);
  }

  /** The latitude whose Snyder's t is `t`. */
  phiFromT(t: number): number {
    return Math.atan(this.tau(Math.tan(FRAC_PI_2 - 2 * Math.atan(t))));
  }

  /** `cos φ / √(1 − e² sin² φ)` (Snyder's m). */
  m(phi: number): number {
    return Math.cos(phi) / Math.sqrt(1 - powi(this.e * Math.sin(phi), 2));
  }

  /** Snyder's q, for the authalic latitude. */
  q(phi: number): number {
    const s = Math.sin(phi);
    const e = this.e;
    const atanhE = e === 0 ? s : Math.atanh(e * s) / e;
    return (1 - e * e) * (s / (1 - powi(e * s, 2)) + atanhE);
  }

  /** The latitude whose q is `q` (Snyder eq. 3-16); NaN past the poles. */
  phiFromQ(q: number): number {
    const e = this.e;
    const qp = this.q(FRAC_PI_2);
    if (Math.abs(Math.abs(q) - qp) < 1e-12) return copysign(FRAC_PI_2, q);
    let phi = Math.asin(q / 2);
    if (e === 0 || !Number.isFinite(phi)) return Math.abs(q) > qp ? NaN : phi;
    for (let i = 0; i < 15; i++) {
      const s = Math.sin(phi);
      const c = Math.cos(phi);
      const w = 1 - powi(e * s, 2);
      const d = ((w * w) / (2 * c)) * (q / (1 - e * e) - s / w - Math.atanh(e * s) / e);
      phi += d;
      if (Math.abs(d) < 1e-14) break;
    }
    return phi;
  }
}

/** Ellipsoidal transverse Mercator: Krüger's series to n⁶ (Karney 2011, as PROJ's default tmerc). */
export class Tmerc {
  el: Ellipsoid;
  /** k₀ times the rectifying radius. */
  k0a: number;
  alpha: number[];
  beta: number[];
  /** ξ of the origin latitude. */
  xi0: number;
  p: Origin;

  constructor(el: Ellipsoid, lat0: number, k0: number, p: Origin) {
    const f = 1 - Math.sqrt(1 - el.e * el.e);
    const n = f / (2 - f);
    const [n2, n3, n4, n5, n6] = [n * n, powi(n, 3), powi(n, 4), powi(n, 5), powi(n, 6)];
    this.alpha = [
      n / 2 - (2 * n2) / 3 + (5 * n3) / 16 + (41 * n4) / 180 - (127 * n5) / 288 + (7891 * n6) / 37800,
      (13 * n2) / 48 - (3 * n3) / 5 + (557 * n4) / 1440 + (281 * n5) / 630 - (1983433 * n6) / 1935360,
      (61 * n3) / 240 - (103 * n4) / 140 + (15061 * n5) / 26880 + (167603 * n6) / 181440,
      (49561 * n4) / 161280 - (179 * n5) / 168 + (6601661 * n6) / 7257600,
      (34729 * n5) / 80640 - (3418889 * n6) / 1995840,
      (212378941 * n6) / 319334400,
    ];
    this.beta = [
      n / 2 - (2 * n2) / 3 + (37 * n3) / 96 - n4 / 360 - (81 * n5) / 512 + (96199 * n6) / 604800,
      n2 / 48 + n3 / 15 - (437 * n4) / 1440 + (46 * n5) / 105 - (1118711 * n6) / 3870720,
      (17 * n3) / 480 - (37 * n4) / 840 - (209 * n5) / 4480 + (5569 * n6) / 90720,
      (4397 * n4) / 161280 - (11 * n5) / 504 - (830251 * n6) / 7257600,
      (4583 * n5) / 161280 - (108847 * n6) / 3991680,
      (20648693 * n6) / 638668800,
    ];
    this.el = el;
    this.k0a = ((k0 * el.a) / (1 + n)) * (1 + n2 / 4 + n4 / 64 + n6 / 256);
    this.p = p;
    this.xi0 = 0;
    this.xi0 = this.xiEta(lat0 * RAD, 0)[0];
  }

  xiEta(phi: number, lam: number): [number, number] {
    const lo = -FRAC_PI_2 + 1e-11;
    const hi = FRAC_PI_2 - 1e-11;
    const taup = this.el.taup(Math.tan(phi < lo ? lo : phi > hi ? hi : phi));
    const xi1 = Math.atan2(taup, Math.cos(lam));
    const eta1 = Math.asinh(Math.sin(lam) / hypot(taup, Math.cos(lam)));
    const [dxi, deta] = sinSeries(this.alpha, xi1, eta1);
    return [xi1 + dxi, eta1 + deta];
  }

  forward(lam: number, phi: number): [number, number] {
    const [xi, eta] = this.xiEta(phi, lam);
    return [this.k0a * eta, this.k0a * (xi - this.xi0)];
  }

  inverse([x, y]: [number, number]): [number, number] {
    const xi = y / this.k0a + this.xi0;
    const eta = x / this.k0a;
    const [dxi, deta] = sinSeries(this.beta, xi, eta);
    const xi1 = xi - dxi;
    const eta1 = eta - deta;
    const taup = Math.sin(xi1) / hypot(Math.sinh(eta1), Math.cos(xi1));
    return [Math.atan2(Math.sinh(eta1), Math.cos(xi1)), Math.atan(this.el.tau(taup))];
  }
}

/**
 * Σⱼ c[j−1]·sin(2jζ) for ζ = ξ + iη, as (real, imaginary): Krüger's series summed with
 * Clenshaw's recurrence in complex arithmetic (as PROJ does), one sin/cos and one exp in all.
 */
function sinSeries(c: number[], xi: number, eta: number): [number, number] {
  const s = Math.sin(2 * xi);
  const co = Math.cos(2 * xi);
  const e = Math.exp(2 * eta);
  const sh = (e - 1 / e) / 2;
  const ch = (e + 1 / e) / 2;
  // sin 2ζ and 2·cos 2ζ.
  const sinZ = [s * ch, co * sh];
  const k = [2 * co * ch, -2 * s * sh];
  // b_j = c_j + k·b_{j+1} − b_{j+2}; the sum is b_1·sin 2ζ.
  let b1 = [0, 0];
  let b2 = [0, 0];
  for (let j = c.length - 1; j >= 0; j--) {
    const b0 = [c[j] + k[0] * b1[0] - k[1] * b1[1] - b2[0], k[0] * b1[1] + k[1] * b1[0] - b2[1]];
    b2 = b1;
    b1 = b0;
  }
  return [b1[0] * sinZ[0] - b1[1] * sinZ[1], b1[0] * sinZ[1] + b1[1] * sinZ[0]];
}

/** Mercator (variant A with `k_0`, B with `lat_ts`). */
export class Merc {
  el: Ellipsoid;
  ak: number;
  p: Origin;
  constructor(el: Ellipsoid, latTs: number | undefined, k0: number, p: Origin) {
    const k = latTs === undefined ? k0 : el.m(latTs * RAD);
    this.el = el;
    this.ak = el.a * k;
    this.p = p;
  }
  forward(lam: number, phi: number): [number, number] {
    return [this.ak * lam, this.ak * Math.asinh(this.el.taup(Math.tan(phi)))];
  }
  inverse([x, y]: [number, number]): [number, number] {
    return [x / this.ak, Math.atan(this.el.tau(Math.sinh(y / this.ak)))];
  }
}

/** Lambert conformal conic (1SP: `lat_1` = `lat_2` = `lat_0` with `k_0`; 2SP), Snyder ch. 15. */
export class Lcc {
  el: Ellipsoid;
  n: number;
  /** a·k₀·F. */
  af: number;
  rho0: number;
  p: Origin;
  constructor(el: Ellipsoid, lat0: number, lat1: number, lat2: number, k0: number, p: Origin) {
    const [phi0, phi1, phi2] = [lat0 * RAD, lat1 * RAD, lat2 * RAD];
    const m1 = el.m(phi1);
    const t1 = el.t(phi1);
    const n =
      Math.abs(phi1 - phi2) > 1e-10
        ? (Math.log(m1) - Math.log(el.m(phi2))) / (Math.log(t1) - Math.log(el.t(phi2)))
        : Math.sin(phi1);
    const af = (el.a * k0 * m1) / (n * Math.pow(t1, n));
    this.el = el;
    this.n = n;
    this.af = af;
    this.rho0 = af * Math.pow(el.t(phi0), n);
    this.p = p;
  }
  forward(lam: number, phi: number): [number, number] {
    const rho = this.af * Math.pow(this.el.t(phi), this.n);
    const theta = this.n * lam;
    return [rho * Math.sin(theta), this.rho0 - rho * Math.cos(theta)];
  }
  inverse([x, y]: [number, number]): [number, number] {
    const s = signum(this.n);
    const dy = this.rho0 - y;
    const rho = s * hypot(x, dy);
    const theta = Math.atan2(s * x, s * dy);
    // Points in the cone's gap (beyond lon_0 ± 180°) are off the map.
    if (Math.abs(theta / this.n) > Math.PI) return [NaN, NaN];
    return [theta / this.n, this.el.phiFromT(Math.pow(rho / this.af, 1 / this.n))];
  }
}

/** Polar stereographic (variant A with `k_0`, B with `lat_ts`), Snyder ch. 21. */
export class Stere {
  el: Ellipsoid;
  /** +1 for the north pole, −1 for the south. */
  s: number;
  /** ρ / t. */
  k: number;
  p: Origin;
  constructor(el: Ellipsoid, lat0: number, latTs: number | undefined, k0: number, p: Origin) {
    const s = signum(lat0);
    const e = el.e;
    const ts = latTs === undefined ? undefined : latTs * s * RAD;
    this.k =
      ts !== undefined && Math.abs(ts - FRAC_PI_2) > 1e-10
        ? (el.a * el.m(ts)) / el.t(ts)
        : (2 * el.a * k0) / Math.sqrt(Math.pow(1 + e, 1 + e) * Math.pow(1 - e, 1 - e));
    this.el = el;
    this.s = s;
    this.p = p;
  }
  forward(lam: number, phi: number): [number, number] {
    const rho = this.k * this.el.t(this.s * phi);
    return [rho * Math.sin(lam), -this.s * rho * Math.cos(lam)];
  }
  inverse([x, y]: [number, number]): [number, number] {
    const rho = hypot(x, y);
    return [Math.atan2(x, -this.s * y), this.s * this.el.phiFromT(rho / this.k)];
  }
}

/** Lambert azimuthal equal-area, Snyder ch. 24. */
export class Laea {
  el: Ellipsoid;
  qp: number;
  /** Authalic radius. */
  rq: number;
  /** +1 / −1 at the north / south pole; 0 otherwise (oblique and equatorial). */
  pole: number;
  /** sin and cos of the origin's authalic latitude, and Snyder's D. */
  sb1: number;
  cb1: number;
  d: number;
  p: Origin;
  constructor(el: Ellipsoid, lat0: number, p: Origin) {
    const qp = el.q(FRAC_PI_2);
    const rq = el.a * Math.sqrt(qp / 2);
    const phi0 = lat0 * RAD;
    const pole = Math.abs(Math.abs(lat0) - 90) < 1e-10 ? signum(lat0) : 0;
    const b1 = Math.asin(clampNaN(el.q(phi0) / qp, -1, 1));
    this.sb1 = Math.sin(b1);
    this.cb1 = Math.cos(b1);
    this.d = pole === 0 ? (el.a * el.m(phi0)) / (rq * this.cb1) : 1;
    this.el = el;
    this.qp = qp;
    this.rq = rq;
    this.pole = pole;
    this.p = p;
  }
  forward(lam: number, phi: number): [number, number] {
    const q = this.el.q(phi);
    if (this.pole !== 0) {
      const v = this.qp - this.pole * q;
      // Rust `max(0.0)` turns NaN into 0.
      const rho = this.el.a * Math.sqrt(v > 0 ? v : 0);
      return [rho * Math.sin(lam), -this.pole * rho * Math.cos(lam)];
    }
    const b = Math.asin(clampNaN(q / this.qp, -1, 1));
    const sb = Math.sin(b);
    const cb = Math.cos(b);
    const bb = this.rq * Math.sqrt(2 / (1 + this.sb1 * sb + this.cb1 * cb * Math.cos(lam)));
    return [bb * this.d * cb * Math.sin(lam), (bb / this.d) * (this.cb1 * sb - this.sb1 * cb * Math.cos(lam))];
  }
  inverse([x0, y0]: [number, number]): [number, number] {
    if (this.pole !== 0) {
      const r = hypot(x0, y0) / this.el.a;
      return [Math.atan2(x0, -this.pole * y0), this.el.phiFromQ(this.pole * (this.qp - r * r))];
    }
    const x = x0 / this.d;
    const y = y0 * this.d;
    const rho = hypot(x, y);
    if (rho === 0) return [0, this.el.phiFromQ(this.qp * this.sb1)];
    const c = 2 * Math.asin(rho / (2 * this.rq));
    const sc = Math.sin(c);
    const cc = Math.cos(c);
    const sb = cc * this.sb1 + (y * sc * this.cb1) / rho;
    return [Math.atan2(x * sc, rho * this.cb1 * cc - y * this.sb1 * sc), this.el.phiFromQ(this.qp * sb)];
  }
}

/** Rust `f64::clamp`: NaN passes through. */
const clampNaN = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

const EQ_A = [1.340264, -0.081106, 0.000893, 0.003796];
const EQ_M = 0.8660254037844386; // √3 / 2

/** Equal Earth (Šavrič et al. 2018), on the authalic sphere of the ellipsoid like PROJ. */
export class EqEarth {
  el: Ellipsoid;
  qp: number;
  rq: number;
  p: Origin;
  constructor(el: Ellipsoid, p: Origin) {
    const qp = el.q(FRAC_PI_2);
    this.el = el;
    this.qp = qp;
    this.rq = el.a * Math.sqrt(qp / 2);
    this.p = p;
  }
  /** y(θ)/θ and dy/dθ of the unit projection. */
  static poly(t: number): [number, number] {
    const [a1, a2, a3, a4] = EQ_A;
    const t2 = t * t;
    const t6 = powi(t, 6);
    return [a1 + a2 * t2 + t6 * (a3 + a4 * t2), a1 + 3 * a2 * t2 + t6 * (7 * a3 + 9 * a4 * t2)];
  }
  forward(lam: number, phi: number): [number, number] {
    const sb = clampNaN(this.el.q(phi) / this.qp, -1, 1);
    const t = Math.asin(EQ_M * sb);
    const [p, dp] = EqEarth.poly(t);
    return [(this.rq * lam * Math.cos(t)) / (EQ_M * dp), this.rq * t * p];
  }
  inverse([x0, y0]: [number, number]): [number, number] {
    const x = x0 / this.rq;
    const y = y0 / this.rq;
    let t = y;
    for (let i = 0; i < 12; i++) {
      const [p, dp] = EqEarth.poly(t);
      const d = (t * p - y) / dp;
      t -= d;
      if (Math.abs(d) < 1e-14) break;
    }
    const lam = (EQ_M * x * EqEarth.poly(t)[1]) / Math.cos(t);
    const sb = Math.sin(t) / EQ_M;
    // Past the outline: no answer.
    if (Math.abs(lam) > Math.PI + 1e-9 || Math.abs(sb) > 1) return [NaN, NaN];
    return [lam, this.el.phiFromQ(this.qp * sb)];
  }
}

/**
 * Geostationary satellite view (PROJ's geos): the scanning angles of a satellite at height `h`
 * above the equator, times `h`. NaN on the side of the Earth the satellite does not see.
 */
export class Geos {
  a: number;
  /** Satellite distance from the center, in units of `a`, and `h / a`. */
  radiusG: number;
  radiusG1: number;
  /** b / a. */
  radiusP: number;
  /** The scanning mirror turns about x first (GOES) instead of y (Himawari, Meteosat). */
  sweepX: boolean;
  p: Origin;
  constructor(el: Ellipsoid, h: number, sweepX: boolean, p: Origin) {
    const radiusG1 = h / el.a;
    this.a = el.a;
    this.radiusG = 1 + radiusG1;
    this.radiusG1 = radiusG1;
    this.radiusP = Math.sqrt(1 - el.e * el.e);
    this.sweepX = sweepX;
    this.p = p;
  }
  forward(lam: number, phi0: number): [number, number] {
    const rp2 = this.radiusP * this.radiusP;
    // Geocentric latitude, and the vector from the center to the surface (units of `a`).
    const phi = Math.atan(rp2 * Math.tan(phi0));
    const r = this.radiusP / hypot(this.radiusP * Math.cos(phi), Math.sin(phi));
    const vx = r * Math.cos(lam) * Math.cos(phi);
    const vy = r * Math.sin(lam) * Math.cos(phi);
    const vz = r * Math.sin(phi);
    if ((this.radiusG - vx) * vx - vy * vy - (vz * vz) / rp2 < 0) return [NaN, NaN];
    const tmp = this.radiusG - vx;
    const g = this.radiusG1 * this.a;
    return this.sweepX
      ? [g * Math.atan(vy / hypot(vz, tmp)), g * Math.atan(vz / tmp)]
      : [g * Math.atan(vy / tmp), g * Math.atan(vz / hypot(vy, tmp))];
  }
  inverse([x0, y0]: [number, number]): [number, number] {
    const x = x0 / this.a / this.radiusG1;
    const y = y0 / this.a / this.radiusG1;
    let vy: number;
    let vz: number;
    if (this.sweepX) {
      vz = Math.tan(y);
      vy = Math.tan(x) * hypot(vz, 1);
    } else {
      vy = Math.tan(x);
      vz = Math.tan(y) * hypot(vy, 1);
    }
    // The nearer intersection of the line of sight with the ellipsoid.
    const a = vy * vy + powi(vz / this.radiusP, 2) + 1;
    const b = -2 * this.radiusG;
    const det = b * b - 4 * a * (this.radiusG * this.radiusG - 1);
    if (det < 0) return [NaN, NaN];
    const k = (-b - Math.sqrt(det)) / (2 * a);
    const [vx, vy2, vz2] = [this.radiusG - k, vy * k, vz * k];
    const lam = Math.atan2(vy2, vx);
    const phi = Math.atan((vz2 * Math.cos(lam)) / vx);
    return [lam, Math.atan(Math.tan(phi) / (this.radiusP * this.radiusP))];
  }
}

/** An EPSG conversion method: code, name, PROJ name, parameters as (code, PROJ key). */
type MethodDef = [number, string, string, [number, string][]];

const METHODS: MethodDef[] = [
  [9807, 'Transverse Mercator', 'tmerc', [[8801, 'lat_0'], [8802, 'lon_0'], [8805, 'k_0'], [8806, 'x_0'], [8807, 'y_0']]],
  [9804, 'Mercator (variant A)', 'merc', [[8801, 'lat_0'], [8802, 'lon_0'], [8805, 'k_0'], [8806, 'x_0'], [8807, 'y_0']]],
  [9805, 'Mercator (variant B)', 'merc', [[8823, 'lat_ts'], [8802, 'lon_0'], [8806, 'x_0'], [8807, 'y_0']]],
  [1024, 'Popular Visualisation Pseudo Mercator', 'webmerc', [[8801, 'lat_0'], [8802, 'lon_0'], [8806, 'x_0'], [8807, 'y_0']]],
  [9801, 'Lambert Conic Conformal (1SP)', 'lcc', [[8801, 'lat_0'], [8802, 'lon_0'], [8805, 'k_0'], [8806, 'x_0'], [8807, 'y_0']]],
  [
    9802,
    'Lambert Conic Conformal (2SP)',
    'lcc',
    [[8821, 'lat_0'], [8822, 'lon_0'], [8823, 'lat_1'], [8824, 'lat_2'], [8826, 'x_0'], [8827, 'y_0']],
  ],
  [9820, 'Lambert Azimuthal Equal Area', 'laea', [[8801, 'lat_0'], [8802, 'lon_0'], [8806, 'x_0'], [8807, 'y_0']]],
  [9810, 'Polar Stereographic (variant A)', 'stere', [[8801, 'lat_0'], [8802, 'lon_0'], [8805, 'k_0'], [8806, 'x_0'], [8807, 'y_0']]],
  [9829, 'Polar Stereographic (variant B)', 'stere', [[8832, 'lat_ts'], [8833, 'lon_0'], [8806, 'x_0'], [8807, 'y_0']]],
  [1078, 'Equal Earth', 'eqearth', [[8802, 'lon_0'], [8806, 'x_0'], [8807, 'y_0']]],
  // PROJ's own methods and parameters, without EPSG codes (0: matched by name).
  [0, 'Geostationary Satellite (Sweep X)', 'geos +sweep=x', [[8801, 'lat_0'], [8802, 'lon_0'], [0, 'h'], [8806, 'x_0'], [8807, 'y_0']]],
  [0, 'Geostationary Satellite (Sweep Y)', 'geos +sweep=y', [[8801, 'lat_0'], [8802, 'lon_0'], [0, 'h'], [8806, 'x_0'], [8807, 'y_0']]],
];

/** EPSG parameter names, for parameters without an `id`. */
const PARAMETER_NAMES: [number, string][] = [
  [8801, 'Latitude of natural origin'],
  [8802, 'Longitude of natural origin'],
  [8805, 'Scale factor at natural origin'],
  [8806, 'False easting'],
  [8807, 'False northing'],
  [8821, 'Latitude of false origin'],
  [8822, 'Longitude of false origin'],
  [8823, 'Latitude of 1st standard parallel'],
  [8824, 'Latitude of 2nd standard parallel'],
  [8826, 'Easting at false origin'],
  [8827, 'Northing at false origin'],
  [8832, 'Latitude of standard parallel'],
  [8833, 'Longitude of origin'],
  [0, 'Satellite Height'],
];

// serde_json `Value` access: indexing a non-object gives null.
const at = (v: unknown, k: string): unknown =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && Object.hasOwn(v, k) ? (v as Record<string, unknown>)[k] : undefined;
const asF64 = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
/** serde_json `as_u64`: a non-negative integer (JSON `1.0` reads as one here, unlike serde). */
const asU64 = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined);
const asStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
/** Rust `{}` of an f64, as far as parsing it back is concerned (keeps −0). */
const fmt = (v: number): string => (Object.is(v, -0) ? '-0' : String(v));
const show = (v: unknown): string => JSON.stringify(v ?? null);

/** A PROJJSON geographic or projected CRS as the PROJ string `Projection.fromProjString` takes. */
function projString(crs: unknown): string {
  const type = asStr(at(crs, 'type'));
  let base: unknown;
  let conversion: unknown;
  let projected: boolean;
  if (type === 'GeographicCRS') {
    [base, projected] = [crs, false];
  } else if (type === 'ProjectedCRS') {
    [base, conversion, projected] = [at(crs, 'base_crs'), at(crs, 'conversion'), true];
  } else {
    throw unsupported(`PROJJSON type ${type ?? '(none)'}`);
  }
  const d = at(base, 'datum');
  const datum = d !== null && typeof d === 'object' && !Array.isArray(d) ? d : at(base, 'datum_ensemble');
  const pm = asF64(at(at(datum, 'prime_meridian'), 'longitude'));
  if (pm !== undefined && pm !== 0) throw unsupported('prime meridians other than Greenwich');
  const el = at(datum, 'ellipsoid');
  // ponytail: ellipsoid lengths are taken as metres.
  const len = (v: unknown): number | undefined => asF64(v) ?? asF64(at(v, 'value'));
  const r = len(at(el, 'radius'));
  const a = len(at(el, 'semi_major_axis'));
  const rf = asF64(at(el, 'inverse_flattening'));
  const b = len(at(el, 'semi_minor_axis'));
  let ellipsoid: string;
  if (r !== undefined) ellipsoid = `+R=${fmt(r)}`;
  else if (a !== undefined && rf !== undefined) ellipsoid = `+a=${fmt(a)} +rf=${fmt(rf)}`;
  else if (a !== undefined && b !== undefined) ellipsoid = `+a=${fmt(a)} +b=${fmt(b)}`;
  else throw unsupported('PROJJSON without an ellipsoid');
  if (!projected) return `+proj=longlat ${ellipsoid}`;
  const axes = at(at(crs, 'coordinate_system'), 'axis');
  for (const axis of Array.isArray(axes) ? axes : []) {
    const unit = at(axis, 'unit');
    if (!(unit === 'metre' || unit === undefined || unit === null || asF64(at(unit, 'conversion_factor')) === 1)) {
      throw unsupported(`axis unit ${show(unit)}`);
    }
  }
  const method = at(conversion, 'method');
  const name = asStr(at(method, 'name')) ?? '';
  const code = asU64(at(at(method, 'id'), 'code'));
  const def = METHODS.find((m) => (code !== undefined && m[0] !== 0 ? code === m[0] : m[1] === name));
  if (def === undefined) throw unsupported(`conversion method ${name}`);
  const [, , proj, keys] = def;
  let out = `+proj=${proj} ${ellipsoid}`;
  const params = at(conversion, 'parameters');
  for (const p of Array.isArray(params) ? params : []) {
    const pname = asStr(at(p, 'name')) ?? '';
    const pcode = asU64(at(at(p, 'id'), 'code')) ?? PARAMETER_NAMES.find((n) => n[1] === pname)?.[0];
    const key = keys.find((k) => k[0] === pcode);
    if (key === undefined) throw unsupported(`parameter ${pname} of ${name}`);
    let value = asF64(at(p, 'value'));
    if (value === undefined) throw unsupported(`parameter ${pname}`);
    const u = at(p, 'unit');
    if (u === undefined || u === null || u === 'degree' || u === 'metre' || u === 'unity') {
      // as is
    } else if (at(u, 'type') === 'AngularUnit') {
      value = value * (asF64(at(u, 'conversion_factor')) ?? NaN) * DEG;
    } else if (typeof at(u, 'conversion_factor') === 'number') {
      value = value * (at(u, 'conversion_factor') as number);
    } else {
      throw unsupported(`unit ${show(u)}`);
    }
    out += ` +${key[1]}=${fmt(value)}`;
  }
  return out;
}
