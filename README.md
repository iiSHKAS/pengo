# Pengo

Screenshot capture + library + editor. Tauri 2 (Rust) backend, plain HTML/CSS/JS frontend (no bundler).

```
src-tauri/src/
  lib.rs            commands, tray, shortcut, app state
  settings.rs       persisted settings (JSON)
  shortcuts.rs      shortcut lifecycle, dispatch, status and fallback selection
  linux_shortcuts.rs GNOME gsettings + single-instance D-Bus relay (from Sonux)
  input_shortcuts.rs opt-in evdev reader and keyboard permission setup (from Sonux)
  library.rs        scan / thumbnails / rename
  clipboard.rs      wl-copy -> xclip -> arboard
  capture/
    mod.rs          backend detection, save pipeline, X11 overlay flow
    x11.rs          generic X11: root GetImage + EWMH window list (any distro / WM)
    gnome.rs        GNOME Wayland: Shell extension over D-Bus
ui/
  index.html, css/  app shell, design tokens (dark/light, RTL-aware)
  js/               gallery, viewer, editor, annotate (shared renderer), settings, i18n (en/ar)
  overlay.html      X11 region/window picker over a frozen frame
extension/          GNOME Shell extension (embedded into the binary, installed from Settings)
```

## UI kit (one place per control)
`ui/js/components.js` + `ui/css/components.css` hold every reusable control:
`Select`, `openMenu`/`Menu`, `Switch`, `Segmented` (sliding pill), `toast`, `confirmDialog`, `promptDialog`,
all built on one animated `Popover` (opens/closes with a fade+scale, flips up near the screen edge, closes on
outside click / Esc, keyboard navigable). Colours, radius and speed come from tokens (`--pop-radius`, `--pop-dur`,
the palette in `app.css`), so restyling a control means editing it once.
```js
import { Select, Segmented, Switch, openMenu } from './components.js';
const sort = Select({ options: [{ value: 'a', label: 'A' }], value: 'a', onChange: v => {} });
openMenu(button, [{ label: 'Save', icon: 'save', onClick }, 'sep', { label: 'Delete', danger: true, onClick }]);
```

## Capture backends
| Session | Backend | Hotkey |
|---|---|---|
| X11 (any desktop) | `x11rb` root grab + overlay window | Tauri global-shortcut |
| GNOME / Wayland | WinProbe Shell extension (frozen frame + annotations in the Shell) | GNOME custom keybinding |
| Other Wayland | not yet (library + editor still work) | opt-in evdev (delivery only) |

Adding a compositor = a new module under `capture/` + a `Backend` variant.

## Build / run
Needs `webkit2gtk-4.1`, `gtk3`, `libsoup3` dev packages and Rust.
```
cd src-tauri && cargo run            # dev
scripts/install.sh                   # release build + install to ~/.local
pengo --capture                    # trigger a capture from another process
```
Debug builds: `PENGO_DEV_EVAL=<dir>` runs `<dir>/eval.js` inside the main webview (handy for scripted UI tests).

See [global shortcut fallback](docs/shortcut-fallback.md) for consent, permissions, tests and Sonux source attribution.

## AppImage updates

Pengo uses Sonux's signed AppImage update flow: automatic checks after 30 seconds
and every six hours, verified downloads, atomic replacement with a `.previous`
recovery copy, and explicit restart. See [setup, keys, builds and releases](docs/updates.md).
The GitHub workflow publishes `Pengo.AppImage`, its version-bound signature,
`latest.json`, and checksums to `iiSHKAS/pengo`. Development binaries do not self-update.
