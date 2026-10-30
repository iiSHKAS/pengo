//! Persistent user settings (JSON in the app config dir).

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Settings {
    pub output_dir: String,
    /// Qt-style accelerator, e.g. "Ctrl+Shift+E".
    pub shortcut: String,
    /// Explicit user opt-in to read keyboard events with evdev.
    pub shortcut_fallback: bool,
    /// Instantly captures the window under the mouse ("" = disabled).
    pub shortcut_window: String,
    /// Instantly captures the whole screen the mouse is on ("" = disabled).
    pub shortcut_screen: String,
    /// Format of saved captures: "png" | "jpg" | "webp" | "bmp".
    pub image_format: String,
    /// JPEG quality, 1..=100.
    pub jpeg_quality: u8,
    pub copy_to_clipboard: bool,
    /// Closing the window hides it to the tray instead of quitting.
    #[serde(alias = "keep_running")]
    pub close_to_tray: bool,
    /// Minimizing the window hides it to the tray.
    pub minimize_to_tray: bool,
    /// Launch at login (XDG autostart entry).
    pub start_with_system: bool,
    /// When launched at login, start hidden in the tray.
    pub start_minimized: bool,
    /// "en" | "ar" | "auto"
    pub language: String,
    /// "dark" | "light" | "auto"
    pub theme: String,
    /// "gallery" | "editor"
    pub after_capture: String,
    pub notifications: bool,
    /// Signed AppImage updates, enabled by default (same as Sonux).
    pub auto_update_enabled: bool,
    pub favorites: Vec<String>,
}

impl Default for Settings {
    fn default() -> Self {
        let pictures = dirs::picture_dir()
            .or_else(|| dirs::home_dir().map(|h| h.join("Pictures")))
            .unwrap_or_else(|| PathBuf::from("."));
        Self {
            output_dir: pictures.join("Pengo").to_string_lossy().into_owned(),
            shortcut: "Ctrl+Shift+E".into(),
            shortcut_fallback: false,
            shortcut_window: "Ctrl+Alt+W".into(),
            shortcut_screen: "Ctrl+Alt+S".into(),
            image_format: "png".into(),
            jpeg_quality: 90,
            copy_to_clipboard: true,
            close_to_tray: true,
            minimize_to_tray: false,
            start_with_system: false,
            start_minimized: false,
            language: "auto".into(),
            theme: "dark".into(),
            after_capture: "gallery".into(),
            notifications: true,
            auto_update_enabled: true,
            favorites: Vec::new(),
        }
    }
}

pub struct SettingsStore {
    path: PathBuf,
    inner: Mutex<Settings>,
}

impl SettingsStore {
    pub fn load(config_dir: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&config_dir);
        let path = config_dir.join("settings.json");
        let inner = std::fs::read_to_string(&path)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default();
        Self { path, inner: Mutex::new(inner) }
    }

    pub fn get(&self) -> Settings {
        self.inner.lock().unwrap().clone()
    }

    pub fn set(&self, s: Settings) -> Result<(), String> {
        let text = serde_json::to_string_pretty(&s).map_err(|e| e.to_string())?;
        std::fs::write(&self.path, text).map_err(|e| e.to_string())?;
        *self.inner.lock().unwrap() = s;
        Ok(())
    }

    pub fn output_dir(&self) -> PathBuf {
        PathBuf::from(self.get().output_dir)
    }
}
