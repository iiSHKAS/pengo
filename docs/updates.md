# AppImage updates and releases

[Project overview](../README.md) · [Development guide](development.md)

This guide explains how Pengo updates itself and how to build and publish signed Linux x86_64 releases to `iiSHKAS/pengo`.

## Update behavior

Automatic updates are enabled by default, including when loading older settings. Pengo checks 30 seconds after startup and every six hours while running. Enabling automatic updates wakes the scheduler. Desktop notifications and an in-app banner report download progress and installation status.

Before replacing the AppImage, Pengo verifies the artifact's signature and signed version. Downloads must use HTTPS URLs for versioned releases in the Pengo repository. The frontend cannot supply arbitrary download URLs or installation files.

The installer stages the download in the same directory, saves a `Pengo.AppImage.previous` recovery copy, and atomically replaces the executable. The current session keeps running its existing version. The update takes effect on the next launch or when the user selects the restart button.

Disabling automatic updates cancels an ongoing check or download. If replacement has already begun, it completes before the setting is saved. A manual check also downloads and installs an available update, even with automatic updates disabled.

Self-updates require a user-owned, regular type-2 AppImage file, not a symbolic link. Development runs and ordinary executable installations do not self-update.

Restart launches the external AppImage after cleaning the previous AppImage environment. It first tries `systemd-run --user`, then falls back to a detached launch. The new process waits for the old process to exit before initializing single-instance handling and shortcuts.

## Signing keys

Pengo uses its own signing key. Local build tools read these files outside the repository:

| File | Purpose |
|---|---|
| `~/.config/pengo-release/updater.key` | Encrypted private signing key |
| `~/.config/pengo-release/updater.password` | Private key password |
| `~/.config/pengo-release/updater.key.pub` | Public verification key |

The directory uses permissions `700`; files use `600`. Only the public key is embedded in `src-tauri/tauri.conf.json`. Keep a secure backup of all three files: installed clients need the matching key for future updates. Never commit the private key or password, or upload them as release assets.

## Configure GitHub Actions

In the repository's **Settings → Secrets and variables → Actions**, configure:

| Type | Name | Value |
|---|---|---|
| Secret | `TAURI_SIGNING_PRIVATE_KEY` | Contents of `updater.key` |
| Secret | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Contents of `updater.password` |
| Variable | `TAURI_UPDATER_PUBLIC_KEY` | Contents of `updater.key.pub` |

Alternatively, install GitHub CLI, authenticate with `gh auth login`, and run from the project root:

```sh
python scripts/release/configure-github.py
```

This command writes the repository secrets and variable; it does not publish a release. Set `PENGO_SIGNING_DIR` to use a different signing-key directory.

## Publish through GitHub Actions

1. Synchronize the version in `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, and `src-tauri/tauri.conf.json`.
2. Add release notes under `## [X.Y.Z]` in `CHANGELOG.md`.
3. Push the changes and a numeric tag such as `0.1.0`, or manually run the **Release** workflow with that version.
4. The workflow checks compilation and configuration, builds the Linux x86_64 AppImage, signs its contents and version, uploads assets to a draft release, and publishes it as the latest stable release.

Release titles and Git tags use numeric `X.Y.Z` versions without a `v` prefix or application name. Each release contains:

- `Pengo.AppImage`
- `Pengo.AppImage.sig`
- `latest.json`
- `SHA256SUMS`

The update manifest endpoint is:

```text
https://github.com/iiSHKAS/pengo/releases/latest/download/latest.json
```

The manifest points to the versioned artifact:

```text
https://github.com/iiSHKAS/pengo/releases/download/X.Y.Z/Pengo.AppImage
```

Keep artifact names consistent and never pair an image with another release's signature. Clients accept only higher versions. The first release establishes the update channel; verifying an upgrade requires two releases.

## Build locally

Install Rust, Node.js 22, the Tauri Linux build dependencies, and `squashfs-tools`. The [release workflow](../.github/workflows/release.yml) lists the Ubuntu packages.

From the repository root:

```sh
npm ci
python scripts/release/build-local.py
```

The helper reads the local signing files, builds and signs the AppImage, and prepares upload-ready assets in `github-files-update/`. It does not upload them. For manual publication, upload the four release assets to a GitHub release with the matching numeric tag, mark it as the latest stable release, and use `release-notes.md` from that directory as the description.

Verify checksums from inside the output directory:

```sh
sha256sum -c SHA256SUMS
```

`npm run build:appimage` is available when signing environment variables are already configured. The `build-local.py` helper additionally creates the version-bound signature and publication files, making it the complete local release preparation command.

## Verify before publishing

Run the compilation checks in the [development guide](development.md). Verify a real upgrade between two signed releases, including restart on X11 and GNOME Wayland. Check failure handling for an unavailable network, a full disk, and a directory without write access. Confirm that the running session remains usable after installation and that the next launch uses the new version.

Compilation alone does not establish that a published AppImage upgrade or the GitHub Actions workflow succeeds.

## Source and licensing

The update flow is adapted from Sonux / Mixweave under GPL-3.0-only. The original license is preserved in the [license file](../licenses/Sonux-GPL-3.0.txt). Pengo uses the AppImage update, signing, manifest, and publication flow; audio features and deb, rpm, and Arch packaging are outside this application's scope.
