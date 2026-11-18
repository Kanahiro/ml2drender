//! Map projections for `reproject`, from PROJJSON (read through the PROJ string parameters it maps
//! to): the common methods on an ellipsoid, without datum shifts (geodetic coordinates are taken
//! as WGS84). Coordinates are always (easting, northing) / (longitude, latitude), whatever the
//! CRS's axis order.

use crate::Error;
use geographiclib_rs::{DirectGeodesic, Geodesic, InverseGeodesic};
use serde_json::Value as J;
use std::f64::consts::{FRAC_PI_2, FRAC_PI_4, PI};

/// `√(a² + b²)`: libm's `hypot` rounds correctly through a software `fma` on wasm32, which costs
/// more than the rest of a projection. The arguments here are far from overflowing.
fn hypot(a: f64, b: f64) -> f64 {
    (a * a + b * b).sqrt()
}

fn unsupported(m: impl Into<String>) -> Error {
    Error::Unsupported(m.into())
}

/// A CRS's projection from and to longitude/latitude, as [`crate::reproject::ProjectedView`] uses it.
#[derive(Debug)]
pub struct Projection {
    method: Method,
    p: Origin,
}

#[derive(Debug)]
enum Method {
    LongLat,
    Tmerc(Tmerc),
    Merc(Merc),
    Lcc(Lcc),
    Stere(Stere),
    Laea(Laea),
    EqEarth(EqEarth),
    Geos(Geos),
    Aea(Aea),
    Sterea(Sterea),
    Omerc(Omerc),
    Eqc(Eqc),
    Aeqd(Box<Aeqd>),
    Ortho(Ortho),
    Moll(Moll),
    Robin(Robin),
    Sinu(Sinu),
    Krovak(Krovak),
    Cass(Cass),
    Eqdc(Eqdc),
    Poly(Poly),
    Cea(Cea),
    NatEarth(NatEarth),
    Wintri(Wintri),
    Mill(Mill),
}

impl Projection {
    /// PROJJSON of a geographic or projected CRS (or of a bound or compound CRS of one, its datum
    /// shift and vertical part ignored).
    pub fn parse(projjson: &str) -> Result<Projection, Error> {
        let json: J = serde_json::from_str(projjson).map_err(|e| unsupported(format!("PROJJSON: {e}")))?;
        Projection::from_proj_string(&proj_string(&json)?)
    }

    /// The PROJ string `proj_string` makes of a PROJJSON CRS.
    fn from_proj_string(def: &str) -> Result<Projection, Error> {
        let params: Vec<(&str, &str)> = def
            .split_whitespace()
            .map(|t| t.trim_start_matches('+'))
            .map(|t| t.split_once('=').unwrap_or((t, "")))
            .collect();
        let get = |k: &str| params.iter().find(|p| p.0 == k).map(|p| p.1);
        let num = |k: &str| get(k).map(|v| v.parse::<f64>().map_err(|_| unsupported(format!("+{k}={v}")))).transpose();
        let (a, f) = match (num("R")?, num("a")?) {
            (Some(r), _) => (r, 0.0),
            (_, Some(a)) => (
                a,
                match (num("rf")?, num("f")?, num("b")?) {
                    // WKT's inverse flattening 0 is a sphere.
                    (Some(rf), ..) => {
                        if rf == 0.0 {
                            0.0
                        } else {
                            1.0 / rf
                        }
                    }
                    (_, Some(f), _) => f,
                    (.., Some(b)) => 1.0 - b / a,
                    _ => 0.0,
                },
            ),
            _ => return Err(unsupported("no ellipsoid")),
        };
        let el = Ellipsoid { a, e: (f * (2.0 - f)).sqrt() };
        // PROJ's spherical forms of EPSG methods: the sphere of the ellipsoid's area.
        // PROJ's series for its radius (exact to ~1e-11).
        let el = if get("R_A").is_some() {
            let es = el.e * el.e;
            Ellipsoid { a: a * (1.0 - es * (1.0 / 6.0 + es * (17.0 / 360.0 + es * 67.0 / 3024.0))), e: 0.0 }
        } else {
            el
        };
        let lat_0 = num("lat_0")?.unwrap_or(0.0);
        // Longitudes of the CRS are from its prime meridian, those given to `forward` from Greenwich.
        let pm = num("pm")?.unwrap_or(0.0);
        let lon_0 = num("lon_0")?.unwrap_or(0.0) + pm;
        let k_0 = num("k_0")?.unwrap_or(1.0);
        let origin = [num("x_0")?.unwrap_or(0.0), num("y_0")?.unwrap_or(0.0)];
        let mut p = Origin { lon_0, origin, to_meter: num("to_meter")?.unwrap_or(1.0) };
        let method = match get("proj").unwrap_or("") {
            "longlat" => Method::LongLat,
            "tmerc" => Method::Tmerc(Tmerc::new(el, lat_0, k_0)),
            "merc" => Method::Merc(Merc::new(el, num("lat_ts")?, k_0)),
            // Web Mercator: spherical formulas with the ellipsoid's semi-major axis.
            "webmerc" => Method::Merc(Merc::new(Ellipsoid { a, e: 0.0 }, None, 1.0)),
            "lcc" => {
                let lat_1 = num("lat_1")?.unwrap_or(lat_0);
                Method::Lcc(Lcc::new(el, lat_0, lat_1, num("lat_2")?.unwrap_or(lat_1), k_0))
            }
            "stere" => {
                let lat_ts = num("lat_ts")?;
                // Variant B gives the pole by the sign of its standard parallel.
                let lat_0 = num("lat_0")?.or(lat_ts.map(|t| 90f64.copysign(t))).unwrap_or(0.0);
                // Within rounding: degrees converted from radians may miss 90 by an ulp or two.
                if (lat_0.abs() - 90.0).abs() > 1e-9 {
                    return Err(unsupported("oblique stereographic as stere (it is sterea)"));
                }
                Method::Stere(Stere::new(el, lat_0, lat_ts, k_0))
            }
            "laea" => Method::Laea(Laea::new(el, lat_0)),
            "eqearth" => Method::EqEarth(EqEarth::new(el)),
            "geos" => {
                if lat_0 != 0.0 {
                    return Err(unsupported("geos with +lat_0 other than 0"));
                }
                let h = num("h")?.ok_or_else(|| unsupported("geos without +h"))?;
                let sweep_x = match get("sweep").unwrap_or("y") {
                    "x" => true,
                    "y" => false,
                    s => return Err(unsupported(format!("+sweep={s}"))),
                };
                Method::Geos(Geos::new(el, h, sweep_x))
            }
            "aea" => {
                let lat_1 = num("lat_1")?.unwrap_or(lat_0);
                Method::Aea(Aea::new(el, lat_0, lat_1, num("lat_2")?.unwrap_or(lat_1))?)
            }
            "sterea" => Method::Sterea(Sterea::new(el, lat_0, k_0)),
            "omerc" => {
                let alpha = num("alpha")?.ok_or_else(|| unsupported("omerc without +alpha"))?;
                let gamma = num("gamma")?.unwrap_or(alpha);
                let lonc = num("lonc")?.unwrap_or(0.0) + pm;
                let o = Omerc::new(el, lat_0, lonc, alpha, gamma, k_0, get("no_uoff").is_some())?;
                // Longitudes are measured from the meridian the method derives from the center's.
                p.lon_0 = o.lam0.to_degrees();
                Method::Omerc(o)
            }
            "eqc" => Method::Eqc(Eqc::new(el, num("lat_ts")?.unwrap_or(0.0), lat_0)?),
            "aeqd" => Method::Aeqd(Box::new(Aeqd::new(el, lat_0))),
            "ortho" => Method::Ortho(Ortho::new(el, lat_0)),
            "moll" => Method::Moll(Moll { a }),
            "robin" => Method::Robin(Robin { a }),
            "sinu" => Method::Sinu(Sinu { el, m: Meridian::new(el) }),
            "krovak" => Method::Krovak(Krovak::new(
                el,
                lat_0,
                num("alpha")?.ok_or_else(|| unsupported("krovak without +alpha"))?,
                num("lat_ts")?.unwrap_or(78.5),
                k_0,
            )),
            "cass" => Method::Cass(Cass::new(el, lat_0)),
            "eqdc" => {
                let lat_1 = num("lat_1")?.unwrap_or(lat_0);
                Method::Eqdc(Eqdc::new(el, lat_0, lat_1, num("lat_2")?.unwrap_or(lat_1)))
            }
            "poly" => Method::Poly(Poly::new(el, lat_0)),
            "cea" => Method::Cea(Cea::new(el, num("lat_ts")?.unwrap_or(0.0))),
            "natearth" => Method::NatEarth(NatEarth { a: el.a }),
            "wintri" => {
                let lat_1 = num("lat_1")?.map_or((2.0 / PI).acos(), f64::to_radians);
                Method::Wintri(Wintri { a: el.a, cos_phi1: lat_1.cos() })
            }
            "mill" => Method::Mill(Mill { a: el.a }),
            p => return Err(unsupported(format!("projection {p:?}"))),
        };
        Ok(Projection { method, p })
    }

    /// Degrees → CRS units.
    pub fn forward(&self, lng: f64, lat: f64) -> [f64; 2] {
        let lon_0 = self.p.lon_0;
        // Like PROJ's `adjlon`, only longitudes beyond lon_0 ± 180° fold: the antimeridian itself stays on
        // its own side (+180° on the east edge), so rings that end at ±180° do not jump across the map.
        let lng = if matches!(self.method, Method::LongLat) || (lng - lon_0).abs() <= 180.0 {
            lng
        } else {
            lon_0 + (lng - lon_0 + 540.0).rem_euclid(360.0) - 180.0
        };
        self.forward_continuous(lng, lat)
    }

    /// `forward` without folding the longitude into `lon_0` ± 180°: past the projection's
    /// antimeridian its formulas continue beyond the edge of the map, so geometry crossing it
    /// stays continuous.
    pub fn forward_continuous(&self, lng: f64, lat: f64) -> [f64; 2] {
        let phi = lat.clamp(-90.0, 90.0).to_radians();
        let lam = self.p.lam(lng);
        self.p.out(match &self.method {
            Method::LongLat => return [lng, phi.to_degrees()],
            Method::Tmerc(t) => t.forward(lam, phi),
            Method::Merc(m) => m.forward(lam, phi),
            Method::Lcc(l) => l.forward(lam, phi),
            Method::Stere(s) => s.forward(lam, phi),
            Method::Laea(l) => l.forward(lam, phi),
            Method::EqEarth(e) => e.forward(lam, phi),
            Method::Geos(g) => g.forward(lam, phi),
            Method::Aea(m) => m.forward(lam, phi),
            Method::Sterea(m) => m.forward(lam, phi),
            Method::Omerc(m) => m.forward(lam, phi),
            Method::Eqc(m) => m.forward(lam, phi),
            Method::Aeqd(m) => m.forward(lam, phi),
            Method::Ortho(m) => m.forward(lam, phi),
            Method::Moll(m) => m.forward(lam, phi),
            Method::Robin(m) => m.forward(lam, phi),
            Method::Sinu(m) => m.forward(lam, phi),
            Method::Krovak(m) => m.forward(lam, phi),
            Method::Cass(m) => m.forward(lam, phi),
            Method::Eqdc(m) => m.forward(lam, phi),
            Method::Poly(m) => m.forward(lam, phi),
            Method::Cea(m) => m.forward(lam, phi),
            Method::NatEarth(m) => m.forward(lam, phi),
            Method::Wintri(m) => m.forward(lam, phi),
            Method::Mill(m) => m.forward(lam, phi),
        })
    }

    /// The center of the longitudes the projection maps (its antimeridian is 180° away), or
    /// `None` for longlat, which maps any longitude.
    pub fn central_meridian(&self) -> Option<f64> {
        (!matches!(self.method, Method::LongLat)).then_some(self.p.lon_0)
    }

    /// Longitude/latitude on the map around which the projection's domain is star-shaped (on the
    /// map, any straight line out from it leaves the map once): its central meridian on the
    /// equator, or an orthographic view's center, whose equator may be on the limb.
    pub fn center(&self) -> [f64; 2] {
        let lat = match &self.method {
            Method::Ortho(o) => o.lat_0,
            _ => 0.0,
        };
        [self.p.lon_0, lat]
    }

    /// CRS units in a turn of Web Mercator's equator: the zoom of a scale is read as Web Mercator's
    /// (OGC scale denominators).
    pub fn units_per_turn(&self) -> f64 {
        match self.method {
            Method::LongLat => 360.0,
            _ => 2.0 * PI * 6378137.0 / self.p.to_meter,
        }
    }

    /// CRS units → degrees, `None` outside the projection's domain.
    pub fn inverse(&self, xy: [f64; 2]) -> Option<[f64; 2]> {
        if matches!(self.method, Method::LongLat) {
            return (xy[1].abs() <= 90.0 && xy[0].is_finite()).then_some(xy);
        }
        let xy = self.p.local(xy);
        let [lam, phi] = match &self.method {
            Method::LongLat => unreachable!(),
            Method::Tmerc(t) => t.inverse(xy),
            Method::Merc(m) => m.inverse(xy),
            Method::Lcc(l) => l.inverse(xy),
            Method::Stere(s) => s.inverse(xy),
            Method::Laea(l) => l.inverse(xy),
            Method::EqEarth(e) => e.inverse(xy),
            Method::Geos(g) => g.inverse(xy),
            Method::Aea(m) => m.inverse(xy),
            Method::Sterea(m) => m.inverse(xy),
            Method::Omerc(m) => m.inverse(xy),
            Method::Eqc(m) => m.inverse(xy),
            Method::Aeqd(m) => m.inverse(xy),
            Method::Ortho(m) => m.inverse(xy),
            Method::Moll(m) => m.inverse(xy),
            Method::Robin(m) => m.inverse(xy),
            Method::Sinu(m) => m.inverse(xy),
            Method::Krovak(m) => m.inverse(xy),
            Method::Cass(m) => m.inverse(xy),
            Method::Eqdc(m) => m.inverse(xy),
            Method::Poly(m) => m.inverse(xy),
            Method::Cea(m) => m.inverse(xy),
            Method::NatEarth(m) => m.inverse(xy),
            Method::Wintri(m) => m.inverse(xy),
            Method::Mill(m) => m.inverse(xy),
        };
        let lon_0 = self.p.lon_0;
        let r = [(lon_0 + lam.to_degrees() + 540.0).rem_euclid(360.0) - 180.0, phi.to_degrees()];
        (r[0].is_finite() && r[1].is_finite()).then_some(r)
    }
}

/// Central meridian, false origin and unit, shared by the projected methods: they work in radians
/// relative to `lon_0` and in metres relative to `origin`.
#[derive(Debug, Clone, Copy)]
struct Origin {
    lon_0: f64,
    origin: [f64; 2],
    /// Metres per CRS unit.
    to_meter: f64,
}

impl Origin {
    /// Longitude difference from the central meridian, in radians.
    fn lam(&self, lng: f64) -> f64 {
        (lng - self.lon_0).to_radians()
    }
    fn out(&self, p: [f64; 2]) -> [f64; 2] {
        [(self.origin[0] + p[0]) / self.to_meter, (self.origin[1] + p[1]) / self.to_meter]
    }
    fn local(&self, p: [f64; 2]) -> [f64; 2] {
        [p[0] * self.to_meter - self.origin[0], p[1] * self.to_meter - self.origin[1]]
    }
}

#[derive(Debug, Clone, Copy)]
struct Ellipsoid {
    a: f64,
    e: f64,
}

impl Ellipsoid {
    /// τ′, the tangent of the conformal latitude, from τ = tan φ (Karney 2011).
    fn taup(&self, tau: f64) -> f64 {
        let s = (self.e * (self.e * tau / hypot(tau, 1.0)).atanh()).sinh();
        tau * hypot(s, 1.0) - s * hypot(tau, 1.0)
    }

    /// τ from τ′ by Newton's method (Karney 2011, eq. 19–21).
    fn tau(&self, taup: f64) -> f64 {
        let e2m = 1.0 - self.e * self.e;
        let mut tau = taup / e2m;
        for _ in 0..5 {
            let tp = self.taup(tau);
            let d = (taup - tp) / hypot(tp, 1.0) * (1.0 + e2m * tau * tau) / (e2m * hypot(tau, 1.0));
            tau += d;
            if d.abs() < 1e-14 * tau.abs().max(1.0) {
                break;
            }
        }
        tau
    }

    /// `tan(π/4 − χ/2)` for the conformal latitude χ of `phi` (Snyder's t).
    fn t(&self, phi: f64) -> f64 {
        let s = self.e * phi.sin();
        (FRAC_PI_4 - phi / 2.0).tan() / ((1.0 - s) / (1.0 + s)).powf(self.e / 2.0)
    }

    /// The latitude whose Snyder's t is `t`.
    fn phi_from_t(&self, t: f64) -> f64 {
        self.tau((FRAC_PI_2 - 2.0 * t.atan()).tan()).atan()
    }

    /// `cos φ / √(1 − e² sin² φ)` (Snyder's m).
    fn m(&self, phi: f64) -> f64 {
        phi.cos() / (1.0 - (self.e * phi.sin()).powi(2)).sqrt()
    }

    /// Snyder's q, for the authalic latitude.
    fn q(&self, phi: f64) -> f64 {
        let s = phi.sin();
        let e = self.e;
        let atanh_e = if e == 0.0 { s } else { (e * s).atanh() / e };
        (1.0 - e * e) * (s / (1.0 - (e * s).powi(2)) + atanh_e)
    }

    /// The latitude whose q is `q` (Snyder eq. 3-16); NaN past the poles.
    fn phi_from_q(&self, q: f64) -> f64 {
        let e = self.e;
        let qp = self.q(FRAC_PI_2);
        if (q.abs() - qp).abs() < 1e-12 {
            return FRAC_PI_2.copysign(q);
        }
        let mut phi = (q / 2.0).asin();
        if e == 0.0 || !phi.is_finite() {
            return if q.abs() > qp { f64::NAN } else { phi };
        }
        for _ in 0..15 {
            let (s, c) = phi.sin_cos();
            let w = 1.0 - (e * s).powi(2);
            let d = w * w / (2.0 * c) * (q / (1.0 - e * e) - s / w - (e * s).atanh() / e);
            phi += d;
            if d.abs() < 1e-14 {
                break;
            }
        }
        phi
    }
}

/// Ellipsoidal transverse Mercator: Krüger's series to n⁶ (Karney 2011, as PROJ's default tmerc).
#[derive(Debug)]
pub struct Tmerc {
    el: Ellipsoid,
    /// k₀ times the rectifying radius.
    k0a: f64,
    alpha: [f64; 6],
    beta: [f64; 6],
    /// ξ of the origin latitude.
    xi0: f64,
}

impl Tmerc {
    fn new(el: Ellipsoid, lat_0: f64, k_0: f64) -> Tmerc {
        let f = 1.0 - (1.0 - el.e * el.e).sqrt();
        let n = f / (2.0 - f);
        let [n2, n3, n4, n5, n6] = [n * n, n.powi(3), n.powi(4), n.powi(5), n.powi(6)];
        let alpha = [
            n / 2.0 - 2.0 * n2 / 3.0 + 5.0 * n3 / 16.0 + 41.0 * n4 / 180.0 - 127.0 * n5 / 288.0 + 7891.0 * n6 / 37800.0,
            13.0 * n2 / 48.0 - 3.0 * n3 / 5.0 + 557.0 * n4 / 1440.0 + 281.0 * n5 / 630.0 - 1983433.0 * n6 / 1935360.0,
            61.0 * n3 / 240.0 - 103.0 * n4 / 140.0 + 15061.0 * n5 / 26880.0 + 167603.0 * n6 / 181440.0,
            49561.0 * n4 / 161280.0 - 179.0 * n5 / 168.0 + 6601661.0 * n6 / 7257600.0,
            34729.0 * n5 / 80640.0 - 3418889.0 * n6 / 1995840.0,
            212378941.0 * n6 / 319334400.0,
        ];
        let beta = [
            n / 2.0 - 2.0 * n2 / 3.0 + 37.0 * n3 / 96.0 - n4 / 360.0 - 81.0 * n5 / 512.0 + 96199.0 * n6 / 604800.0,
            n2 / 48.0 + n3 / 15.0 - 437.0 * n4 / 1440.0 + 46.0 * n5 / 105.0 - 1118711.0 * n6 / 3870720.0,
            17.0 * n3 / 480.0 - 37.0 * n4 / 840.0 - 209.0 * n5 / 4480.0 + 5569.0 * n6 / 90720.0,
            4397.0 * n4 / 161280.0 - 11.0 * n5 / 504.0 - 830251.0 * n6 / 7257600.0,
            4583.0 * n5 / 161280.0 - 108847.0 * n6 / 3991680.0,
            20648693.0 * n6 / 638668800.0,
        ];
        let k0a = k_0 * el.a / (1.0 + n) * (1.0 + n2 / 4.0 + n4 / 64.0 + n6 / 256.0);
        let mut t = Tmerc { el, k0a, alpha, beta, xi0: 0.0 };
        t.xi0 = t.xi_eta(lat_0.to_radians(), 0.0)[0];
        t
    }

    fn xi_eta(&self, phi: f64, lam: f64) -> [f64; 2] {
        let taup = self.el.taup(phi.clamp(-FRAC_PI_2 + 1e-11, FRAC_PI_2 - 1e-11).tan());
        let (xi1, eta1) = (taup.atan2(lam.cos()), (lam.sin() / hypot(taup, lam.cos())).asinh());
        let [dxi, deta] = sin_series(&self.alpha, xi1, eta1);
        [xi1 + dxi, eta1 + deta]
    }

    fn forward(&self, lam: f64, phi: f64) -> [f64; 2] {
        let [xi, eta] = self.xi_eta(phi, lam);
        [self.k0a * eta, self.k0a * (xi - self.xi0)]
    }

    fn inverse(&self, [x, y]: [f64; 2]) -> [f64; 2] {
        let (xi, eta) = (y / self.k0a + self.xi0, x / self.k0a);
        let [dxi, deta] = sin_series(&self.beta, xi, eta);
        let (xi1, eta1) = (xi - dxi, eta - deta);
        let taup = xi1.sin() / hypot(eta1.sinh(), xi1.cos());
        [eta1.sinh().atan2(xi1.cos()), self.el.tau(taup).atan()]
    }
}

/// Σⱼ c[j−1]·sin(2jζ) for ζ = ξ + iη, as (real, imaginary): Krüger's series summed with
/// Clenshaw's recurrence in complex arithmetic (as PROJ does), one sin/cos and one exp in all.
fn sin_series(c: &[f64; 6], xi: f64, eta: f64) -> [f64; 2] {
    let (s, co) = (2.0 * xi).sin_cos();
    let e = (2.0 * eta).exp();
    let (sh, ch) = ((e - 1.0 / e) / 2.0, (e + 1.0 / e) / 2.0);
    // sin 2ζ and 2·cos 2ζ.
    let sin_z = [s * ch, co * sh];
    let k = [2.0 * co * ch, -2.0 * s * sh];
    // b_j = c_j + k·b_{j+1} − b_{j+2}; the sum is b_1·sin 2ζ.
    let (mut b1, mut b2) = ([0.0; 2], [0.0; 2]);
    for &a in c.iter().rev() {
        let b0 = [a + k[0] * b1[0] - k[1] * b1[1] - b2[0], k[0] * b1[1] + k[1] * b1[0] - b2[1]];
        (b2, b1) = (b1, b0);
    }
    [b1[0] * sin_z[0] - b1[1] * sin_z[1], b1[0] * sin_z[1] + b1[1] * sin_z[0]]
}

/// Mercator (variant A with `k_0`, B with `lat_ts`).
#[derive(Debug)]
pub struct Merc {
    el: Ellipsoid,
    ak: f64,
}

impl Merc {
    fn new(el: Ellipsoid, lat_ts: Option<f64>, k_0: f64) -> Merc {
        let k = lat_ts.map_or(k_0, |t| el.m(t.to_radians()));
        Merc { el, ak: el.a * k }
    }
    fn forward(&self, lam: f64, phi: f64) -> [f64; 2] {
        [self.ak * lam, self.ak * self.el.taup(phi.tan()).asinh()]
    }
    fn inverse(&self, [x, y]: [f64; 2]) -> [f64; 2] {
        [x / self.ak, self.el.tau((y / self.ak).sinh()).atan()]
    }
}

/// Lambert conformal conic (1SP: `lat_1` = `lat_2` = `lat_0` with `k_0`; 2SP), Snyder ch. 15.
#[derive(Debug)]
pub struct Lcc {
    el: Ellipsoid,
    n: f64,
    /// a·k₀·F.
    af: f64,
    rho0: f64,
}

impl Lcc {
    fn new(el: Ellipsoid, lat_0: f64, lat_1: f64, lat_2: f64, k_0: f64) -> Lcc {
        let [phi0, phi1, phi2] = [lat_0, lat_1, lat_2].map(f64::to_radians);
        let (m1, t1) = (el.m(phi1), el.t(phi1));
        let n = if (phi1 - phi2).abs() > 1e-10 {
            (m1.ln() - el.m(phi2).ln()) / (t1.ln() - el.t(phi2).ln())
        } else {
            phi1.sin()
        };
        let af = el.a * k_0 * m1 / (n * t1.powf(n));
        Lcc { el, n, af, rho0: af * el.t(phi0).powf(n) }
    }
    fn forward(&self, lam: f64, phi: f64) -> [f64; 2] {
        let rho = self.af * self.el.t(phi).powf(self.n);
        let theta = self.n * lam;
        [rho * theta.sin(), self.rho0 - rho * theta.cos()]
    }
    fn inverse(&self, [x, y]: [f64; 2]) -> [f64; 2] {
        let s = self.n.signum();
        let dy = self.rho0 - y;
        let rho = s * hypot(x, dy);
        let theta = (s * x).atan2(s * dy);
        // Points in the cone's gap (beyond lon_0 ± 180°) are off the map.
        if (theta / self.n).abs() > std::f64::consts::PI {
            return [f64::NAN; 2];
        }
        [theta / self.n, self.el.phi_from_t((rho / self.af).powf(1.0 / self.n))]
    }
}

/// Polar stereographic (variant A with `k_0`, B with `lat_ts`), Snyder ch. 21.
#[derive(Debug)]
pub struct Stere {
    el: Ellipsoid,
    /// +1 for the north pole, −1 for the south.
    s: f64,
    /// ρ / t.
    k: f64,
}

impl Stere {
    fn new(el: Ellipsoid, lat_0: f64, lat_ts: Option<f64>, k_0: f64) -> Stere {
        let s = lat_0.signum();
        let e = el.e;
        let k = match lat_ts.map(|t| (t * s).to_radians()).filter(|t| (t - FRAC_PI_2).abs() > 1e-10) {
            Some(ts) => el.a * el.m(ts) / el.t(ts),
            None => 2.0 * el.a * k_0 / ((1.0 + e).powf(1.0 + e) * (1.0 - e).powf(1.0 - e)).sqrt(),
        };
        Stere { el, s, k }
    }
    fn forward(&self, lam: f64, phi: f64) -> [f64; 2] {
        let rho = self.k * self.el.t(self.s * phi);
        [rho * lam.sin(), -self.s * rho * lam.cos()]
    }
    fn inverse(&self, [x, y]: [f64; 2]) -> [f64; 2] {
        let rho = hypot(x, y);
        [x.atan2(-self.s * y), self.s * self.el.phi_from_t(rho / self.k)]
    }
}

/// Lambert azimuthal equal-area, Snyder ch. 24.
#[derive(Debug)]
pub struct Laea {
    el: Ellipsoid,
    qp: f64,
    /// Authalic radius.
    rq: f64,
    /// +1 / −1 at the north / south pole; 0 otherwise (oblique and equatorial).
    pole: f64,
    /// sin and cos of the origin's authalic latitude, and Snyder's D.
    sb1: f64,
    cb1: f64,
    d: f64,
}

impl Laea {
    fn new(el: Ellipsoid, lat_0: f64) -> Laea {
        let qp = el.q(FRAC_PI_2);
        let rq = el.a * (qp / 2.0).sqrt();
        let phi0 = lat_0.to_radians();
        let pole = if (lat_0.abs() - 90.0).abs() < 1e-10 { lat_0.signum() } else { 0.0 };
        let (sb1, cb1) = (el.q(phi0) / qp).clamp(-1.0, 1.0).asin().sin_cos();
        let d = if pole == 0.0 { el.a * el.m(phi0) / (rq * cb1) } else { 1.0 };
        Laea { el, qp, rq, pole, sb1, cb1, d }
    }
    fn forward(&self, lam: f64, phi: f64) -> [f64; 2] {
        let q = self.el.q(phi);
        if self.pole != 0.0 {
            let rho = self.el.a * (self.qp - self.pole * q).max(0.0).sqrt();
            return [rho * lam.sin(), -self.pole * rho * lam.cos()];
        }
        let (sb, cb) = (q / self.qp).clamp(-1.0, 1.0).asin().sin_cos();
        let b = self.rq * (2.0 / (1.0 + self.sb1 * sb + self.cb1 * cb * lam.cos())).sqrt();
        [b * self.d * cb * lam.sin(), b / self.d * (self.cb1 * sb - self.sb1 * cb * lam.cos())]
    }
    fn inverse(&self, [x, y]: [f64; 2]) -> [f64; 2] {
        if self.pole != 0.0 {
            let r = hypot(x, y) / self.el.a;
            return [x.atan2(-self.pole * y), self.el.phi_from_q(self.pole * (self.qp - r * r))];
        }
        let (x, y) = (x / self.d, y * self.d);
        let rho = hypot(x, y);
        if rho == 0.0 {
            return [0.0, self.el.phi_from_q(self.qp * self.sb1)];
        }
        let (sc, cc) = (2.0 * (rho / (2.0 * self.rq)).asin()).sin_cos();
        let sb = cc * self.sb1 + y * sc * self.cb1 / rho;
        [(x * sc).atan2(rho * self.cb1 * cc - y * self.sb1 * sc), self.el.phi_from_q(self.qp * sb)]
    }
}

/// Equal Earth (Šavrič et al. 2018), on the authalic sphere of the ellipsoid like PROJ.
#[derive(Debug)]
pub struct EqEarth {
    el: Ellipsoid,
    qp: f64,
    rq: f64,
}

const EQ_A: [f64; 4] = [1.340264, -0.081106, 0.000893, 0.003796];
const EQ_M: f64 = 0.866_025_403_784_438_6; // √3 / 2

impl EqEarth {
    fn new(el: Ellipsoid) -> EqEarth {
        let qp = el.q(FRAC_PI_2);
        EqEarth { el, qp, rq: el.a * (qp / 2.0).sqrt() }
    }
    /// y(θ)/θ and dy/dθ of the unit projection.
    fn poly(t: f64) -> (f64, f64) {
        let [a1, a2, a3, a4] = EQ_A;
        let (t2, t6) = (t * t, t.powi(6));
        (a1 + a2 * t2 + t6 * (a3 + a4 * t2), a1 + 3.0 * a2 * t2 + t6 * (7.0 * a3 + 9.0 * a4 * t2))
    }
    fn forward(&self, lam: f64, phi: f64) -> [f64; 2] {
        let sb = (self.el.q(phi) / self.qp).clamp(-1.0, 1.0);
        let t = (EQ_M * sb).asin();
        let (p, dp) = Self::poly(t);
        [self.rq * lam * t.cos() / (EQ_M * dp), self.rq * t * p]
    }
    fn inverse(&self, [x, y]: [f64; 2]) -> [f64; 2] {
        let (x, y) = (x / self.rq, y / self.rq);
        let mut t = y;
        for _ in 0..12 {
            let (p, dp) = Self::poly(t);
            let d = (t * p - y) / dp;
            t -= d;
            if d.abs() < 1e-14 {
                break;
            }
        }
        let lam = EQ_M * x * Self::poly(t).1 / t.cos();
        let sb = t.sin() / EQ_M;
        // Past the outline: no answer.
        if lam.abs() > std::f64::consts::PI + 1e-9 || sb.abs() > 1.0 {
            return [f64::NAN; 2];
        }
        [lam, self.el.phi_from_q(self.qp * sb)]
    }
}

/// Geostationary satellite view (PROJ's geos): the scanning angles of a satellite at height `h`
/// above the equator, times `h`. NaN on the side of the Earth the satellite does not see.
#[derive(Debug)]
pub struct Geos {
    a: f64,
    /// Satellite distance from the center, in units of `a`, and `h / a`.
    radius_g: f64,
    radius_g_1: f64,
    /// b / a.
    radius_p: f64,
    /// The scanning mirror turns about x first (GOES) instead of y (Himawari, Meteosat).
    sweep_x: bool,
}

impl Geos {
    fn new(el: Ellipsoid, h: f64, sweep_x: bool) -> Geos {
        let radius_g_1 = h / el.a;
        Geos { a: el.a, radius_g: 1.0 + radius_g_1, radius_g_1, radius_p: (1.0 - el.e * el.e).sqrt(), sweep_x }
    }
    fn forward(&self, lam: f64, phi: f64) -> [f64; 2] {
        let rp2 = self.radius_p * self.radius_p;
        // Geocentric latitude, and the vector from the center to the surface (units of `a`).
        let phi = (rp2 * phi.tan()).atan();
        let r = self.radius_p / hypot(self.radius_p * phi.cos(), phi.sin());
        let (vx, vy, vz) = (r * lam.cos() * phi.cos(), r * lam.sin() * phi.cos(), r * phi.sin());
        if (self.radius_g - vx) * vx - vy * vy - vz * vz / rp2 < 0.0 {
            return [f64::NAN; 2];
        }
        let tmp = self.radius_g - vx;
        let g = self.radius_g_1 * self.a;
        if self.sweep_x {
            [g * (vy / hypot(vz, tmp)).atan(), g * (vz / tmp).atan()]
        } else {
            [g * (vy / tmp).atan(), g * (vz / hypot(vy, tmp)).atan()]
        }
    }
    fn inverse(&self, [x, y]: [f64; 2]) -> [f64; 2] {
        let (x, y) = (x / self.a / self.radius_g_1, y / self.a / self.radius_g_1);
        let (vy, vz) = if self.sweep_x {
            let vz = y.tan();
            (x.tan() * hypot(vz, 1.0), vz)
        } else {
            let vy = x.tan();
            (vy, y.tan() * hypot(vy, 1.0))
        };
        // The nearer intersection of the line of sight with the ellipsoid.
        let a = vy * vy + (vz / self.radius_p).powi(2) + 1.0;
        let b = -2.0 * self.radius_g;
        let det = b * b - 4.0 * a * (self.radius_g * self.radius_g - 1.0);
        if det < 0.0 {
            return [f64::NAN; 2];
        }
        let k = (-b - det.sqrt()) / (2.0 * a);
        let (vx, vy, vz) = (self.radius_g - k, vy * k, vz * k);
        let lam = vy.atan2(vx);
        let phi = (vz * lam.cos() / vx).atan();
        [lam, (phi.tan() / (self.radius_p * self.radius_p)).atan()]
    }
}

/// Albers equal-area conic (1SP: `lat_1` = `lat_2`; 2SP), Snyder ch. 14, as PROJ's aea.
#[derive(Debug)]
pub struct Aea {
    el: Ellipsoid,
    n: f64,
    c: f64,
    /// q at the pole.
    qp: f64,
    rho0: f64,
}

impl Aea {
    fn new(el: Ellipsoid, lat_0: f64, lat_1: f64, lat_2: f64) -> Result<Aea, Error> {
        let [phi0, phi1, phi2] = [lat_0, lat_1, lat_2].map(f64::to_radians);
        if (phi1 + phi2).abs() < 1e-10 || phi1.abs().max(phi2.abs()) > FRAC_PI_2 {
            return Err(unsupported("aea standard parallels opposite about the equator or past a pole"));
        }
        let (m1, q1) = (el.m(phi1), el.q(phi1));
        let n = if (phi1 - phi2).abs() >= 1e-10 {
            let m2 = el.m(phi2);
            (m1 * m1 - m2 * m2) / (el.q(phi2) - q1)
        } else {
            phi1.sin()
        };
        let c = m1 * m1 + n * q1;
        let mut aea = Aea { el, n, c, qp: el.q(FRAC_PI_2), rho0: 0.0 };
        aea.rho0 = aea.rho(phi0);
        Ok(aea)
    }
    /// NaN where the cone does not reach (a pole beyond a cone near it).
    fn rho(&self, phi: f64) -> f64 {
        self.el.a / self.n * (self.c - self.n * self.el.q(phi)).sqrt()
    }
    fn forward(&self, lam: f64, phi: f64) -> [f64; 2] {
        let rho = self.rho(phi);
        let theta = self.n * lam;
        [rho * theta.sin(), self.rho0 - rho * theta.cos()]
    }
    fn inverse(&self, [x, y]: [f64; 2]) -> [f64; 2] {
        let s = self.n.signum();
        let dy = self.rho0 - y;
        let theta = (s * x).atan2(s * dy);
        // Points in the cone's gap (beyond lon_0 ± 180°) are off the map.
        if (theta / self.n).abs() > PI {
            return [f64::NAN; 2];
        }
        let r = hypot(x, dy) * self.n / self.el.a;
        let q = (self.c - r * r) / self.n;
        let phi = if (self.qp - q.abs()).abs() > 1e-7 { self.el.phi_from_q(q) } else { FRAC_PI_2.copysign(q) };
        [theta / self.n, phi]
    }
}

/// `((1 − x) / (1 + x))^p`.
fn srat(x: f64, p: f64) -> f64 {
    ((1.0 - x) / (1.0 + x)).powf(p)
}

/// Oblique stereographic (EPSG's, PROJ's sterea): stereographic on the ellipsoid's conformal
/// (Gauss) sphere.
#[derive(Debug)]
pub struct Sterea {
    e: f64,
    /// The Gauss sphere's longitude scale, the exponent of its latitude, and its constant.
    c: f64,
    ratexp: f64,
    k: f64,
    /// The origin's latitude on the sphere, its sine and cosine.
    phic0: f64,
    sinc0: f64,
    cosc0: f64,
    /// 2 · k₀ · the sphere's radius.
    r2: f64,
}

impl Sterea {
    fn new(el: Ellipsoid, lat_0: f64, k_0: f64) -> Sterea {
        let phi0 = lat_0.to_radians();
        let (e, es) = (el.e, el.e * el.e);
        let sphi = phi0.sin();
        let rc = (1.0 - es).sqrt() / (1.0 - es * sphi * sphi);
        let cphi2 = phi0.cos().powi(2);
        let c = (1.0 + es * cphi2 * cphi2 / (1.0 - es)).sqrt();
        let phic0 = (sphi / c).asin();
        let ratexp = 0.5 * c * e;
        let k = (0.5 * phic0 + FRAC_PI_4).tan() / ((0.5 * phi0 + FRAC_PI_4).tan().powf(c) * srat(e * sphi, ratexp));
        let (sinc0, cosc0) = phic0.sin_cos();
        Sterea { e, c, ratexp, k, phic0, sinc0, cosc0, r2: 2.0 * rc * k_0 * el.a }
    }
    fn forward(&self, lam: f64, phi: f64) -> [f64; 2] {
        let chi = 2.0
            * (self.k * (0.5 * phi + FRAC_PI_4).tan().powf(self.c) * srat(self.e * phi.sin(), self.ratexp)).atan()
            - FRAC_PI_2;
        let lam = self.c * lam;
        let (sinc, cosc) = chi.sin_cos();
        let cosl = lam.cos();
        let k = self.r2 / (1.0 + self.sinc0 * sinc + self.cosc0 * cosc * cosl);
        [k * cosc * lam.sin(), k * (self.cosc0 * sinc - self.sinc0 * cosc * cosl)]
    }
    fn inverse(&self, [x, y]: [f64; 2]) -> [f64; 2] {
        let rho = hypot(x, y);
        let (chi, lam) = if rho != 0.0 {
            let (sinc, cosc) = (2.0 * rho.atan2(self.r2)).sin_cos();
            (
                (cosc * self.sinc0 + y * sinc * self.cosc0 / rho).asin(),
                (x * sinc).atan2(rho * self.cosc0 * cosc - y * self.sinc0 * sinc),
            )
        } else {
            (self.phic0, 0.0)
        };
        let num = ((0.5 * chi + FRAC_PI_4).tan() / self.k).powf(1.0 / self.c);
        let mut phi = chi;
        for _ in 0..20 {
            let next = 2.0 * (num * srat(self.e * phi.sin(), -0.5 * self.e)).atan() - FRAC_PI_2;
            let done = (next - phi).abs() < 1e-14;
            phi = next;
            if done {
                break;
            }
        }
        [lam / self.c, phi]
    }
}

/// Hotine oblique Mercator (variant A: `u` from the natural origin, B: from the center), as
/// PROJ's omerc.
#[derive(Debug)]
pub struct Omerc {
    el: Ellipsoid,
    b: f64,
    /// A / B and B / A (units of `a`).
    arb: f64,
    bra: f64,
    e: f64,
    singam: f64,
    cosgam: f64,
    sinrot: f64,
    cosrot: f64,
    u_0: f64,
    v_pole_n: f64,
    v_pole_s: f64,
    /// The longitude of the origin (radians), which longitudes are measured from.
    lam0: f64,
}

impl Omerc {
    fn new(
        el: Ellipsoid,
        lat_0: f64,
        lonc: f64,
        alpha: f64,
        gamma: f64,
        k_0: f64,
        no_uoff: bool,
    ) -> Result<Omerc, Error> {
        let phi0 = lat_0.to_radians();
        if (phi0.abs() - FRAC_PI_2).abs() <= 1e-10 {
            return Err(unsupported("omerc centered on a pole"));
        }
        let es = el.e * el.e;
        let com = (1.0 - es).sqrt();
        let (b, a, e, d, f) = if phi0.abs() > 1e-10 {
            let (sinph0, cosph0) = phi0.sin_cos();
            let con = 1.0 - es * sinph0 * sinph0;
            let b = (1.0 + es * cosph0.powi(4) / (1.0 - es)).sqrt();
            let d = b * com / (cosph0 * con.sqrt());
            let f = d + (d * d - 1.0).max(0.0).sqrt().copysign(phi0);
            (b, b * k_0 * com / con, f * el.t(phi0).powf(b), d, f)
        } else {
            (1.0 / com, k_0, 1.0, 1.0, 1.0)
        };
        let (alpha_c, gamma) = (alpha.to_radians(), gamma.to_radians());
        let gamma0 = (alpha_c.sin() / d).clamp(-1.0, 1.0).asin();
        let lam0 = lonc.to_radians() - (0.5 * (f - 1.0 / f) * gamma0.tan()).clamp(-1.0, 1.0).asin() / b;
        let arb = a / b;
        let u_0 = if no_uoff { 0.0 } else { (arb * ((d * d - 1.0).max(0.0).sqrt() / alpha_c.cos()).atan()).abs() };
        Ok(Omerc {
            el,
            b,
            arb,
            bra: 1.0 / arb,
            e,
            singam: gamma0.sin(),
            cosgam: gamma0.cos(),
            sinrot: gamma.sin(),
            cosrot: gamma.cos(),
            u_0: if phi0 < 0.0 { -u_0 } else { u_0 },
            v_pole_n: arb * (FRAC_PI_4 - 0.5 * gamma0).tan().ln(),
            v_pole_s: arb * (FRAC_PI_4 + 0.5 * gamma0).tan().ln(),
            lam0,
        })
    }
    fn forward(&self, lam: f64, phi: f64) -> [f64; 2] {
        let (u, v) = if (phi.abs() - FRAC_PI_2).abs() > 1e-10 {
            let q = self.e / self.el.t(phi).powf(self.b);
            let (s, t) = (0.5 * (q - 1.0 / q), 0.5 * (q + 1.0 / q));
            let vv = (self.b * lam).sin();
            let uu = (s * self.singam - vv * self.cosgam) / t;
            // The oblique system's poles.
            if (uu.abs() - 1.0).abs() < 1e-10 {
                return [f64::NAN; 2];
            }
            let cos = (self.b * lam).cos();
            let u = if cos.abs() < 1e-7 {
                self.arb * self.b * lam
            } else {
                self.arb * (s * self.cosgam + vv * self.singam).atan2(cos)
            };
            (u, 0.5 * self.arb * ((1.0 - uu) / (1.0 + uu)).ln())
        } else {
            (self.arb * phi, if phi > 0.0 { self.v_pole_n } else { self.v_pole_s })
        };
        let u = u - self.u_0;
        [self.el.a * (v * self.cosrot + u * self.sinrot), self.el.a * (u * self.cosrot - v * self.sinrot)]
    }
    fn inverse(&self, [x, y]: [f64; 2]) -> [f64; 2] {
        let (x, y) = (x / self.el.a, y / self.el.a);
        let v = x * self.cosrot - y * self.sinrot;
        let u = y * self.cosrot + x * self.sinrot + self.u_0;
        let qp = (-self.bra * v).exp();
        if qp == 0.0 {
            return [f64::NAN; 2];
        }
        let (sp, tp) = (0.5 * (qp - 1.0 / qp), 0.5 * (qp + 1.0 / qp));
        let vp = (self.bra * u).sin();
        let up = (vp * self.cosgam + sp * self.singam) / tp;
        if (up.abs() - 1.0).abs() < 1e-10 {
            return [0.0, FRAC_PI_2.copysign(up)];
        }
        let t = self.e / ((1.0 + up) / (1.0 - up)).sqrt();
        [
            -(sp * self.cosgam - vp * self.singam).atan2((self.bra * u).cos()) / self.b,
            self.el.phi_from_t(t.powf(1.0 / self.b)),
        ]
    }
}

/// Equidistant cylindrical (plate carrée with a standard parallel): parallels true to scale on the
/// standard one, meridians true to scale (EPSG's ellipsoidal form, as PROJ's eqc).
#[derive(Debug)]
pub struct Eqc {
    /// The radius of the standard parallel.
    rc: f64,
    m: Meridian,
    /// Meridian arc to the origin's latitude.
    m0: f64,
}

impl Eqc {
    fn new(el: Ellipsoid, lat_ts: f64, lat_0: f64) -> Result<Eqc, Error> {
        let rc = el.a * el.m(lat_ts.to_radians());
        if rc <= 0.0 {
            return Err(unsupported("eqc with a standard parallel at a pole"));
        }
        let m = Meridian::new(el);
        Ok(Eqc { rc, m, m0: m.arc(lat_0.to_radians()) })
    }
    fn forward(&self, lam: f64, phi: f64) -> [f64; 2] {
        [self.rc * lam, self.m.arc(phi) - self.m0]
    }
    fn inverse(&self, [x, y]: [f64; 2]) -> [f64; 2] {
        let (lam, phi) = (x / self.rc, self.m.phi(y + self.m0));
        // Past the outline.
        if lam.abs() > PI + 1e-9 || phi.abs() > FRAC_PI_2 + 1e-9 {
            return [f64::NAN; 2];
        }
        [lam, phi]
    }
}

/// Azimuthal equidistant: geodesic distance and azimuth from the origin, like PROJ's aeqd.
#[derive(Debug)]
pub struct Aeqd {
    geod: Geodesic,
    lat_0: f64,
}

impl Aeqd {
    fn new(el: Ellipsoid, lat_0: f64) -> Aeqd {
        Aeqd { geod: Geodesic::new(el.a, 1.0 - (1.0 - el.e * el.e).sqrt()), lat_0 }
    }
    fn forward(&self, lam: f64, phi: f64) -> [f64; 2] {
        let (s, azi, _, _): (f64, f64, f64, f64) =
            self.geod.inverse(self.lat_0, 0.0, phi.to_degrees(), lam.to_degrees());
        let (sin, cos) = azi.to_radians().sin_cos();
        [s * sin, s * cos]
    }
    fn inverse(&self, [x, y]: [f64; 2]) -> [f64; 2] {
        let s = hypot(x, y);
        if s < 1e-10 {
            return [0.0, self.lat_0.to_radians()];
        }
        let (lat, lon): (f64, f64) = self.geod.direct(self.lat_0, 0.0, x.atan2(y).to_degrees(), s);
        // Past the antipode (the map's edge) the geodesic is no longer the shortest.
        let back: f64 = self.geod.inverse(self.lat_0, 0.0, lat, lon);
        if (back - s).abs() > 1e-3 {
            return [f64::NAN; 2];
        }
        [lon.to_radians(), lat.to_radians()]
    }
}

/// Orthographic: the ellipsoid seen from infinitely far along the normal at the origin, as PROJ's
/// ortho. NaN on the far side.
#[derive(Debug)]
pub struct Ortho {
    a: f64,
    es: f64,
    lat_0: f64,
    sinph0: f64,
    cosph0: f64,
    /// The prime vertical radius at the origin (units of `a`).
    nu0: f64,
}

impl Ortho {
    fn new(el: Ellipsoid, lat_0: f64) -> Ortho {
        let (sinph0, cosph0) = lat_0.to_radians().sin_cos();
        let es = el.e * el.e;
        Ortho { a: el.a, es, lat_0, sinph0, cosph0, nu0: 1.0 / (1.0 - es * sinph0 * sinph0).sqrt() }
    }
    fn forward(&self, lam: f64, phi: f64) -> [f64; 2] {
        let (sinphi, cosphi) = phi.sin_cos();
        let (sinlam, coslam) = lam.sin_cos();
        // The surface's normal away from the viewer.
        if sinphi * self.sinph0 + cosphi * self.cosph0 * coslam < -1e-10 {
            return [f64::NAN; 2];
        }
        let nu = 1.0 / (1.0 - self.es * sinphi * sinphi).sqrt();
        [
            self.a * nu * cosphi * sinlam,
            self.a
                * (nu * (sinphi * self.cosph0 - cosphi * self.sinph0 * coslam)
                    + self.es * (self.nu0 * self.sinph0 - nu * sinphi) * self.cosph0),
        ]
    }
    fn inverse(&self, [x, y]: [f64; 2]) -> [f64; 2] {
        // The nearer point of the ellipsoid (x² + y² + z²/(1 − e²) = 1, geocentric, units of `a`,
        // x toward the origin's meridian) on the line through the plane's point along the normal.
        let (x, y) = (x / self.a, y / self.a);
        let (s, c, w) = (self.sinph0, self.cosph0, 1.0 / (1.0 - self.es));
        let px = self.nu0 * c - y * s;
        let pz = self.nu0 * (1.0 - self.es) * s + y * c;
        let qa = c * c + w * s * s;
        let qb = 2.0 * (px * c + w * pz * s);
        let qc = px * px + x * x + w * pz * pz - 1.0;
        let det = qb * qb - 4.0 * qa * qc;
        if det < 0.0 {
            return [f64::NAN; 2];
        }
        let t = (-qb + det.sqrt()) / (2.0 * qa);
        let (gx, gz) = (px + t * c, pz + t * s);
        [x.atan2(gx), (w * gz).atan2(hypot(gx, x))]
    }
}

/// Mollweide, on the sphere of the semi-major axis like PROJ's moll.
#[derive(Debug)]
pub struct Moll {
    a: f64,
}

/// 2√2 / π and √2.
const MOLL_CX: f64 = 0.900_316_316_157_106_1;
const MOLL_CY: f64 = std::f64::consts::SQRT_2;

impl Moll {
    fn forward(&self, lam: f64, phi: f64) -> [f64; 2] {
        // 2θ + sin 2θ = π sin φ, by Newton's method from 2θ = φ.
        let k = PI * phi.sin();
        let mut t = phi;
        let mut converged = false;
        for _ in 0..10 {
            let v = (t + t.sin() - k) / (1.0 + t.cos());
            t -= v;
            if v.abs() < 1e-7 {
                converged = true;
                break;
            }
        }
        let theta = if converged { 0.5 * t } else { FRAC_PI_2.copysign(t) };
        [self.a * MOLL_CX * lam * theta.cos(), self.a * MOLL_CY * theta.sin()]
    }
    fn inverse(&self, [x, y]: [f64; 2]) -> [f64; 2] {
        let theta = (y / (self.a * MOLL_CY)).asin();
        let lam = x / (self.a * MOLL_CX * theta.cos());
        // Past the outline.
        if lam.abs() > PI + 1e-9 {
            return [f64::NAN; 2];
        }
        let t = 2.0 * theta;
        [lam, ((t + t.sin()) / PI).clamp(-1.0, 1.0).asin()]
    }
}

/// Robinson, on the sphere of the semi-major axis: PROJ's robin, cubics through Robinson's table
/// of lengths of parallels (`X`) and distances from the equator (`Y`) every 5°, their coefficients
/// in single precision as PROJ keeps them.
#[derive(Debug)]
pub struct Robin {
    a: f64,
}

#[rustfmt::skip]
const ROBIN_X: [[f32; 4]; 19] = [
    [1.0, 2.2199e-17, -7.15515e-05, 3.1103e-06],
    [0.9986, -0.000482243, -2.4897e-05, -1.3309e-06],
    [0.9954, -0.00083103, -4.48605e-05, -9.86701e-07],
    [0.99, -0.00135364, -5.9661e-05, 3.6777e-06],
    [0.9822, -0.00167442, -4.49547e-06, -5.72411e-06],
    [0.973, -0.00214868, -9.03571e-05, 1.8736e-08],
    [0.96, -0.00305085, -9.00761e-05, 1.64917e-06],
    [0.9427, -0.00382792, -6.53386e-05, -2.6154e-06],
    [0.9216, -0.00467746, -0.00010457, 4.81243e-06],
    [0.8962, -0.00536223, -3.23831e-05, -5.43432e-06],
    [0.8679, -0.00609363, -0.000113898, 3.32484e-06],
    [0.835, -0.00698325, -6.40253e-05, 9.34959e-07],
    [0.7986, -0.00755338, -5.00009e-05, 9.35324e-07],
    [0.7597, -0.00798324, -3.5971e-05, -2.27626e-06],
    [0.7186, -0.00851367, -7.01149e-05, -8.6303e-06],
    [0.6732, -0.00986209, -0.000199569, 1.91974e-05],
    [0.6213, -0.010418, 8.83923e-05, 6.24051e-06],
    [0.5722, -0.00906601, 0.000182, 6.24051e-06],
    [0.5322, -0.00677797, 0.000275608, 6.24051e-06],
];
#[rustfmt::skip]
const ROBIN_Y: [[f32; 4]; 19] = [
    [-5.20417e-18, 0.0124, 1.21431e-18, -8.45284e-11],
    [0.062, 0.0124, -1.26793e-09, 4.22642e-10],
    [0.124, 0.0124, 5.07171e-09, -1.60604e-09],
    [0.186, 0.0123999, -1.90189e-08, 6.00152e-09],
    [0.248, 0.0124002, 7.10039e-08, -2.24e-08],
    [0.31, 0.0123992, -2.64997e-07, 8.35986e-08],
    [0.372, 0.0124029, 9.88983e-07, -3.11994e-07],
    [0.434, 0.0123893, -3.69093e-06, -4.35621e-07],
    [0.4958, 0.0123198, -1.02252e-05, -3.45523e-07],
    [0.5571, 0.0121916, -1.54081e-05, -5.82288e-07],
    [0.6176, 0.0119938, -2.41424e-05, -5.25327e-07],
    [0.6769, 0.011713, -3.20223e-05, -5.16405e-07],
    [0.7346, 0.0113541, -3.97684e-05, -6.09052e-07],
    [0.7903, 0.0109107, -4.89042e-05, -1.04739e-06],
    [0.8435, 0.0103431, -6.4615e-05, -1.40374e-09],
    [0.8936, 0.00969686, -6.4636e-05, -8.547e-06],
    [0.9394, 0.00840947, -0.000192841, -4.2106e-06],
    [0.9761, 0.00616527, -0.000256, -4.2106e-06],
    [1.0, 0.00328947, -0.000319159, -4.2106e-06],
];
const ROBIN_FXC: f64 = 0.8487;
const ROBIN_FYC: f64 = 1.3523;

/// A table cubic at `z` degrees into its 5° interval, and its derivative.
fn robin_v(c: &[f32; 4], z: f64) -> f64 {
    let c = c.map(f64::from);
    c[0] + z * (c[1] + z * (c[2] + z * c[3]))
}
fn robin_dv(c: &[f32; 4], z: f64) -> f64 {
    let c = c.map(f64::from);
    c[1] + 2.0 * z * c[2] + z * z * 3.0 * c[3]
}

impl Robin {
    fn forward(&self, lam: f64, phi: f64) -> [f64; 2] {
        // The 5° interval (5° = 0.0872… rad).
        let i = ((phi.abs() * 11.459_155_902_616_464 + 1e-15).floor() as usize).min(18);
        let z = (phi.abs() - 0.087_266_462_599_716_48 * i as f64).to_degrees();
        let y = robin_v(&ROBIN_Y[i], z) * ROBIN_FYC;
        [self.a * robin_v(&ROBIN_X[i], z) * ROBIN_FXC * lam, self.a * y.copysign(phi)]
    }
    fn inverse(&self, [x, y]: [f64; 2]) -> [f64; 2] {
        let lam = x / self.a / ROBIN_FXC;
        let p = (y / self.a / ROBIN_FYC).abs();
        let (phi, lam) = if p >= 1.0 {
            if p > 1.000001 {
                return [f64::NAN; 2];
            }
            (FRAC_PI_2, lam / f64::from(ROBIN_X[18][0]))
        } else {
            // The table interval, then Newton's method from a linear guess within it.
            let mut i = ((p * 18.0).floor() as usize).min(17);
            let y0 = |i: usize| f64::from(ROBIN_Y[i][0]);
            while y0(i) > p {
                i -= 1;
            }
            while y0(i + 1) <= p {
                i += 1;
            }
            let c = &ROBIN_Y[i];
            let mut t = 5.0 * (p - y0(i)) / (y0(i + 1) - y0(i));
            for _ in 0..100 {
                let d = (robin_v(c, t) - p) / robin_dv(c, t);
                t -= d;
                if d.abs() < 1e-10 {
                    break;
                }
            }
            ((5.0 * i as f64 + t).to_radians(), lam / robin_v(&ROBIN_X[i], t))
        };
        // Past the outline.
        if lam.abs() > PI + 1e-9 {
            return [f64::NAN; 2];
        }
        [lam, phi.copysign(y)]
    }
}

/// Meridian arc length from the equator: Helmert's series in the third flattening to n⁴ (well
/// under a micrometre on the Earth), and its inverse.
#[derive(Debug, Clone, Copy)]
struct Meridian {
    /// The rectifying radius.
    r: f64,
    fwd: [f64; 4],
    inv: [f64; 4],
}

impl Meridian {
    fn new(el: Ellipsoid) -> Meridian {
        let f = 1.0 - (1.0 - el.e * el.e).sqrt();
        let n = f / (2.0 - f);
        let [n2, n3, n4] = [n * n, n.powi(3), n.powi(4)];
        Meridian {
            r: el.a / (1.0 + n) * (1.0 + n2 / 4.0 + n4 / 64.0),
            fwd: [
                -1.5 * n + 9.0 * n3 / 16.0,
                15.0 * n2 / 16.0 - 15.0 * n4 / 32.0,
                -35.0 * n3 / 48.0,
                315.0 * n4 / 512.0,
            ],
            inv: [
                1.5 * n - 27.0 * n3 / 32.0,
                21.0 * n2 / 16.0 - 55.0 * n4 / 32.0,
                151.0 * n3 / 96.0,
                1097.0 * n4 / 512.0,
            ],
        }
    }
    fn series(c: &[f64; 4], x: f64) -> f64 {
        x + c.iter().enumerate().map(|(k, c)| c * (2.0 * (k + 1) as f64 * x).sin()).sum::<f64>()
    }
    fn arc(&self, phi: f64) -> f64 {
        self.r * Self::series(&self.fwd, phi)
    }
    fn phi(&self, arc: f64) -> f64 {
        Self::series(&self.inv, arc / self.r)
    }
}

/// Sinusoidal on the ellipsoid (true parallels and central meridian), as PROJ's sinu.
#[derive(Debug)]
pub struct Sinu {
    el: Ellipsoid,
    m: Meridian,
}

impl Sinu {
    fn forward(&self, lam: f64, phi: f64) -> [f64; 2] {
        let (s, c) = phi.sin_cos();
        [self.el.a * lam * c / (1.0 - (self.el.e * s).powi(2)).sqrt(), self.m.arc(phi)]
    }
    fn inverse(&self, [x, y]: [f64; 2]) -> [f64; 2] {
        let phi = self.m.phi(y);
        if phi.abs() > FRAC_PI_2 + 1e-10 {
            return [f64::NAN; 2];
        }
        let lam = if phi.abs() < FRAC_PI_2 {
            x * (1.0 - (self.el.e * phi.sin()).powi(2)).sqrt() / (self.el.a * phi.cos())
        } else {
            0.0
        };
        // Past the outline.
        if lam.abs() > PI + 1e-9 {
            return [f64::NAN; 2];
        }
        [lam, phi.clamp(-FRAC_PI_2, FRAC_PI_2)]
    }
}

/// Krovak, north orientated (EPSG's 1041, PROJ's krovak): a Lambert conic on the Gauss conformal
/// sphere in an oblique aspect. The false origin applies after the axes are turned to east and
/// north, as in PROJ (both are 0 in S-JTSK).
#[derive(Debug)]
pub struct Krovak {
    e: f64,
    b: f64,
    t0: f64,
    /// sin and cos of the co-latitude of the cone axis.
    sin_a: f64,
    cos_a: f64,
    /// sin of the pseudo standard parallel, `tan^n(π/4 + φP/2)`, and r₀.
    n: f64,
    tan_p: f64,
    r0: f64,
}

impl Krovak {
    fn new(el: Ellipsoid, lat_0: f64, alpha: f64, lat_ts: f64, k_0: f64) -> Krovak {
        let (phi_c, phi_p) = (lat_0.to_radians(), lat_ts.to_radians());
        let (e, es) = (el.e, el.e * el.e);
        let sc = phi_c.sin();
        let a = el.a * (1.0 - es).sqrt() / (1.0 - es * sc * sc);
        let b = (1.0 + es * phi_c.cos().powi(4) / (1.0 - es)).sqrt();
        let g0 = (sc / b).asin();
        let t0 = (FRAC_PI_4 + g0 / 2.0).tan() * ((1.0 + e * sc) / (1.0 - e * sc)).powf(e * b / 2.0)
            / (FRAC_PI_4 + phi_c / 2.0).tan().powf(b);
        let n = phi_p.sin();
        let (sin_a, cos_a) = alpha.to_radians().sin_cos();
        let tan_p = (FRAC_PI_4 + phi_p / 2.0).tan().powf(n);
        Krovak { e, b, t0, sin_a, cos_a, n, tan_p, r0: k_0 * a / phi_p.tan() }
    }
    fn forward(&self, lam: f64, phi: f64) -> [f64; 2] {
        let es = self.e * phi.sin();
        let u = 2.0
            * ((self.t0 * (phi / 2.0 + FRAC_PI_4).tan().powf(self.b)
                / ((1.0 + es) / (1.0 - es)).powf(self.e * self.b / 2.0))
            .atan()
                - FRAC_PI_4);
        let v = -self.b * lam;
        let t = (self.cos_a * u.sin() + self.sin_a * u.cos() * v.cos()).asin();
        let d = (u.cos() * v.sin() / t.cos()).asin();
        let theta = self.n * d;
        let r = self.r0 * self.tan_p / (t / 2.0 + FRAC_PI_4).tan().powf(self.n);
        // Southing and westing, turned to easting and northing.
        [-r * theta.sin(), -r * theta.cos()]
    }
    fn inverse(&self, [x, y]: [f64; 2]) -> [f64; 2] {
        let (xp, yp) = (-y, -x);
        let r = hypot(xp, yp);
        let d = yp.atan2(xp) / self.n;
        let t = 2.0 * (((self.r0 / r).powf(1.0 / self.n) * self.tan_p.powf(1.0 / self.n)).atan() - FRAC_PI_4);
        let u = (self.cos_a * t.sin() - self.sin_a * t.cos() * d.cos()).asin();
        let v = (t.cos() * d.sin() / u.cos()).asin();
        let k = self.t0.powf(-1.0 / self.b) * (u / 2.0 + FRAC_PI_4).tan().powf(1.0 / self.b);
        let mut phi = u;
        for _ in 0..30 {
            let es = self.e * phi.sin();
            let next = 2.0 * ((k * ((1.0 + es) / (1.0 - es)).powf(self.e / 2.0)).atan() - FRAC_PI_4);
            let done = (next - phi).abs() < 1e-14;
            phi = next;
            if done {
                break;
            }
        }
        [-v / self.b, phi]
    }
}

/// Cassini-Soldner (EPSG's series on the ellipsoid, exact on the sphere), as PROJ's cass. A local
/// projection: the series diverge far from the central meridian.
#[derive(Debug)]
pub struct Cass {
    el: Ellipsoid,
    m: Meridian,
    phi0: f64,
    /// Meridian arc to the origin's latitude.
    m0: f64,
}

impl Cass {
    fn new(el: Ellipsoid, lat_0: f64) -> Cass {
        let (m, phi0) = (Meridian::new(el), lat_0.to_radians());
        Cass { el, m, phi0, m0: m.arc(phi0) }
    }
    fn forward(&self, lam: f64, phi: f64) -> [f64; 2] {
        let a = self.el.a;
        if self.el.e == 0.0 {
            let x = (phi.cos() * lam.sin()).asin();
            return [a * x, a * (phi.tan().atan2(lam.cos()) - self.phi0)];
        }
        let es = self.el.e * self.el.e;
        let (s, c) = phi.sin_cos();
        let nu = a / (1.0 - es * s * s).sqrt();
        let tn = phi.tan();
        let t = tn * tn;
        let aa = lam * c;
        let cc = es * c * c / (1.0 - es);
        let a2 = aa * aa;
        [
            nu * aa * (1.0 - a2 * t * (1.0 / 6.0 + (8.0 - t + 8.0 * cc) * a2 / 120.0)),
            self.m.arc(phi) - self.m0 + nu * tn * a2 * (0.5 + (5.0 - t + 6.0 * cc) * a2 / 24.0),
        ]
    }
    fn inverse(&self, [x, y]: [f64; 2]) -> [f64; 2] {
        let a = self.el.a;
        if self.el.e == 0.0 {
            let (x, d) = (x / a, y / a + self.phi0);
            return [x.tan().atan2(d.cos()), (d.sin() * x.cos()).asin()];
        }
        let es = self.el.e * self.el.e;
        let phi1 = self.m.phi(self.m0 + y);
        let tn = phi1.tan();
        let t = tn * tn;
        let s = phi1.sin();
        let w = 1.0 - es * s * s;
        let nu = a / w.sqrt();
        let rho = a * (1.0 - es) / (w * w.sqrt());
        let d = x / nu;
        let d2 = d * d;
        [
            d * (1.0 + t * d2 * (-1.0 / 3.0 + (1.0 + 3.0 * t) * d2 / 15.0)) / phi1.cos(),
            phi1 - nu * tn / rho * d2 * (0.5 - (1.0 + 3.0 * t) * d2 / 24.0),
        ]
    }
}

/// `(lam, phi)` whose `forward` is `xy`, by Newton's method from `guess` with a central-difference
/// Jacobian; NaN if it does not converge (e.g. outside the projection's outline). For methods
/// whose exact inverse is iterative anyway.
fn newton(forward: impl Fn(f64, f64) -> [f64; 2], xy: [f64; 2], tol: f64, mut g: [f64; 2]) -> [f64; 2] {
    const H: f64 = 1e-7;
    for _ in 0..40 {
        let f = forward(g[0], g[1]);
        let r = [f[0] - xy[0], f[1] - xy[1]];
        if !(r[0].is_finite() && r[1].is_finite()) {
            break;
        }
        if r[0].abs().max(r[1].abs()) <= tol {
            return g;
        }
        let d = |a: [f64; 2], b: [f64; 2]| [(a[0] - b[0]) / (2.0 * H), (a[1] - b[1]) / (2.0 * H)];
        let jl = d(forward(g[0] + H, g[1]), forward(g[0] - H, g[1]));
        let jp = d(forward(g[0], g[1] + H), forward(g[0], g[1] - H));
        let det = jl[0] * jp[1] - jp[0] * jl[1];
        if det == 0.0 || !det.is_finite() {
            break;
        }
        g[0] -= (r[0] * jp[1] - r[1] * jp[0]) / det;
        g[1] -= (jl[0] * r[1] - jl[1] * r[0]) / det;
        g[1] = g[1].clamp(-FRAC_PI_2, FRAC_PI_2);
    }
    [f64::NAN; 2]
}

/// NaN outside `[-π, π]` longitudes: the outline of a world map.
fn within_outline([lam, phi]: [f64; 2]) -> [f64; 2] {
    if lam.abs() <= PI + 1e-9 && phi.abs() <= FRAC_PI_2 + 1e-9 { [lam, phi] } else { [f64::NAN; 2] }
}

/// Equidistant conic, Snyder ch. 16.
#[derive(Debug)]
pub struct Eqdc {
    m: Meridian,
    n: f64,
    /// a·G of Snyder, and ρ₀.
    ag: f64,
    rho0: f64,
}

impl Eqdc {
    fn new(el: Ellipsoid, lat_0: f64, lat_1: f64, lat_2: f64) -> Eqdc {
        let [phi0, phi1, phi2] = [lat_0, lat_1, lat_2].map(f64::to_radians);
        let m = Meridian::new(el);
        let m1 = el.m(phi1);
        let n = if (phi1 - phi2).abs() > 1e-10 {
            el.a * (m1 - el.m(phi2)) / (m.arc(phi2) - m.arc(phi1))
        } else {
            phi1.sin()
        };
        let ag = el.a * m1 / n + m.arc(phi1);
        Eqdc { m, n, ag, rho0: ag - m.arc(phi0) }
    }
    fn forward(&self, lam: f64, phi: f64) -> [f64; 2] {
        let rho = self.ag - self.m.arc(phi);
        let theta = self.n * lam;
        [rho * theta.sin(), self.rho0 - rho * theta.cos()]
    }
    fn inverse(&self, [x, y]: [f64; 2]) -> [f64; 2] {
        let dy = self.rho0 - y;
        let s = self.n.signum();
        let rho = s * hypot(x, dy);
        let theta = (s * x).atan2(s * dy);
        let phi = self.m.phi(self.ag - rho);
        if (theta / self.n).abs() > PI || phi.abs() > FRAC_PI_2 {
            return [f64::NAN; 2];
        }
        [theta / self.n, phi]
    }
}

/// American polyconic, Snyder ch. 18 (as PROJ).
#[derive(Debug)]
pub struct Poly {
    el: Ellipsoid,
    m: Meridian,
    m0: f64,
}

impl Poly {
    fn new(el: Ellipsoid, lat_0: f64) -> Poly {
        let m = Meridian::new(el);
        Poly { el, m, m0: m.arc(lat_0.to_radians()) }
    }
    fn forward(&self, lam: f64, phi: f64) -> [f64; 2] {
        if phi.abs() <= 1e-10 {
            return [self.el.a * lam, -self.m0];
        }
        let s = phi.sin();
        // ν·cot φ: the radius of the parallel's cone, over a.
        let ms = self.el.m(phi) / s;
        let e = lam * s;
        [self.el.a * ms * e.sin(), self.m.arc(phi) - self.m0 + self.el.a * ms * (1.0 - e.cos())]
    }
    fn inverse(&self, [x, y]: [f64; 2]) -> [f64; 2] {
        // Snyder 18-17 (in units of a), Newton's method on φ.
        let es = self.el.e * self.el.e;
        let (x, y) = (x / self.el.a, (y + self.m0) / self.el.a);
        if y.abs() <= 1e-10 {
            return [x, 0.0];
        }
        let r = x * x + y * y;
        let mut phi = y;
        for _ in 0..20 {
            let (s, c) = phi.sin_cos();
            let w = (1.0 - es * s * s).sqrt();
            let cc = s * w / c;
            let ml = self.m.arc(phi) / self.el.a;
            let mlb = ml * ml + r;
            let mlp = (1.0 - es) / w.powi(3);
            let d = (2.0 * ml + cc * mlb - 2.0 * y * (cc * ml + 1.0))
                / (es * s * c * (mlb - 2.0 * y * ml) / cc + 2.0 * (y - ml) * (cc * mlp - 1.0 / (s * c)) - 2.0 * mlp);
            phi += d;
            if !d.is_finite() {
                return [f64::NAN; 2];
            }
            if d.abs() <= 1e-12 {
                let s = phi.sin();
                return [(x * phi.tan() * (1.0 - es * s * s).sqrt()).asin() / s, phi];
            }
        }
        [f64::NAN; 2]
    }
}

/// Lambert cylindrical equal-area (Snyder ch. 10).
#[derive(Debug)]
pub struct Cea {
    el: Ellipsoid,
    k0: f64,
    qp: f64,
}

impl Cea {
    fn new(el: Ellipsoid, lat_ts: f64) -> Cea {
        Cea { el, k0: el.m(lat_ts.to_radians()), qp: el.q(FRAC_PI_2) }
    }
    fn forward(&self, lam: f64, phi: f64) -> [f64; 2] {
        [self.el.a * self.k0 * lam, self.el.a * self.el.q(phi) / (2.0 * self.k0)]
    }
    fn inverse(&self, [x, y]: [f64; 2]) -> [f64; 2] {
        let q = 2.0 * self.k0 * y / self.el.a;
        if q.abs() > self.qp + 1e-12 {
            return [f64::NAN; 2];
        }
        [x / (self.el.a * self.k0), self.el.phi_from_q(q.clamp(-self.qp, self.qp))]
    }
}

/// Natural Earth, spherical (PROJ's natearth).
#[derive(Debug)]
pub struct NatEarth {
    a: f64,
}

const NE_A: [f64; 5] = [0.8707, -0.131979, -0.013791, 0.003971, -0.001529];
const NE_B: [f64; 5] = [1.007226, 0.015085, -0.044475, 0.028874, -0.005916];

impl NatEarth {
    fn x_scale(phi: f64) -> f64 {
        let [a0, a1, a2, a3, a4] = NE_A;
        let p2 = phi * phi;
        a0 + p2 * (a1 + p2 * (a2 + p2 * p2 * p2 * (a3 + p2 * a4)))
    }
    /// y and dy/dφ.
    fn y(phi: f64) -> (f64, f64) {
        let [b0, b1, b2, b3, b4] = NE_B;
        let (p2, p4) = (phi * phi, phi.powi(4));
        (
            phi * (b0 + p2 * (b1 + p4 * (b2 + b3 * p2 + b4 * p4))),
            b0 + p2 * (3.0 * b1 + p4 * (7.0 * b2 + 9.0 * b3 * p2 + 11.0 * b4 * p4)),
        )
    }
    fn forward(&self, lam: f64, phi: f64) -> [f64; 2] {
        [self.a * lam * Self::x_scale(phi), self.a * Self::y(phi).0]
    }
    fn inverse(&self, [x, y]: [f64; 2]) -> [f64; 2] {
        let y = y / self.a;
        if y.abs() > Self::y(FRAC_PI_2).0 + 1e-12 {
            return [f64::NAN; 2];
        }
        let mut phi = y;
        for _ in 0..30 {
            let (f, d) = Self::y(phi);
            let step = (f - y) / d;
            phi -= step;
            if step.abs() < 1e-14 {
                break;
            }
        }
        within_outline([x / (self.a * Self::x_scale(phi)), phi])
    }
}

/// Winkel tripel, spherical (PROJ's wintri).
#[derive(Debug)]
pub struct Wintri {
    a: f64,
    cos_phi1: f64,
}

impl Wintri {
    fn unit(&self, lam: f64, phi: f64) -> [f64; 2] {
        let c = 0.5 * lam;
        let d = (phi.cos() * c.cos()).clamp(-1.0, 1.0).acos();
        let [x, y] = if d != 0.0 {
            let k = d / d.sin();
            [2.0 * k * phi.cos() * c.sin(), k * phi.sin()]
        } else {
            [0.0, 0.0]
        };
        [0.5 * (x + lam * self.cos_phi1), 0.5 * (y + phi)]
    }
    fn forward(&self, lam: f64, phi: f64) -> [f64; 2] {
        self.unit(lam, phi).map(|v| v * self.a)
    }
    fn inverse(&self, [x, y]: [f64; 2]) -> [f64; 2] {
        let xy = [x / self.a, y / self.a];
        let guess = [xy[0] / (0.5 * (1.0 + self.cos_phi1)), xy[1].clamp(-FRAC_PI_2, FRAC_PI_2)];
        within_outline(newton(|l, p| self.unit(l, p), xy, 1e-14, guess))
    }
}

/// Miller cylindrical, spherical.
#[derive(Debug)]
pub struct Mill {
    a: f64,
}

impl Mill {
    fn forward(&self, lam: f64, phi: f64) -> [f64; 2] {
        [self.a * lam, self.a * 1.25 * (FRAC_PI_4 + 0.4 * phi).tan().ln()]
    }
    fn inverse(&self, [x, y]: [f64; 2]) -> [f64; 2] {
        let phi = 2.5 * ((0.8 * y / self.a).exp().atan() - FRAC_PI_4);
        [x / self.a, if phi.abs() <= FRAC_PI_2 { phi } else { f64::NAN }]
    }
}

/// An EPSG conversion method: code, name, PROJ name, parameters as (code, PROJ key).
type MethodDef = (u64, &'static str, &'static str, &'static [(u64, &'static str)]);

const CYLINDRICAL: &[(u64, &str)] = &[(8801, "lat_0"), (8823, "lat_ts"), (8802, "lon_0"), (8806, "x_0"), (8807, "y_0")];

const METHODS: &[MethodDef] = &[
    (
        9807,
        "Transverse Mercator",
        "tmerc",
        &[(8801, "lat_0"), (8802, "lon_0"), (8805, "k_0"), (8806, "x_0"), (8807, "y_0")],
    ),
    (
        9804,
        "Mercator (variant A)",
        "merc",
        &[(8801, "lat_0"), (8802, "lon_0"), (8805, "k_0"), (8806, "x_0"), (8807, "y_0")],
    ),
    (9805, "Mercator (variant B)", "merc", &[(8823, "lat_ts"), (8802, "lon_0"), (8806, "x_0"), (8807, "y_0")]),
    (
        1024,
        "Popular Visualisation Pseudo Mercator",
        "webmerc",
        &[(8801, "lat_0"), (8802, "lon_0"), (8806, "x_0"), (8807, "y_0")],
    ),
    (
        9801,
        "Lambert Conic Conformal (1SP)",
        "lcc",
        &[(8801, "lat_0"), (8802, "lon_0"), (8805, "k_0"), (8806, "x_0"), (8807, "y_0")],
    ),
    (
        9802,
        "Lambert Conic Conformal (2SP)",
        "lcc",
        &[(8821, "lat_0"), (8822, "lon_0"), (8823, "lat_1"), (8824, "lat_2"), (8826, "x_0"), (8827, "y_0")],
    ),
    (9820, "Lambert Azimuthal Equal Area", "laea", &[(8801, "lat_0"), (8802, "lon_0"), (8806, "x_0"), (8807, "y_0")]),
    (
        9810,
        "Polar Stereographic (variant A)",
        "stere",
        &[(8801, "lat_0"), (8802, "lon_0"), (8805, "k_0"), (8806, "x_0"), (8807, "y_0")],
    ),
    (
        9829,
        "Polar Stereographic (variant B)",
        "stere",
        &[(8832, "lat_ts"), (8833, "lon_0"), (8806, "x_0"), (8807, "y_0")],
    ),
    (1078, "Equal Earth", "eqearth", &[(8802, "lon_0"), (8806, "x_0"), (8807, "y_0")]),
    (
        9822,
        "Albers Equal Area",
        "aea",
        &[(8821, "lat_0"), (8822, "lon_0"), (8823, "lat_1"), (8824, "lat_2"), (8826, "x_0"), (8827, "y_0")],
    ),
    (
        9809,
        "Oblique Stereographic",
        "sterea",
        &[(8801, "lat_0"), (8802, "lon_0"), (8805, "k_0"), (8806, "x_0"), (8807, "y_0")],
    ),
    (
        9812,
        "Hotine Oblique Mercator (variant A)",
        "omerc +no_uoff",
        &[
            (8811, "lat_0"),
            (8812, "lonc"),
            (8813, "alpha"),
            (8814, "gamma"),
            (8815, "k_0"),
            (8806, "x_0"),
            (8807, "y_0"),
        ],
    ),
    (
        9815,
        "Hotine Oblique Mercator (variant B)",
        "omerc",
        &[
            (8811, "lat_0"),
            (8812, "lonc"),
            (8813, "alpha"),
            (8814, "gamma"),
            (8815, "k_0"),
            (8816, "x_0"),
            (8817, "y_0"),
        ],
    ),
    (1028, "Equidistant Cylindrical", "eqc", CYLINDRICAL),
    (1029, "Equidistant Cylindrical (Spherical)", "eqc +R_A", CYLINDRICAL),
    (1125, "Azimuthal Equidistant", "aeqd", &[(8801, "lat_0"), (8802, "lon_0"), (8806, "x_0"), (8807, "y_0")]),
    (9840, "Orthographic", "ortho", &[(8801, "lat_0"), (8802, "lon_0"), (8806, "x_0"), (8807, "y_0")]),
    (
        1041,
        "Krovak (North Orientated)",
        "krovak",
        &[
            (8811, "lat_0"),
            (8833, "lon_0"),
            (1036, "alpha"),
            (8818, "lat_ts"),
            (8819, "k_0"),
            (8806, "x_0"),
            (8807, "y_0"),
        ],
    ),
    (9806, "Cassini-Soldner", "cass", &[(8801, "lat_0"), (8802, "lon_0"), (8806, "x_0"), (8807, "y_0")]),
    (
        1027,
        "Lambert Azimuthal Equal Area (Spherical)",
        "laea +R_A",
        &[(8801, "lat_0"), (8802, "lon_0"), (8806, "x_0"), (8807, "y_0")],
    ),
    (
        1119,
        "Equidistant Conic",
        "eqdc",
        &[(8821, "lat_0"), (8822, "lon_0"), (8823, "lat_1"), (8824, "lat_2"), (8826, "x_0"), (8827, "y_0")],
    ),
    (9818, "American Polyconic", "poly", &[(8801, "lat_0"), (8802, "lon_0"), (8806, "x_0"), (8807, "y_0")]),
    (9835, "Lambert Cylindrical Equal Area", "cea", CYLINDRICAL),
    (9834, "Lambert Cylindrical Equal Area (Spherical)", "cea +R_A", CYLINDRICAL),
    (9823, "Equidistant Cylindrical (Spherical)", "eqc", CYLINDRICAL),
    // PROJ's own methods and parameters, without EPSG codes (0: matched by name).
    (0, "Mollweide", "moll", &[(8802, "lon_0"), (8806, "x_0"), (8807, "y_0")]),
    (0, "Robinson", "robin", &[(8802, "lon_0"), (8806, "x_0"), (8807, "y_0")]),
    (0, "Sinusoidal", "sinu", &[(8802, "lon_0"), (8806, "x_0"), (8807, "y_0")]),
    (0, "Natural Earth", "natearth", &[(8802, "lon_0"), (8806, "x_0"), (8807, "y_0")]),
    (0, "Miller Cylindrical", "mill +R_A", &[(8802, "lon_0"), (8806, "x_0"), (8807, "y_0")]),
    (0, "Winkel Tripel", "wintri", &[(8802, "lon_0"), (8823, "lat_1"), (8806, "x_0"), (8807, "y_0")]),
    (
        0,
        "Geostationary Satellite (Sweep X)",
        "geos +sweep=x",
        &[(8801, "lat_0"), (8802, "lon_0"), (0, "h"), (8806, "x_0"), (8807, "y_0")],
    ),
    (
        0,
        "Geostationary Satellite (Sweep Y)",
        "geos +sweep=y",
        &[(8801, "lat_0"), (8802, "lon_0"), (0, "h"), (8806, "x_0"), (8807, "y_0")],
    ),
];

/// EPSG parameter names, for parameters without an `id`.
const PARAMETER_NAMES: &[(u64, &str)] = &[
    (8801, "Latitude of natural origin"),
    (8802, "Longitude of natural origin"),
    (8805, "Scale factor at natural origin"),
    (8806, "False easting"),
    (8807, "False northing"),
    (8811, "Latitude of projection centre"),
    (8812, "Longitude of projection centre"),
    (8813, "Azimuth at projection centre"),
    (8813, "Azimuth of initial line"),
    (8814, "Angle from Rectified to Skew Grid"),
    (8815, "Scale factor at projection centre"),
    (8815, "Scale factor on initial line"),
    (8816, "Easting at projection centre"),
    (8817, "Northing at projection centre"),
    (8818, "Latitude of pseudo standard parallel"),
    (8819, "Scale factor on pseudo standard parallel"),
    (1036, "Co-latitude of cone axis"),
    (8821, "Latitude of false origin"),
    (8822, "Longitude of false origin"),
    (8823, "Latitude of 1st standard parallel"),
    (8824, "Latitude of 2nd standard parallel"),
    (8826, "Easting at false origin"),
    (8827, "Northing at false origin"),
    (8832, "Latitude of standard parallel"),
    (8833, "Longitude of origin"),
    (0, "Satellite Height"),
];

/// A PROJJSON value in its `unit` as degrees (angles) or metres (lengths).
fn in_unit(value: f64, unit: &J) -> Result<f64, Error> {
    Ok(match unit {
        J::Null => value,
        J::String(u) if matches!(u.as_str(), "degree" | "metre" | "unity") => value,
        u if u["type"] == "AngularUnit" => (value * u["conversion_factor"].as_f64().unwrap_or(f64::NAN)).to_degrees(),
        u if u["conversion_factor"].is_f64() || u["conversion_factor"].is_u64() => {
            value * u["conversion_factor"].as_f64().unwrap_or(1.0)
        }
        u => return Err(unsupported(format!("unit {u}"))),
    })
}

/// A PROJJSON geographic or projected CRS as the PROJ string `Projection::from_proj_string` takes.
/// Of a bound CRS, its source CRS (the datum shift is ignored); of a compound CRS, its horizontal
/// part.
fn proj_string(mut crs: &J) -> Result<String, Error> {
    loop {
        crs = match crs["type"].as_str() {
            Some("BoundCRS") => &crs["source_crs"],
            Some("CompoundCRS") => &crs["components"][0],
            _ => break,
        };
    }
    let (base, conversion) = match crs["type"].as_str() {
        Some("GeographicCRS") => (crs, None),
        Some("ProjectedCRS") => (&crs["base_crs"], Some(&crs["conversion"])),
        t => {
            return Err(unsupported(format!("PROJJSON type {}", t.unwrap_or("(none)"))));
        }
    };
    let datum = if base["datum"].is_object() { &base["datum"] } else { &base["datum_ensemble"] };
    let pm = match &datum["prime_meridian"]["longitude"] {
        J::Null => 0.0,
        J::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        l => in_unit(l["value"].as_f64().unwrap_or(f64::NAN), &l["unit"])?,
    };
    let el = &datum["ellipsoid"];
    // Lengths in metres, or with their unit.
    let len = |v: &J| v.as_f64().or_else(|| in_unit(v["value"].as_f64()?, &v["unit"]).ok());
    let ellipsoid = match (
        len(&el["radius"]),
        len(&el["semi_major_axis"]),
        el["inverse_flattening"].as_f64(),
        len(&el["semi_minor_axis"]),
    ) {
        (Some(r), ..) => format!("+R={r}"),
        (_, Some(a), Some(rf), _) => format!("+a={a} +rf={rf}"),
        (_, Some(a), _, Some(b)) => format!("+a={a} +b={b}"),
        _ => return Err(unsupported("PROJJSON without an ellipsoid")),
    };
    let Some(conversion) = conversion else {
        // ponytail: geographic longitudes are taken as from Greenwich, in degrees; a CRS that
        // measures them otherwise (e.g. NTF (Paris), in grads) is refused.
        if pm != 0.0 {
            return Err(unsupported("geographic CRS with a prime meridian other than Greenwich"));
        }
        return Ok(format!("+proj=longlat {ellipsoid}"));
    };
    // Metres per unit of the axes, which share it.
    let mut to_meter = None;
    for axis in crs["coordinate_system"]["axis"].as_array().into_iter().flatten() {
        let unit = &axis["unit"];
        let f = if unit.is_null() || unit == "metre" { Some(1.0) } else { unit["conversion_factor"].as_f64() };
        match (f, to_meter) {
            (Some(f), None) => to_meter = Some(f),
            (Some(f), Some(t)) if f == t => {}
            _ => return Err(unsupported(format!("axis unit {unit}"))),
        }
    }
    let method = &conversion["method"];
    let name = method["name"].as_str().unwrap_or_default();
    let &(_, _, proj, keys) = METHODS
        .iter()
        .find(|m| method["id"]["code"].as_u64().filter(|_| m.0 != 0).map_or(m.1 == name, |c| c == m.0))
        .ok_or_else(|| unsupported(format!("conversion method {name}")))?;
    let mut out = format!("+proj={proj} {ellipsoid}");
    if pm != 0.0 {
        out += &format!(" +pm={pm}");
    }
    if let Some(f) = to_meter.filter(|&f| f != 1.0) {
        out += &format!(" +to_meter={f}");
    }
    for p in conversion["parameters"].as_array().into_iter().flatten() {
        let pname = p["name"].as_str().unwrap_or_default();
        let code = p["id"]["code"].as_u64().or_else(|| PARAMETER_NAMES.iter().find(|n| n.1 == pname).map(|n| n.0));
        let key = keys
            .iter()
            .find(|k| Some(k.0) == code)
            .ok_or_else(|| unsupported(format!("parameter {pname} of {name}")))?
            .1;
        let value = p["value"].as_f64().ok_or_else(|| unsupported(format!("parameter {pname}")))?;
        out += &format!(" +{key}={}", in_unit(value, &p["unit"])?);
    }
    Ok(out)
}

/// PROJJSON for tests.
#[cfg(test)]
pub(crate) mod test_crs {
    /// PROJJSON ellipsoid members.
    pub const WGS84: &str = r#""semi_major_axis":6378137,"inverse_flattening":298.257223563"#;
    pub const GRS80: &str = r#""semi_major_axis":6378137,"inverse_flattening":298.257222101"#;
    pub const HIMAWARI: &str = r#""semi_major_axis":6378137,"semi_minor_axis":6356752.3"#;

    /// WGS 84 longitude/latitude.
    pub fn geographic() -> String {
        format!(r#"{{"type":"GeographicCRS","datum":{{"ellipsoid":{{{WGS84}}}}}}}"#)
    }

    /// A projected CRS by `method` name, its parameters by EPSG name, in degrees and metres.
    pub fn projected(method: &str, ellipsoid: &str, params: &[(&str, f64)]) -> String {
        let params: Vec<String> =
            params.iter().map(|(name, value)| format!(r#"{{"name":"{name}","value":{value}}}"#)).collect();
        format!(
            r#"{{"type":"ProjectedCRS","base_crs":{{"datum":{{"ellipsoid":{{{ellipsoid}}}}}}},"conversion":{{"method":{{"name":"{method}"}},"parameters":[{}]}}}}"#,
            params.join(",")
        )
    }

    /// Himawari's full disk.
    pub fn himawari() -> String {
        projected(
            "Geostationary Satellite (Sweep Y)",
            HIMAWARI,
            &[("Longitude of natural origin", 140.7), ("Satellite Height", 35785863.0)],
        )
    }
}

#[cfg(test)]
mod tests {
    use super::test_crs::*;
    use super::*;

    fn close(a: [f64; 2], b: [f64; 2], tol: f64) -> bool {
        (a[0] - b[0]).abs() <= tol && (a[1] - b[1]).abs() <= tol
    }

    #[test]
    fn projections_match_proj4js_and_roundtrip() {
        // Reference values from proj4js 2.22.0 (`proj4('EPSG:4326', def).forward`).
        let cases: &[(&str, [f64; 2], [f64; 2])] = &[
            (
                "+proj=tmerc +lon_0=-81 +k_0=0.9996 +x_0=500000 +a=6378137 +rf=298.257223563",
                [-79.387139, 43.642567],
                [630084.3008341494, 4833438.585674324],
            ),
            (
                "+proj=tmerc +lat_0=36 +lon_0=139.833333333333 +k_0=0.9999 +x_0=0 +y_0=0 +a=6378137 +rf=298.257222101",
                [139.76, 35.68],
                [-6637.949198869096, -35499.90401395519],
            ),
            (
                "+proj=merc +lon_0=0 +k_0=1 +x_0=0 +y_0=0 +a=6378137 +rf=298.257223563",
                [139.76, 35.68],
                [15558012.033267912, 4231756.054513181],
            ),
            (
                "+proj=merc +lat_ts=30 +lon_0=100 +x_0=1000 +y_0=-500 +a=6378137 +rf=298.257223563",
                [120.5, -20.25],
                [1978968.7451433796, -1983529.347369561],
            ),
            (
                "+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k_0=1 +units=m +nadgrids=@null +wktext +no_defs",
                [139.76, 35.68],
                [15558012.033267912, 4256678.731903622],
            ),
            (
                "+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 +a=6378137 +rf=298.257222101 +units=m +no_defs",
                [2.35, 48.85],
                [652301.5648305281, 6861302.725899575],
            ),
            (
                "+proj=lcc +lat_1=35 +lat_0=35 +lon_0=135 +k_0=0.9999 +x_0=500000 +y_0=0 +a=6378137 +rf=298.257222101",
                [139.76, 35.68],
                [930730.4556511124, 85702.45477958511],
            ),
            (
                "+proj=lcc +lat_0=-32 +lon_0=-60 +lat_1=-20 +lat_2=-40 +x_0=0 +y_0=0 +a=6378137 +rf=298.257223563",
                [-58.4, -34.6],
                [144979.31136620985, -285470.0217958316],
            ),
            (
                "+proj=stere +lat_0=90 +lat_ts=70 +lon_0=-45 +k_0=1 +x_0=0 +y_0=0 +a=6378137 +rf=298.257223563 +units=m +no_defs",
                [-51.7, 64.2],
                [-331477.812219844, -2821736.128997682],
            ),
            (
                "+proj=stere +lat_0=-90 +lat_ts=-71 +lon_0=0 +k_0=1 +x_0=0 +y_0=0 +a=6378137 +rf=298.257223563 +units=m +no_defs",
                [166.67, -77.85],
                [305467.1627322748, -1289201.5377136339],
            ),
            (
                "+proj=stere +lat_0=90 +lon_0=0 +k_0=0.994 +x_0=2000000 +y_0=2000000 +a=6378137 +rf=298.257223563 +units=m +no_defs",
                [25.0, 78.2],
                [2555550.35298834, 808618.423324977],
            ),
            (
                "+proj=laea +lat_0=52 +lon_0=10 +x_0=4321000 +y_0=3210000 +a=6378137 +rf=298.257222101 +units=m +no_defs",
                [2.35, 48.85],
                [3760536.8229023204, 2888771.0209501884],
            ),
            (
                "+proj=laea +lat_0=90 +lon_0=-40 +x_0=0 +y_0=0 +a=6378137 +rf=298.257223563 +units=m +no_defs",
                [-51.7, 64.2],
                [-579072.5036568096, -2796235.3538357066],
            ),
            (
                "+proj=eqearth +lon_0=0 +x_0=0 +y_0=0 +a=6378137 +rf=298.257223563 +units=m +no_defs",
                [139.76, 35.68],
                [12179903.70918021, 4430861.430775947],
            ),
            ("+proj=eqearth +lon_0=150 +R=6371008.8", [-170.0, -70.0], [2600439.895258415, -7692885.397207941]),
            (
                "+proj=laea +lat_0=-90 +lon_0=0 +x_0=0 +y_0=0 +a=6378137 +rf=298.257223563 +units=m +no_defs",
                [-60.0, -75.0],
                [-1446478.9424851353, 835125.0068209183],
            ),
            (
                "+proj=laea +lat_0=-90 +lon_0=0 +x_0=0 +y_0=0 +a=6378137 +rf=298.257222101 +units=m",
                [166.67, -77.85],
                [312255.0815240369, -1317849.4462676693],
            ),
            (
                "+proj=laea +lat_0=0 +lon_0=0 +x_0=0 +y_0=0 +R=6371000 +units=m",
                [40.0, -30.0],
                [3888844.3587193084, -3492950.553975445],
            ),
            (
                "+proj=laea +lat_0=0 +lon_0=0 +x_0=0 +y_0=0 +a=6378137 +rf=298.257223563",
                [40.0, -30.0],
                [3896680.5516183116, -3476561.355509021],
            ),
            (
                "+proj=geos +h=35785863 +lon_0=140.7 +a=6378137 +b=6356752.3 +units=m +no_defs",
                [139.76, 35.68],
                [-82347.91997331403, 3568269.3634791635],
            ),
            (
                "+proj=geos +h=35785863 +lon_0=140.7 +a=6378137 +b=6356752.3 +units=m +no_defs",
                [100.0, -40.0],
                [-2962314.9709050534, -3767986.255491857],
            ),
            (
                "+proj=geos +h=35785863 +lon_0=140.7 +a=6378137 +b=6356752.3 +sweep=x +units=m +no_defs",
                [139.76, 35.68],
                [-81938.88936006774, 3568278.7483523316],
            ),
            (
                "+proj=geos +h=35785863 +lon_0=140.7 +a=6378137 +b=6356752.3 +sweep=x +units=m +no_defs",
                [100.0, -40.0],
                [-2945871.976800097, -3780837.030351118],
            ),
        ];
        for &(def, lnglat, xy) in cases {
            let p = Projection::from_proj_string(def).unwrap();
            let f = p.forward(lnglat[0], lnglat[1]);
            assert!(close(f, xy, 1e-3), "{def}: {lnglat:?} → {f:?}, expected {xy:?}");
            let i = p.inverse(xy).unwrap();
            assert!(close(i, lnglat, 1e-9), "{def}: {xy:?} → {i:?}, expected {lnglat:?}");
        }
        // Himawari's far side of the Earth.
        let geos = Projection::from_proj_string("+proj=geos +h=35785863 +lon_0=140.7 +a=6378137 +b=6356752.3").unwrap();
        assert!(geos.forward(-40.0, 0.0)[0].is_nan() && geos.inverse([6.0e6, 0.0]).is_none());
        // Krovak with southing and westing axes.
        assert!(Projection::parse(&projected("Krovak", WGS84, &[])).is_err());
        // Past the Equal Earth outline.
        assert!(
            Projection::from_proj_string("+proj=eqearth +a=6378137 +rf=298.257223563")
                .unwrap()
                .inverse([2.0e7, 0.0])
                .is_none()
        );
        // ±180° stay on their own edges, like PROJ; beyond them longitudes fold.
        let eqearth = Projection::from_proj_string("+proj=eqearth +a=6378137 +rf=298.257223563").unwrap();
        let [east, west] = [eqearth.forward(180.0, 60.0), eqearth.forward(-180.0, 60.0)];
        assert!(east[0] > 0.0 && east[0] == -west[0]);
        assert!(close(eqearth.forward(190.0, 60.0), eqearth.forward(-170.0, 60.0), 1e-6));
    }

    #[test]
    fn projections_match_proj_and_roundtrip() {
        // Reference values from PROJ 9.8.1 (pyproj's `Proj(def)`; longitudes from Greenwich). Off
        // Robinson's 5° nodes, where its table's cubics (and so PROJ's inverse) do not quite meet.
        let cases: &[(&str, [f64; 2], [f64; 2])] = &[
            (
                "+proj=lcc +lat_0=33.75 +lon_0=-79 +lat_1=36.1666666666667 +lat_2=34.3333333333333 +x_0=609601.219202438 +y_0=0 +a=6378137 +rf=298.257222101 +to_meter=0.304800609601219",
                [-78.64, 35.78],
                [2106778.0115409433, 739010.2627657467],
            ),
            (
                "+proj=lcc +lat_1=46.8 +lat_0=46.8 +lon_0=0 +k_0=0.99987742 +x_0=600000 +y_0=2200000 +a=6378249.2 +b=6356515 +pm=2.337229166666667",
                [2.35, 48.85],
                [600937.8045896705, 2427953.79931374],
            ),
            (
                "+proj=lcc +lat_1=46.8 +lat_0=46.8 +lon_0=0 +k_0=0.99987742 +x_0=600000 +y_0=2200000 +a=6378249.2 +b=6356515 +pm=2.337229166666667",
                [5.37, 43.3],
                [846456.6089637313, 1815604.8995432318],
            ),
            (
                "+proj=aea +lat_0=23 +lon_0=-96 +lat_1=29.5 +lat_2=45.5 +x_0=0 +y_0=0 +a=6378137 +rf=298.257222101",
                [-122.42, 37.77],
                [-2275632.970778876, 1955421.6880452568],
            ),
            (
                "+proj=aea +lat_0=23 +lon_0=-96 +lat_1=29.5 +lat_2=45.5 +x_0=0 +y_0=0 +a=6378137 +rf=298.257222101",
                [-74.0, 40.7],
                [1827122.1735598098, 2177832.0010803128],
            ),
            (
                "+proj=aea +lat_0=0 +lon_0=132 +lat_1=-18 +lat_2=-36 +x_0=0 +y_0=0 +a=6378137 +rf=298.257222101",
                [151.2, -33.87],
                [1760115.3577786004, -3828753.5580679267],
            ),
            (
                "+proj=aea +lat_0=40 +lon_0=10 +lat_1=30 +lat_2=50 +R=6371000",
                [20.0, 55.0],
                [652681.1086189194, 1709841.1233021053],
            ),
            (
                "+proj=sterea +lat_0=52.1561605555556 +lon_0=5.38763888888889 +k_0=0.9999079 +x_0=155000 +y_0=463000 +a=6377397.155 +rf=299.1528128",
                [4.9, 52.37],
                [121793.91939738547, 486901.27417955425],
            ),
            (
                "+proj=sterea +lat_0=52.1561605555556 +lon_0=5.38763888888889 +k_0=0.9999079 +x_0=155000 +y_0=463000 +a=6377397.155 +rf=299.1528128",
                [5.69, 50.85],
                [176291.5695262811, 317747.03330267454],
            ),
            (
                "+proj=sterea +lat_0=46.5 +lon_0=25 +k_0=0.99975 +x_0=500000 +y_0=500000 +a=6378245 +rf=298.3",
                [26.1, 44.43],
                [587593.7695604839, 270566.52796753217],
            ),
            (
                "+proj=sterea +lat_0=46.5 +lon_0=25 +k_0=0.99975 +x_0=500000 +y_0=500000 +a=6378245 +rf=298.3",
                [-60.0, -30.0],
                [-15443928.784515265, -6787754.096067183],
            ),
            (
                "+proj=omerc +lat_0=46.9524055555556 +lonc=7.43958333333333 +alpha=90 +gamma=90 +k_0=1 +x_0=2600000 +y_0=1200000 +a=6377397.155 +rf=299.1528128",
                [8.54, 47.37],
                [2683103.1620201683, 1247004.0568773025],
            ),
            (
                "+proj=omerc +lat_0=46.9524055555556 +lonc=7.43958333333333 +alpha=90 +gamma=90 +k_0=1 +x_0=2600000 +y_0=1200000 +a=6377397.155 +rf=299.1528128",
                [6.14, 46.2],
                [2499701.5046359217, 1117198.9467646847],
            ),
            (
                "+proj=omerc +no_uoff +lat_0=4 +lonc=102.25 +alpha=323.025796466667 +gamma=323.130102361111 +k_0=0.99984 +x_0=804671 +y_0=0 +a=6378137 +rf=298.257222101",
                [101.69, 3.15],
                [410420.4637243126, 348605.0913964071],
            ),
            (
                "+proj=omerc +no_uoff +lat_0=4 +lonc=102.25 +alpha=323.025796466667 +gamma=323.130102361111 +k_0=0.99984 +x_0=804671 +y_0=0 +a=6378137 +rf=298.257222101",
                [103.8, 1.35],
                [644844.7770413656, 149292.92320112034],
            ),
            (
                "+proj=omerc +lat_0=57 +lonc=-133.666666666667 +alpha=323.130102361111 +gamma=323.130102361111 +k_0=0.9999 +x_0=5000000 +y_0=-5000000 +a=6378137 +rf=298.257222101",
                [-134.4, 58.3],
                [4956995.727620596, -4854999.359243995],
            ),
            (
                "+proj=omerc +lat_0=-36 +lonc=147 +alpha=30 +gamma=20 +k_0=0.9996 +x_0=1000 +y_0=2000 +a=6378137 +rf=298.257223563",
                [150.0, -33.0],
                [219994.75132472662, 374179.3759954339],
            ),
            (
                "+proj=eqc +lat_ts=0 +lat_0=0 +lon_0=0 +x_0=0 +y_0=0 +a=6378137 +rf=298.257223563",
                [139.76, 35.68],
                [15558012.033267912, 3950036.7381267366],
            ),
            (
                "+proj=eqc +lat_ts=0 +lat_0=0 +lon_0=0 +x_0=0 +y_0=0 +a=6378137 +rf=298.257223563",
                [-170.0, -80.0],
                [-18924313.434856508, -8885139.87193687],
            ),
            (
                "+proj=eqc +lat_ts=30 +lat_0=10 +lon_0=-90 +x_0=100 +y_0=200 +a=6378137 +rf=298.257223563",
                [120.0, 45.0],
                [-14472842.037634479, 3879289.5447433707],
            ),
            (
                "+proj=aeqd +lat_0=35 +lon_0=139 +a=6378137 +rf=298.257223563",
                [139.76, 35.68],
                [68801.09853891017, 75707.04553405476],
            ),
            (
                "+proj=aeqd +lat_0=35 +lon_0=139 +a=6378137 +rf=298.257223563",
                [-74.0, 40.7],
                [4574358.716935647, 9970917.27827599],
            ),
            (
                "+proj=aeqd +lat_0=35 +lon_0=139 +a=6378137 +rf=298.257223563",
                [-40.0, -30.0],
                [-3084333.740782107, 19195960.18519194],
            ),
            (
                "+proj=aeqd +lat_0=90 +lon_0=0 +a=6378137 +rf=298.257223563",
                [10.0, 45.0],
                [871196.6149753996, -4940801.523822472],
            ),
            (
                "+proj=aeqd +lat_0=90 +lon_0=0 +a=6378137 +rf=298.257223563",
                [100.0, -60.0],
                [16402995.89733163, 2892290.741149824],
            ),
            ("+proj=aeqd +lat_0=0 +lon_0=0 +R=6371000", [100.0, 30.0], [9462975.200852258, 5547733.821993049]),
            ("+proj=ortho +lat_0=60 +lon_0=10 +a=6378137 +rf=298.257223563", [10.0, 60.0], [0.0, 0.0]),
            (
                "+proj=ortho +lat_0=60 +lon_0=10 +a=6378137 +rf=298.257223563",
                [30.0, 50.0],
                [1404972.2652369114, -893040.5300066423],
            ),
            (
                "+proj=ortho +lat_0=60 +lon_0=10 +a=6378137 +rf=298.257223563",
                [-120.0, 70.0],
                [-1676049.8176765635, 4222009.785424529],
            ),
            (
                "+proj=ortho +lat_0=90 +lon_0=0 +a=6378137 +rf=298.257223563",
                [45.0, 30.0],
                [3909067.7577835177, -3909067.757783518],
            ),
            (
                "+proj=ortho +lat_0=90 +lon_0=0 +a=6378137 +rf=298.257223563",
                [-100.0, 5.0],
                [-6257495.8605447775, 1103365.3518855781],
            ),
            ("+proj=ortho +lat_0=0 +lon_0=140 +R=6371000", [100.0, 30.0], [-3546547.113471518, 3185499.9999999995]),
            (
                "+proj=moll +lon_0=0 +a=6378137 +rf=298.257223563",
                [139.76, 35.68],
                [12312194.290264571, 4301043.98217482],
            ),
            (
                "+proj=moll +lon_0=0 +a=6378137 +rf=298.257223563",
                [-170.0, -80.0],
                [-5553219.288515829, -8527486.04177697],
            ),
            ("+proj=moll +lon_0=0 +a=6378137 +rf=298.257223563", [179.0, 0.0], [17939872.94227981, 0.0]),
            (
                "+proj=sinu +lon_0=0 +a=6378137 +rf=298.257223563",
                [139.76, 35.68],
                [12651988.357907623, 3950036.7381267366],
            ),
            (
                "+proj=sinu +lon_0=0 +a=6378137 +rf=298.257223563",
                [-170.0, -80.0],
                [-3296892.539782466, -8885139.87193687],
            ),
            ("+proj=sinu +lon_0=-60 +R=6371007.181", [10.0, 20.0], [7314241.8867256, 2223901.039533046]),
            (
                "+proj=krovak +lat_0=49.5 +lon_0=24.8333333333333 +alpha=30.2881397527778 +k_0=0.9999 +x_0=0 +y_0=0 +a=6377397.155 +rf=299.1528128",
                [14.42, 50.09],
                [-742949.430991364, -1042796.9661625588],
            ),
            (
                "+proj=krovak +lat_0=49.5 +lon_0=24.8333333333333 +alpha=30.2881397527778 +k_0=0.9999 +x_0=0 +y_0=0 +a=6377397.155 +rf=299.1528128",
                [21.26, 48.72],
                [-262783.2672881957, -1239668.5147915953],
            ),
            (
                "+proj=krovak +lat_0=49.5 +lon_0=24.8333333333333 +alpha=30.2881397527778 +k_0=0.9999 +x_0=0 +y_0=0 +a=6377397.155 +rf=299.1528128",
                [12.1, 50.2],
                [-904966.7597106425, -1005557.7978329073],
            ),
            (
                "+proj=cass +lat_0=2.04258333333333 +lon_0=103.562758333333 +x_0=-14810.562 +y_0=8758.32 +a=6378137 +rf=298.257222101",
                [103.76, 1.48],
                [7139.00410969019, -53448.5439719868],
            ),
            (
                "+proj=cass +lat_0=2.04258333333333 +lon_0=103.562758333333 +x_0=-14810.562 +y_0=8758.32 +a=6378137 +rf=298.257222101",
                [103.2, 2.5],
                [-55154.4565815896, 59343.20801807112],
            ),
            (
                "+proj=cass +lat_0=10.4416666666667 +lon_0=-61.3333333333333 +x_0=86501.46392052 +y_0=65379.0134283 +R=6371000",
                [-61.5, 10.65],
                [68288.20937297426, 88549.51877392016],
            ),
            ("+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563", [37.3, -90.0], [1875465.5798042065, -8625154.6651]),
            ("+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563", [37.3, 90.0], [1875465.5798042065, 8625154.6651]),
            (
                "+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563",
                [37.3, -87.5],
                [1940906.0270909618, -8537587.027768036],
            ),
            (
                "+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563",
                [37.3, -82.5],
                [2099961.017006902, -8272839.92050932],
            ),
            (
                "+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563",
                [37.3, -77.5],
                [2282124.6773910387, -7911894.177903671],
            ),
            (
                "+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563",
                [37.3, -72.5],
                [2455312.034629885, -7494861.804146355],
            ),
            (
                "+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563",
                [37.3, -67.5],
                [2605922.9274987676, -7048948.577337145],
            ),
            (
                "+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563",
                [37.3, -62.5],
                [2746660.9524342683, -6578639.967954137],
            ),
            (
                "+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563",
                [37.3, -57.5],
                [2879647.8450711365, -6089137.708305939],
            ),
            (
                "+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563",
                [37.3, -52.5],
                [3002457.7989474074, -5584144.435390903],
            ),
            (
                "+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563",
                [37.3, -47.5],
                [3109943.2450310388, -5067050.657632864],
            ),
            (
                "+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563",
                [37.3, -42.5],
                [3204459.542178442, -4541404.267002712],
            ),
            (
                "+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563",
                [37.3, -37.5],
                [3286755.3095752164, -4010208.403823528],
            ),
            (
                "+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563",
                [37.3, -32.5],
                [3354256.037312124, -3476011.195574633],
            ),
            (
                "+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563",
                [37.3, -27.5],
                [3407920.026863379, -2941157.4997707433],
            ),
            (
                "+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563",
                [37.3, -22.5],
                [3446093.9272485916, -2406423.2306508254],
            ),
            (
                "+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563",
                [37.3, -17.5],
                [3475709.692518936, -1871656.2227502123],
            ),
            (
                "+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563",
                [37.3, -12.5],
                [3499412.550614994, -1336899.0202493998],
            ),
            (
                "+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563",
                [37.3, -7.5],
                [3514182.8325179676, -802139.3714020291],
            ),
            (
                "+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563",
                [37.3, -2.5],
                [3522581.9179941793, -267379.7909057314],
            ),
            ("+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563", [37.3, 2.5], [3522581.9179941793, 267379.7909057314]),
            ("+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563", [37.3, 7.5], [3514182.8325179676, 802139.3714020291]),
            (
                "+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563",
                [37.3, 12.5],
                [3499412.550614994, 1336899.0202493998],
            ),
            (
                "+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563",
                [37.3, 17.5],
                [3475709.692518936, 1871656.2227502123],
            ),
            (
                "+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563",
                [37.3, 22.5],
                [3446093.9272485916, 2406423.2306508254],
            ),
            (
                "+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563",
                [37.3, 27.5],
                [3407920.026863379, 2941157.4997707433],
            ),
            ("+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563", [37.3, 32.5], [3354256.037312124, 3476011.195574633]),
            (
                "+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563",
                [37.3, 37.5],
                [3286755.3095752164, 4010208.403823528],
            ),
            ("+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563", [37.3, 42.5], [3204459.542178442, 4541404.267002712]),
            (
                "+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563",
                [37.3, 47.5],
                [3109943.2450310388, 5067050.657632864],
            ),
            (
                "+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563",
                [37.3, 52.5],
                [3002457.7989474074, 5584144.435390903],
            ),
            (
                "+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563",
                [37.3, 57.5],
                [2879647.8450711365, 6089137.708305939],
            ),
            (
                "+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563",
                [37.3, 62.5],
                [2746660.9524342683, 6578639.967954137],
            ),
            (
                "+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563",
                [37.3, 67.5],
                [2605922.9274987676, 7048948.577337145],
            ),
            ("+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563", [37.3, 72.5], [2455312.034629885, 7494861.804146355]),
            (
                "+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563",
                [37.3, 77.5],
                [2282124.6773910387, 7911894.177903671],
            ),
            ("+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563", [37.3, 82.5], [2099961.017006902, 8272839.92050932]),
            (
                "+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563",
                [37.3, 87.5],
                [1940906.0270909618, 8537587.027768036],
            ),
            (
                "+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563",
                [-179.0, 2.5],
                [-16904615.638631586, 267379.7909057314],
            ),
            (
                "+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563",
                [-179.0, 7.5],
                [-16864309.035407946, 802139.3714020291],
            ),
            (
                "+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563",
                [-179.0, 12.5],
                [-16793427.52171807, 1336899.0202493998],
            ),
            (
                "+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563",
                [-179.0, 17.5],
                [-16679679.22147157, 1871656.2227502123],
            ),
            (
                "+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563",
                [-179.0, 22.5],
                [-16537555.30770772, 2406423.2306508254],
            ),
            (
                "+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563",
                [-179.0, 27.5],
                [-16354361.52301729, 2941157.4997707433],
            ),
            (
                "+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563",
                [-179.0, 32.5],
                [-16096831.92168553, 3476011.195574633],
            ),
            (
                "+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563",
                [-179.0, 37.5],
                [-15772900.815387772, 4010208.403823528],
            ),
            (
                "+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563",
                [-179.0, 42.5],
                [-15377969.38471692, 4541404.267002712],
            ),
            (
                "+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563",
                [-179.0, 47.5],
                [-14924392.516368793, 5067050.657632864],
            ),
            (
                "+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563",
                [-179.0, 52.5],
                [-14408577.64106129, 5584144.435390903],
            ),
            (
                "+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563",
                [-179.0, 57.5],
                [-13819221.562137628, 6089137.708305939],
            ),
            (
                "+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563",
                [-179.0, 62.5],
                [-13181027.090770353, 6578639.967954137],
            ),
            (
                "+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563",
                [-179.0, 67.5],
                [-12505635.496575858, 7048948.577337145],
            ),
            (
                "+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563",
                [-179.0, 72.5],
                [-11782864.723827064, 7494861.804146355],
            ),
            (
                "+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563",
                [-179.0, 77.5],
                [-10951751.132788096, 7911894.177903671],
            ),
            (
                "+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563",
                [-179.0, 82.5],
                [-10077560.912714086, 8272839.92050932],
            ),
            (
                "+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563",
                [-179.0, 87.5],
                [-9314267.529471373, 8537587.027768036],
            ),
            (
                "+proj=robin +lon_0=0 +a=6378137 +rf=298.257223563",
                [150.0, -88.7],
                [7673364.240093727, -8583698.789847562],
            ),
        ];
        let mut failures = Vec::new();
        for &(def, lnglat, xy) in cases {
            let p = Projection::from_proj_string(def).unwrap();
            let f = p.forward(lnglat[0], lnglat[1]);
            if !close(f, xy, 1e-3) {
                failures.push(format!("{def}: {lnglat:?} → {f:?}, expected {xy:?}"));
            }
            match p.inverse(xy) {
                Some(i) if close(i, lnglat, 1e-9) => {}
                i => failures.push(format!("{def}: {xy:?} → {i:?}, expected {lnglat:?}")),
            }
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }

    #[test]
    fn projjson_matches_proj_string() {
        let laea = r#"{"type":"ProjectedCRS","name":"ETRS89-extended / LAEA Europe","base_crs":{"type":"GeographicCRS","name":"ETRS89",
            "datum_ensemble":{"name":"ETRS89","members":[],"ellipsoid":{"name":"GRS 1980","semi_major_axis":6378137,"inverse_flattening":298.257222101}}},
            "conversion":{"name":"Europe Equal Area 2001","method":{"name":"Lambert Azimuthal Equal Area","id":{"authority":"EPSG","code":9820}},
            "parameters":[{"name":"Latitude of natural origin","value":52,"unit":"degree","id":{"authority":"EPSG","code":8801}},
            {"name":"Longitude of natural origin","value":10,"unit":"degree","id":{"authority":"EPSG","code":8802}},
            {"name":"False easting","value":4321000,"unit":"metre","id":{"authority":"EPSG","code":8806}},
            {"name":"False northing","value":3210000,"unit":"metre"}]},
            "coordinate_system":{"subtype":"Cartesian","axis":[{"name":"Northing","abbreviation":"Y","direction":"north","unit":"metre"},{"name":"Easting","abbreviation":"X","direction":"east","unit":"metre"}]}}"#;
        let a = Projection::parse(laea).unwrap().forward(2.35, 48.85);
        let b = Projection::from_proj_string(
            "+proj=laea +lat_0=52 +lon_0=10 +x_0=4321000 +y_0=3210000 +a=6378137 +rf=298.257222101",
        )
        .unwrap()
        .forward(2.35, 48.85);
        assert_eq!(a, b);
        let geographic = r#"{"type":"GeographicCRS","name":"WGS 84","datum":{"type":"GeodeticReferenceFrame","name":"WGS84","ellipsoid":{"name":"WGS 84","semi_major_axis":6378137,"inverse_flattening":298.257223563}}}"#;
        assert!(matches!(Projection::parse(geographic).unwrap().method, Method::LongLat));
        assert!(Projection::parse(r#"{"type":"BoundCRS"}"#).is_err());
        // PROJ's own geos method and satellite height, matched by name.
        let himawari = r#"{"type":"ProjectedCRS","name":"Himawari","base_crs":{"name":"Himawari geographic","datum":{"type":"GeodeticReferenceFrame","name":"Himawari",
            "ellipsoid":{"name":"Himawari","semi_major_axis":6378137,"semi_minor_axis":6356752.3}}},
            "conversion":{"name":"Geostationary Satellite 140.7E","method":{"name":"Geostationary Satellite (Sweep Y)"},"parameters":[
            {"name":"Longitude of natural origin","value":140.7,"unit":"degree","id":{"authority":"EPSG","code":8802}},
            {"name":"Satellite Height","value":35785863,"unit":"metre"},
            {"name":"False easting","value":0,"unit":"metre","id":{"authority":"EPSG","code":8806}}]},
            "coordinate_system":{"subtype":"Cartesian","axis":[{"name":"Easting","direction":"east","unit":"metre"},{"name":"Northing","direction":"north","unit":"metre"}]}}"#;
        let a = Projection::parse(himawari).unwrap().forward(139.76, 35.68);
        let b = Projection::from_proj_string("+proj=geos +h=35785863 +lon_0=140.7 +a=6378137 +b=6356752.3")
            .unwrap()
            .forward(139.76, 35.68);
        assert_eq!(a, b);
        assert_eq!(Projection::parse(&test_crs::himawari()).unwrap().forward(139.76, 35.68), b);
        assert!(Projection::parse("+proj=longlat").is_err());
    }

    #[test]
    fn projjson_of_proj_matches_proj() {
        // PROJJSON from PROJ 9.8.1 (US survey feet, the Paris meridian in grads, a bound CRS, a
        // compound CRS, Clarke's links, the methods without PROJ strings above), and its `Proj` of each.
        let cases: Vec<(J, [f64; 2], [f64; 2])> = serde_json::from_str(include_str!("projjson_cases.json")).unwrap();
        for (crs, lnglat, xy) in cases {
            let p = Projection::parse(&crs.to_string()).unwrap();
            let f = p.forward(lnglat[0], lnglat[1]);
            assert!(close(f, xy, 1e-3), "{}: {lnglat:?} → {f:?}, expected {xy:?}", crs["name"]);
            // PROJ takes the Paris meridian for 2°20′14.025″, 0.2 mm east of EPSG's 2.5969213 grad.
            let i = p.inverse(xy).unwrap();
            assert!(close(i, lnglat, 1e-8), "{}: {xy:?} → {i:?}, expected {lnglat:?}", crs["name"]);
        }
        // Geographic longitudes from Paris: refused.
        let paris = r#"{"type":"GeographicCRS","datum":{"ellipsoid":{"semi_major_axis":6378249.2,"semi_minor_axis":6356515},
            "prime_meridian":{"name":"Paris","longitude":{"value":2.5969213,"unit":{"type":"AngularUnit","name":"grad","conversion_factor":0.0157079632679489}}}}}"#;
        assert!(Projection::parse(paris).is_err());
    }

    #[test]
    fn projjson_edge_cases() {
        use test_crs::projected;
        // WKT's inverse flattening 0: a sphere.
        let sphere = r#""semi_major_axis":6371000,"inverse_flattening":0"#;
        let p = Projection::parse(&projected("Transverse Mercator", sphere, &[])).unwrap();
        assert!(p.forward(1.0, 1.0).iter().all(|v| v.is_finite()));
        // A pole a few ulps off 90° (degrees from radians) is still polar.
        let lat = (90f64.to_radians() * 1.0000000000000002).to_degrees();
        assert!(
            Projection::parse(&projected(
                "Polar Stereographic (variant A)",
                test_crs::WGS84,
                &[("Latitude of natural origin", lat)]
            ))
            .is_ok()
        );
        // Lambert conformal conic: the cone's gap behind the apex is off the map.
        let lcc = Projection::parse(&projected(
            "Lambert Conic Conformal (2SP)",
            test_crs::WGS84,
            &[
                ("Latitude of 1st standard parallel", 30.0),
                ("Latitude of 2nd standard parallel", 60.0),
                ("Latitude of false origin", 45.0),
            ],
        ))
        .unwrap();
        let apex = lcc.forward(0.0, 90.0);
        assert_eq!(lcc.inverse([1e6, apex[1] + 5e6]), None);
        let p = lcc.inverse([1e6, 0.0]).unwrap();
        assert!(close(lcc.forward(p[0], p[1]), [1e6, 0.0], 1e-3));
    }

    #[test]
    fn more_methods_match_proj() {
        use test_crs::projected;
        // Reference values from PROJ 9.8.1 (pyproj 3.8.0): the PROJJSON of EPSG:5070, 28992, 2056, 3375,
        // 6933, 4087, 5514, 5880, 9311 and ESRI:102031, 54028, 54009, 54030, 54008, 54003, 54077, 54042
        // (from their geographic CRS, without datum shifts), and an ellipsoidal orthographic.
        #[rustfmt::skip]
        let cases: &[(&str, &str, &[(&str, f64)], [f64; 2], [f64; 2])] = &[
            ("Albers Equal Area", r#""semi_major_axis":6378137,"inverse_flattening":298.257222101"#, &[("Latitude of false origin", 23.0), ("Longitude of false origin", -96.0), ("Latitude of 1st standard parallel", 29.5), ("Latitude of 2nd standard parallel", 45.5), ("Easting at false origin", 0.0), ("Northing at false origin", 0.0)], [-96.0, 40.0], [0.0, 1886977.5648988034]),
            ("Albers Equal Area", r#""semi_major_axis":6378137,"inverse_flattening":298.257222101"#, &[("Latitude of false origin", 23.0), ("Longitude of false origin", -96.0), ("Latitude of 1st standard parallel", 29.5), ("Latitude of 2nd standard parallel", 45.5), ("Easting at false origin", 0.0), ("Northing at false origin", 0.0)], [-120.0, 35.0], [-2149393.5126428995, 1599660.032831896]),
            ("Oblique Stereographic", r#""semi_major_axis":6377397.155,"inverse_flattening":299.1528128"#, &[("Latitude of natural origin", 52.1561605555556), ("Longitude of natural origin", 5.38763888888889), ("Scale factor at natural origin", 0.9999079), ("False easting", 155000.0), ("False northing", 463000.0)], [5.0, 52.0], [128383.47452664126, 445698.8043061154]),
            ("Oblique Stereographic", r#""semi_major_axis":6377397.155,"inverse_flattening":299.1528128"#, &[("Latitude of natural origin", 52.1561605555556), ("Longitude of natural origin", 5.38763888888889), ("Scale factor at natural origin", 0.9999079), ("False easting", 155000.0), ("False northing", 463000.0)], [6.5, 53.2], [229323.39417033814, 579711.5975776529]),
            ("Hotine Oblique Mercator (variant B)", r#""semi_major_axis":6377397.155,"inverse_flattening":299.1528128"#, &[("Latitude of projection centre", 46.9524055555556), ("Longitude of projection centre", 7.43958333333333), ("Azimuth at projection centre", 90.0), ("Angle from Rectified to Skew Grid", 90.0), ("Scale factor at projection centre", 1.0), ("Easting at projection centre", 2600000.0), ("Northing at projection centre", 1200000.0)], [7.4, 46.9], [2596984.202521673, 1194175.5182895144]),
            ("Hotine Oblique Mercator (variant B)", r#""semi_major_axis":6377397.155,"inverse_flattening":299.1528128"#, &[("Latitude of projection centre", 46.9524055555556), ("Longitude of projection centre", 7.43958333333333), ("Azimuth at projection centre", 90.0), ("Angle from Rectified to Skew Grid", 90.0), ("Scale factor at projection centre", 1.0), ("Easting at projection centre", 2600000.0), ("Northing at projection centre", 1200000.0)], [9.5, 47.5], [2755209.648060532, 1262912.607027531]),
            ("Hotine Oblique Mercator (variant A)", r#""semi_major_axis":6378137,"inverse_flattening":298.257222101"#, &[("Latitude of projection centre", 4.0), ("Longitude of projection centre", 102.25), ("Azimuth at projection centre", 323.025796466667), ("Angle from Rectified to Skew Grid", 323.130102361111), ("Scale factor at projection centre", 0.99984), ("False easting", 804671.0), ("False northing", 0.0)], [102.0, 4.0], [445072.33326358895, 442508.8986183557]),
            ("Hotine Oblique Mercator (variant A)", r#""semi_major_axis":6378137,"inverse_flattening":298.257222101"#, &[("Latitude of projection centre", 4.0), ("Longitude of projection centre", 102.25), ("Azimuth at projection centre", 323.025796466667), ("Angle from Rectified to Skew Grid", 323.130102361111), ("Scale factor at projection centre", 0.99984), ("False easting", 804671.0), ("False northing", 0.0)], [103.5, 2.0], [611504.2087569564, 221172.84639757543]),
            ("Lambert Cylindrical Equal Area", r#""semi_major_axis":6378137,"inverse_flattening":298.257223563"#, &[("Latitude of 1st standard parallel", 30.0), ("Longitude of natural origin", 0.0), ("False easting", 0.0), ("False northing", 0.0)], [139.76, 35.68], [13484922.527865294, 4269756.253587328]),
            ("Lambert Cylindrical Equal Area", r#""semi_major_axis":6378137,"inverse_flattening":298.257223563"#, &[("Latitude of 1st standard parallel", 30.0), ("Longitude of natural origin", 0.0), ("False easting", 0.0), ("False northing", 0.0)], [-60.0, -75.0], [-5789176.81505379, -7089914.145211107]),
            ("Equidistant Cylindrical", r#""semi_major_axis":6378137,"inverse_flattening":298.257223563"#, &[("Latitude of 1st standard parallel", 0.0), ("Longitude of natural origin", 0.0), ("False easting", 0.0), ("False northing", 0.0)], [139.76, 35.68], [15558012.033267912, 3950036.7381267366]),
            ("Equidistant Cylindrical", r#""semi_major_axis":6378137,"inverse_flattening":298.257223563"#, &[("Latitude of 1st standard parallel", 0.0), ("Longitude of natural origin", 0.0), ("False easting", 0.0), ("False northing", 0.0)], [-60.0, -75.0], [-6679169.447596414, -8326937.587280346]),
            ("Krovak (North Orientated)", r#""semi_major_axis":6377397.155,"inverse_flattening":299.1528128"#, &[("Latitude of projection centre", 49.5), ("Longitude of origin", 24.8333333333333), ("Co-latitude of cone axis", 30.2881397527778), ("Latitude of pseudo standard parallel", 78.5), ("Scale factor on pseudo standard parallel", 0.9999), ("False easting", 0.0), ("False northing", 0.0)], [14.42, 50.09], [-742949.430991364, -1042796.9661625588]),
            ("Krovak (North Orientated)", r#""semi_major_axis":6377397.155,"inverse_flattening":299.1528128"#, &[("Latitude of projection centre", 49.5), ("Longitude of origin", 24.8333333333333), ("Co-latitude of cone axis", 30.2881397527778), ("Latitude of pseudo standard parallel", 78.5), ("Scale factor on pseudo standard parallel", 0.9999), ("False easting", 0.0), ("False northing", 0.0)], [18.0, 49.0], [-499258.06054492824, -1192389.1602215304]),
            ("American Polyconic", r#""semi_major_axis":6378137,"inverse_flattening":298.257222101"#, &[("Latitude of natural origin", 0.0), ("Longitude of natural origin", -54.0), ("False easting", 5000000.0), ("False northing", 10000000.0)], [-47.9, -15.8], [5653463.734227156, 8243016.222029742]),
            ("American Polyconic", r#""semi_major_axis":6378137,"inverse_flattening":298.257222101"#, &[("Latitude of natural origin", 0.0), ("Longitude of natural origin", -54.0), ("False easting", 5000000.0), ("False northing", 10000000.0)], [-70.0, 5.0], [3225795.874051436, 10574477.228071121]),
            ("Equidistant Conic", r#""semi_major_axis":6378388,"inverse_flattening":297"#, &[("Latitude of false origin", 30.000000000000004), ("Longitude of false origin", 10.000000000000002), ("Latitude of 1st standard parallel", 43.00000000000001), ("Latitude of 2nd standard parallel", 62.000000000000014), ("Easting at false origin", 0.0), ("Northing at false origin", 0.0)], [10.0, 50.0], [0.0, 2220797.012985132]),
            ("Equidistant Conic", r#""semi_major_axis":6378388,"inverse_flattening":297"#, &[("Latitude of false origin", 30.000000000000004), ("Longitude of false origin", 10.000000000000002), ("Latitude of 1st standard parallel", 43.00000000000001), ("Latitude of 2nd standard parallel", 62.000000000000014), ("Easting at false origin", 0.0), ("Northing at false origin", 0.0)], [30.0, 40.0], [1701013.203128221, 1345410.9010574487]),
            ("Cassini-Soldner", r#""semi_major_axis":6378137,"inverse_flattening":298.257223563"#, &[("Latitude of natural origin", 0.0), ("Longitude of natural origin", 0.0), ("False easting", 0.0), ("False northing", 0.0)], [0.5, 51.5], [34719.988409660495, 5707830.814447506]),
            ("Cassini-Soldner", r#""semi_major_axis":6378137,"inverse_flattening":298.257223563"#, &[("Latitude of natural origin", 0.0), ("Longitude of natural origin", 0.0), ("False easting", 0.0), ("False northing", 0.0)], [-0.8, 10.0], [-87711.40531096116, 1105961.1736498005]),
            ("Lambert Azimuthal Equal Area (Spherical)", r#""semi_major_axis":6378206.4,"semi_minor_axis":6356583.8"#, &[("Latitude of natural origin", 45.0), ("Longitude of natural origin", -100.0), ("False easting", 0.0), ("False northing", 0.0)], [-100.0, 45.0], [0.0, 0.0]),
            ("Lambert Azimuthal Equal Area (Spherical)", r#""semi_major_axis":6378206.4,"semi_minor_axis":6356583.8"#, &[("Latitude of natural origin", 45.0), ("Longitude of natural origin", -100.0), ("False easting", 0.0), ("False northing", 0.0)], [-80.0, 30.0], [1921494.5283289563, -1439433.3752588553]),
            ("Mollweide", r#""semi_major_axis":6378137,"inverse_flattening":298.257223563"#, &[("Longitude of natural origin", 0.0), ("False easting", 0.0), ("False northing", 0.0)], [139.76, 35.68], [12312194.290264571, 4301043.98217482]),
            ("Mollweide", r#""semi_major_axis":6378137,"inverse_flattening":298.257223563"#, &[("Longitude of natural origin", 0.0), ("False easting", 0.0), ("False northing", 0.0)], [-170.0, -80.0], [-5553219.288515829, -8527486.04177697]),
            ("Robinson", r#""semi_major_axis":6378137,"inverse_flattening":298.257223563"#, &[("Longitude of natural origin", 0.0), ("False easting", 0.0), ("False northing", 0.0)], [139.76, 35.68], [12412711.298027338, 3815965.647171651]),
            ("Robinson", r#""semi_major_axis":6378137,"inverse_flattening":298.257223563"#, &[("Longitude of natural origin", 0.0), ("False easting", 0.0), ("False northing", 0.0)], [-170.0, -80.0], [-9978739.279836627, -8102470.441278092]),
            ("Sinusoidal", r#""semi_major_axis":6378137,"inverse_flattening":298.257223563"#, &[("Longitude of natural origin", 0.0), ("False easting", 0.0), ("False northing", 0.0)], [139.76, 35.68], [12651988.357907623, 3950036.7381267366]),
            ("Sinusoidal", r#""semi_major_axis":6378137,"inverse_flattening":298.257223563"#, &[("Longitude of natural origin", 0.0), ("False easting", 0.0), ("False northing", 0.0)], [-170.0, -80.0], [-3296892.539782466, -8885139.87193687]),
            ("Miller Cylindrical", r#""semi_major_axis":6378137,"inverse_flattening":298.257223563"#, &[("Longitude of natural origin", 0.0), ("False easting", 0.0), ("False northing", 0.0)], [139.76, 35.68], [15540620.464457994, 4142532.187346332]),
            ("Miller Cylindrical", r#""semi_major_axis":6378137,"inverse_flattening":298.257223563"#, &[("Longitude of natural origin", 0.0), ("False easting", 0.0), ("False northing", 0.0)], [-170.0, -80.0], [-18903158.83627547, -11674140.641483014]),
            ("Natural Earth", r#""semi_major_axis":6378137,"inverse_flattening":298.257223563"#, &[("Longitude of natural origin", 0.0), ("False easting", 0.0), ("False northing", 0.0)], [139.76, 35.68], [12718279.489365363, 4015900.931179231]),
            ("Natural Earth", r#""semi_major_axis":6378137,"inverse_flattening":298.257223563"#, &[("Longitude of natural origin", 0.0), ("False easting", 0.0), ("False northing", 0.0)], [-170.0, -80.0], [-11143938.433007937, -8527794.77272659]),
            ("Winkel Tripel", r#""semi_major_axis":6378137,"inverse_flattening":298.257223563"#, &[("Longitude of natural origin", 0.0), ("Latitude of 1st standard parallel", 50.46700000000001), ("False easting", 0.0), ("False northing", 0.0)], [139.76, 35.68], [11475202.282200357, 4480307.6191124115]),
            ("Winkel Tripel", r#""semi_major_axis":6378137,"inverse_flattening":298.257223563"#, &[("Longitude of natural origin", 0.0), ("Latitude of 1st standard parallel", 50.46700000000001), ("False easting", 0.0), ("False northing", 0.0)], [-170.0, -80.0], [-7739491.771480376, -9339079.344355782]),
            ("Orthographic", r#""semi_major_axis":6378137,"inverse_flattening":298.257223563"#, &[("Latitude of natural origin", 35.0), ("Longitude of natural origin", 135.0), ("False easting", 0.0), ("False northing", 0.0)], [139.76, 35.68], [430410.79303808004, 85702.80492914576]),
            ("Orthographic", r#""semi_major_axis":6378137,"inverse_flattening":298.257223563"#, &[("Latitude of natural origin", 35.0), ("Longitude of natural origin", 135.0), ("False easting", 0.0), ("False northing", 0.0)], [100.0, -20.0], [-3439070.466019209, -4572711.385913498]),
        ];
        for &(method, ellipsoid, params, lnglat, xy) in cases {
            let p = Projection::parse(&projected(method, ellipsoid, params)).unwrap();
            let f = p.forward(lnglat[0], lnglat[1]);
            // Cassini-Soldner is EPSG's series, PROJ's exact: they part as λ⁵ (0.2 mm 1° from the meridian).
            let tol = if method == "Cassini-Soldner" { 1e-4 } else { 1e-6 };
            assert!(close(f, xy, tol), "{method}: {lnglat:?} → {f:?}, expected {xy:?}");
            let i = p.inverse(xy).unwrap();
            assert!(close(i, lnglat, 1e-9), "{method}: {xy:?} → {i:?}, expected {lnglat:?}");
        }
        // Outside the outlines of world maps, the far side of a globe and the gap of a cone: no answer.
        let world = |m: &str| Projection::parse(&projected(m, WGS84, &[])).unwrap();
        for m in ["Mollweide", "Robinson", "Sinusoidal", "Natural Earth", "Winkel Tripel"] {
            assert_eq!(world(m).inverse([2.0e7, 1.0e6]), None, "{m}");
            assert!(world(m).inverse([1.0e6, 1.0e6]).is_some(), "{m}");
        }
        let ortho =
            Projection::parse(&projected("Orthographic", WGS84, &[("Latitude of natural origin", 35.0)])).unwrap();
        assert!(ortho.forward(180.0, -35.0)[0].is_nan());
        assert_eq!(ortho.inverse([7.0e6, 0.0]), None);
        let aea = Projection::parse(&projected(
            "Albers Equal Area",
            WGS84,
            &[("Latitude of 1st standard parallel", 30.0), ("Latitude of 2nd standard parallel", 60.0)],
        ))
        .unwrap();
        let apex = aea.forward(0.0, 90.0);
        assert_eq!(aea.inverse([1e6, apex[1] + 5e6]), None);
    }
}
