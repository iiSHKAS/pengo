//! Shortcut lifecycle shared by startup, settings, GNOME relays and evdev.
use crate::{capture, input_shortcuts, linux_shortcuts, settings::Settings, AppState};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU8, Ordering},
        Mutex,
    },
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

pub static CONFIG_LOCK: Mutex<()> = Mutex::new(());
static SOURCE: AtomicU8 = AtomicU8::new(0); // 0 stopped, 1 native, 2 evdev
static STATUS: Mutex<Status> = Mutex::new(Status {
    active: false,
    fallback: false,
    error: String::new(),
});
#[derive(Clone, serde::Serialize)]
pub struct Status {
    pub active: bool,
    pub fallback: bool,
    pub error: String,
}
#[tauri::command]
pub fn shortcut_status() -> Status {
    STATUS.lock().unwrap().clone()
}
fn publish(app: &AppHandle, active: bool, fallback: bool, error: String) {
    let status = Status {
        active,
        fallback,
        error,
    };
    *STATUS.lock().unwrap() = status.clone();
    let _ = app.emit("shortcut-status", status);
}
pub fn input_availability(app: &AppHandle, available: bool) {
    if SOURCE.load(Ordering::Acquire) == 2 {
        publish(
            app,
            available,
            true,
            if available {
                String::new()
            } else {
                "No readable keyboard. Reconnect it or enable keyboard access again.".into()
            },
        );
    }
}
pub fn bindings(settings: &Settings, backend: capture::Backend) -> HashMap<String, String> {
    let mut bindings = HashMap::new();
    for (action, shortcut) in [
        ("region", &settings.shortcut),
        ("window", &settings.shortcut_window),
        ("screen", &settings.shortcut_screen),
    ] {
        if !shortcut.is_empty() && (action == "region" || backend == capture::Backend::Gnome) {
            bindings.insert(action.into(), crate::x11_accel(shortcut));
        }
    }
    bindings
}
// Caller serializes settings transactions with CONFIG_LOCK. Never hold STATUS
// while joining the reader: it can publish a device-disconnection notification.
pub fn configure(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let bindings = bindings(settings, app.state::<AppState>().backend);
    input_shortcuts::validate(bindings.clone())?;
    SOURCE.store(0, Ordering::Release);
    input_shortcuts::stop();
    let result = (|| {
        if let Err(e) = app.global_shortcut().unregister_all() {
            // Native callbacks are gated by SOURCE even when cleanup fails.
            // A broken native backend must not prevent opting into evdev.
            if !settings.shortcut_fallback {
                return Err(e.to_string());
            }
            crate::log(app, format!("Native shortcut cleanup failed: {e}"));
        }
        let backend = linux_shortcuts::detect_shortcut_backend();
        if settings.shortcut_fallback {
            if backend == linux_shortcuts::ShortcutBackend::GnomeWayland {
                if let Err(e) =
                    linux_shortcuts::sync_gnome_shortcuts(app.clone(), false, HashMap::new())
                {
                    crate::log(app, format!("GNOME shortcut cleanup failed: {e}"));
                }
            }
            input_shortcuts::sync_input_shortcuts(app.clone(), true, bindings)?;
            SOURCE.store(2, Ordering::Release);
        } else {
            if cfg!(debug_assertions)
                && std::env::var("PENGO_SIMULATE_SHORTCUT_FAILURE").as_deref() == Ok("1")
            {
                if backend == linux_shortcuts::ShortcutBackend::GnomeWayland {
                    linux_shortcuts::sync_gnome_shortcuts(app.clone(), false, HashMap::new())?;
                }
                return Err("Simulated native shortcut registration failure.".into());
            }
            match backend {
                linux_shortcuts::ShortcutBackend::GnomeWayland => {
                    if let Err(e) =
                        linux_shortcuts::sync_gnome_shortcuts(app.clone(), true, bindings)
                    {
                        let _ = linux_shortcuts::sync_gnome_shortcuts(
                            app.clone(),
                            false,
                            HashMap::new(),
                        );
                        return Err(e);
                    }
                }
                linux_shortcuts::ShortcutBackend::X11 => {
                    for (action, shortcut) in bindings {
                        if let Err(e) = app.global_shortcut().on_shortcut(
                            shortcut.as_str(),
                            move |app, _, event| {
                                if event.state() == ShortcutState::Pressed {
                                    dispatch(app, &action, false);
                                }
                            },
                        ) {
                            let _ = app.global_shortcut().unregister_all();
                            return Err(e.to_string());
                        }
                    }
                }
                linux_shortcuts::ShortcutBackend::Unsupported => {
                    return Err(
                        "Native global shortcuts currently support X11 and GNOME Wayland only."
                            .into(),
                    )
                }
            }
            SOURCE.store(1, Ordering::Release);
        }
        Ok(())
    })();
    publish(
        app,
        result.is_ok(),
        settings.shortcut_fallback,
        result.as_ref().err().cloned().unwrap_or_default(),
    );
    result
}
pub fn dispatch(app: &AppHandle, action: &str, input: bool) {
    if SOURCE.load(Ordering::Acquire) != if input { 2 } else { 1 } {
        return;
    }
    // Keep the evdev loop responsive while capture waits for the compositor.
    let app = app.clone();
    let action = action.to_string();
    std::thread::spawn(move || {
        if SOURCE.load(Ordering::Acquire) != if input { 2 } else { 1 } {
            return;
        }
        match action.as_str() {
            "region" => capture::start(&app),
            "window" | "screen" if app.state::<AppState>().backend == capture::Backend::Gnome => {
                capture::gnome::capture_mode(&app, &action)
            }
            _ => {}
        }
    });
}
pub fn relay(app: &AppHandle, args: &[String]) -> bool {
    if let Some(i) = args.iter().position(|a| a == "--shortcut") {
        if let Some(action) = args.get(i + 1) {
            dispatch(app, action, false);
        }
        true
    } else {
        false
    }
}
pub fn shutdown(app: &AppHandle) {
    SOURCE.store(0, Ordering::Release);
    input_shortcuts::stop();
    let _ = app.global_shortcut().unregister_all();
    if linux_shortcuts::detect_shortcut_backend() == linux_shortcuts::ShortcutBackend::GnomeWayland
    {
        let _ = linux_shortcuts::sync_gnome_shortcuts(app.clone(), false, HashMap::new());
    }
}
