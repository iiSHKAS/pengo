const tauri = window.__TAURI__;
export const invoke = tauri.core.invoke;
export const convertFileSrc = tauri.core.convertFileSrc;
export const listen = tauri.event.listen;

const enc = v => encodeURIComponent(v);

export const api = {
  getUpdateStatus: () => invoke('get_update_status'),
  setAutoUpdate: enabled => invoke('set_auto_update', { enabled }),
  checkAndInstallUpdate: () => invoke('check_and_install_update'),
  restartApp: () => invoke('restart_app'),
  getSettings: () => invoke('get_settings'),
  setSettings: settings => invoke('set_settings', { settings }),
  shortcutStatus: () => invoke('shortcut_status'),
  enableInputShortcutAccess: () => invoke('enable_input_shortcut_access'),
  envInfo: () => invoke('env_info'),
  getLog: () => invoke('get_log'),
  listItems: () => invoke('list_items'),
  thumbnail: path => invoke('thumbnail', { path }),
  deleteItems: paths => invoke('delete_items', { paths }),
  renameItem: (path, name) => invoke('rename_item', { path, name }),
  revealItem: path => invoke('reveal_item', { path }),
  openExternal: path => invoke('open_external', { path }),
  copyItem: path => invoke('copy_item', { path }),
  startCapture: () => invoke('start_capture'),
  installExtension: () => invoke('install_extension'),
  saveImage: (bytes, path, mode) => invoke('save_image', bytes, { headers: { 'x-path': enc(path), 'x-mode': mode } }),
  finishCompose: (bytes, label, base) => invoke('finish_compose', bytes, { headers: { 'x-label': enc(label), 'x-base': enc(base) } }),
  readFile: path => invoke('read_file', { path }),
  copyBytes: bytes => invoke('copy_bytes', bytes),
  quit: () => invoke('quit_app'),
  pickFolder: async () => tauri.dialog.open({ directory: true, multiple: false }),
};

export const assetUrl = path => convertFileSrc(path);

const report = m => { try { invoke('js_log', { message: String(m).slice(0, 600) }); } catch {} };
window.addEventListener('error', e => report(`${e.message} @ ${(e.filename || '').split('/').pop()}:${e.lineno}`));
window.addEventListener('unhandledrejection', e => report(`unhandled: ${e.reason?.stack || e.reason}`));
export const jsLog = report;
