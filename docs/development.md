# Developing Pengo

[Project overview](../README.md)

Pengo is a Linux desktop application built with Tauri 2 and Rust. The frontend is served directly from `ui/`; it uses native JavaScript modules and requires no bundler.

## Requirements

- Rust with Cargo.
- GTK 3, WebKitGTK 4.1, libsoup 3, and AppIndicator development libraries.
- Node.js 22 and npm for release tooling.
- AppImage packaging tools for release builds; see the dependency installation step in the [release workflow](../.github/workflows/release.yml).

The clipboard integration uses `wl-copy` on Wayland or `xclip` on X11 when available, with a Rust clipboard fallback. Optional evdev permission setup requires `pkexec`, a desktop polkit agent, `udevadm`, and `setfacl`.

## Run locally

From the repository root:

```sh
cargo run --manifest-path src-tauri/Cargo.toml
```

To install a release-mode executable and desktop entry for the current user:

```sh
sh scripts/install.sh
```

This installs an ordinary executable rather than an AppImage, so it does not support self-updates. Use the [release guide](updates.md) to build the signed AppImage edition.

An installed Pengo instance can also receive a capture request:

```sh
pengo --capture
```

## Source layout

| Path | Responsibility |
|---|---|
| `src-tauri/src/lib.rs` | Application state, IPC commands, tray, and lifecycle |
| `src-tauri/src/capture/` | X11 and GNOME capture backends and image saving |
| `src-tauri/src/shortcuts.rs` | Shortcut registration, dispatch, and fallback selection |
| `src-tauri/src/linux_shortcuts.rs` | GNOME custom keybindings and D-Bus relay |
| `src-tauri/src/input_shortcuts.rs` | Opt-in evdev listener and keyboard permission setup |
| `src-tauri/src/updates.rs` | Update checks, download progress, and cancellation |
| `src-tauri/src/update_install.rs` | AppImage replacement and recovery copy |
| `src-tauri/src/restart.rs` | Detached restart and AppImage environment cleanup |
| `ui/` | Application UI, library, editor, settings, and translations |
| `extension/` | WinProbe GNOME Shell extension, embedded in the Rust build |
| `scripts/release/` | Signing, verification, build, and publication tools |

## UI components

Reusable controls live in `ui/js/components.js` and `ui/css/components.css`. These include selects, menus, switches, segmented controls, toast messages, and dialogs. Palette and layout tokens live in `ui/css/app.css`; translation strings live in `ui/js/i18n.js`.

Keep user-visible strings in the translation dictionaries and check both English and Arabic layouts when changing the interface.

## Checks

Install JavaScript dependencies once:

```sh
npm ci
```

Run the relevant checks from the repository root:

```sh
cargo check --locked --manifest-path src-tauri/Cargo.toml
cargo check --locked --manifest-path scripts/release/signing/Cargo.toml
```

These checks validate compilation. Verify capture, shortcuts, and AppImage updates in a real desktop session before publishing.

## Desktop verification

Check capture, clipboard, editor output, tray behavior, and restart on X11 and GNOME Wayland. Verify GNOME's extension installation and its unavailable state. Test shortcuts while another application has focus.

Use the [shortcut guide](shortcut-fallback.md) for evdev permission, disconnect/reconnect, and failure simulation tests. Use the [update guide](updates.md) for signed releases and the two-release upgrade test.

Debug builds support `PENGO_DEV_EVAL=<directory>`: the application reads and removes `eval.js` for the main webview and `eval-overlay.js` for the capture overlay. This development facility is excluded from release builds.

## Release artifacts

Local signed builds write upload-ready files to `github-files-update/`. Generated binaries, dependency directories, and signing secrets are excluded from Git. Release names and tags follow `X.Y.Z`, without a `v` prefix.
