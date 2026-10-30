const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<div id="update-banner" hidden></div><div id="settings"></div>', { url: 'https://pengo.test' });
const { document } = dom.window;
const events = new Map(), appEvents = new Map();
const on = (name, fn) => { const all = appEvents.get(name) || []; all.push(fn); appEvents.set(name, all); };
const emit = name => (appEvents.get(name) || []).forEach(fn => fn());
let current = { enabled: true, supported: true, configured: true, status: { phase: 'idle', version: null, downloaded: 0, total: null, error: null } };
let snapshot, rejectToggle = false, rejectRestart = false, restarts = 0, checks = 0;
const api = {
  getUpdateStatus: async () => snapshot ? snapshot() : structuredClone(current),
  setAutoUpdate: async enabled => { if (rejectToggle) throw Error('Cannot save preferences'); current.enabled = enabled; },
  checkAndInstallUpdate: async () => { checks++; current.status.phase = 'current'; },
  restartApp: async () => { restarts++; if (rejectRestart) throw Error('Restart failed'); },
};
const context = vm.createContext({ document, navigator: { language: 'en' }, console });
const mocked = {
  './api.js': { api, listen: async (name, fn) => { events.set(name, fn); return () => events.delete(name); } },
  './store.js': { S: { env: { version: '0.1.0' } }, on, emit },
};
const cache = new Map();
async function load(name) {
  if (cache.has(name)) return cache.get(name);
  let module;
  if (mocked[name]) {
    module = new vm.SyntheticModule(Object.keys(mocked[name]), function () {
      for (const [key, value] of Object.entries(mocked[name])) this.setExport(key, value);
    }, { context });
  } else module = new vm.SourceTextModule(fs.readFileSync('ui/js/' + name.slice(2), 'utf8'), { context });
  cache.set(name, module);
  await module.link(load);
  return module;
}
function send(status) {
  current.status = { ...current.status, ...status };
  events.get('pengo://update')({ payload: structuredClone(current.status) });
}
(async () => {
  const uiModule = await load('./updates.js'); await uiModule.evaluate();
  const ui = uiModule.namespace;
  const store = cache.get('./updates-store.js').namespace;
  await ui.initUpdates();
  document.querySelector('#settings').appendChild(ui.createUpdateSettings());
  assert.equal(document.querySelector('[data-update-action="toggle"]').checked, true);
  assert.equal(document.querySelector('#update-banner').hidden, true);
  assert.equal(checks, 0, 'UI does not trigger an automatic update on subscription');
  current.supported = false; await store.refreshUpdates();
  assert.equal(document.querySelector('[data-update-action="check"]').disabled, true);
  assert.match(document.querySelector('.update-status').textContent, /AppImage/);
  current.supported = true; current.configured = false; await store.refreshUpdates();
  assert.equal(document.querySelector('[data-update-action="check"]').disabled, true);
  current.configured = true; await store.refreshUpdates();
  console.log('PASS supported/unconfigured/source-build states and default preference');

  let resolve;
  const stale = structuredClone(current);
  snapshot = () => new Promise(r => resolve = r);
  const refreshing = store.refreshUpdates();
  send({ phase: 'downloading', version: '0.2.0', downloaded: 50, total: 100 });
  resolve(stale); await refreshing; snapshot = null;
  assert.equal(store.updates.info.status.phase, 'downloading');
  assert.equal(document.querySelector('#update-banner').hidden, false);
  assert.equal(document.querySelector('[role=progressbar]').getAttribute('aria-valuenow'), '50');
  send({ total: null });
  assert.equal(document.querySelector('[role=progressbar]').hasAttribute('aria-valuenow'), false);
  console.log('PASS progress with known/unknown length and stale snapshot protection');

  rejectToggle = true;
  await store.toggleUpdates(false);
  assert.equal(store.updates.info.enabled, true);
  assert.match(document.querySelector('.update-action-error').textContent, /Cannot save/);
  rejectToggle = false; await store.toggleUpdates(false);
  assert.equal(store.updates.info.enabled, false);
  send({ phase: 'idle' });
  await store.checkUpdates();
  assert.equal(checks, 1, 'manual check works with automatic updates disabled');
  assert.equal(store.updates.pending, false);
  console.log('PASS persisted toggle errors and manual check while auto-update is off');

  send({ phase: 'error', error: '<img src=x onerror=bad()> signature verification failed' });
  assert.equal(document.querySelector('.update-status img'), null);
  assert.match(document.querySelector('.update-status').textContent, /signature verification/);
  assert.ok(document.querySelector('.update-error-details code'));
  send({ phase: 'installed', error: null, version: '0.2.0' });
  assert.equal(restarts, 0, 'installation never restarts automatically');
  assert.ok(document.querySelector('[data-update-action="restart"]'));
  rejectRestart = true; await store.restartApplication();
  assert.equal(store.updates.restarting, false);
  assert.match(document.querySelector('#update-banner').textContent, /Restart failed/);
  rejectRestart = false; await store.restartApplication(); await store.restartApplication();
  assert.equal(restarts, 2, 'duplicate restart clicks are suppressed');
  cache.get('./i18n.js').namespace.setLanguage('ar'); emit('appearance');
  assert.equal(document.documentElement.dir, 'rtl');
  assert.match(document.querySelector('#update-banner').textContent, /إعادة التشغيل/);
  console.log('PASS escaped errors, explicit restart, restart retry and Arabic rendering');
})().catch(error => { console.error(error); process.exitCode = 1; });
