import { api, assetUrl } from './api.js';
import { icon } from './icons.js';
import { t, locale } from './i18n.js';
import { S, emit, on, isFav, toggleFav, shortcutLabel } from './store.js';
import { $, $$, esc, humanSize, debounce } from './util.js';
import { toast, confirmDialog, promptDialog, Select, mountSlots } from './components.js';
import { openViewer } from './viewer.js';
import { openEditor } from './editor.js';

const root = () => $('#view-library');
let lastClicked = -1;
let sortSel;
let visible = [];          // items currently shown, in display order

// ---------------------------------------------------------------- data
export async function reload() {
  try {
    S.items = await api.listItems();
  } catch (e) {
    toast(String(e), 'err');
  }
  S.loaded = true;
  const paths = new Set(S.items.map(i => i.path));
  S.selected = new Set([...S.selected].filter(p => paths.has(p)));
  emit('items');
  render();
}

function displayName(it) {
  return it.app || it.name.replace(/\.[^.]+$/, '');
}

function filtered() {
  const q = S.query.trim().toLowerCase();
  let list = S.items.filter(it => {
    if (S.view === 'favorites' && !isFav(it.path)) return false;
    if (S.app !== 'all' && (it.app || '—') !== S.app) return false;
    if (q && !(it.name.toLowerCase().includes(q) || it.app.toLowerCase().includes(q))) return false;
    return true;
  });
  const by = {
    newest: (a, b) => b.mtime - a.mtime,
    oldest: (a, b) => a.mtime - b.mtime,
    name: (a, b) => a.name.localeCompare(b.name),
    size: (a, b) => b.size - a.size,
  }[S.sort];
  return list.sort(by);
}

function groupLabel(ts) {
  const d = new Date(ts * 1000), now = new Date();
  const day = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff <= 0) return t('group.today');
  if (diff === 1) return t('group.yesterday');
  if (diff < 7) return t('group.week');
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) return t('group.month');
  return d.toLocaleDateString(locale(), { month: 'long', year: 'numeric' });
}

function timeLabel(ts) {
  const d = new Date(ts * 1000);
  return d.toLocaleString(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

// ---------------------------------------------------------------- render
export function renderShell() {
  const r = root();
  r.innerHTML = `
    <div class="topbar">
      <div>
        <h1 class="page-title" id="lib-title"></h1>
        <div class="page-sub" id="lib-sub"></div>
      </div>
      <div class="spacer"></div>
      <label class="search">${icon('search', 17)}<input id="q" type="text" spellcheck="false"></label>
      <span data-slot="sort"></span>
      <input class="range" id="size" type="range" min="170" max="420" step="10" title="">
      <button class="btn icon" id="refresh" title="">${icon('refresh', 17)}</button>
    </div>
    <div class="chips" id="chips"></div>
    <div class="scroller" id="scroller"></div>
    <div class="selbar" id="selbar" hidden></div>`;

  sortSel = Select({ value: S.sort, onChange: v => { S.sort = v; render(); } });
  mountSlots(r, { sort: sortSel });
  const q = $('#q', r);
  q.addEventListener('input', debounce(() => { S.query = q.value; render(); }, 90));
  const size = $('#size', r);
  size.oninput = () => { S.cardSize = +size.value; document.documentElement.style.setProperty('--card-min', `${S.cardSize}px`); try { localStorage.cardSize = S.cardSize; } catch {} };
  $('#refresh', r).onclick = () => reload();

  const sc = $('#scroller', r);
  sc.addEventListener('click', onGridClick);
  sc.addEventListener('contextmenu', onContext);
  applyLabels();
}

export function applyLabels() {
  const r = root();
  if (!$('#q', r)) return;
  $('#q', r).placeholder = t('search.placeholder');
  sortSel.setOptions(['newest', 'oldest', 'name', 'size'].map(k => ({ value: k, label: t(`sort.${k}`) })));
  sortSel.setValue(S.sort);
  $('#refresh', r).title = t('act.refresh');
  $('#size', r).value = S.cardSize;
}

export async function startCapture() {
  try { await api.startCapture(); } catch (e) { toast(String(e), 'err'); }
}

export function render() {
  const r = root();
  if (!$('#scroller', r)) return;
  applyLabels();
  const fav = S.view === 'favorites';
  $('#lib-title', r).textContent = fav ? t('nav.favorites') : t('nav.library');
  visible = filtered();
  $('#lib-sub', r).textContent = t('count.items', visible.length);
  renderChips();

  const sc = $('#scroller', r);
  if (!S.loaded) { sc.innerHTML = ''; return; }
  if (!visible.length) {
    const searching = S.query.trim();
    sc.innerHTML = `<div class="empty">
      <div class="empty-art">${icon(fav ? 'star' : searching ? 'search' : 'image', 40)}</div>
      <h2>${esc(searching ? t('empty.search', S.query) : fav ? t('nav.favorites') : t('empty.title'))}</h2>
      <p>${esc(fav ? t('empty.favorites') : searching ? '' : t('empty.body', shortcutLabel()))}</p>
      ${fav || searching || S.env?.backend === 'unsupported' ? '' : `<button class="btn primary" data-act="capture">${icon('capture', 18)}${esc(t('capture'))}</button>`}
    </div>`;
    $$('[data-act=capture]', sc).forEach(b => (b.onclick = startCapture));
    updateSelbar();
    return;
  }

  const grouped = S.sort === 'newest' || S.sort === 'oldest';
  const groups = [];
  for (const it of visible) {
    const label = grouped ? groupLabel(it.mtime) : '';
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(it); else groups.push({ label, items: [it] });
  }
  let idx = 0;
  const scrollTop = sc.scrollTop;
  sc.innerHTML = groups.map(g => `
    <div class="group">
      ${g.label ? `<div class="group-head"><h3>${esc(g.label)}</h3><span>${g.items.length}</span></div>` : ''}
      <div class="grid">${g.items.map(it => cardHtml(it, idx++)).join('')}</div>
    </div>`).join('');
  sc.scrollTop = scrollTop;
  observeThumbs(sc);
  updateSelbar();
}

function renderChips() {
  const counts = new Map();
  const base = S.items.filter(i => S.view !== 'favorites' || isFav(i.path));
  for (const it of base) counts.set(it.app || '—', (counts.get(it.app || '—') || 0) + 1);
  if (S.app !== 'all' && !counts.has(S.app)) S.app = 'all';
  const apps = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  const chips = $('#chips', root());
  chips.hidden = apps.length < 2;
  chips.innerHTML =
    `<button class="chip ${S.app === 'all' ? 'active' : ''}" data-app="all">${esc(t('filter.all'))} <small>${base.length}</small></button>` +
    apps.map(([a, n]) => `<button class="chip ${S.app === a ? 'active' : ''}" data-app="${esc(a)}">${esc(a)} <small>${n}</small></button>`).join('');
  $$('.chip', chips).forEach(c => (c.onclick = () => { S.app = c.dataset.app; render(); }));
}

function cardHtml(it, i) {
  const sel = S.selected.has(it.path);
  const fav = isFav(it.path);
  return `<div class="card ${sel ? 'selected' : ''}" data-i="${i}" data-path="${esc(it.path)}">
    <div class="thumb"><div class="skeleton"></div><img alt="" data-src="${esc(it.path)}" draggable="false"></div>
    <div class="check">${icon('check', 15)}</div>
    <div class="card-actions">
      <button class="mini ${fav ? 'on' : ''}" data-act="fav" title="${esc(fav ? t('act.unfavorite') : t('act.favorite'))}">${icon('star', 15)}</button>
      <button class="mini" data-act="copy" title="${esc(t('act.copy'))}">${icon('copy', 15)}</button>
      <button class="mini" data-act="edit" title="${esc(t('act.edit'))}">${icon('edit', 15)}</button>
      <button class="mini danger" data-act="delete" title="${esc(t('act.delete'))}">${icon('trash', 15)}</button>
    </div>
    <div class="card-meta">
      <div class="card-title">${esc(displayName(it))}</div>
      <div class="card-sub"><span>${esc(timeLabel(it.mtime))}</span><i>•</i><span>${it.width}×${it.height}</span><i>•</i><span>${humanSize(it.size)}</span></div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------- thumbnails
const queue = [];
let active = 0;
let io;

function observeThumbs(sc) {
  io?.disconnect();
  io = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      queue.push(e.target);
    }
    pump();
  }, { root: sc, rootMargin: '400px' });
  $$('img[data-src]', sc).forEach(img => io.observe(img));
}

function pump() {
  while (active < 4 && queue.length) {
    const img = queue.shift();
    if (!img.isConnected) continue;
    active++;
    api.thumbnail(img.dataset.src)
      .then(p => new Promise(res => { img.onload = img.onerror = res; img.src = assetUrl(p); }))
      .catch(() => {})
      .finally(() => {
        img.classList.add('loaded');
        img.parentElement.querySelector('.skeleton')?.remove();
        active--;
        pump();
      });
  }
}

// ---------------------------------------------------------------- interaction
const itemAt = el => visible[+el.closest('.card')?.dataset.i];

async function onGridClick(e) {
  const card = e.target.closest('.card');
  if (!card) return;
  const it = itemAt(card);
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act) { e.stopPropagation(); return runAction(act, it); }
  const idx = +card.dataset.i;
  if (e.target.closest('.check') || e.ctrlKey || e.metaKey || S.selected.size) {
    if (e.shiftKey && lastClicked >= 0) {
      const [a, b] = [Math.min(lastClicked, idx), Math.max(lastClicked, idx)];
      for (let i = a; i <= b; i++) S.selected.add(visible[i].path);
    } else {
      S.selected.has(it.path) ? S.selected.delete(it.path) : S.selected.add(it.path);
    }
    lastClicked = idx;
    refreshSelectionUi();
    return;
  }
  lastClicked = idx;
  openViewer(visible, idx);
}

function onContext(e) {
  const card = e.target.closest('.card');
  if (!card) return;
  e.preventDefault();
  const it = itemAt(card);
  S.selected.has(it.path) ? S.selected.delete(it.path) : S.selected.add(it.path);
  refreshSelectionUi();
}

export async function runAction(act, it) {
  try {
    if (act === 'fav') { await toggleFav(it.path); render(); }
    else if (act === 'copy') { await api.copyItem(it.path); toast(t('toast.copied')); }
    else if (act === 'edit') openEditor(it.path);
    else if (act === 'delete') await deleteItems([it.path]);
    else if (act === 'reveal') await api.revealItem(it.path);
    else if (act === 'open') await api.openExternal(it.path);
    else if (act === 'rename') {
      const name = await promptDialog({ title: t('rename.title'), value: it.name });
      if (name && name !== it.name) {
        await api.renameItem(it.path, name);
        toast(t('toast.renamed'));
        await reload();
      }
    }
  } catch (err) {
    toast(String(err), 'err');
  }
}

export async function deleteItems(paths) {
  const ok = await confirmDialog({ title: t('confirm.delete.title', paths.length), body: t('confirm.delete.body'), ok: t('act.delete'), danger: true });
  if (!ok) return false;
  const n = await api.deleteItems(paths);
  paths.forEach(p => S.selected.delete(p));
  toast(t('toast.deleted', n));
  await reload();
  return true;
}

function refreshSelectionUi() {
  $$('.card', root()).forEach(c => c.classList.toggle('selected', S.selected.has(c.dataset.path)));
  updateSelbar();
}

function updateSelbar() {
  const bar = $('#selbar', root());
  if (!bar) return;
  document.body.classList.toggle('selecting', S.selected.size > 0);
  bar.hidden = S.selected.size === 0;
  if (!S.selected.size) return;
  bar.innerHTML = `<b>${esc(t('selected', S.selected.size))}</b>
    <button class="btn sm" id="sb-all">${esc(t('sel.all'))}</button>
    <button class="btn sm" id="sb-fav">${icon('star', 15)}${esc(t('act.favorite'))}</button>
    <button class="btn sm danger" id="sb-del">${icon('trash', 15)}${esc(t('act.delete'))}</button>
    <button class="btn sm icon ghost" id="sb-clear" title="${esc(t('sel.clear'))}">${icon('close', 15)}</button>`;
  $('#sb-all', bar).onclick = () => { visible.forEach(i => S.selected.add(i.path)); refreshSelectionUi(); };
  $('#sb-clear', bar).onclick = () => { S.selected.clear(); refreshSelectionUi(); };
  $('#sb-del', bar).onclick = () => deleteItems([...S.selected]);
  $('#sb-fav', bar).onclick = async () => {
    const fav = new Set(S.settings.favorites);
    S.selected.forEach(p => fav.add(p));
    const { saveSettings } = await import('./store.js');
    await saveSettings({ favorites: [...fav] });
    S.selected.clear();
    render();
  };
}

export function libraryKey(e) {
  if (S.view !== 'library' && S.view !== 'favorites') return;
  if (e.target.matches?.('input, textarea, select')) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); visible.forEach(i => S.selected.add(i.path)); refreshSelectionUi(); }
  else if (e.key === 'Escape' && S.selected.size) { S.selected.clear(); refreshSelectionUi(); }
  else if (e.key === 'Delete' && S.selected.size) deleteItems([...S.selected]);
  else if (e.key === 'F5') { e.preventDefault(); reload(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); $('#q').focus(); }
}

on('settings', () => { if (S.loaded) render(); });
