<div align="center">
  <img src="ui/assets/pengo.svg" alt="Pengo" width="96" height="96">
  <h1>Pengo</h1>
  <p>Capture, annotate, and organize screenshots on Linux.</p>
  <p><a href="https://github.com/iiSHKAS/pengo/releases">Releases</a> · <a href="https://github.com/iiSHKAS/pengo/issues">Report an issue</a></p>
</div>

Pengo brings screen capture, an image library, and an annotation editor into one desktop application. Capture a region or window, add an explanation, and keep the result in a searchable library. The interface supports English and Arabic, including right-to-left layouts, with light and dark themes.

## Features

- **Capture:** select a region or window on X11 and GNOME Wayland. Both backends also support instant capture of the window or screen under the pointer.
- **Annotate:** add text, arrows, shapes, numbered steps, freehand drawings, and highlights. Crop images or use blur and pixelation tools.
- **Organize:** browse thumbnails, search, sort, mark favorites, rename images, and open their location in the file manager.
- **Save and copy:** choose PNG, JPG, WebP, or BMP, adjust JPEG quality, and copy images to the clipboard.
- **Work in the background:** configure global shortcuts, launch at login, or keep Pengo in the system tray when a tray is available.
- **Stay updated:** the AppImage edition can download and install signed updates while the current session remains open. Restart when you are ready.

## Desktop support

| Session | Screen capture | Global shortcuts |
|---|---|---|
| X11 | Supported through the X11 capture backend | Native shortcut registration |
| GNOME Wayland | Supported through the included WinProbe Shell extension | GNOME custom keybindings |
| Other Wayland desktops | Not supported yet; the library and editor remain available | Optional evdev input fallback |

The **evdev fallback changes how shortcuts are received**. It does not add screen capture support to another Wayland compositor. It requires explicit consent and may request administrator authorization for keyboard access. See the [shortcut guide](docs/shortcut-fallback.md).

## Run the AppImage

Download `Pengo.AppImage` from a published [GitHub release](https://github.com/iiSHKAS/pengo/releases), then run:

```sh
chmod +x Pengo.AppImage
./Pengo.AppImage
```

On **GNOME Wayland**, open Settings and install the capture extension. A newly installed extension may require signing out and back in once. The capture engine status in Settings shows whether the extension is available.

### Default shortcuts

| Shortcut | Action | Availability |
|---|---|---|
| `Ctrl+Shift+E` | Open capture selection | X11 and GNOME Wayland |
| `Ctrl+Alt+W` | Capture the window under the pointer | GNOME Wayland; X11 supported (not yet tested) |
| `Ctrl+Alt+S` | Capture the screen under the pointer | GNOME Wayland; X11 supported (not yet tested) |

Change these bindings in **Settings → Shortcut**. You can also start a capture from the application or its tray menu.

## Updates

Automatic updates are enabled by default for the AppImage edition. Pengo checks after 30 seconds and then every six hours while running. It verifies the downloaded artifact's signature and signed version, preserves a `.previous` recovery copy, and replaces the AppImage file.

Pengo does **not restart automatically**. Use the restart button or reopen the application later. Disable automatic updates or run a manual check from Settings. Development builds and ordinary executable installations do not self-update.

See the [AppImage update and release guide](docs/updates.md) for signing, release preparation, and recovery details. Release names and GitHub tags use numeric versions such as `0.1.0`, without a `v` prefix.

## Build from source

The desktop application uses **Rust and Tauri 2**, with a plain HTML, CSS, and JavaScript frontend. There is no frontend bundling step.

Install Rust and the Linux Tauri build dependencies, then run these commands separately:

```sh
git clone https://github.com/iiSHKAS/pengo.git Pengo
cd Pengo
cargo run --manifest-path src-tauri/Cargo.toml
```

Node.js 22 and `npm ci` are needed for AppImage release tooling. The [development guide](docs/development.md) covers dependencies, checks, installation, and the source layout. The [release guide](docs/updates.md) covers signed AppImage builds.

## Documentation

- [Development guide](docs/development.md)
- [Global shortcuts and evdev permissions](docs/shortcut-fallback.md)
- [AppImage updates, builds, and releases](docs/updates.md)
- [Changelog](CHANGELOG.md)

## Credits and licensing

Pengo's GNOME shortcut integration, evdev fallback, and AppImage update flow include code adapted from **Sonux / Mixweave**. The capture extension retains its WinProbe identity for compatibility.

The copied Sonux / Mixweave components are licensed under **GPL-3.0-only**. Their license is preserved in [licenses/Sonux-GPL-3.0.txt](licenses/Sonux-GPL-3.0.txt); dependency licenses remain with their respective projects.
