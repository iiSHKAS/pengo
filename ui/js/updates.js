// Sonux's update banner and settings, using Pengo's UI components/translations.
import { updates, subscribeUpdates, toggleUpdates, checkUpdates, restartApplication } from './updates-store.js';
import { S, on } from './store.js';
import { t } from './i18n.js';
import { $, el, esc } from './util.js';
import { icon } from './icons.js';

function errorKind(raw) {
  const e = raw.toLowerCase();
  if (/signature|minisign/.test(e)) return 'signature';
  if (/certificate|tls|ssl|handshake/.test(e)) return 'tls';
  if (/timed out|timeout/.test(e)) return 'timeout';
  if (/error sending request|dns|connect|network|resolve|unreachable|offline/.test(e)) return 'network';
  return 'other';
}
function statusHTML(detailed = false) {
  const info = updates.info;
  if (!info) return '';
  if (!info.supported) return esc(t('updates.unsupported'));
  if (!info.configured) return esc(t('updates.unconfigured'));
  const status = info.status;
  if (status.phase === 'error') {
    if (!detailed) return esc(t('updates.error'));
    return `${esc(t('updates.error'))}: ${esc(t(`updates.error.${errorKind(status.error ?? '')}`))}
      ${status.error ? `<details class="update-error-details"><summary>${esc(t('updates.error.details'))}</summary><code dir="ltr">${esc(status.error)}</code></details>` : ''}`;
  }
  const percent = status.total ? Math.min(100, Math.floor(status.downloaded / status.total * 100)) : null;
  return esc(t(`updates.${status.phase}`, status.version ?? '')) + (status.phase === 'downloading' && percent !== null ? ` ${percent}%` : '');
}
function progressHTML() {
  const status = updates.info?.status;
  if (!status || !['downloading', 'installing'].includes(status.phase)) return '';
  const known = status.phase === 'downloading' && status.total > 0;
  const percent = known ? Math.max(0, Math.min(100, Math.floor(status.downloaded / status.total * 100))) : undefined;
  const mb = bytes => `${(bytes / 1048576).toFixed(1)} MB`;
  const label = esc(t(`updates.${status.phase}`, status.version ?? ''));
  return `<div class="update-progress">
    <div class="update-progress-meta" aria-hidden="true"><span>${label}</span><span dir="ltr">${percent === undefined ? '…' : `${percent}%`}</span></div>
    <div class="update-progress-track ${known ? '' : 'indeterminate'}" role="progressbar" aria-label="${label}" aria-valuemin="0" aria-valuemax="100" ${known ? `aria-valuenow="${percent}"` : ''}>
      <div class="update-progress-fill" ${known ? `style="width:${percent}%"` : ''}></div>
    </div>
    ${status.phase === 'downloading' ? `<div class="update-transfer" dir="ltr">${mb(status.downloaded)}${known ? ` / ${mb(status.total)}` : ''}</div>` : ''}
  </div>`;
}
function drawSettings(root) {
  const { info, pending, actionError, restarting } = updates;
  const phase = info?.status.phase ?? 'idle';
  const busy = ['checking', 'downloading', 'installing', 'installed'].includes(phase);
  const emblem = ['installed', 'current'].includes(phase) ? 'check' : phase === 'error' ? 'warn' : 'download';
  // Preserve keyboard focus while progress events update this small panel.
  const focused = root.contains(document.activeElement) ? document.activeElement?.dataset.updateAction : null;
  root.innerHTML = `<div class="update-overview">
    <span class="update-emblem phase-${phase}">${icon(emblem, 25)}</span>
    <div class="update-heading"><strong>${esc(t('updates.title'))}</strong><div class="update-status" role="status">${statusHTML(true)}</div></div>
    <span class="update-version" dir="ltr">${esc(S.env?.version || '')}</span>
  </div>${progressHTML()}
  <label class="update-toggle"><span><strong>${esc(t('updates.automatic'))}</strong><span class="update-description">${esc(t('updates.description'))}</span></span>
    <input type="checkbox" role="switch" data-update-action="toggle" ${info?.enabled ?? true ? 'checked' : ''} ${!info?.supported || pending ? 'disabled' : ''}>
  </label>
  ${actionError ? `<p class="update-action-error" role="alert">${esc(actionError)}</p>` : ''}
  <div class="update-actions">${phase === 'installed'
    ? `<button class="btn primary" data-update-action="restart" ${restarting ? 'disabled' : ''}>${esc(t('updates.restart'))}</button>`
    : `<button class="btn primary" data-update-action="check" ${!info?.supported || !info?.configured || pending || busy ? 'disabled' : ''}>${esc(t(phase === 'checking' ? 'updates.checking' : 'updates.check'))}</button>`}</div>`;
  $('[data-update-action="toggle"]', root).onchange = e => void toggleUpdates(e.target.checked);
  const check = $('[data-update-action="check"]', root);
  if (check) check.onclick = () => void checkUpdates();
  const restart = $('[data-update-action="restart"]', root);
  if (restart) restart.onclick = () => void restartApplication();
  if (focused) root.querySelector(`[data-update-action="${focused}"]`)?.focus({ preventScroll: true });
}
export function createUpdateSettings() {
  const root = el('<div class="update-settings" data-update-settings></div>');
  drawSettings(root);
  return root;
}
export function renderUpdates() {
  document.querySelectorAll('[data-update-settings]').forEach(drawSettings);
  const banner = $('#update-banner');
  if (!banner) return;
  const phase = updates.info?.status.phase;
  banner.hidden = !updates.info?.supported || !['downloading', 'installing', 'installed'].includes(phase);
  if (banner.hidden) { banner.replaceChildren(); return; }
  banner.innerHTML = `<div class="update-banner-body"><div>${statusHTML()}</div>${progressHTML()}
    ${updates.actionError ? `<p class="update-action-error" role="alert">${esc(updates.actionError)}</p>` : ''}</div>
    ${phase === 'installed' ? `<button class="btn" ${updates.restarting ? 'disabled' : ''}>${esc(t('updates.restart'))}</button>` : ''}`;
  const button = $('button', banner);
  if (button) button.onclick = () => void restartApplication();
}
export async function initUpdates() {
  on('updates', renderUpdates);
  on('appearance', renderUpdates);
  try { await subscribeUpdates(); }
  catch (error) { updates.actionError = String(error); renderUpdates(); }
}
