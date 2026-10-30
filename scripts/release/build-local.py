#!/usr/bin/env python3
"""Build/sign/prepare a local AppImage release; never publish or print secrets."""
from pathlib import Path
import json
import os
import shutil
import subprocess
import sys

root = Path(__file__).resolve().parents[2]
os.chdir(root)
node = shutil.which("node")
if not node:
    sys.exit("Node.js 22 is required. Activate it in this terminal before building.")
cli = root / "node_modules/@tauri-apps/cli/tauri.js"
if not cli.exists():
    sys.exit("Run npm ci first.")
env = os.environ.copy()
key_dir = Path(env.get("PENGO_SIGNING_DIR", str(Path.home() / ".config/pengo-release")))
for name, filename in [("TAURI_SIGNING_PRIVATE_KEY", "updater.key"), ("TAURI_SIGNING_PRIVATE_KEY_PASSWORD", "updater.password"), ("TAURI_UPDATER_PUBLIC_KEY", "updater.key.pub")]:
    if name not in env:
        file = key_dir / filename
        if not file.is_file():
            sys.exit(f"Missing {name}; provide it in the environment or create {file}.")
        env[name] = file.read_text().strip()
version = json.loads((root / "package.json").read_text())["version"]
env["VERSION"] = version
env["NO_STRIP"] = "1"
# Keep bundle paths predictable even when another project exports CARGO_TARGET_DIR.
env["CARGO_TARGET_DIR"] = str(root / "src-tauri/target")

def run(args):
    subprocess.run(args, env=env, check=True)

run([node, "scripts/release/build-config.mjs"])
run([node, str(cli), "build", "--ci", "--bundles", "appimage", "--config", "update-build.json"])
images = list((root / "src-tauri/target/release/bundle/appimage").glob(f"Pengo_{version}_*.AppImage"))
if len(images) != 1:
    sys.exit("Expected exactly one Pengo AppImage for this version in the bundle directory.")
image = images[0]
run(["cargo", "run", "--locked", "--manifest-path", "scripts/release/signing/Cargo.toml", "--", version, str(image)])
lines = (root / "CHANGELOG.md").read_text().splitlines()
notes = []
found = False
for line in lines:
    if line == f"## [{version}]" or line.startswith(f"## [{version}] - "):
        found = True
        continue
    if found and line.startswith("## ["):
        break
    if found:
        notes.append(line)
if not found:
    sys.exit(f"Add a CHANGELOG.md entry for {version} before preparing the release.")
output = root / "github-files-update"
output.mkdir(parents=True, exist_ok=True)
notes_path = output / "release-notes.md"
notes_path.write_text("\n".join(notes).strip() + "\n")
run([node, "scripts/release/prepare-release.mjs", version, str(image), str(image) + ".sig", str(output), str(notes_path)])
print(f"Signed release ready in {output}. Nothing has been uploaded.")
