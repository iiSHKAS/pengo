#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Same environment setup as Mixweave (Sonux): native Wayland instead of XWayland when
    // launched from an AppImage, and no DMABUF renderer (smoother scrolling / no Gdk Error 71
    // on some GPU/driver combinations). Both can still be overridden by the user.
    #[cfg(target_os = "linux")]
    {
        if let Some(backend) = std::env::var_os("PENGO_GDK_BACKEND") {
            std::env::set_var("GDK_BACKEND", backend);
        } else if std::env::var_os("APPIMAGE").is_some()
            && std::env::var_os("WAYLAND_DISPLAY").is_some_and(|value| !value.is_empty())
        {
            std::env::set_var("GDK_BACKEND", "wayland,x11");
        }
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }

    pengo_lib::run()
}
