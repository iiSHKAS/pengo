# Global shortcuts

[Project overview](../README.md) · [Development guide](development.md)

The native paths are X11 (Tauri global shortcut) and GNOME Wayland
(gsettings custom keybindings, MediaKeys service, direct single-instance D-Bus
relay with a quoted executable cold-start fallback), ported from Sonux.
The old WinProbe launcher bindings are removed on startup during migration.
Only Pengo's new `pengo-*` bindings are synchronized; other apps' entries remain.

On registration failure, the first offer explains the optional evdev reader.
Later dismisses it persistently; Settings → Shortcut keeps the fallback control
available. Consent (`shortcut_fallback`) is stored in Pengo's settings. Turning
it off stops the reader and retries native registration. A failed native retry
never prevents disabling the reader. A disconnected keyboard is detected and
new devices are scanned every three seconds. Repeated keydown events are ignored.

The fallback only changes shortcut delivery. Capture still requires X11 or the
WinProbe GNOME extension. Other Wayland compositors still have no capture backend.
Window and screen instant shortcuts work on X11 and GNOME Wayland. On X11,
window capture crops the visible desktop rectangle, so overlapping content remains
visible. Screen capture selects the monitor under the pointer through RandR,
falling back to the root screen if monitor information is unavailable.

## Permission

No permission changes happen until Enable is clicked. Existing read access
requires no prompt. Otherwise a fixed `pkexec` script installs
`/etc/udev/rules.d/99-pengo-keyboard-UID.rules` and grants read-only ACLs to
keyboard event devices for the numeric user ID. Dependencies: `pkexec`, a polkit
authentication agent, `udevadm`, and `setfacl` (acl package).
The app opens devices read-only; raw keys are never logged or persisted.
These account permissions also apply to other applications running as that user.
Events are not exclusively grabbed, so the focused app can also receive the keys.

Disabling the fallback closes its device handles, but retains the system rule.
To revoke permission entirely, close Pengo, remove the account-specific rule as
administrator, reload udev, and remove that user's ACL from keyboard event nodes
(or reconnect the keyboards). Removing the rule alone does not revoke existing
ACLs or already-open device handles.

## Verification

For manual testing, close Pengo, then run a debug build with
`PENGO_SIMULATE_SHORTCUT_FAILURE=1 cargo run --manifest-path src-tauri/Cargo.toml`.
This skips native registration while retaining the real evdev opt-in flow.
If the offer was previously dismissed, reopen it from Settings. Existing saved
consent is respected. Check Later, cancelled authorization, successful activation,
background delivery, unplug/replug, settings changes, disable and restart.
The simulation flag is ignored in release builds.

## Source attribution

`src-tauri/src/input_shortcuts.rs` and `src-tauri/src/linux_shortcuts.rs` are
adapted from Sonux / Mixweave's corresponding command modules. The fallback UI
flow is adapted from its shortcutFallback store and ShortcutFallbackModal.
Sonux / Mixweave identifies its license as GPL-3.0-only; the original license is
preserved in the [license file](../licenses/Sonux-GPL-3.0.txt).
