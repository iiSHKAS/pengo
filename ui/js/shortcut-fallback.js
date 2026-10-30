import { api, listen } from './api.js';
import { S, saveSettings, emit } from './store.js';
import { t } from './i18n.js';
import { el, esc, $ } from './util.js';

export let shortcutStatus = { active: false, fallback: false, error: '' };
let modal = null;
let busy = false;
let seen = false;
try { seen = localStorage.getItem('pengo-shortcut-fallback-seen') === 'true'; } catch {}
export const fallbackSeen = () => seen || S.settings.shortcut_fallback;
function markSeen() {
  seen = true;
  try { localStorage.setItem('pengo-shortcut-fallback-seen', 'true'); } catch {}
}
function update(status) {
  shortcutStatus = status;
  if (status.error) {
    const show = !seen || (status.fallback && !status.active);
    markSeen();
    if (show) showShortcutFallback();
  }
  emit('shortcut-status');
}
export async function initShortcutFallback() {
  // Subscribe first, then query: startup failures happen before the webview is ready.
  await listen('shortcut-status', e => update(e.payload));
  await listen('shortcut-failed', e => update({ ...shortcutStatus, error: String(e.payload) }));
  update(await api.shortcutStatus());
}
export async function disableShortcutFallback() {
  if (busy) return;
  busy = true;
  try {
    await saveSettings({ shortcut_fallback: false });
    update(await api.shortcutStatus());
  } finally { busy = false; emit('shortcut-status'); }
}
export function showShortcutFallback() {
  if (modal) return;
  markSeen();
  const previous = document.activeElement;
  modal = el(`<div class="modal-back"><div class="modal shortcut-fallback-modal" role="dialog" aria-modal="true" aria-labelledby="fallback-title">
    <h3 id="fallback-title">${esc(t('fallback.title'))}</h3>
    <p>${esc(t('fallback.description'))}</p>
    <div class="fallback-permission"><strong>${esc(t('fallback.permissionTitle'))}</strong><p>${esc(t('fallback.permission'))}</p></div>
    <p>${esc(t('fallback.password'))}</p><p>${esc(t('fallback.later'))}</p>
    ${S.env?.backend === 'unsupported' ? `<p class="fallback-warning">${esc(t('fallback.capture'))}</p>` : ''}
    <details><summary>${esc(t('fallback.details'))}</summary><p>${esc(t('fallback.permissionDetails'))}</p><p data-reason dir="auto"></p></details>
    <p data-error class="fallback-error" role="alert" dir="auto"></p>
    <div class="modal-actions"><button class="btn" data-later>${esc(t('fallback.laterButton'))}</button><button class="btn primary" data-enable>${esc(t('fallback.enable'))}</button></div>
  </div></div>`);
  const node = modal;
  $('[data-reason]', node).textContent = shortcutStatus.error;
  const close = () => {
    if (busy) return;
    modal = null;
    node.remove();
    previous?.focus();
    emit('shortcut-status');
  };
  $('[data-later]', node).onclick = close;
  node.onmousedown = e => { if (e.target === node) close(); };
  node.onkeydown = e => {
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); }
    if (e.key === 'Tab') {
      const focusable = [...node.querySelectorAll('button:not(:disabled), summary')];
      const first = focusable[0], last = focusable.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  $('[data-enable]', node).onclick = async () => {
    if (busy) return;
    busy = true;
    node.querySelectorAll('button').forEach(b => b.disabled = true);
    $('[data-enable]', node).textContent = t('fallback.authorizing');
    $('[data-error]', node).textContent = '';
    let succeeded = false;
    try {
      await api.enableInputShortcutAccess();
      await saveSettings({ shortcut_fallback: true });
      shortcutStatus = await api.shortcutStatus();
      // A previously enabled reader may have lost all keyboards; saving the
      // same preference retries registration in the backend as well.
      succeeded = shortcutStatus.active;
      if (!succeeded) throw Error(shortcutStatus.error);
    } catch (error) {
      $('[data-error]', node).textContent = String(error);
    } finally {
      busy = false;
      node.querySelectorAll('button').forEach(b => b.disabled = false);
      $('[data-enable]', node).textContent = t('fallback.enable');
      if (succeeded) close();
      emit('shortcut-status');
    }
  };
  $('#modal-root').appendChild(node);
  requestAnimationFrame(() => node.classList.add('in'));
  $('[data-later]', node).focus();
}
