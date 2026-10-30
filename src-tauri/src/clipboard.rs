//! Copy a PNG to the system clipboard, using the most reliable tool available.

use std::io::Write;
use std::process::{Command, Stdio};

pub fn copy_png(png: &[u8]) -> Result<(), String> {
    let wayland = std::env::var_os("WAYLAND_DISPLAY").is_some();
    // A background Wayland client can't own the clipboard; wl-copy forks and does.
    if wayland && pipe_to("wl-copy", &["--type", "image/png"], png) {
        return Ok(());
    }
    if !wayland && pipe_to("xclip", &["-selection", "clipboard", "-t", "image/png"], png) {
        return Ok(());
    }
    // Fallback: we are long-running (tray), so owning the selection ourselves works
    // (X11 / XWayland, which mutter bridges to native clients).
    let img = image::load_from_memory(png).map_err(|e| e.to_string())?.to_rgba8();
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    cb.set_image(arboard::ImageData {
        width: img.width() as usize,
        height: img.height() as usize,
        bytes: std::borrow::Cow::Owned(img.into_raw()),
    })
    .map_err(|e| e.to_string())
}

fn pipe_to(program: &str, args: &[&str], data: &[u8]) -> bool {
    let Ok(mut child) = Command::new(program)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return false;
    };
    if let Some(mut stdin) = child.stdin.take() {
        if stdin.write_all(data).is_err() {
            return false;
        }
    }
    child.wait().map(|s| s.success()).unwrap_or(false)
}
