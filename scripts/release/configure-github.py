#!/usr/bin/env python3
"""Explicit one-time setup of Pengo's GitHub signing secrets/variable."""
from pathlib import Path
import json
import os
import shutil
import subprocess
import sys

repo = "iiSHKAS/pengo"
root = Path(__file__).resolve().parents[2]
key_dir = Path(os.environ.get("PENGO_SIGNING_DIR", str(Path.home() / ".config/pengo-release")))
if not shutil.which("gh"):
    sys.exit("Install GitHub CLI and run gh auth login first.")
subprocess.run(["gh", "auth", "status"], check=True)
files = {"TAURI_SIGNING_PRIVATE_KEY": key_dir / "updater.key", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD": key_dir / "updater.password"}
public = (key_dir / "updater.key.pub").read_text().strip()
config = json.loads((root / "src-tauri/tauri.conf.json").read_text())
if public != config["plugins"]["updater"]["pubkey"]:
    sys.exit("The local public key does not match this Pengo build.")
# Read all inputs before any remote mutation; never put private values in argv/logs.
values = {name: path.read_text().strip() for name, path in files.items()}
for name, value in values.items():
    subprocess.run(["gh", "secret", "set", name, "--repo", repo], input=value, text=True, check=True)
subprocess.run(["gh", "variable", "set", "TAURI_UPDATER_PUBLIC_KEY", "--repo", repo, "--body", public], check=True)
print(f"Configured signing secrets and public-key variable for {repo}. No release was published.")
