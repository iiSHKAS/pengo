import { createUpdateSettings } from './updates.js';
import { shortcutStatus, fallbackSeen, showShortcutFallback, disableShortcutFallback } from './shortcut-fallback.js';
import { api } from './api.js';
import { icon } from './icons.js';
import { t } from './i18n.js';
import { S, saveSettings, emit } from './store.js';
import { $, el, esc } from './util.js';
import { toast, Switch, Segmented, Select } from './components.js';

const root = () => $('#view-settings');
let recording = false;
let logLines = [];

// ---- small builders so the page reads as data; the controls themselves live in components.js
function row(title, desc, ...controls) {
  const r = el('<div class="row"><div class="row-text"><div class="row-title"></div></div></div>');
  r.querySelector('.row-title').textContent = title ?? '';
  const text = r.querySelector('.row-text');
  for (const d of [desc].flat().filter(Boolean)) {
    const line = el('<div class="row-desc"></div>');
    if (typeof d === 'object') { line.textContent = d.text; if (d.warn) line.style.color = 'var(--warn)'; } else line.textContent = d;
    text.appendChild(line);
  }
  controls.filter(Boolean).forEach(c => r.appendChild(c));
  return r;
}
const section = (title, ...rows) => {
  const w = el('<div class="set-section"><div class="section-title"></div><div class="panel"></div></div>');
  w.querySelector('.section-title').textContent = title;
  rows.filter(Boolean).forEach(r => w.querySelector('.panel').appendChild(r));
  return w;
};
const pill = (text, title) => { const p = el('<span class="path-pill"></span>'); p.textContent = text; if (title) p.title = title; return p; };
const button = (label, ic, onClick, cls = '') => {
  const b = el(`<button class="btn ${cls}">${ic ? icon(ic, 17) : ''}<span></span></button>`);
  b.querySelector('span').textContent = label; b.onclick = onClick; return b;
};
// `parent`: a setting this one depends on - shown indented and greyed out while the parent is off.
const toggle = (key, title, desc, { parent, after } = {}) => {
  const off = parent && !S.settings[parent];
  const r = row(title, desc, Switch({ checked: S.settings[key], ariaLabel: title, disabled: off,
    onChange: async v => { await saveSettings({ [key]: v }); after?.(); } }));
  if (parent) r.classList.add('sub');
  if (off) r.classList.add('is-disabled');
  return r;
};
const choice = (key, items, after) => Segmented({ items, value: S.settings[key], onChange: async v => { await saveSettings({ [key]: v }); after?.(); } });

export async function renderSettings() {
  S.env = await api.envInfo();
  logLines = await api.getLog();
  draw(S.settings, S.env);
}

// One scrolling page, ordered by how people use it: capture -> result -> storage -> app -> system.
function draw(s, env) {
  const ok = env.reachable;
  const shortcutBtn = shortcutButton('shortcut', s.shortcut);
  const winBtn = shortcutButton('shortcut_window', s.shortcut_window, true);
  const screenBtn = shortcutButton('shortcut_screen', s.shortcut_screen, true);

  const status = el(`<span class="status-pill"><span class="dot ${ok ? 'ok' : 'bad'}"></span><span></span></span>`);
  status.lastElementChild.textContent = ok ? t('set.engine.ok') : t('set.engine.missing');
  const install = env.backend === 'gnome' && button(t('set.engine.install'), 'plug', async () => {
    const msg = await api.installExtension();
    toast(msg.length > 90 ? msg.slice(0, 90) + '…' : msg);
    setTimeout(renderSettings, 600);
  });

  const log = el('<pre class="log" id="s-log"></pre>');
  log.textContent = logLines.join('\n') || t('set.diag.empty');
  const logSec = el('<div class="set-section"><div class="section-title"></div><div class="panel"></div></div>');
  logSec.querySelector('.section-title').textContent = t('set.diag');
  logSec.querySelector('.panel').appendChild(log);

  const page = el('<div class="settings-scroll"><div class="settings-col"></div></div>');
  page.firstElementChild.append(
    section(t('set.sec.behavior'),
      toggle('start_with_system', t('set.autostart'), t('set.autostart.desc'), { after: renderSettings }),
      toggle('start_minimized', t('set.startmin'), t('set.startmin.desc'), { parent: 'start_with_system' }),
      toggle('minimize_to_tray', t('set.mintray'), env.tray ? t('set.mintray.desc') : t('set.tray.na')),
      toggle('close_to_tray', t('set.tray'), env.tray ? t('set.tray.desc') : t('set.tray.na'))),
    section(t('set.sec.appearance'),
      row(t('set.language'), null, Select({
        ariaLabel: t('set.language'), value: s.language,
        options: [{ value: 'auto', label: t('set.lang.auto') }, { value: 'en', label: 'English' }, { value: 'ar', label: 'العربية' }],
        onChange: async v => { await saveSettings({ language: v }); emit('appearance'); },
      })),
      row(t('set.theme'), null, choice('theme', [['dark', t('set.theme.dark')], ['light', t('set.theme.light')], ['auto', t('set.theme.auto')]], () => emit('appearance')))),
    section(t('set.sec.shortcut'),
      row(t('set.shortcut'), t('set.shortcut.desc'), shortcutBtn),
      ['gnome', 'x11'].includes(env.backend) && row(t('set.shortcut.window'), t('set.shortcut.window.desc'), winBtn),
      ['gnome', 'x11'].includes(env.backend) && row(t('set.shortcut.screen'), t('set.shortcut.screen.desc'), screenBtn),
      fallbackSeen() && row(t('fallback.setting'),
        [t(s.shortcut_fallback ? shortcutStatus.active ? 'fallback.active' : 'fallback.waiting' : 'fallback.settingDescription'),
         shortcutStatus.error && { text: shortcutStatus.error, warn: true }],
        button(t(s.shortcut_fallback ? 'fallback.details' : 'fallback.enable'), null, showShortcutFallback),
        s.shortcut_fallback && Switch({ checked: true, ariaLabel: t('fallback.setting'), onChange: async () => {
          try { await disableShortcutFallback(); } catch (e) { toast(String(e), 'err'); }
          renderSettings();
        } }))),
    section(t('set.sec.engine'),
      row(t('set.engine'), [t(`set.engine.${env.backend}`),
        env.backend === 'gnome' && !ok && { text: t('set.engine.hint'), warn: true },
        env.backend === 'unsupported' && t('set.engine.unsupported.desc')], status, install)),
    section(t('set.sec.result'),
      row(t('set.format'), t('set.format.desc'), choice('image_format', [['png', 'PNG'], ['jpg', 'JPG'], ['webp', 'WebP'], ['bmp', 'BMP']], renderSettings)),
      s.image_format === 'jpg' && qualityRow(s.jpeg_quality),
      row(t('set.after'), null, choice('after_capture', [['gallery', t('set.after.gallery')], ['editor', t('set.after.editor')]])),
      toggle('copy_to_clipboard', t('set.copy'), t('set.copy.desc')),
      toggle('notifications', t('set.notify'), t('set.notify.desc'))),
    section(t('set.sec.location'),
      row(t('set.folder'), t('set.folder.desc'), pill(s.output_dir, s.output_dir),
        button(t('set.folder.change'), 'folder', async () => {
          const dir = await api.pickFolder();
          if (dir) { await saveSettings({ output_dir: dir }); emit('items-dir'); renderSettings(); }
        }),
        button(t('set.folder.open'), 'external', () => api.openExternal(S.settings.output_dir)))),
    section(t('updates.title'), createUpdateSettings()),
    section(t('set.sec.system'),
      row(t('set.session'), null, pill(`${env.session || '—'} · ${env.desktop || '—'}`)),
      row(t('set.quit'), null, button(t('set.quit'), null, () => api.quit(), 'danger'))),
    logSec,
  );
  root().replaceChildren(el(`<div class="topbar"><div><h1 class="page-title">${esc(t('set.title'))}</h1></div></div>`), page);
}

// A recorder button for one shortcut setting; `clearable` ones may be emptied with Backspace/Delete.
function shortcutButton(key, value, clearable = false) {
  const b = el('<button class="shortcut-btn"></button>');
  b.innerHTML = value ? value.split('+').map(k => `<kbd>${esc(pretty(k))}</kbd>`).join('') : `<span class="muted">${esc(t('set.shortcut.none'))}</span>`;
  b.onclick = () => startRecording(b, key, clearable);
  return b;
}

function qualityRow(q) {
  const input = el(`<input class="range" type="range" min="40" max="100" step="1" value="${q}" aria-label="${esc(t('set.quality'))}">`);
  const val = el(`<span class="path-pill">${q}</span>`);
  input.oninput = () => { val.textContent = input.value; };
  input.onchange = () => saveSettings({ jpeg_quality: Number(input.value) });
  return row(t('set.quality'), t('set.quality.desc'), input, val);
}

const CODE_NAMES = {
  Backslash: 'Backslash', Comma: 'Comma', Period: 'Period', Slash: 'Slash', Semicolon: 'Semicolon', Quote: 'Quote',
  BracketLeft: 'BracketLeft', BracketRight: 'BracketRight', Minus: 'Minus', Equal: 'Equal', Backquote: 'Backquote',
  Space: 'Space', Escape: 'Esc', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left',
  ArrowRight: 'Right', PrintScreen: 'Print',
};
const LABELS = { Backslash: '\\', Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Backquote: '`' };
const pretty = k => LABELS[k] || k;

// Physical key (e.code), so Shift/layout can't change what gets recorded.
function keyName(e) {
  const c = e.code;
  if (/^(Control|Shift|Alt|Meta|OS)/.test(c)) return null;
  if (/^Key[A-Z]$/.test(c)) return c.slice(3);
  if (/^Digit\d$/.test(c)) return c.slice(5);
  if (/^F\d{1,2}$/.test(c)) return c;
  return CODE_NAMES[c] || null;
}

function startRecording(btn, key0 = 'shortcut', clearable = false) {
  if (recording) return;
  recording = true;
  btn.classList.add('rec');
  btn.innerHTML = esc(t(clearable ? 'set.shortcut.press.clear' : 'set.shortcut.press'));
  const onKey = async e => {
    e.preventDefault(); e.stopPropagation();
    if (e.key === 'Escape') return stop();
    if (clearable && (e.key === 'Backspace' || e.key === 'Delete')) {
      stop(false);
      try { await saveSettings({ [key0]: '' }); toast(t('set.shortcut.saved')); } catch (err) { toast(String(err), 'err'); }
      return renderSettings();
    }
    const key = keyName(e);
    if (!key) return;
    const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean);
    if (!mods.length && !/^F\d+$/.test(key) && key !== 'Print') { toast(t('set.shortcut.bad'), 'err'); return; }
    stop(false);
    const accel = [...mods, key].join('+');
    try {
      await saveSettings({ [key0]: accel });
      toast(t('set.shortcut.saved'));
    } catch (err) {
      toast(String(err), 'err');
    }
    renderSettings();
  };
  const stop = (redraw = true) => {
    recording = false;
    document.removeEventListener('keydown', onKey, true);
    btn.classList.remove('rec');
    if (redraw) renderSettings();
  };
  document.addEventListener('keydown', onKey, true);
}

export function pushLog(line) {
  logLines.push(line);
  const el = $('#s-log');
  if (el) { el.textContent = logLines.join('\n'); el.scrollTop = el.scrollHeight; }
}
