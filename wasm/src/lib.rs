//! Plain C-ABI exports for wasm32-unknown-unknown (no wasm-bindgen).
//!
//! Byte results (needs list, RGBA, error messages) go to a shared output buffer read via
//! `out_ptr`/`out_len`; it stays valid until the next call. Inputs are copied in via `alloc`.

use ml2drender::{Renderer, View};
use std::cell::RefCell;

thread_local! {
    static OUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

fn set_out(bytes: Vec<u8>) {
    OUT.with(|o| *o.borrow_mut() = bytes);
}

unsafe fn bytes<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if len == 0 { &[] } else { unsafe { std::slice::from_raw_parts(ptr, len) } }
}

#[unsafe(no_mangle)]
pub extern "C" fn out_ptr() -> *const u8 {
    OUT.with(|o| o.borrow().as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn out_len() -> usize {
    OUT.with(|o| o.borrow().len())
}

#[unsafe(no_mangle)]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// `ptr`/`len` must come from `alloc`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    drop(unsafe { Vec::from_raw_parts(ptr, 0, len) });
}

/// Returns a renderer handle, or null with the error message in the output buffer.
///
/// # Safety
/// `style_ptr`/`style_len` must describe readable memory.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn renderer_new(
    style_ptr: *const u8,
    style_len: usize,
    lng: f64,
    lat: f64,
    zoom: f64,
    bearing: f64,
    width: u32,
    height: u32,
    pixel_ratio: f64,
) -> *mut Renderer {
    let style = String::from_utf8_lossy(unsafe { bytes(style_ptr, style_len) });
    let view = View { center: [lng, lat], zoom, bearing, width, height, pixel_ratio };
    match Renderer::new(&style, view) {
        Ok(r) => Box::into_raw(Box::new(r)),
        Err(e) => {
            set_out(e.to_string().into_bytes());
            std::ptr::null_mut()
        }
    }
}

/// Writes the needed URLs, newline-separated, to the output buffer; returns their count.
///
/// # Safety
/// `r` must be a live handle from `renderer_new`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn renderer_needs(r: *mut Renderer) -> usize {
    let needs = unsafe { &*r }.needs();
    set_out(needs.iter().map(|n| n.url.as_str()).collect::<Vec<_>>().join("\n").into_bytes());
    needs.len()
}

/// `found == 0` means the host could not fetch the URL.
///
/// # Safety
/// `r` must be a live handle; pointers must describe readable memory.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn renderer_provide(
    r: *mut Renderer,
    url_ptr: *const u8,
    url_len: usize,
    data_ptr: *const u8,
    data_len: usize,
    found: u32,
) {
    let url = String::from_utf8_lossy(unsafe { bytes(url_ptr, url_len) });
    let data = (found != 0).then(|| unsafe { bytes(data_ptr, data_len) });
    unsafe { &mut *r }.provide(&url, data);
}

/// Returns 1 with RGBA in the output buffer, or 0 with an error message.
///
/// # Safety
/// `r` must be a live handle from `renderer_new`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn renderer_render(r: *mut Renderer) -> u32 {
    match unsafe { &mut *r }.render() {
        Ok(rgba) => {
            set_out(rgba);
            1
        }
        Err(e) => {
            set_out(e.to_string().into_bytes());
            0
        }
    }
}

/// # Safety
/// `r` must be a live handle from `renderer_new`; it is invalid afterwards.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn renderer_free(r: *mut Renderer) {
    drop(unsafe { Box::from_raw(r) });
}
