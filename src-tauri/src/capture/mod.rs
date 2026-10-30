//! Capture orchestration: backend detection, the shared save pipeline, and the
//! X11 overlay flow. GNOME/Wayland lives in `gnome`.

pub mod gnome;
pub mod x11;

use crate::{library, log, util, AppState};
use image::RgbaImage;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Backend {
    X11,
    Gnome,
    Unsupported,
}

impl Backend {
    pub fn detect() -> Self {
        let session = std::env::var("XDG_SESSION_TYPE").unwrap_or_default().to_lowercase();
        let desktop = std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default().to_lowercase();
        let wayland = session == "wayland" || (session.is_empty() && std::env::var_os("WAYLAND_DISPLAY").is_some());
        if wayland {
            if desktop.contains("gnome") || desktop.contains("zorin") || desktop.contains("ubuntu") {
                Backend::Gnome
            } else {
                Backend::Unsupported
            }
        } else if std::env::var_os("DISPLAY").is_some() {
            Backend::X11
        } else {
            Backend::Unsupported
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Backend::X11 => "x11",
            Backend::Gnome => "gnome",
            Backend::Unsupported => "unsupported",
        }
    }
}

// ------------------------------------------------------------ main window

/// Hides the main window so it isn't part of the screenshot; remembers to bring it back.
pub fn hide_main_for_capture(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        if w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false) {
            app.state::<AppState>().restore_main.store(true, Ordering::Relaxed);
            let _ = w.hide();
            std::thread::sleep(Duration::from_millis(280));
        }
    }
}

pub fn restore_main(app: &AppHandle) {
    if app.state::<AppState>().restore_main.swap(false, Ordering::Relaxed) {
        show_main(app);
    }
}

/// Shows the main window AND gives it keyboard focus. Plain `set_focus` is ignored by
/// compositors' focus-stealing prevention, so each backend asks the shell/WM directly.
pub fn show_main(app: &AppHandle) {
    let Some(w) = app.get_webview_window("main") else { return };
    let _ = w.show();
    let _ = w.unminimize();
    let _ = w.set_focus();
    let backend = app.state::<AppState>().backend;
    std::thread::spawn(move || {
        // Give the window a moment to be mapped before asking for activation.
        for delay in [120u64, 350] {
            std::thread::sleep(Duration::from_millis(delay));
            match backend {
                Backend::Gnome => {
                    gnome::focus_main();
                }
                Backend::X11 => {
                    let _ = x11::activate_own_window();
                }
                Backend::Unsupported => {}
            }
        }
    });
}

// ------------------------------------------------------------ entry point

pub fn start(app: &AppHandle) {
    let backend = app.state::<AppState>().backend;
    match backend {
        Backend::Gnome => gnome::toggle(app),
        Backend::X11 => {
            let app = app.clone();
            std::thread::spawn(move || {
                if let Err(e) = start_x11(&app) {
                    log(&app, format!("capture failed: {e}"));
                    if let Some(o) = app.get_webview_window("overlay") {
                        let _ = o.close();
                    }
                    restore_main(&app);
                }
            });
        }
        Backend::Unsupported => log(
            app,
            "Capture isn't supported on this session yet (only X11 and GNOME/Wayland for now).",
        ),
    }
}

/// Instant capture runs on the shortcut worker, without changing focus first.
pub fn capture_mode(app: &AppHandle, action: &str) {
    match app.state::<AppState>().backend {
        Backend::Gnome => gnome::capture_mode(app, action),
        Backend::X11 => {
            // Serialize quick captures and ignore them while selection is open.
            static BUSY: std::sync::Mutex<()> = std::sync::Mutex::new(());
            let Ok(_guard) = BUSY.try_lock() else { return };
            if app.get_webview_window("overlay").is_some() { return; }
            let result = x11::grab_mode(action).and_then(|capture| {
                if let Some((image, label)) = capture {
                    save_rgba(app, &image, &label)?;
                }
                Ok(())
            });
            if let Err(error) = result {
                log(app, format!("capture failed: {error}"));
            }
        }
        Backend::Unsupported => {}
    }
}

// ------------------------------------------------------------- save pipeline

/// Canonical lower-case extension for a format name ("jpeg" -> "jpg"; unknown -> "png").
pub fn format_ext(fmt: &str) -> &'static str {
    match fmt.to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => "jpg",
        "webp" => "webp",
        "bmp" => "bmp",
        _ => "png",
    }
}

/// Encodes pixels as `fmt`. PNG uses fast compression: this runs between the hotkey and the
/// "saved" toast, so speed beats file size. JPEG has no alpha, so it is flattened onto white.
pub fn encode_as(img: &RgbaImage, fmt: &str, quality: u8) -> Result<(Vec<u8>, &'static str), String> {
    use image::{ExtendedColorType as C, ImageEncoder};
    let ext = format_ext(fmt);
    let (w, h) = (img.width(), img.height());
    let mut out = Vec::new();
    match ext {
        "jpg" => {
            let rgb: Vec<u8> = img
                .pixels()
                .flat_map(|p| {
                    let a = p[3] as u32;
                    [0, 1, 2].map(|c| ((p[c] as u32 * a + 255 * (255 - a) + 127) / 255) as u8)
                })
                .collect();
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality.clamp(1, 100))
                .write_image(&rgb, w, h, C::Rgb8)
                .map_err(|e| e.to_string())?;
        }
        "webp" => image::codecs::webp::WebPEncoder::new_lossless(&mut out)
            .write_image(img.as_raw(), w, h, C::Rgba8)
            .map_err(|e| e.to_string())?,
        "bmp" => image::codecs::bmp::BmpEncoder::new(&mut out)
            .write_image(img.as_raw(), w, h, C::Rgba8)
            .map_err(|e| e.to_string())?,
        _ => image::codecs::png::PngEncoder::new_with_quality(
            &mut out,
            image::codecs::png::CompressionType::Fast,
            image::codecs::png::FilterType::Sub,
        )
        .write_image(img.as_raw(), w, h, C::Rgba8)
        .map_err(|e| e.to_string())?,
    }
    Ok((out, ext))
}

/// PNG bytes -> bytes of `fmt` (PNG passes through untouched, no decode).
pub fn png_to_format(png: &[u8], fmt: &str, quality: u8) -> Result<(Vec<u8>, &'static str), String> {
    if format_ext(fmt) == "png" {
        return Ok((png.to_vec(), "png"));
    }
    let img = image::load_from_memory(png).map_err(|e| e.to_string())?.to_rgba8();
    encode_as(&img, fmt, quality)
}

pub fn save_rgba(app: &AppHandle, img: &RgbaImage, label: &str) -> Result<PathBuf, String> {
    let s = app.state::<AppState>().settings.get();
    let (bytes, ext) = encode_as(img, &s.image_format, s.jpeg_quality)?;
    if ext == "png" {
        return write_capture(app, bytes.clone(), ext, move || bytes, label);
    }
    // The clipboard wants PNG: build it off the critical path.
    let img = img.clone();
    write_capture(app, bytes, ext, move || encode_as(&img, "png", 100).map(|r| r.0).unwrap_or_default(), label)
}

/// Writes a finished capture (PNG bytes) into the library in the user's chosen format.
pub fn save_png(app: &AppHandle, png: Vec<u8>, label: &str) -> Result<PathBuf, String> {
    let s = app.state::<AppState>().settings.get();
    let (bytes, ext) = png_to_format(&png, &s.image_format, s.jpeg_quality)?;
    write_capture(app, bytes, ext, move || png, label)
}

/// Saves `bytes` as `<label>-<timestamp>.<ext>`, copies the image (as PNG, from `clip_png`),
/// notifies, and tells the UI.
fn write_capture(
    app: &AppHandle,
    bytes: Vec<u8>,
    ext: &str,
    clip_png: impl FnOnce() -> Vec<u8> + Send + 'static,
    label: &str,
) -> Result<PathBuf, String> {
    let st = app.state::<AppState>();
    let s = st.settings.get();
    let dir = st.settings.output_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let stem = format!("{}-{}", util::sanitize(label), chrono::Local::now().format("%Y%m%d-%H%M%S"));
    let path = library::unique_path(&dir, &stem, ext);
    std::fs::write(&path, &bytes).map_err(|e| format!("could not save {}: {e}", path.display()))?;

    log(app, format!("saved {}", path.display()));
    if s.copy_to_clipboard {
        // Off the critical path: handing the image to the clipboard can take a while.
        let app = app.clone();
        std::thread::spawn(move || match crate::clipboard::copy_png(&clip_png()) {
            Ok(()) => log(&app, "copied to clipboard"),
            Err(e) => log(&app, format!("clipboard copy failed: {e}")),
        });
    }
    if s.notifications {
        let _ = std::process::Command::new("notify-send")
            .args(["-a", "Pengo", "-i"])
            .arg(&path)
            .arg("Screenshot saved")
            .arg(path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default())
            .spawn();
    }
    let p = path.to_string_lossy().into_owned();
    let _ = app.emit("captured", &p);
    if s.after_capture == "editor" {
        st.restore_main.store(false, Ordering::Relaxed);
        show_main(app);
        let _ = app.emit("open-editor", &p);
    }
    Ok(path)
}

// ------------------------------------------------------------------ X11 flow

#[derive(Serialize)]
pub struct OverlayState {
    pub image: String,
    pub width: u32,
    pub height: u32,
    pub windows: Vec<x11::WinRect>,
}

fn start_x11(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window("overlay").is_some() {
        return Ok(());
    }
    hide_main_for_capture(app);
    let frozen = x11::grab()?;
    let (w, h) = (frozen.img.width(), frozen.img.height());

    let cache = app.state::<AppState>().cache_dir.clone();
    std::fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
    let file = cache.join("frozen.png");
    {
        let f = std::io::BufWriter::new(std::fs::File::create(&file).map_err(|e| e.to_string())?);
        let enc = image::codecs::png::PngEncoder::new_with_quality(
            f,
            image::codecs::png::CompressionType::Fast,
            image::codecs::png::FilterType::NoFilter,
        );
        image::ImageEncoder::write_image(enc, frozen.img.as_raw(), w, h, image::ExtendedColorType::Rgba8)
            .map_err(|e| e.to_string())?;
    }
    *app.state::<AppState>().frozen.lock().unwrap() = Some(frozen);

    let scale = app.primary_monitor().ok().flatten().map(|m| m.scale_factor()).unwrap_or(1.0);
    let win = WebviewWindowBuilder::new(app, "overlay", WebviewUrl::App("overlay.html".into()))
        .title("Pengo capture")
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .inner_size(w as f64 / scale, h as f64 / scale)
        .position(0.0, 0.0)
        .focused(true)
        .build()
        .map_err(|e| e.to_string())?;
    let _ = win.set_position(PhysicalPosition::new(0, 0));
    let _ = win.set_size(PhysicalSize::new(w, h));
    let _ = win.set_focus();
    Ok(())
}

pub fn overlay_state(app: &AppHandle) -> Result<OverlayState, String> {
    let st = app.state::<AppState>();
    let guard = st.frozen.lock().unwrap();
    let f = guard.as_ref().ok_or("no frozen frame")?;
    Ok(OverlayState {
        image: st.cache_dir.join("frozen.png").to_string_lossy().into_owned(),
        width: f.img.width(),
        height: f.img.height(),
        windows: f.windows.clone(),
    })
}

#[derive(serde::Deserialize)]
pub struct Selection {
    pub x: i64,
    pub y: i64,
    pub w: i64,
    pub h: i64,
    pub label: String,
}

pub fn overlay_done(app: &AppHandle, sel: Option<Selection>) {
    let frozen = app.state::<AppState>().frozen.lock().unwrap().take();
    if let Some(o) = app.get_webview_window("overlay") {
        let _ = o.close();
    }
    let (Some(sel), Some(frozen)) = (sel, frozen) else {
        restore_main(app);
        return;
    };
    let app = app.clone();
    std::thread::spawn(move || {
        match frozen.crop(sel.x, sel.y, sel.w, sel.h) {
            Some(img) => {
                if let Err(e) = save_rgba(&app, &img, &sel.label) {
                    log(&app, format!("capture failed: {e}"));
                }
            }
            None => log(&app, "empty selection"),
        }
        restore_main(&app);
    });
}
