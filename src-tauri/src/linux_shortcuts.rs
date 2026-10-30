// Adapted from Sonux / Mixweave (GPL-3.0-only). See docs/shortcut-fallback.md.
//! Global shortcuts on Wayland cannot be grabbed by an application directly
//! (the compositor mediates all global input for security reasons). On GNOME,
//! `tauri-plugin-global-shortcut` falls back to an X11/XWayland grab that only
//! fires while our own window has focus. GNOME's long-standing
//! "custom keybinding" mechanism (Settings > Keyboard > Custom Shortcuts) runs
//! an arbitrary command on a system-wide key press regardless of focus, and
//! has existed since GNOME 3 with no portal/version gate. We drive that
//! mechanism through `gsettings`. GNOME sends `--shortcut <action>` directly
//! to the existing single-instance D-Bus endpoint via gdbus, avoiding full
//! application startup on each press. Launching the binary is a cold-start
//! fallback only.

use std::collections::HashMap;
use std::process::Command;

const MEDIA_KEYS_SCHEMA: &str = "org.gnome.settings-daemon.plugins.media-keys";
const CUSTOM_KEYBINDING_SCHEMA: &str =
    "org.gnome.settings-daemon.plugins.media-keys.custom-keybinding";
const KEYBINDINGS_KEY: &str = "custom-keybindings";
const PATH_PREFIX: &str = "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/pengo-";
const MEDIA_KEYS_SERVICE: &str = "org.gnome.SettingsDaemon.MediaKeys.service";

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ShortcutBackend {
    /// X11 (or XWayland-hosted session): the existing plugin grab already
    /// works system-wide, nothing to change.
    X11,
    /// Wayland on GNOME: drive shortcuts through `gsettings` custom
    /// keybindings instead of the plugin grab.
    GnomeWayland,
    /// Wayland without a supported native integration. The frontend offers
    /// opt-in evdev access; an XWayland grab is not global on this desktop.
    Unsupported,
}

pub(crate) fn is_wayland() -> bool {
    std::env::var_os("WAYLAND_DISPLAY").is_some()
        || std::env::var("XDG_SESSION_TYPE").is_ok_and(|s| s == "wayland")
}

pub(crate) fn is_gnome() -> bool {
    std::env::var("XDG_CURRENT_DESKTOP")
        .map(|value| value.to_ascii_lowercase().contains("gnome"))
        .unwrap_or(false)
}

fn gsettings_available() -> bool {
    Command::new("gsettings")
        .arg("--version")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

#[tauri::command]
pub fn detect_shortcut_backend() -> ShortcutBackend {
    if !is_wayland() {
        ShortcutBackend::X11
    } else if is_gnome() && gsettings_available() {
        ShortcutBackend::GnomeWayland
    } else {
        ShortcutBackend::Unsupported
    }
}

/// Translate Pengo's own recorder syntax (`Ctrl+Alt+M`, matching what
/// `shortcutFromKeyboardEvent` in the frontend produces) into a GTK
/// accelerator string GNOME's `custom-keybinding` schema understands.
fn to_gtk_accelerator(shortcut: &str) -> Option<String> {
    if shortcut.is_empty() {
        return None;
    }
    let parts: Vec<&str> = shortcut.split('+').collect();
    let (modifiers, key) = parts.split_at(parts.len() - 1);
    let key = key.first()?;

    let mut accelerator = String::new();
    for modifier in modifiers {
        accelerator.push_str(match *modifier {
            "Ctrl" => "<Control>",
            "Alt" => "<Alt>",
            "Shift" => "<Shift>",
            "Super" => "<Super>",
            _ => return None,
        });
    }
    accelerator.push_str(&gtk_keysym(key)?);
    Some(accelerator)
}

fn gtk_keysym(key: &str) -> Option<String> {
    if let Some(fkey) = key.strip_prefix('F') {
        if !fkey.is_empty() && fkey.chars().all(|c| c.is_ascii_digit()) {
            return Some(key.to_string());
        }
    }
    if let Some(digit) = key.strip_prefix("Numpad") {
        if digit.len() == 1 && digit.chars().all(|c| c.is_ascii_digit()) {
            return Some(format!("KP_{digit}"));
        }
    }
    if key.chars().count() == 1 {
        let ch = key.chars().next()?;
        if ch.is_ascii_alphabetic() {
            return Some(ch.to_ascii_lowercase().to_string());
        }
        if ch.is_ascii_digit() {
            return Some(ch.to_string());
        }
    }
    let name = match key {
        "ArrowUp" => "Up",
        "ArrowDown" => "Down",
        "ArrowLeft" => "Left",
        "ArrowRight" => "Right",
        "Backquote" => "grave",
        "Backslash" => "backslash",
        "BracketLeft" => "bracketleft",
        "BracketRight" => "bracketright",
        "CapsLock" => "Caps_Lock",
        "Comma" => "comma",
        "End" => "End",
        "Enter" => "Return",
        "Equal" => "equal",
        "Escape" => "Escape",
        "Home" => "Home",
        "Insert" => "Insert",
        "Minus" => "minus",
        "PageDown" => "Page_Down",
        "PageUp" => "Page_Up",
        "Pause" => "Pause",
        "Period" => "period",
        "PrintScreen" => "Print",
        "Quote" => "apostrophe",
        "ScrollLock" => "Scroll_Lock",
        "Semicolon" => "semicolon",
        "Slash" => "slash",
        "Space" => "space",
        "Tab" => "Tab",
        "Backspace" => "BackSpace",
        "Delete" => "Delete",
        "AudioVolumeDown" => "AudioLowerVolume",
        "AudioVolumeMute" => "AudioMute",
        "AudioVolumeUp" => "AudioRaiseVolume",
        "MediaPause" => "AudioPause",
        "MediaPlay" => "AudioPlay",
        "MediaPlayPause" => "AudioPlay",
        "MediaStop" => "AudioStop",
        "MediaTrackNext" => "AudioNext",
        "MediaTrackPrevious" => "AudioPrev",
        "NumLock" => "Num_Lock",
        "NumpadAdd" => "KP_Add",
        "NumpadDecimal" => "KP_Decimal",
        "NumpadDivide" => "KP_Divide",
        "NumpadEnter" => "KP_Enter",
        "NumpadEqual" => "KP_Equal",
        "NumpadMultiply" => "KP_Multiply",
        "NumpadSubtract" => "KP_Subtract",
        _ => return None,
    };
    Some(name.to_string())
}

/// dconf path segments only tolerate `[A-Za-z0-9_-]`; anything else
/// (":" from a "channel:<name>:<kind>" action id, in practice) becomes "-".
fn sanitize_path_segment(action: &str) -> String {
    action
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

pub(crate) fn gvariant_string(value: &str) -> String {
    format!("'{}'", value.replace('\\', "\\\\").replace('\'', "\\'"))
}

/// GNOME splits a custom keybinding's `command` with shell-style parsing, so
/// a path containing a space (e.g. "/media/me/PC games/...") must be quoted
/// or it is launched as just its first word.
fn shell_quote(value: &str) -> String {
    if !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "/._-+:@%".contains(c))
    {
        return value.to_string();
    }
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Send directly to the single-instance D-Bus endpoint already owned by
/// Tauri. Starting the full executable first initializes PipeWire/GTK (and
/// mounts an AppImage) for every key press. Keep that path only for cold start
/// or systems without gdbus. Both shell and GVariant values are quoted.
fn shortcut_command(binary: &str, action: &str, identifier: &str) -> String {
    let service = format!("{identifier}.SingleInstance");
    let object = format!("/{}", service.replace('.', "/").replace('-', "_"));
    let argv = gvariant_string_array(&["pengo".into(), "--shortcut".into(), action.into()]);
    let relay = format!(
        "gdbus call --session --timeout 1 --dest {} --object-path {} --method org.SingleInstance.DBus.ExecuteCallback {} '' >/dev/null 2>&1 || exec {} --shortcut {}",
        shell_quote(&service), shell_quote(&object), shell_quote(&argv),
        shell_quote(binary), shell_quote(action),
    );
    format!("sh -c {}", shell_quote(&relay))
}

#[cfg(test)]
mod relay_tests {
    use super::*;

    #[test]
    fn relay_uses_the_configured_single_instance_endpoint() {
        let command = shortcut_command(
            "/opt/Pengo.AppImage",
            "channel:sink_game:mute",
            "dev.sonux.audio",
        );
        assert!(command.contains("dev.sonux.audio.SingleInstance"));
        assert!(command.contains("/dev/sonux/audio/SingleInstance"));
        assert!(command.contains("org.SingleInstance.DBus.ExecuteCallback"));
        assert!(command.contains("|| exec /opt/Pengo.AppImage --shortcut channel:sink_game:mute"));
    }

    #[test]
    fn relay_and_cold_start_preserve_arguments_without_shell_expansion() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("arguments");
        let fake_dbus = dir.path().join("gdbus");
        let binary = dir.path().join("PC games Pengo's.AppImage");
        std::fs::write(
            &fake_dbus,
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$RELAY_LOG\"\nexit \"$RELAY_STATUS\"\n",
        )
        .unwrap();
        std::fs::write(
            &binary,
            "#!/bin/sh\nprintf '%s\\n' fallback \"$@\" > \"$RELAY_LOG\"\n",
        )
        .unwrap();
        for file in [&fake_dbus, &binary] {
            std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let action = "channel:Bob's $(false);:mute";
        let command = shortcut_command(binary.to_str().unwrap(), action, "dev.sonux.audio");
        for status in ["0", "1"] {
            assert!(Command::new("sh")
                .args(["-c", &command])
                .env("PATH", format!("{}:/usr/bin:/bin", dir.path().display()))
                .env("RELAY_LOG", &log)
                .env("RELAY_STATUS", status)
                .status()
                .unwrap()
                .success());
            let recorded = std::fs::read_to_string(&log).unwrap();
            if status == "0" {
                assert!(recorded.contains(&gvariant_string_array(&[
                    "pengo".into(),
                    "--shortcut".into(),
                    action.into()
                ])));
                assert!(!recorded.starts_with("fallback"));
            } else {
                assert_eq!(recorded, format!("fallback\n--shortcut\n{action}\n"));
            }
        }
    }
}

fn gvariant_string_array(values: &[String]) -> String {
    let items: Vec<String> = values.iter().map(|v| gvariant_string(v)).collect();
    format!("[{}]", items.join(", "))
}

fn run_gsettings(args: &[&str]) -> Result<(), String> {
    let output = Command::new("gsettings")
        .args(args)
        .output()
        .map_err(|error| format!("could not run gsettings: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if detail.is_empty() {
            format!("gsettings exited with {}", output.status)
        } else {
            detail
        })
    }
}

/// Parse `gsettings get`'s GVariant text output for an `as` (string array)
/// value. An empty array prints with an explicit type annotation
/// ("@as []") since there are no elements to infer the type from; a
/// non-empty array never carries that prefix.
fn parse_string_array(text: &str) -> Vec<String> {
    let text = text.trim();
    let list = text.strip_prefix("@as").map(str::trim).unwrap_or(text);
    let Some(inner) = list
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
    else {
        return Vec::new();
    };
    inner
        .split(',')
        .map(|entry| entry.trim().trim_matches('\'').to_string())
        // Every real custom-keybinding entry is an absolute dconf path.
        // This also self-heals a dconf array corrupted by an older parser
        // that mishandled "@as []", by dropping whatever garbage it left
        // behind instead of preserving it forever as "some other app's
        // shortcut".
        .filter(|entry| entry.starts_with('/'))
        .collect()
}

fn current_custom_keybindings() -> Result<Vec<String>, String> {
    let output = Command::new("gsettings")
        .args(["get", MEDIA_KEYS_SCHEMA, KEYBINDINGS_KEY])
        .output();
    let output = output.map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into_owned());
    }
    Ok(parse_string_array(&String::from_utf8_lossy(&output.stdout)))
}

fn binary_command() -> Result<String, String> {
    let executable = crate::autostart::exe()
        .map_err(|error| format!("could not locate the Pengo executable: {error}"))?;
    let path = executable.to_string_lossy().into_owned();
    let path = path
        .strip_suffix(" (deleted)")
        .map(str::to_string)
        .unwrap_or(path);
    Ok(path)
}

fn media_keys_daemon_active() -> bool {
    Command::new("systemctl")
        .args(["--user", "is-active", "--quiet", MEDIA_KEYS_SERVICE])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

/// Some GNOME/Ubuntu-based packaging ships this component marked
/// "started by systemd" in its autostart entry without any systemd unit or
/// target actually pulling it in at session start, so it never launches at
/// login even though starting it on demand always works fine. Nudge it
/// awake ourselves; a no-op if it is already running.
fn ensure_media_keys_daemon_running() {
    if media_keys_daemon_active() {
        return;
    }
    let _ = Command::new("systemctl")
        .args(["--user", "start", MEDIA_KEYS_SERVICE])
        .status();
}

/// Rebuild every Pengo-owned GNOME custom keybinding from the bindings the
/// frontend currently holds. Rebuilding from scratch each time (rather than
/// diffing) makes this self-healing: a stale or hand-edited entry is wiped
/// and replaced on the very next call, e.g. right after Pengo starts.
#[tauri::command]
pub fn sync_gnome_shortcuts(
    app: tauri::AppHandle,
    enabled: bool,
    bindings: HashMap<String, String>,
) -> Result<(), String> {
    if enabled {
        // The gsettings entries below are useless if nothing on the desktop
        // is actually listening for them. Only nudge the daemon awake for
        // this running Pengo process (a plain `systemctl --user start`,
        // idempotent and with no lasting effect once Pengo exits) - do NOT
        // install anything into autostart: on this desktop, that produced a
        // second, uncoordinated launch path for the same component that
        // raced the system's own one over the same global keybinding grab
        // and brought down the whole Wayland session.
        ensure_media_keys_daemon_running();
        if !media_keys_daemon_active() {
            return Err(
                "GNOME media-keys service is unavailable; global shortcuts could not be activated."
                    .into(),
            );
        }
    }
    let binary = if enabled {
        binary_command()?
    } else {
        String::new()
    };
    let existing = current_custom_keybindings()?;
    let (ours, others): (Vec<String>, Vec<String>) = existing
        .into_iter()
        .partition(|path| path.starts_with(PATH_PREFIX));

    let mut next_paths = others;
    let mut apply_errors = Vec::new();

    if enabled {
        for (action, shortcut) in &bindings {
            let Some(accelerator) = to_gtk_accelerator(shortcut) else {
                apply_errors.push(format!("{action}: unsupported shortcut {shortcut}"));
                continue;
            };
            // Per-channel actions look like "channel:sink_game:mute"; dconf
            // path segments only tolerate a restricted character set, so the
            // raw action id (unchanged) still goes to `--shortcut`, but the
            // storage path uses a sanitized copy.
            let path = format!("{PATH_PREFIX}{}/", sanitize_path_segment(action));
            let schema_arg = format!("{CUSTOM_KEYBINDING_SCHEMA}:{path}");
            let name = format!("Pengo: {action}");
            let command = shortcut_command(&binary, action, &app.config().identifier);
            let result = run_gsettings(&["set", &schema_arg, "name", &gvariant_string(&name)])
                .and_then(|()| {
                    run_gsettings(&["set", &schema_arg, "command", &gvariant_string(&command)])
                })
                .and_then(|()| {
                    run_gsettings(&[
                        "set",
                        &schema_arg,
                        "binding",
                        &gvariant_string(&accelerator),
                    ])
                });
            match result {
                Ok(()) => next_paths.push(path),
                Err(error) => apply_errors.push(format!("{action}: {error}")),
            }
        }
    }

    run_gsettings(&[
        "set",
        MEDIA_KEYS_SCHEMA,
        KEYBINDINGS_KEY,
        &gvariant_string_array(&next_paths),
    ])?;

    for stale in ours {
        if !next_paths.contains(&stale) {
            let schema_arg = format!("{CUSTOM_KEYBINDING_SCHEMA}:{stale}");
            let _ = run_gsettings(&["reset-recursively", &schema_arg]);
        }
    }

    if apply_errors.is_empty() {
        Ok(())
    } else {
        Err(apply_errors.join("; "))
    }
}
