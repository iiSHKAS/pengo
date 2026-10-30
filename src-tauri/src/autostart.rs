//! "Start with the system": an XDG autostart entry (same approach as Ignite Panel), written to
//! ~/.config/autostart/pengo.desktop. The entry passes `--startup` so the app knows it was
//! launched at login (and may then start minimized to the tray).

use std::path::PathBuf;

fn entry_path() -> Option<PathBuf> {
    Some(dirs::config_dir()?.join("autostart").join("pengo.desktop"))
}

/// Path of the executable to launch at login (the AppImage itself, not its temporary mount).
pub(crate) fn exe() -> Result<PathBuf, String> {
    let path = crate::launch_path::launch_path().map_err(|e| e.to_string())?;
    let s = path.to_string_lossy();
    if !path.is_absolute() || s.starts_with("/tmp/.mount_") {
        return Err("a persistent install path is required (install Pengo first)".into());
    }
    Ok(path)
}

fn quote(arg: &str) -> String {
    format!("\"{}\"", arg.replace('\\', "\\\\").replace('"', "\\\"").replace('$', "\\$").replace('`', "\\`"))
}

pub fn set(enabled: bool) -> Result<(), String> {
    let path = entry_path().ok_or("no config directory")?;
    if !enabled {
        return match std::fs::remove_file(&path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        };
    }
    let exe = exe()?;
    let contents = format!(
        "[Desktop Entry]\nType=Application\nName=Pengo\nComment=Screenshot capture, library and editor\n\
         Icon=pengo\nTerminal=false\nExec={} --startup\nX-GNOME-Autostart-enabled=true\n",
        quote(&exe.to_string_lossy())
    );
    if std::fs::read_to_string(&path).is_ok_and(|c| c == contents) {
        return Ok(());
    }
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(&path, contents).map_err(|e| e.to_string())
}
