import { initUpdates } from './updates.js';
import { initShortcutFallback } from './shortcut-fallback.js';
import { api, listen, assetUrl, jsLog } from './api.js';
import { icon } from './icons.js';
import { t, setLanguage } from './i18n.js';
import { S, on, emit, shortcutLabel } from './store.js';
import { $, $$, esc } from './util.js';
import { toast } from './components.js';
import { renderShell, render as renderGallery, reload, libraryKey, applyLabels, startCapture } from './gallery.js';
import { renderSettings, pushLog } from './settings.js';
import { openEditor, closeEditor, editorOpen, relabelEditor } from './editor.js';
import './smoothscroll.js';
import { loadImageFile, renderAnnotations, canvasToPng } from './annotate.js';

const win = window.__TAURI__.window.getCurrentWindow();

function renderTitlebar() {
  const bar = $('#titlebar');
  bar.innerHTML = `<div class="tb-title" data-tauri-drag-region><img src="assets/pengo.png" alt="">Pengo</div>
    <div class="tb-controls">
      <button class="tb-btn" id="tb-min" title="Minimize"><svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 6h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button>
      <button class="tb-btn" id="tb-max" title="Maximize"><svg width="12" height="12" viewBox="0 0 12 12"><rect x="2" y="2" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/></svg></button>
      <button class="tb-btn close" id="tb-close" title="Close"><svg width="12" height="12" viewBox="0 0 12 12"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button>
    </div>`;
  $('#tb-min').onclick = () => (S.settings?.minimize_to_tray && S.env?.tray ? win.hide() : win.minimize());
  $('#tb-max').onclick = () => win.toggleMaximize();
  $('#tb-close').onclick = () => win.close();
  if (!document.querySelector('.rz')) {
    const dirs = { n: 'North', s: 'South', w: 'West', e: 'East', nw: 'NorthWest', ne: 'NorthEast', sw: 'SouthWest', se: 'SouthEast' };
    for (const [k, v] of Object.entries(dirs)) {
      const d = document.createElement('div');
      d.className = `rz ${k}`;
      d.onmousedown = e => { if (e.button === 0) { e.preventDefault(); win.startResizeDragging(v); } };
      document.body.appendChild(d);
    }
  }
  const sync = async () => document.body.classList.toggle('maximized', await win.isMaximized());
  win.onResized(sync); sync();
}

function applyAppearance() {
  setLanguage(S.settings.language);
  const theme = S.settings.theme === 'auto'
    ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : S.settings.theme;
  document.documentElement.dataset.theme = theme;
}

function renderSidebar() {
  const fav = S.settings.favorites.filter(p => S.items.some(i => i.path === p)).length;
  const env = S.env;
  $('#sidebar').innerHTML = `
    <div class="brand">
      <div class="brand-mark"><img src="assets/pengo.png" alt=""></div>
      <div><div class="brand-name">Pengo</div></div>
    </div>
    <button class="nav-item ${S.view === 'library' ? 'active' : ''}" data-nav="library">${icon('library', 19)}<span>${esc(t('nav.library'))}</span><span class="badge">${S.items.length}</span></button>
    <button class="nav-item ${S.view === 'favorites' ? 'active' : ''}" data-nav="favorites">${icon('star', 19)}<span>${esc(t('nav.favorites'))}</span><span class="badge">${fav || ''}</span></button>
    <div class="sidebar-spacer"></div>
    <button class="nav-item ${S.view === 'settings' ? 'active' : ''}" data-nav="settings">${icon('settings', 19)}<span>${esc(t('nav.settings'))}</span></button>
    <div class="sidebar-foot"><div class="divider"></div><div class="ver"><i></i>${esc(t('set.version'))} ${esc(env?.version || '')}</div></div>`;
  $$('[data-nav]').forEach(b => (b.onclick = () => navigate(b.dataset.nav)));
}

async function navigate(view) {
  if (editorOpen() && !(await closeEditor())) return;
  S.view = view;
  showView();
}

function showView() {
  const v = S.view;
  $('#view-library').hidden = !(v === 'library' || v === 'favorites');
  $('#view-settings').hidden = v !== 'settings';
  $('#view-editor').hidden = v !== 'editor';
  document.body.classList.remove('selecting');
  if (v === 'library' || v === 'favorites') renderGallery();
  if (v === 'settings') renderSettings();
  renderSidebar();
}

on('shortcut-status', () => { if (S.view === 'settings') renderSettings(); });
on('view', showView);
on('items', renderSidebar);
on('settings', () => { renderSidebar(); });
on('appearance', () => {
  applyAppearance();
  renderSidebar(); renderShell(); showView();
  relabelEditor();
});
on('items-dir', () => reload());

// ---- GNOME: captures annotated in the Shell overlay are composited here
async function composeCapture(p) {
  try {
    const img = await loadImageFile(p.path);
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const cx = c.getContext('2d');
    cx.drawImage(img, 0, 0);
    const ox = Math.floor(p.x * p.scale) / p.scale, oy = Math.floor(p.y * p.scale) / p.scale;
    renderAnnotations(cx, p.annotations, { ox, oy, scale: p.scale });
    let out = c;
    if (Math.abs(p.native - p.scale) > 0.01) {
      const f = p.native / p.scale;
      out = document.createElement('canvas');
      out.width = Math.max(1, Math.round(c.width * f)); out.height = Math.max(1, Math.round(c.height * f));
      const o = out.getContext('2d');
      o.imageSmoothingQuality = 'high';
      o.drawImage(c, 0, 0, out.width, out.height);
    }
    await api.finishCompose(await canvasToPng(out), p.label || 'capture', p.path);
  } catch (e) {
    toast(String(e), 'err');
  }
}

async function init() {
  S.settings = await api.getSettings();
  S.env = await api.envInfo();
  try { S.cardSize = +localStorage.cardSize || 250; } catch {}
  document.documentElement.style.setProperty('--card-min', `${S.cardSize}px`);
  applyAppearance();
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => S.settings.theme === 'auto' && applyAppearance());

  renderTitlebar();
  renderShell();
  renderSidebar();
  showView();
  await reload();
  renderSidebar();

  jsLog(`ui ready: ${S.items.length} items, view=${S.view}, cards=${document.querySelectorAll('.card').length}, lang=${document.documentElement.lang}, grid=${document.querySelector('.grid')?.getBoundingClientRect().width}`);
  document.addEventListener('keydown', libraryKey);
  document.addEventListener('contextmenu', e => { if (!e.target.closest('input, textarea, .card')) e.preventDefault(); });
  window.addEventListener('focus', () => { if (!editorOpen() && S.view !== 'settings') reload(); });

  await initUpdates();
  await initShortcutFallback();
  await listen('captured', () => { reload(); toast(t('toast.captured')); });
  await listen('library-changed', () => reload());
  await listen('open-editor', ev => openEditor(ev.payload));
  await listen('compose-capture', ev => composeCapture(ev.payload));
  await listen('log', ev => pushLog(ev.payload));
  await listen('engine-status', async () => { S.env = await api.envInfo(); renderSidebar(); if (S.view === 'settings') renderSettings(); });
}

init().catch(e => { document.body.innerHTML = `<pre style="padding:24px;color:#f66">${esc(String(e))}</pre>`; });
