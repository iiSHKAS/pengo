// Adapted from Sonux / Mixweave (GPL-3.0-only). See docs/updates.md.
//! The path a user would launch Pengo by.
//!
//! Inside an AppImage, `std::env::current_exe()` is a file in a temporary
//! FUSE mount (`/tmp/.mount_XXXX/usr/bin/pengo`) that changes on every
//! launch and disappears when the app exits. Anything that must outlive the
//! process (the autostart unit, GNOME keybinding commands, a restart) has to
//! use the AppImage file itself, which the runtime exports as `$APPIMAGE`.

use std::ffi::OsString;
use std::io;
use std::path::PathBuf;

/// Use AppImage metadata only when this executable belongs to its APPDIR.
/// Development processes can inherit both variables from an AppImage IDE.
pub fn launch_path() -> io::Result<PathBuf> {
    launch_path_from(
        std::env::var_os("APPIMAGE"),
        std::env::var_os("APPDIR"),
        std::env::current_exe,
    )
}

fn launch_path_from(
    appimage: Option<OsString>,
    appdir: Option<OsString>,
    current_exe: impl FnOnce() -> io::Result<PathBuf>,
) -> io::Result<PathBuf> {
    let executable = current_exe()?;
    if let (Some(image), Some(directory)) = (appimage, appdir) {
        if !image.is_empty() && !directory.is_empty() {
            let directory = PathBuf::from(directory);
            let directory = directory.canonicalize().unwrap_or(directory);
            let resolved = executable
                .canonicalize()
                .unwrap_or_else(|_| executable.clone());
            if directory.is_absolute()
                && directory.parent().is_some()
                && resolved.starts_with(&directory)
            {
                return Ok(PathBuf::from(image));
            }
        }
    }
    Ok(executable)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_build_ignores_parent_appimage_environment() {
        let source = PathBuf::from("/projects/Sonux/target/debug/pengo");
        assert_eq!(
            launch_path_from(
                Some("/home/user/ignite_panel.appimage".into()),
                Some("/tmp/.mount_ignite123".into()),
                || Ok(source.clone()),
            )
            .unwrap(),
            source
        );
    }

    #[test]
    fn packaged_binary_uses_its_persistent_appimage_path() {
        let image = PathBuf::from("/home/user/Apps/Pengo.AppImage");
        assert_eq!(
            launch_path_from(
                Some(image.clone().into_os_string()),
                Some("/tmp/.mount_mix123".into()),
                || Ok("/tmp/.mount_mix123/usr/bin/pengo".into()),
            )
            .unwrap(),
            image
        );
    }

    #[test]
    fn missing_or_unrelated_appdir_keeps_real_executable() {
        for directory in [
            None,
            Some("".into()),
            Some("/".into()),
            Some("/tmp/.mount_mix12".into()),
        ] {
            let source = PathBuf::from("/tmp/.mount_mix123/usr/bin/pengo");
            assert_eq!(
                launch_path_from(Some("/other.AppImage".into()), directory, || Ok(
                    source.clone()
                ))
                .unwrap(),
                source
            );
        }
    }
}
