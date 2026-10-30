// Adapted from Sonux's release configuration generator.
import fs from 'node:fs';
const pkg = JSON.parse(fs.readFileSync('package.json'));
const version = process.env.VERSION ?? pkg.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid release version');
const config = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json'));
const cargo = fs.readFileSync('src-tauri/Cargo.toml', 'utf8').match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const pubkey = process.env.TAURI_UPDATER_PUBLIC_KEY || config.plugins.updater.pubkey;
const decoded = Buffer.from(pubkey, 'base64').toString();
const key = Buffer.from(decoded.trim().split('\n')[1] ?? '', 'base64');
if (!decoded.startsWith('untrusted comment:') || key.length !== 42) throw new Error('Invalid updater public key');
if (config.version !== version || pkg.version !== version || cargo !== version) throw new Error('Source versions must match the release version');
// Prevent signing with a new key that existing Pengo installations would reject.
if (pubkey !== config.plugins.updater.pubkey) throw new Error('Repository public key must match the embedded Pengo key');
fs.writeFileSync('update-build.json', JSON.stringify({version,bundle:{createUpdaterArtifacts:true},plugins:{updater:{pubkey,requireSignedVersion:true}}},null,2)+'\n');
console.log(`Updater configuration ready for ${version}`);
