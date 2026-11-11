// Rust numeric semantics the port relies on.

/** Rust `f64::round`: halves away from zero (JS `Math.round` rounds halves up). */
export const roundAway = (x: number): number => (x < 0 ? -Math.round(-x) : Math.round(x));

/** Rust `x as i32` from a float: truncates, saturates, NaN → 0. */
export const asI32 = (x: number): number => (x !== x ? 0 : Math.max(-2147483648, Math.min(2147483647, Math.trunc(x))));
/** Rust `x as u8` from a float: truncates, saturates, NaN → 0. */
export const asU8 = (x: number): number => (x !== x ? 0 : Math.max(0, Math.min(255, Math.trunc(x))));
/** Rust `(x as i32) as i16` style wrapping of an integer to 16 / 8 bits. */
export const wrapI16 = (x: number): number => (x << 16) >> 16;
export const wrapI8 = (x: number): number => (x << 24) >> 24;

export const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));
