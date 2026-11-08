//! Caps how much styled text macOS can ask the editor webview for.
//!
//! On every selection change AppKit asks the text input client for an attributed
//! copy of the selection (to decide whether to show the Writing Tools
//! affordance). WebKit builds that copy with full styling in the page process.
//! After Cmd+A in a long note each request takes seconds and they keep coming,
//! so the page and the app stop responding for good. Turning Writing Tools off
//! doesn't stop that check.
//!
//! wry's WKWebView subclass doesn't override these NSTextInputClient methods, so
//! add overrides that clamp the requested range and call WebKit's own
//! implementation. Input methods only ask for a few characters around the caret,
//! and copying goes through the editor's copy handler, not this path.

use objc2::ffi;
use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
use objc2::sel;
use std::ffi::c_void;
use std::sync::OnceLock;

const MAX_LENGTH: usize = 2048;

#[repr(C)]
#[derive(Clone, Copy)]
struct NSRange {
    location: usize,
    length: usize,
}

fn clamp(range: NSRange) -> NSRange {
    NSRange {
        location: range.location,
        length: range.length.min(MAX_LENGTH),
    }
}

type AsyncFn = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, NSRange, *mut c_void);
type SyncFn =
    unsafe extern "C-unwind" fn(*mut AnyObject, Sel, NSRange, *mut NSRange) -> *mut AnyObject;

static ASYNC_ORIGINAL: OnceLock<AsyncFn> = OnceLock::new();
static SYNC_ORIGINAL: OnceLock<SyncFn> = OnceLock::new();

// -attributedSubstringForProposedRange:completionHandler:
unsafe extern "C-unwind" fn clamped_async(
    this: *mut AnyObject,
    cmd: Sel,
    range: NSRange,
    handler: *mut c_void,
) {
    if let Some(original) = ASYNC_ORIGINAL.get() {
        original(this, cmd, clamp(range), handler);
    }
}

// -attributedSubstringForProposedRange:actualRange:
unsafe extern "C-unwind" fn clamped_sync(
    this: *mut AnyObject,
    cmd: Sel,
    range: NSRange,
    actual: *mut NSRange,
) -> *mut AnyObject {
    match SYNC_ORIGINAL.get() {
        Some(original) => original(this, cmd, clamp(range), actual),
        None => std::ptr::null_mut(),
    }
}

/// Replaces `sel` on `class` and returns the implementation it inherited.
unsafe fn override_method(class: *const AnyClass, sel: Sel, imp: Imp) -> Option<Imp> {
    let method = ffi::class_getInstanceMethod(class, sel);
    if method.is_null() {
        return None;
    }
    let original = ffi::method_getImplementation(method)?;
    let types = ffi::method_getTypeEncoding(method);
    ffi::class_replaceMethod(class as *mut _, sel, imp, types);
    Some(original)
}

/// `webview` is the WKWebView pointer from `PlatformWebview::inner()`.
pub fn limit_attributed_substrings(webview: *mut c_void) {
    if webview.is_null() {
        return;
    }
    unsafe {
        let class = ffi::object_getClass(webview as *const AnyObject);
        if class.is_null() {
            return;
        }
        let sel = sel!(attributedSubstringForProposedRange:completionHandler:);
        if ASYNC_ORIGINAL.get().is_none() {
            if let Some(original) = override_method(class, sel, std::mem::transmute::<AsyncFn, Imp>(clamped_async)) {
                assert!(ASYNC_ORIGINAL.set(std::mem::transmute::<Imp, AsyncFn>(original)).is_ok(), "Async selection hook installed twice");
            }
        }
        let sel = sel!(attributedSubstringForProposedRange:actualRange:);
        if SYNC_ORIGINAL.get().is_none() {
            if let Some(original) = override_method(class, sel, std::mem::transmute::<SyncFn, Imp>(clamped_sync)) {
                assert!(SYNC_ORIGINAL.set(std::mem::transmute::<Imp, SyncFn>(original)).is_ok(), "Sync selection hook installed twice");
            }
        }
    }
}
