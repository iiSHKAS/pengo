// UI behavior tests: IPC and permissions are mocked; no desktop changes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
async function scenario({ error = '', fallback = false, seen = false } = {}) {
  const dom = new JSDOM('<button id="previous">Settings</button><div id="modal-root"></div>', { url: 'https://pengo.test' });
  const { document, localStorage } = dom.window;
  if (seen) localStorage.setItem('pengo-shortcut-fallback-seen', 'true');
  const S = { settings: { shortcut_fallback: fallback }, env: { backend: 'unsupported' } };
  let status = { active: !error, fallback, error };
  const listeners = new Map();
  let attempts = 0, rejectAccess = false, rejectSave = false;
  const api = {
    shortcutStatus: async () => status,
    enableInputShortcutAccess: async () => { attempts++; if (rejectAccess) throw Error('Authorization cancelled'); },
  };
  const context = vm.createContext({ document, localStorage, requestAnimationFrame: fn => fn(), console });
  const sources = {
    './api.js': { api, listen: async (name, fn) => listeners.set(name, fn) },
    './store.js': { S, emit: () => {}, saveSettings: async patch => {
      if (rejectSave) throw Error('No readable keyboard');
      Object.assign(S.settings, patch);
      status = patch.shortcut_fallback ? { active: true, fallback: true, error: '' } : { active: false, fallback: false, error: 'Unsupported desktop' };
    } },
    './i18n.js': { t: key => key },
    './util.js': {
      el: html => { const template = document.createElement('template'); template.innerHTML = html; return template.content.firstElementChild; },
      esc: text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
      $: (selector, root = document) => root.querySelector(selector),
    },
  };
  const module = new vm.SourceTextModule(fs.readFileSync('ui/js/shortcut-fallback.js', 'utf8'), { context });
  await module.link(name => new vm.SyntheticModule(Object.keys(sources[name]), function () {
    for (const [key, value] of Object.entries(sources[name])) this.setExport(key, value);
  }, { context }));
  await module.evaluate();
  await module.namespace.initShortcutFallback();
  return { document, S, module: module.namespace, listeners, localStorage,
    attempts: () => attempts, rejectAccess: value => rejectAccess = value, rejectSave: value => rejectSave = value };
}
(async () => {
  let x = await scenario();
  assert.equal(x.document.querySelector('[role=dialog]'), null);
  assert.equal(x.attempts(), 0);
  console.log('PASS healthy native startup never requests input permission');
  x = await scenario({ error: 'Unsupported desktop' });
  assert.ok(x.document.querySelector('[role=dialog]'));
  assert.equal(x.attempts(), 0);
  x.document.querySelector('[data-later]').click();
  assert.equal(x.document.querySelector('[role=dialog]'), null);
  assert.equal(x.localStorage.getItem('pengo-shortcut-fallback-seen'), 'true');
  assert.equal(x.S.settings.shortcut_fallback, false);
  assert.equal(x.module.fallbackSeen(), true);
  x = await scenario({ error: 'Unsupported desktop', seen: true });
  assert.equal(x.document.querySelector('[role=dialog]'), null);
  x.module.showShortcutFallback();
  assert.ok(x.document.querySelector('[role=dialog]'));
  console.log('PASS failure, Later, persisted dismissal, settings reopen');
  x.rejectAccess(true);
  await x.document.querySelector('[data-enable]').onclick();
  assert.match(x.document.querySelector('[data-error]').textContent, /Authorization cancelled/);
  assert.equal(x.S.settings.shortcut_fallback, false);
  assert.equal(x.document.querySelector('[data-enable]').disabled, false);
  x.rejectAccess(false); x.rejectSave(true);
  await x.document.querySelector('[data-enable]').onclick();
  assert.match(x.document.querySelector('[data-error]').textContent, /No readable keyboard/);
  assert.equal(x.S.settings.shortcut_fallback, false);
  console.log('PASS cancelled authorization and activation failure preserve disabled preference');
  x.rejectSave(false);
  await x.document.querySelector('[data-enable]').onclick();
  assert.equal(x.S.settings.shortcut_fallback, true);
  assert.equal(x.document.querySelector('[role=dialog]'), null);
  assert.equal(x.module.shortcutStatus.active, true);
  x.listeners.get('shortcut-status')({ payload: { active: false, fallback: true, error: 'Disconnected' } });
  assert.ok(x.document.querySelector('[role=dialog]'));
  x.listeners.get('shortcut-status')({ payload: { active: true, fallback: true, error: '' } });
  assert.equal(x.module.shortcutStatus.active, true);
  x.document.querySelector('[data-later]').click();
  await x.module.disableShortcutFallback();
  assert.equal(x.S.settings.shortcut_fallback, false);
  assert.equal(x.module.shortcutStatus.active, false);
  assert.equal(x.document.querySelector('[role=dialog]'), null);
  console.log('PASS retry, activation, disconnect/reconnect and disabling on unsupported desktop');
  x = await scenario({ error: 'Keyboard missing', fallback: true, seen: true });
  assert.ok(x.document.querySelector('[role=dialog]'));
  console.log('PASS saved fallback failure remains recoverable after restart');
})().catch(error => { console.error(error); process.exitCode = 1; });
