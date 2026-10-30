mod autostart;
mod capture;
mod clipboard;
mod library;
mod settings;
mod util;
mod updates;
mod update_install;
mod launch_path;
mod restart;
mod shortcuts;
mod input_shortcuts;
mod linux_shortcuts;

use capture::Backend;
use serde::Serialize;
use settings::{Settings, SettingsStore};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State};


pub struct AppState {
    pub settings: SettingsStore,
    pub backend: Backend,
    pub frozen: Mutex<Option<capture::x11::Frozen>>,
    pub restore_main: AtomicBool,
    pub gnome_reachable: AtomicBool,
    pub tray_ok: AtomicBool,
    pub logs: Mutex<Vec<String>>,
    pub cache_dir: PathBuf,
}

pub fn log(app: &AppHandle, msg: impl Into<String>) {
    let line = format!("{}  {}", chrono::Local::now().format("%H:%M:%S"), msg.into());
    eprintln!("[pengo] {line}");
    let st = app.state::<AppState>();
    {
        let mut logs = st.logs.lock().unwrap();
        logs.push(line.clone());
        let excess = logs.len().saturating_sub(300);
        logs.drain(..excess);
    }
    let _ = app.emit("log", line);
}

// ------------------------------------------------------------------ commands

#[tauri::command]
fn get_settings(state: State<AppState>) -> Settings {
    state.settings.get()
}

#[tauri::command]
fn set_settings(app: AppHandle, state: State<AppState>, settings: Settings) -> Result<(), String> {
    let _guard = shortcuts::CONFIG_LOCK.lock().map_err(|e| e.to_string())?;
    let mut settings = settings;
    let old = state.settings.get();
    if restart::is_restarting() { return Err("Application is restarting".into()); }
    // Only set_auto_update may change this preference: it cancels in-flight work.
    settings.auto_update_enabled = old.auto_update_enabled;
    for shortcut in [&mut settings.shortcut, &mut settings.shortcut_window, &mut settings.shortcut_screen] {
        *shortcut = shortcut.split('+').map(capture::gnome::canonical_key).collect::<Vec<_>>().join("+");
    }
    let changed = (settings.shortcut_fallback && !shortcuts::shortcut_status().active) || old.shortcut != settings.shortcut || old.shortcut_window != settings.shortcut_window
        || old.shortcut_screen != settings.shortcut_screen || old.shortcut_fallback != settings.shortcut_fallback;
    // Reject invalid/duplicate bindings before touching live registrations.
    if changed {
        input_shortcuts::validate(shortcuts::bindings(&settings, state.backend))?;
        if let Err(e) = shortcuts::configure(&app, &settings) {
            // Turning evdev off must stay possible even on an unsupported desktop.
            if !(old.shortcut_fallback && !settings.shortcut_fallback) {
                let _ = shortcuts::configure(&app, &old);
                let _ = app.emit("shortcut-failed", &e);
                return Err(e);
            }
        }
    }
    if old.start_with_system != settings.start_with_system {
        if let Err(e) = autostart::set(settings.start_with_system) {
            if changed { let _ = shortcuts::configure(&app, &old); }
            return Err(e);
        }
    }
    settings.image_format = capture::format_ext(&settings.image_format).to_string();
    settings.jpeg_quality = settings.jpeg_quality.clamp(1, 100);
    if let Err(e) = state.settings.set(settings) {
        if changed { let _ = shortcuts::configure(&app, &old); }
        let _ = autostart::set(old.start_with_system);
        return Err(e);
    }
    Ok(())
}

#[derive(Serialize)]
struct EnvInfo {
    session: String,
    desktop: String,
    backend: &'static str,
    reachable: bool,
    binding: Option<String>,
    tray: bool,
    version: &'static str,
}

#[tauri::command]
fn env_info(state: State<AppState>) -> EnvInfo {
    EnvInfo {
        session: std::env::var("XDG_SESSION_TYPE").unwrap_or_default(),
        desktop: std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default(),
        backend: state.backend.id(),
        reachable: match state.backend {
            Backend::Gnome => capture::gnome::extension_reachable(),
            Backend::X11 => true,
            Backend::Unsupported => false,
        },
        binding: None,
        tray: state.tray_ok.load(Ordering::Relaxed),
        version: env!("CARGO_PKG_VERSION"),
    }
}

#[tauri::command]
fn get_log(state: State<AppState>) -> Vec<String> {
    state.logs.lock().unwrap().clone()
}

#[tauri::command]
async fn list_items(state: State<'_, AppState>) -> Result<Vec<library::Item>, String> {
    let dir = state.settings.output_dir();
    tauri::async_runtime::spawn_blocking(move || library::scan(&dir)).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn thumbnail(state: State<'_, AppState>, path: String) -> Result<String, String> {
    let cache = state.cache_dir.join("thumbs");
    tauri::async_runtime::spawn_blocking(move || {
        library::thumbnail(&cache, Path::new(&path)).map(|p| p.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn delete_items(app: AppHandle, state: State<AppState>, paths: Vec<String>) -> Result<usize, String> {
    let root = state.settings.output_dir();
    let mut n = 0;
    for p in &paths {
        let p = Path::new(p);
        if library::is_image(p) && p.starts_with(&root) && std::fs::remove_file(p).is_ok() {
            n += 1;
        }
    }
    let _ = app.emit("library-changed", ());
    Ok(n)
}

#[tauri::command]
fn rename_item(app: AppHandle, path: String, name: String) -> Result<String, String> {
    let dest = library::rename(Path::new(&path), &name)?;
    let _ = app.emit("library-changed", ());
    Ok(dest.to_string_lossy().into_owned())
}

/// Brings the default file manager to the front once its window exists. A freshly launched
/// (or already open) window is otherwise left behind by the compositor's focus-stealing rules.
fn focus_file_manager(app: &AppHandle) {
    if app.state::<AppState>().backend != Backend::Gnome {
        return;
    }
    std::thread::spawn(|| {
        // "org.gnome.Nautilus.desktop" -> "org.gnome.nautilus" matches the window's app id / class.
        let id = util::run(&["xdg-mime", "query", "default", "inode/directory"]).unwrap_or_default();
        let needle = id.trim().trim_end_matches(".desktop").to_lowercase();
        let needle = if needle.is_empty() { "nautilus".to_string() } else { needle };
        // The window may take a moment to appear (or be reused), so ask a few times.
        for delay in [150u64, 250, 400, 600] {
            std::thread::sleep(std::time::Duration::from_millis(delay));
            capture::gnome::focus_window(&needle);
        }
    });
}

#[tauri::command]
fn reveal_item(app: AppHandle, path: String) -> Result<(), String> {
    let uri = format!("file://{path}");
    // Highlight the file in the file manager; fall back to opening the folder.
    let ok = util::run(&[
        "gdbus", "call", "--session", "--dest", "org.freedesktop.FileManager1",
        "--object-path", "/org/freedesktop/FileManager1",
        "--method", "org.freedesktop.FileManager1.ShowItems", &format!("['{}']", uri.replace('\'', "%27")), "",
    ])
    .is_ok();
    if !ok {
        let dir = Path::new(&path).parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or(path);
        std::process::Command::new("xdg-open").arg(dir).spawn().map_err(|e| e.to_string())?;
    }
    focus_file_manager(&app);
    Ok(())
}

#[tauri::command]
fn open_external(app: AppHandle, path: String) -> Result<(), String> {
    let is_dir = Path::new(&path).is_dir();
    std::process::Command::new("xdg-open").arg(path).spawn().map_err(|e| e.to_string())?;
    if is_dir {
        focus_file_manager(&app);
    }
    Ok(())
}

#[tauri::command]
fn copy_item(path: String) -> Result<(), String> {
    let data = std::fs::read(&path).map_err(|e| e.to_string())?;
    // The clipboard wants PNG; convert anything else first.
    let png = if path.to_lowercase().ends_with(".png") {
        data
    } else {
        let img = image::load_from_memory(&data).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png).map_err(|e| e.to_string())?;
        out
    };
    clipboard::copy_png(&png)
}

fn header(req: &tauri::ipc::Request<'_>, name: &str) -> Option<String> {
    let raw = req.headers().get(name)?.to_str().ok()?;
    // Values are percent-encoded by the frontend (paths can contain anything).
    let b = raw.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&raw[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8(out).ok()
}

/// Saves edited PNG bytes (converted to the target format). x-mode: "replace" (overwrite x-path) | "copy" (new file beside it).
#[tauri::command]
fn save_image(app: AppHandle, state: State<AppState>, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else { return Err("expected raw bytes".into()) };
    let path = PathBuf::from(header(&request, "x-path").ok_or("missing x-path")?);
    let mode = header(&request, "x-mode").unwrap_or_else(|| "copy".into());
    let cfg = state.settings.get();
    // Replacing keeps the original's format; a new copy uses the format chosen in Settings.
    let want = if mode == "replace" {
        path.extension().and_then(|e| e.to_str()).unwrap_or("png").to_string()
    } else {
        cfg.image_format.clone()
    };
    let (bytes, ext) = capture::png_to_format(data, &want, cfg.jpeg_quality)?;
    let target = if mode == "replace" {
        path.with_extension(ext)
    } else {
        let dir = path.parent().map(Path::to_path_buf).unwrap_or_else(|| state.settings.output_dir());
        let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "image".into());
        let stem = stem.split("-edited").next().unwrap_or(&stem).to_string();
        library::unique_path(&dir, &format!("{stem}-edited"), ext)
    };
    std::fs::write(&target, bytes).map_err(|e| e.to_string())?;
    if mode == "replace" && target != path {
        let _ = std::fs::remove_file(&path);
    }
    let _ = app.emit("library-changed", ());
    Ok(target.to_string_lossy().into_owned())
}

/// Final PNG of a capture whose annotations the frontend composited (GNOME path).
#[tauri::command]
fn finish_compose(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else { return Err("expected raw bytes".into()) };
    let label = header(&request, "x-label").unwrap_or_else(|| "capture".into());
    if let Some(base) = header(&request, "x-base") {
        let _ = std::fs::remove_file(base);
    }
    capture::save_png(&app, data.clone(), &label).map(|p| p.to_string_lossy().into_owned())
}

/// Raw file bytes for the editor (a blob URL keeps the canvas untainted, unlike asset://).
#[tauri::command]
fn read_file(state: State<AppState>, path: String) -> Result<tauri::ipc::Response, String> {
    let p = Path::new(&path);
    let allowed = p.starts_with(state.settings.output_dir()) || p.starts_with(&state.cache_dir);
    if !allowed || !library::is_image(p) {
        return Err("path not allowed".into());
    }
    std::fs::read(p).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
}

#[tauri::command]
fn copy_bytes(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else { return Err("expected raw bytes".into()) };
    clipboard::copy_png(data)
}

#[tauri::command]
fn start_capture(app: AppHandle) {
    capture::start(&app);
}

#[tauri::command]
fn overlay_state(app: AppHandle) -> Result<capture::OverlayState, String> {
    capture::overlay_state(&app)
}

#[tauri::command]
fn overlay_done(app: AppHandle, selection: Option<capture::Selection>) {
    capture::overlay_done(&app, selection);
}

#[tauri::command]
fn install_extension(app: AppHandle) -> String {
    let msg = capture::gnome::install_extension();
    log(&app, msg.clone());
    msg
}

/// Frontend errors end up in the Diagnostics log (and stderr), so they're never silent.
#[tauri::command]
fn js_log(app: AppHandle, message: String) {
    log(&app, format!("[ui] {message}"));
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

// ------------------------------------------------------------------ setup

/// Our canonical accelerator -> the global-hotkey crate's spelling.
fn x11_accel(accel: &str) -> String {
    accel
        .split('+')
        .map(|p| match capture::gnome::canonical_key(p).as_str() {
            "Esc" => "Escape".to_string(),
            "Print" => "PrintScreen".to_string(),
            "Up" => "ArrowUp".to_string(),
            "Down" => "ArrowDown".to_string(),
            "Left" => "ArrowLeft".to_string(),
            "Right" => "ArrowRight".to_string(),
            other => other.to_string(),
        })
        .collect::<Vec<_>>()
        .join("+")
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Pengo", true, None::<&str>)?;
    let cap = MenuItem::with_id(app, "capture", "Capture", true, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", "Restart Application", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &cap, &restart, &quit])?;
    TrayIconBuilder::new()
        .icon(app.default_window_icon().cloned().ok_or(tauri::Error::WindowNotFound)?)
        .tooltip("Pengo")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, ev| match ev.id.as_ref() {
            "open" => capture::show_main(app),
            "capture" => capture::start(app),
            "restart" => {
                if let Err(e) = restart::restart_app(app.clone()) { log(app, format!("Restart failed: {e}")); }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                capture::show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn wants_capture(args: &[String]) -> bool {
    args.iter().any(|a| a == "--capture")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
fn settings_start_with_system(app: &AppHandle) -> bool {
    app.state::<AppState>().settings.get().start_with_system
}

pub fn run() {
    restart::wait_for_restart_parent();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if shortcuts::relay(app, &args) {
                return;
            } else if wants_capture(&args) {
                capture::start(app);
            } else {
                capture::show_main(app);
            }
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .manage(updates::UpdateRuntime::default())
        .setup(|app| {
            let handle = app.handle().clone();
            // Set explicitly (same as Sonux): the bundler's implicit default-window-icon is
            // unreliable for the Linux taskbar / dash across GTK and Wayland versions.
            if let (Some(window), Ok(icon)) = (
                app.get_webview_window("main"),
                tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png")),
            ) {
                let _ = window.set_icon(icon);
            }
            let config_dir = app.path().app_config_dir()?;
            let state = AppState {
                settings: SettingsStore::load(config_dir),
                backend: Backend::detect(),
                frozen: Mutex::new(None),
                restore_main: AtomicBool::new(false),
                gnome_reachable: AtomicBool::new(false),
                tray_ok: AtomicBool::new(false),
                logs: Mutex::new(Vec::new()),
                cache_dir: app.path().app_cache_dir()?,
            };
            let backend = state.backend;
            app.manage(state);
            updates::start(handle.clone());

            if build_tray(app).is_ok() {
                app.state::<AppState>().tray_ok.store(true, Ordering::Relaxed);
            }

            if backend == Backend::Gnome {
                capture::gnome::spawn_poller(handle.clone());
                // Remove the previous direct-to-extension bindings once on migration.
                capture::gnome::unregister_all();
            }
            let settings = app.state::<AppState>().settings.get();
            if let Err(e) = shortcuts::configure(&handle, &settings) { log(&handle, e); }

            // Dev aid (debug builds): PENGO_DEV_EVAL=<dir> runs <dir>/eval.js in the main
            // webview and <dir>/eval-overlay.js in the overlay, then deletes the file.
            #[cfg(debug_assertions)]
            if let Some(dir) = std::env::var_os("PENGO_DEV_EVAL").map(PathBuf::from) {
                let h = handle.clone();
                std::thread::spawn(move || loop {
                    std::thread::sleep(std::time::Duration::from_millis(400));
                    for (file, label) in [("eval.js", "main"), ("eval-overlay.js", "overlay")] {
                        let path = dir.join(file);
                        if let Ok(js) = std::fs::read_to_string(&path) {
                            let _ = std::fs::remove_file(&path);
                            if let Some(w) = h.get_webview_window(label) {
                                let _ = w.eval(&js);
                            }
                        }
                    }
                });
            }

            let args: Vec<String> = std::env::args().collect();
            if shortcuts::relay(&handle, &args) {
                // The cold-start relay has already dispatched the requested action.
            } else if wants_capture(&args) {
                capture::start(&handle);
            } else {
                let st = handle.state::<AppState>();
                let tray = st.tray_ok.load(Ordering::Relaxed);
                let at_login = args.iter().any(|a| a == "--startup");
                let hidden = args.iter().any(|a| a == "--hidden")
                    || (at_login && tray && st.settings.get().start_minimized);
                if !hidden {
                    capture::show_main(&handle);
                }
            }
            if settings_start_with_system(&handle) {
                let _ = autostart::set(true);   // refresh the entry if the install path moved
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Resized(_) = event {
                if window.label() == "main" && window.is_minimized().unwrap_or(false) {
                    let st = window.app_handle().state::<AppState>();
                    if st.settings.get().minimize_to_tray && st.tray_ok.load(Ordering::Relaxed) {
                        let _ = window.hide();
                    }
                }
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                match window.label() {
                    "main" => {
                        let st = app.state::<AppState>();
                        if st.settings.get().close_to_tray && st.tray_ok.load(Ordering::Relaxed) {
                            api.prevent_close();
                            let _ = window.hide();
                        }
                    }
                    "overlay" => {
                        // Closed by the WM (Alt+F4): treat as cancel.
                        if app.state::<AppState>().frozen.lock().unwrap().is_some() {
                            capture::overlay_done(app, None);
                        }
                    }
                    _ => {}
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_settings, set_settings, env_info, get_log, list_items, thumbnail, delete_items,
            rename_item, reveal_item, open_external, copy_item, copy_bytes, read_file, save_image, finish_compose,
            start_capture, overlay_state, overlay_done, install_extension, js_log, quit_app,
            shortcuts::shortcut_status, input_shortcuts::enable_input_shortcut_access,
            updates::get_update_status, updates::set_auto_update, updates::check_and_install_update, restart::restart_app
        ])
        .build(tauri::generate_context!())
        .expect("error while building Pengo")
        .run(|app, event| {
            // Global shortcuts live only as long as the app does.
            if let tauri::RunEvent::Exit = event {
                shortcuts::shutdown(app);
            }
        });
}
