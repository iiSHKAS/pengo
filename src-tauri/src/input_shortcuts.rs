// Adapted from Sonux / Mixweave (GPL-3.0-only). See docs/shortcut-fallback.md.
//! Opt-in evdev shortcuts. Only action IDs leave this module; raw keystrokes
//! are neither logged nor persisted. The application never runs as root.
use evdev::{Device, EventType, KeyCode};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

static WORKER: Mutex<Option<Worker>> = Mutex::new(None);
struct Worker {
    stop: Arc<AtomicBool>,
    thread: thread::JoinHandle<()>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct Binding {
    action: String,
    modifiers: u8,
    key: KeyCode,
}
fn modifier(key: KeyCode) -> u8 {
    match key {
        KeyCode::KEY_LEFTCTRL | KeyCode::KEY_RIGHTCTRL => 1,
        KeyCode::KEY_LEFTALT | KeyCode::KEY_RIGHTALT => 2,
        KeyCode::KEY_LEFTSHIFT | KeyCode::KEY_RIGHTSHIFT => 4,
        KeyCode::KEY_LEFTMETA | KeyCode::KEY_RIGHTMETA => 8,
        _ => 0,
    }
}
fn key_code(name: &str) -> Option<KeyCode> {
    let evdev = match name {
        "ArrowUp" => "UP",
        "ArrowDown" => "DOWN",
        "ArrowLeft" => "LEFT",
        "ArrowRight" => "RIGHT",
        "Backquote" => "GRAVE",
        "Backslash" => "BACKSLASH",
        "BracketLeft" => "LEFTBRACE",
        "BracketRight" => "RIGHTBRACE",
        "CapsLock" => "CAPSLOCK",
        "Comma" => "COMMA",
        "End" => "END",
        "Enter" => "ENTER",
        "Equal" => "EQUAL",
        "Escape" => "ESC",
        "Home" => "HOME",
        "Insert" => "INSERT",
        "Minus" => "MINUS",
        "PageDown" => "PAGEDOWN",
        "PageUp" => "PAGEUP",
        "Pause" => "PAUSE",
        "Period" => "DOT",
        "PrintScreen" => "SYSRQ",
        "Quote" => "APOSTROPHE",
        "ScrollLock" => "SCROLLLOCK",
        "Semicolon" => "SEMICOLON",
        "Slash" => "SLASH",
        "Space" => "SPACE",
        "Tab" => "TAB",
        "Backspace" => "BACKSPACE",
        "Delete" => "DELETE",
        "NumLock" => "NUMLOCK",
        "AudioVolumeDown" => "VOLUMEDOWN",
        "AudioVolumeUp" => "VOLUMEUP",
        "AudioVolumeMute" => "MUTE",
        "MediaPause" => "PAUSECD",
        "MediaPlay" => "PLAYCD",
        "MediaPlayPause" => "PLAYPAUSE",
        "MediaStop" => "STOPCD",
        "MediaTrackNext" => "NEXTSONG",
        "MediaTrackPrevious" => "PREVIOUSSONG",
        "NumpadAdd" => "KPPLUS",
        "NumpadSubtract" => "KPMINUS",
        "NumpadMultiply" => "KPASTERISK",
        "NumpadDivide" => "KPSLASH",
        "NumpadDecimal" => "KPDOT",
        "NumpadEnter" => "KPENTER",
        "NumpadEqual" => "KPEQUAL",
        _ => {
            if let Some(digit) = name.strip_prefix("Numpad") {
                if digit.len() == 1 && digit.bytes().all(|b| b.is_ascii_digit()) {
                    return format!("KEY_KP{digit}").parse().ok();
                }
            }
            if (name.len() == 1 && name.bytes().all(|b| b.is_ascii_alphanumeric()))
                || name
                    .strip_prefix('F')
                    .and_then(|v| v.parse::<u8>().ok())
                    .is_some_and(|v| (1..=24).contains(&v))
            {
                return format!("KEY_{}", name.to_ascii_uppercase()).parse().ok();
            }
            return None;
        }
    };
    format!("KEY_{evdev}").parse().ok()
}
fn parse_bindings(bindings: HashMap<String, String>) -> Result<Vec<Binding>, String> {
    let mut result = Vec::new();
    for (action, combo) in bindings {
        let mut parts: Vec<_> = combo.split('+').collect();
        let key = key_code(parts.pop().unwrap_or(""))
            .ok_or_else(|| format!("Unsupported shortcut: {combo}"))?;
        let mut modifiers = 0;
        for part in parts {
            let bit = match part {
                "Ctrl" => 1,
                "Alt" => 2,
                "Shift" => 4,
                "Super" => 8,
                _ => return Err(format!("Unsupported modifier: {part}")),
            };
            if modifiers & bit != 0 {
                return Err(format!("Duplicate modifier: {combo}"));
            }
            modifiers |= bit;
        }
        if result
            .iter()
            .any(|b: &Binding| b.key == key && b.modifiers == modifiers)
        {
            return Err(format!("Duplicate shortcut: {combo}"));
        }
        result.push(Binding {
            action,
            modifiers,
            key,
        });
    }
    Ok(result)
}

struct Keyboard {
    device: Device,
    held: HashSet<KeyCode>,
}
fn keyboards() -> HashMap<PathBuf, Keyboard> {
    std::fs::read_dir("/dev/input")
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            if !entry.file_name().to_string_lossy().starts_with("event") {
                return None;
            }
            // Open read-only even if this account has broader input access.
            let device = Device::from_fd(std::fs::File::open(&path).ok()?.into()).ok()?;
            let keys = device.supported_keys()?;
            if !keys.contains(KeyCode::KEY_A) || !keys.contains(KeyCode::KEY_SPACE) {
                return None;
            }
            device.set_nonblocking(true).ok()?;
            let held = device
                .get_key_state()
                .ok()?
                .iter()
                .filter(|k| modifier(*k) != 0)
                .collect();
            Some((path, Keyboard { device, held }))
        })
        .collect()
}
fn pressed_action<'a>(
    bindings: &'a [Binding],
    held: &mut HashSet<KeyCode>,
    key: KeyCode,
    value: i32,
) -> Option<&'a str> {
    if modifier(key) != 0 {
        if value == 1 {
            held.insert(key);
        } else if value == 0 {
            held.remove(&key);
        }
        return None;
    }
    if value != 1 {
        return None;
    } // Ignore release and autorepeat.
    let modifiers = held.iter().fold(0, |mask, key| mask | modifier(*key));
    bindings
        .iter()
        .find(|b| b.key == key && b.modifiers == modifiers)
        .map(|b| b.action.as_str())
}
fn run_listener(
    mut devices: HashMap<PathBuf, Keyboard>,
    bindings: Vec<Binding>,
    stop: Arc<AtomicBool>,
    action: impl Fn(&str),
    availability: impl Fn(bool),
) {
    let mut scan = Instant::now();
    let mut available = !devices.is_empty();
    while !stop.load(Ordering::Acquire) {
        devices.retain(|_, keyboard| match keyboard.device.fetch_events() {
            Ok(events) => {
                for event in events {
                    if event.event_type() == EventType::KEY {
                        if let Some(id) = pressed_action(
                            &bindings,
                            &mut keyboard.held,
                            KeyCode::new(event.code()),
                            event.value(),
                        ) {
                            if !stop.load(Ordering::Acquire) {
                                action(id);
                            }
                        }
                    }
                }
                true
            }
            Err(e) => {
                e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::Interrupted
            }
        });
        if scan.elapsed() >= Duration::from_secs(3) {
            for (path, device) in keyboards() {
                devices.entry(path).or_insert(device);
            }
            scan = Instant::now();
        }
        let next = !devices.is_empty();
        if next != available {
            available = next;
            availability(next);
        }
        thread::sleep(Duration::from_millis(12));
    }
}
fn stop_worker(worker: &mut Option<Worker>) {
    if let Some(old) = worker.take() {
        old.stop.store(true, Ordering::Release);
        // Worker has no Drop so join consumes the handle below.
        let Worker { thread, .. } = old;
        let _ = thread.join();
    }
}
#[tauri::command]
pub fn sync_input_shortcuts(
    app: tauri::AppHandle,
    enabled: bool,
    bindings: HashMap<String, String>,
) -> Result<(), String> {
    let mut worker = WORKER.lock().map_err(|e| e.to_string())?;
    stop_worker(&mut worker);
    if !enabled || bindings.is_empty() {
        return Ok(());
    }
    let bindings = parse_bindings(bindings)?;
    let devices = keyboards();
    if devices.is_empty() {
        return Err("No readable keyboard. Enable keyboard access, then reconnect the keyboard or sign in again if needed.".into());
    }
    let stop = Arc::new(AtomicBool::new(false));
    let signal = stop.clone();
    let thread = thread::Builder::new()
        .name("input-shortcuts".into())
        .spawn(move || {
            run_listener(
                devices,
                bindings,
                signal,
                |action| {
                    crate::shortcuts::dispatch(&app, action, true);
                },
                |available| {
                    crate::shortcuts::input_availability(&app, available);
                },
            );
        })
        .map_err(|e| e.to_string())?;
    *worker = Some(Worker { stop, thread });
    Ok(())
}

// Fixed, embedded script; only the numeric real UID is interpolated. No
// user-supplied paths, scripts or shortcut text execute with root privileges.
fn permission_script(uid: u32) -> String {
    format!(
        r#"set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
command -v udevadm >/dev/null
acl=$(command -v setfacl)
[ -n "$acl" ]
rule=/etc/udev/rules.d/99-pengo-keyboard-{uid}.rules
[ ! -L "$rule" ]
mkdir -p /etc/udev/rules.d
umask 022
printf '%s\n' 'ACTION=="add|change", SUBSYSTEM=="input", KERNEL=="event*", ENV{{ID_INPUT_KEYBOARD}}=="1", RUN+="'"$acl"' -m u:{uid}:r-- /dev/input/%k"' > "$rule"
chmod 644 "$rule"
udevadm control --reload-rules
udevadm trigger --subsystem-match=input --action=change
udevadm settle --timeout=10
"#
    )
}
#[tauri::command]
pub async fn enable_input_shortcut_access() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        // Existing access needs no privilege prompt or system changes.
        if !keyboards().is_empty() { return Ok(()); }
        let uid = unsafe { libc::getuid() };
        if uid == 0 { return Err("Run Pengo as your normal desktop user.".into()); }
        let output = std::process::Command::new("pkexec")
            .args(["/bin/sh", "-c", &permission_script(uid)])
            .output().map_err(|e| format!("Could not request administrator authorization (polkit/pkexec): {e}"))?;
        if !output.status.success() {
            return Err(format!("Keyboard access was not enabled (authorization cancelled or setup failed). {}", String::from_utf8_lossy(&output.stderr).trim()));
        }
        if keyboards().is_empty() { return Err("Permission was installed, but no keyboard is readable yet. Reconnect your keyboard or sign in again, then retry.".into()); }
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

pub fn validate(bindings: HashMap<String, String>) -> Result<(), String> {
    parse_bindings(bindings).map(|_| ())
}
pub fn stop() {
    if let Ok(mut worker) = WORKER.lock() {
        stop_worker(&mut worker);
    }
}
