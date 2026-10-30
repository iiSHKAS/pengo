//! GNOME on Wayland: the WinProbe Shell extension owns the frozen-frame overlay
//! (it is the only place with access to the compositor's pixels); we talk to it
//! over D-Bus, pick up the result and run the save pipeline.

use crate::{log, AppState};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use zbus::blocking::Connection;

pub const EXT_UUID: &str = "winprobe@sonux.dev";
pub const DBUS_NAME: &str = "dev.sonux.WinProbe";
pub const DBUS_PATH: &str = "/dev/sonux/WinProbe";

const KB_SCHEMA: &str = "org.gnome.settings-daemon.plugins.media-keys";
const KB_PATH: &str = "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/winprobe/";
const KB_PATH_WINDOW: &str = "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/winprobe-window/";
const KB_PATH_SCREEN: &str = "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/winprobe-screen/";

const EXT_FILES: [(&str, &str); 3] = [
    ("metadata.json", include_str!("../../../extension/metadata.json")),
    ("extension.js", include_str!("../../../extension/extension.js")),
    ("logic.js", include_str!("../../../extension/logic.js")),
];

static CONN: OnceLock<Connection> = OnceLock::new();

fn conn() -> Option<&'static Connection> {
    if let Some(c) = CONN.get() {
        return Some(c);
    }
    let c = Connection::session().ok()?;
    Some(CONN.get_or_init(|| c))
}

pub fn extension_reachable() -> bool {
    let Some(c) = conn() else { return false };
    c.call_method(
        Some("org.freedesktop.DBus"),
        "/org/freedesktop/DBus",
        Some("org.freedesktop.DBus"),
        "NameHasOwner",
        &(DBUS_NAME,),
    )
    .ok()
    .and_then(|m| m.body().deserialize::<bool>().ok())
    .unwrap_or(false)
}

fn call(method: &str, args: &str) -> Option<Value> {
    let c = conn()?;
    let reply = c
        .call_method(Some(DBUS_NAME), DBUS_PATH, Some(DBUS_NAME), "Call", &(method, args))
        .ok()?;
    let text: String = reply.body().deserialize().ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    if v.get("error").is_some() {
        return None;
    }
    Some(v)
}

fn call_plain(method: &str) -> Result<(), String> {
    let c = conn().ok_or("no session bus")?;
    c.call_method(Some(DBUS_NAME), DBUS_PATH, Some(DBUS_NAME), method, &())
        .map(|_| ())
        .map_err(|e| e.to_string())
}

pub fn toggle(app: &AppHandle) {
    if !extension_reachable() {
        log(app, "Cannot capture: the WinProbe Shell extension isn't answering. Install it in Settings, then log out/in once.");
        return;
    }
    super::hide_main_for_capture(app);
    if let Err(e) = call_plain("Toggle") {
        log(app, format!("Toggle failed: {e}"));
        super::restore_main(app);
    }
}

// ---------------------------------------------------------------- polling

pub fn spawn_poller(app: AppHandle) {
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        let mut active = false;
        let mut reachable = false;
        // Push the newest logic.js into the running Shell (no re-login needed).
        let _ = sync_extension_files();
        loop {
            std::thread::sleep(Duration::from_millis(60));
            let r = extension_reachable();
            if r != reachable {
                reachable = r;
                state.gnome_reachable.store(r, Ordering::Relaxed);
                if r {
                    let _ = reload_logic();
                }
                let _ = app.emit("engine-status", r);
            }
            let a = r && call("IsActive", "[]").and_then(|v| v.as_bool()).unwrap_or(active);
            if active && !a {
                handle_pick(&app);
                super::restore_main(&app);
            }
            // Instant captures (window / screen shortcuts) never show the overlay, so the
            // active -> idle edge above can't see them: collect any waiting pick directly.
            if r && !a && !active && call("HasPick", "[]").and_then(|v| v.as_bool()).unwrap_or(false) {
                handle_pick(&app);
            }
            active = a;
        }
    });
}

fn handle_pick(app: &AppHandle) {
    for _ in 0..240 {
        match call("TakePicked", "[]") {
            Some(v) if v.get("valid").and_then(Value::as_bool) == Some(true) => {
                if let Err(e) = process_pick(app, &v) {
                    log(app, format!("capture failed: {e}"));
                }
                return;
            }
            Some(v) if v.get("pending").and_then(Value::as_bool) == Some(true) => {
                std::thread::sleep(Duration::from_millis(25));
            }
            _ => return, // cancelled
        }
    }
}

fn num(v: &Value, k: &str) -> f64 {
    v.get(k).and_then(Value::as_f64).unwrap_or(0.0)
}

fn process_pick(app: &AppHandle, v: &Value) -> Result<(), String> {
    let (x, y, w, h) = (num(v, "x"), num(v, "y"), num(v, "w"), num(v, "h"));
    let scale = num(v, "scale").max(0.1);
    let label = v.get("app").and_then(Value::as_str).unwrap_or("").to_string();
    let title = v.get("title").and_then(Value::as_str).unwrap_or("");
    let path = PathBuf::from(v.get("path").and_then(Value::as_str).ok_or("no path")?);
    let annotations = v.get("annotations").cloned().unwrap_or(Value::Array(vec![]));
    log(app, format!("picked: {label} | {title} | {x},{y} {w}x{h}"));
    if let Some(ms) = v.get("ms").and_then(Value::as_array) {
        log(app, format!("timing: shell frame {} ms, png written {} ms after the key (source: {})", ms[0], ms[1], v.get("via").and_then(Value::as_str).unwrap_or("?")));
    }
    let t0 = std::time::Instant::now();

    let native = monitor_scale_at((x + w / 2.0) as i32, (y + h / 2.0) as i32).unwrap_or(scale);
    let has_ann = annotations.as_array().map(|a| !a.is_empty()).unwrap_or(false);
    let label = if label.is_empty() { "Region".to_string() } else { label };

    // Fast path: nothing to draw and no resampling -> the Shell's PNG is already the final file.
    if !has_ann && (native - scale).abs() <= 0.01 {
        let png = std::fs::read(&path).map_err(|e| format!("could not read the captured image: {e}"))?;
        let _ = std::fs::remove_file(&path);
        let r = super::save_png(app, png, &label).map(|_| ());
        log(app, format!("timing: pass-through save {} ms", t0.elapsed().as_millis()));
        return r;
    }

    let img = image::open(&path).map_err(|e| format!("could not read the captured image: {e}"))?.to_rgba8();
    let _ = std::fs::remove_file(&path);

    let t_dec = t0.elapsed().as_millis();

    if has_ann {
        // Annotations are drawn by the web frontend (same renderer as the editor).
        let cache = app.state::<AppState>().cache_dir.clone();
        std::fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
        let base = cache.join(format!("compose-{}.png", chrono::Local::now().timestamp_millis()));
        img.save(&base).map_err(|e| e.to_string())?;
        log(app, format!("{} annotation(s) -> compositing in the UI", annotations.as_array().map_or(0, Vec::len)));
        app.emit(
            "compose-capture",
            serde_json::json!({
                "path": base, "annotations": annotations, "scale": scale, "native": native,
                "x": x, "y": y, "label": label
            }),
        )
        .map_err(|e| e.to_string())?;
        return Ok(());
    }

    let img = if (native - scale).abs() > 0.01 {
        let f = native / scale;
        log(app, format!("monitor scale {native} vs capture scale {scale}: resampled to native resolution"));
        fast_resize(
            &img,
            ((img.width() as f64 * f).round() as u32).max(1),
            ((img.height() as f64 * f).round() as u32).max(1),
        )
    } else {
        img
    };
    let t_rs = t0.elapsed().as_millis();
    let r = super::save_rgba(app, &img, &label).map(|_| ());
    log(app, format!("timing: decode {t_dec} ms, resize done {t_rs} ms, saved {} ms", t0.elapsed().as_millis()));
    r
}

/// Bilinear resize, split across all cores (the stock `imageops::resize` is single-threaded
/// and several hundred ms for a full-screen capture).
fn fast_resize(src: &image::RgbaImage, nw: u32, nh: u32) -> image::RgbaImage {
    let (sw, sh) = (src.width() as usize, src.height() as usize);
    let (nw, nh) = (nw as usize, nh as usize);
    let (kx, ky) = (sw as f32 / nw as f32, sh as f32 / nh as f32);
    let raw = src.as_raw();
    let mut out = vec![0u8; nw * nh * 4];
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(nh).max(1);
    let rows_per = nh.div_ceil(threads);
    // Box-filter each output pixel over its source footprint (anti-aliased when shrinking).
    std::thread::scope(|sc| {
        for (band, chunk) in out.chunks_mut(rows_per * nw * 4).enumerate() {
            sc.spawn(move || {
                for (ry, row) in chunk.chunks_mut(nw * 4).enumerate() {
                    let y = band * rows_per + ry;
                    let y0 = ((y as f32 * ky) as usize).min(sh - 1);
                    let y1 = (((y + 1) as f32 * ky).ceil() as usize).clamp(y0 + 1, sh);
                    for x in 0..nw {
                        let x0 = ((x as f32 * kx) as usize).min(sw - 1);
                        let x1 = (((x + 1) as f32 * kx).ceil() as usize).clamp(x0 + 1, sw);
                        let mut acc = [0u32; 4];
                        for yy in y0..y1 {
                            let base = yy * sw * 4;
                            for xx in x0..x1 {
                                let p = &raw[base + xx * 4..base + xx * 4 + 4];
                                for c in 0..4 {
                                    acc[c] += p[c] as u32;
                                }
                            }
                        }
                        let n = ((y1 - y0) * (x1 - x0)) as u32;
                        for c in 0..4 {
                            row[x * 4 + c] = ((acc[c] + n / 2) / n) as u8;
                        }
                    }
                }
            });
        }
    });
    image::RgbaImage::from_raw(nw as u32, nh as u32, out).expect("buffer size matches")
}

fn monitor_scale_at(px: i32, py: i32) -> Option<f64> {
    let text = crate::util::run(&[
        "gdbus", "call", "--session", "--dest", "org.gnome.Mutter.DisplayConfig",
        "--object-path", "/org/gnome/Mutter/DisplayConfig",
        "--method", "org.gnome.Mutter.DisplayConfig.GetCurrentState",
    ])
    .ok()?;
    let re = regex::Regex::new(r"\((-?\d+), (-?\d+), ([\d.]+), (?:uint32 )?\d+, (?:true|false), \[\(").ok()?;
    re.captures_iter(&text)
        .filter_map(|c| Some((c[1].parse::<i32>().ok()?, c[2].parse::<i32>().ok()?, c[3].parse::<f64>().ok()?)))
        .filter(|(x, y, _)| *x <= px && *y <= py)
        .max_by(|a, b| (a.0, a.1).cmp(&(b.0, b.1)))
        .map(|c| c.2)
}

// ------------------------------------------------------- extension plumbing

fn ext_dir() -> PathBuf {
    // Not XDG_DATA_HOME: sandboxes remap it, and GNOME Shell never reads the remap.
    dirs::home_dir().unwrap_or_default().join(".local/share/gnome-shell/extensions").join(EXT_UUID)
}

pub fn sync_extension_files() -> Result<Vec<&'static str>, String> {
    let dir = ext_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut changed = Vec::new();
    for (name, src) in EXT_FILES {
        let dst = dir.join(name);
        if std::fs::read_to_string(&dst).ok().as_deref() != Some(src) {
            std::fs::write(&dst, src).map_err(|e| e.to_string())?;
            changed.push(name);
        }
    }
    Ok(changed)
}

pub fn reload_logic() -> Result<String, String> {
    let c = conn().ok_or("no session bus")?;
    let reply = c
        .call_method(Some(DBUS_NAME), DBUS_PATH, Some(DBUS_NAME), "Reload", &())
        .map_err(|e| e.to_string())?;
    let err: String = reply.body().deserialize().map_err(|e| e.to_string())?;
    if err.is_empty() { Ok("logic reloaded".into()) } else { Err(err) }
}

pub fn install_extension() -> String {
    let changed = match sync_extension_files() {
        Ok(c) => c,
        Err(e) => return format!("could not copy extension files: {e}"),
    };
    let note = match crate::util::run(&["gnome-extensions", "enable", EXT_UUID]) {
        Ok(_) => "enabled".to_string(),
        Err(e) => format!("enable failed ({e}); it will be enabled after you log out and in"),
    };
    if extension_reachable() {
        let _ = reload_logic();
    }
    format!(
        "extension files updated ({}) in {}; {note}. A brand-new extension needs one log out/in.",
        if changed.is_empty() { "no changes".to_string() } else { changed.join(", ") },
        ext_dir().display()
    )
}

// ---------------------------------------------------------------- shortcut

/// Canonical key token for any spelling we may have stored ("\\", "Esc", "Backslash"...).
pub fn canonical_key(key: &str) -> String {
    match key {
        "\\" => "Backslash", "," => "Comma", "." => "Period", "/" => "Slash", ";" => "Semicolon",
        "'" => "Quote", "[" => "BracketLeft", "]" => "BracketRight", "-" => "Minus", "=" => "Equal",
        "`" => "Backquote", " " => "Space", "Escape" => "Esc", "Return" => "Enter", "Del" => "Delete",
        "Ins" => "Insert", "PgUp" => "PageUp", "PgDown" => "PageDown", "ArrowUp" => "Up",
        "ArrowDown" => "Down", "ArrowLeft" => "Left", "ArrowRight" => "Right", "PrintScreen" => "Print",
        other => other,
    }
    .to_string()
}

/// Asks the Shell to raise + focus our main window (Wayland apps can't do it themselves).
pub fn focus_main() -> bool {
    focus_window("pengo")
}

/// Raises + focuses the first window whose class / app id contains `needle` (case-insensitive).
pub fn focus_window(needle: &str) -> bool {
    let arg = serde_json::json!([needle]).to_string();
    call("FocusWindow", &arg).and_then(|v| v.as_bool()).unwrap_or(false)
}

fn read_paths() -> Vec<String> {
    let Ok(text) = crate::util::run(&["gsettings", "get", KB_SCHEMA, "custom-keybindings"]) else { return vec![] };
    regex::Regex::new(r"'([^']+)'")
        .map(|re| re.captures_iter(&text).map(|c| c[1].to_string()).collect())
        .unwrap_or_default()
}

fn write_paths(paths: &[String]) -> bool {
    let list = format!("[{}]", paths.iter().map(|p| format!("'{p}'")).collect::<Vec<_>>().join(", "));
    crate::util::run(&["gsettings", "set", KB_SCHEMA, "custom-keybindings", &list]).is_ok()
}

/// Removes all three capture shortcuts from GNOME's custom keybindings. Called when Pengo quits,
/// so the shortcuts (which talk straight to the Shell extension) only exist while the app runs.
pub fn unregister_all() {
    let mut paths = read_paths();
    let before = paths.len();
    paths.retain(|p| ![KB_PATH, KB_PATH_WINDOW, KB_PATH_SCREEN].contains(&p.as_str()));
    if paths.len() != before {
        write_paths(&paths);
    }
}

/// Immediate capture actions share the same extension/poller save pipeline.
pub fn capture_mode(app: &AppHandle, action: &str) {
    let method = match action { "window" => "CaptureWindow", "screen" => "CaptureScreen", _ => return };
    if !extension_reachable() { log(app, "Cannot capture: the WinProbe Shell extension is unavailable."); return; }
    // Match the previous direct extension command: preserve the window under
    // the pointer and let the Shell take its snapshot before any focus changes.
    if call(method, "[]").is_none() { log(app, format!("{method} failed")); }
}
