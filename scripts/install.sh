#!/bin/sh
# Builds Pengo in release mode and installs it for the current user.
set -e
cd "$(dirname "$0")/../src-tauri"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/pengo-target}"
cargo build --release

bin_home=${XDG_BIN_HOME:-"$HOME/.local/bin"}
data_home=${XDG_DATA_HOME:-"$HOME/.local/share"}
app_id=pengo   # tauri sets no app id of its own, so GTK uses the binary name: that is the Wayland app id / WM class the taskbar matches (same as Sonux's mixweave.desktop)

install -Dm755 "$CARGO_TARGET_DIR/release/pengo" "$bin_home/pengo"
for icon_size in 32x32:32x32.png 128x128:128x128.png 256x256:128x128@2x.png 512x512:icon.png; do
  install -Dm644 "icons/${icon_size#*:}" "$data_home/icons/hicolor/${icon_size%%:*}/apps/$app_id.png"
done

desktop_file="$data_home/applications/$app_id.desktop"
install -Dm644 /dev/stdin "$desktop_file" <<DESK
[Desktop Entry]
Type=Application
Name=Pengo
Comment=Screenshot capture, library and editor
Exec=$bin_home/pengo
TryExec=$bin_home/pengo
Icon=$app_id
Categories=Utility;Graphics;
StartupWMClass=$app_id
Terminal=false
DESK

# Remove the old WinShot install, if any.
rm -f "$data_home/applications/dev.sonux.pengo.desktop" "$data_home"/icons/hicolor/*/apps/dev.sonux.pengo.png "$bin_home/winshot" "$data_home/applications/winshot.desktop" "$data_home/icons/hicolor/512x512/apps/winshot.png"
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$data_home/applications" >/dev/null 2>&1 || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -t "$data_home/icons/hicolor" >/dev/null 2>&1 || true
echo "Installed. Launch 'Pengo' from the app menu, or run: pengo   (use 'pengo --capture' to trigger a capture)"
