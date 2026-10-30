// Restart lifecycle adapted from Sonux / Mixweave (GPL-3.0-only).
use std::{
    ffi::OsString,
    path::PathBuf,
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
};
const RESTART_PARENT_ARG: &str = "--pengo-restart-parent";
static RESTARTING: AtomicBool = AtomicBool::new(false);
pub fn is_restarting() -> bool {
    RESTARTING.load(Ordering::Acquire)
}
/// A detached replacement waits for the current process to disappear before
/// it initializes the single-instance plugin. This avoids both a
/// duplicate capture instance and terminal launchers killing the new
/// process together with the old process group.
pub(crate) fn wait_for_restart_parent() {
    #[cfg(target_os = "linux")]
    {
        let mut args = std::env::args_os();
        while let Some(arg) = args.next() {
            if arg != RESTART_PARENT_ARG {
                continue;
            }
            let Some(pid) = args
                .next()
                .and_then(|value| value.to_string_lossy().parse::<u32>().ok())
            else {
                return;
            };
            let parent = std::path::PathBuf::from(format!("/proc/{pid}"));
            for _ in 0..200 {
                if !parent.exists() {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            eprintln!("pengo: restart parent {pid} did not exit within 5 seconds; continuing");
            return;
        }
    }
}

fn current_args_without_restart_marker() -> Vec<OsString> {
    let mut filtered = Vec::new();
    let mut args = std::env::args_os().skip(1);
    while let Some(arg) = args.next() {
        if arg == RESTART_PARENT_ARG {
            let _ = args.next();
        } else {
            filtered.push(arg);
        }
    }
    filtered
}

/// Cargo replaces a release binary by renaming over it. Linux then reports
/// the still-running executable as `/path/to/sink (deleted)`, even though the
/// freshly built `/path/to/sink` already exists. The kernel suffix is not part
/// of the real filename and must never be passed to systemd-run or Command.
fn normalize_restart_executable(executable: PathBuf) -> PathBuf {
    #[cfg(target_os = "linux")]
    if let Some(path) = executable
        .to_str()
        .and_then(|path| path.strip_suffix(" (deleted)"))
    {
        return PathBuf::from(path);
    }
    executable
}

// Relaunch the outer AppImage with a fresh runtime environment, not paths
// into the previous image's FUSE mount. Keep session/driver overrides.
fn clean_appimage_environment(command: &mut Command) {
    if std::env::var_os("APPIMAGE").is_none() {
        return;
    }
    for name in [
        "APPIMAGE",
        "APPDIR",
        "ARGV0",
        "OWD",
        "LD_LIBRARY_PATH",
        "GIO_MODULE_DIR",
        "GDK_PIXBUF_MODULE_FILE",
        "GDK_PIXBUF_MODULEDIR",
        "GTK_PATH",
        "GTK_EXE_PREFIX",
        "GTK_DATA_PREFIX",
    ] {
        command.env_remove(name);
    }
    if let Some(appdir) = std::env::var_os("APPDIR") {
        for name in ["PATH", "XDG_DATA_DIRS"] {
            if let Some(value) = std::env::var_os(name) {
                let entries: Vec<_> = std::env::split_paths(&value)
                    .filter(|path| !path.starts_with(&appdir))
                    .collect();
                if let Ok(value) = std::env::join_paths(entries) {
                    command.env(name, value);
                }
            }
        }
    }
}

#[cfg(target_os = "linux")]
fn spawn_systemd_replacement(executable: &std::path::Path) -> Result<(), String> {
    // Plasma launches desktop applications in transient systemd scopes. A
    // normal child remains in that cgroup and is killed as soon as the old
    // application exits, even after creating a new Unix process group. Put
    // the replacement in its own user service so it survives that cleanup.
    let unit = format!("pengo-restart-{}", std::process::id());
    let mut command = Command::new("systemd-run");
    clean_appimage_environment(&mut command);
    // User managers may not have imported the current Wayland/X11 session.
    for name in [
        "DISPLAY",
        "WAYLAND_DISPLAY",
        "XAUTHORITY",
        "XDG_RUNTIME_DIR",
        "DBUS_SESSION_BUS_ADDRESS",
        "XDG_SESSION_TYPE",
        "XDG_CURRENT_DESKTOP",
        "PENGO_GDK_BACKEND",
        "WEBKIT_DISABLE_DMABUF_RENDERER",
    ] {
        if let Some(value) = std::env::var_os(name) {
            let mut argument = OsString::from(format!("--setenv={name}="));
            argument.push(value);
            command.arg(argument);
        }
    }
    let output = command
        .args([
            "--user",
            "--quiet",
            "--collect",
            "--service-type=exec",
            "--unit",
        ])
        .arg(unit)
        .arg("--")
        .arg(executable)
        .args(current_args_without_restart_marker())
        .arg(RESTART_PARENT_ARG)
        .arg(std::process::id().to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("Could not ask systemd to restart Pengo: {error}"))?;

    if output.status.success() {
        Ok(())
    } else {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if detail.is_empty() {
            format!("systemd-run exited with {}", output.status)
        } else {
            format!("systemd-run exited with {}: {detail}", output.status)
        })
    }
}

fn spawn_direct_replacement(executable: &std::path::Path) -> Result<(), String> {
    let mut command = Command::new(executable);
    clean_appimage_environment(&mut command);
    command
        .args(current_args_without_restart_marker())
        .arg(RESTART_PARENT_ARG)
        .arg(std::process::id().to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not launch the replacement Pengo process: {error}"))
}

fn spawn_detached_replacement() -> Result<(), String> {
    let executable = normalize_restart_executable(
        crate::launch_path::launch_path()
            .map_err(|error| format!("Could not locate the Pengo executable: {error}"))?,
    );

    #[cfg(target_os = "linux")]
    match spawn_systemd_replacement(&executable) {
        Ok(()) => return Ok(()),
        Err(error) => {
            eprintln!("pengo: systemd restart unavailable ({error}); using direct launch")
        }
    }

    spawn_direct_replacement(&executable)
}

#[tauri::command]
pub fn restart_app(app: tauri::AppHandle) -> Result<(), String> {
    let _install = crate::updates::INSTALL_LOCK
        .lock()
        .map_err(|e| e.to_string())?;
    let _settings = crate::shortcuts::CONFIG_LOCK
        .lock()
        .map_err(|e| e.to_string())?;
    if is_restarting() {
        return Ok(());
    }
    spawn_detached_replacement()?;
    RESTARTING.store(true, Ordering::Release);
    // RunEvent::Exit releases native shortcuts and joins the evdev listener.
    app.exit(0);
    Ok(())
}
