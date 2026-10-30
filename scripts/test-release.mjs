import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
const root = path.resolve(import.meta.dirname, '..');
function fixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pengo-release-test-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
function run(script, args, cwd, env = {}) {
  return spawnSync(process.execPath, [path.join(root, script), ...args], { cwd, env: { ...process.env, TAURI_UPDATER_PUBLIC_KEY: '', ...env }, encoding: 'utf8' });
}
test('release manifest uses Pengo immutable URLs and matches all checksums', () => fixture(dir => {
  const image = Buffer.alloc(64); image.write('\x7fELF'); image.set([65, 73, 2], 8);
  fs.writeFileSync(path.join(dir, 'source.AppImage'), image);
  // This fixture tests manifest metadata only; Rust signer tests verify cryptography.
  const sig = Buffer.from('untrusted comment: test fixture\nfixture\ntrusted comment: timestamp:1\tversion:0.1.0\nfixture\n').toString('base64');
  fs.writeFileSync(path.join(dir, 'source.sig'), sig);
  fs.writeFileSync(path.join(dir, 'notes.md'), 'Pengo release notes');
  const result = run('scripts/release/prepare-release.mjs', ['0.1.0', 'source.AppImage', 'source.sig', 'upload', 'notes.md'], dir);
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'upload/latest.json')));
  assert.equal(manifest.version, '0.1.0');
  assert.equal(manifest.platforms['linux-x86_64'].url, 'https://github.com/iiSHKAS/pengo/releases/download/0.1.0/Pengo.AppImage');
  assert.equal(manifest.platforms['linux-x86_64'].signature, sig);
  for (const line of fs.readFileSync(path.join(dir, 'upload/SHA256SUMS'), 'utf8').trim().split('\n')) {
    const [digest, name] = line.split('  ');
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'upload', name))).digest('hex'), digest);
  }
  assert.equal(fs.statSync(path.join(dir, 'upload/Pengo.AppImage')).mode & 0o777, 0o755);
  assert.notEqual(run('scripts/release/prepare-release.mjs', ['0.2.0', 'source.AppImage', 'source.sig', 'bad', 'notes.md'], dir).status, 0);
  assert.equal(fs.existsSync(path.join(dir, 'bad')), false);
  fs.writeFileSync(path.join(dir, 'source.AppImage'), 'not an AppImage');
  assert.notEqual(run('scripts/release/prepare-release.mjs', ['0.1.0', 'source.AppImage', 'source.sig', 'bad', 'notes.md'], dir).status, 0);
}));
test('build configuration binds source versions and public key, never carries private credentials', () => fixture(dir => {
  fs.mkdirSync(path.join(dir, 'src-tauri'));
  for (const name of ['package.json', 'src-tauri/Cargo.toml', 'src-tauri/tauri.conf.json']) fs.copyFileSync(path.join(root, name), path.join(dir, name));
  const version = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'))).version;
  const result = run('scripts/release/build-config.mjs', [], dir, { VERSION: version });
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'update-build.json')));
  assert.equal(config.bundle.createUpdaterArtifacts, true);
  assert.equal(config.plugins.updater.requireSignedVersion, true);
  assert.equal(config.version, version);
  assert.notEqual(run('scripts/release/build-config.mjs', [], dir, { VERSION: '999.0.0' }).status, 0);
  assert.notEqual(run('scripts/release/build-config.mjs', [], dir, { VERSION: version, TAURI_UPDATER_PUBLIC_KEY: 'invalid' }).status, 0);
  assert.ok(!JSON.stringify(config).includes('PRIVATE_KEY'));
  const cargo = path.join(dir, 'src-tauri/Cargo.toml');
  fs.writeFileSync(cargo, fs.readFileSync(cargo, 'utf8').replace(`version = "${version}"`, 'version = "999.0.0"'));
  assert.notEqual(run('scripts/release/build-config.mjs', [], dir, { VERSION: version }).status, 0);
}));
