import { api, assetUrl } from './api.js';
import { icon } from './icons.js';
import { t, locale } from './i18n.js';
import { S, isFav } from './store.js';
import { $, esc, humanSize, clamp } from './util.js';
import { runAction } from './gallery.js';
import { openEditor } from './editor.js';

let list = [], index = 0;
let z = { scale: 1, fit: 1, x: 0, y: 0, w: 0, h: 0 };
let showInfo = false;
let drag = null;

const host = () => $('#viewer');
export const viewerOpen = () => !host().hidden;

export function openViewer(items, i) {
  list = items; index = i; showInfo = false;
  host().hidden = false;
  build();
  load();
}

export function closeViewer() {
  host().hidden = true;
  host().innerHTML = '';
  document.removeEventListener('keydown', onKey, true);
  window.removeEventListener('resize', fit);
}

function build() {
  host().innerHTML = `
    <div class="viewer-top">
      <button class="btn icon ghost" id="v-close" title="${esc(t('act.close'))}">${icon('close', 20)}</button>
      <div style="min-width:0"><div class="viewer-title" id="v-title"></div><div class="viewer-sub" id="v-sub"></div></div>
      <div class="spacer"></div>
      <button class="btn icon ghost" id="v-fit" title="${esc(t('viewer.fit'))}">${icon('fit', 19)}</button>
      <button class="btn icon ghost" id="v-info" title="${esc(t('act.info'))}">${icon('info', 19)}</button>
    </div>
    <div class="viewer-stage" id="v-stage">
      <img id="v-img" alt="" draggable="false">
      <button class="nav-arrow prev" id="v-prev">${icon('chevL', 22)}</button>
      <button class="nav-arrow next" id="v-next">${icon('chevR', 22)}</button>
      <div class="info-panel" id="v-panel" hidden></div>
    </div>
    <div class="viewer-dock"><div class="dock">
      <button class="btn" data-a="copy">${icon('copy', 17)}${esc(t('act.copy'))}</button>
      <button class="btn" data-a="edit">${icon('edit', 17)}${esc(t('act.edit'))}</button>
      <button class="btn" data-a="fav">${icon('star', 17)}<span id="v-favt"></span></button>
      <span class="sep"></span>
      <button class="btn icon" data-a="rename" title="${esc(t('act.rename'))}">${icon('text', 17)}</button>
      <button class="btn icon" data-a="reveal" title="${esc(t('act.reveal'))}">${icon('folder', 17)}</button>
      <button class="btn icon" data-a="open" title="${esc(t('act.open'))}">${icon('external', 17)}</button>
      <span class="sep"></span>
      <button class="btn icon danger" data-a="delete" title="${esc(t('act.delete'))}">${icon('trash', 17)}</button>
    </div></div>`;

  $('#v-close').onclick = closeViewer;
  $('#v-prev').onclick = () => step(-1);
  $('#v-next').onclick = () => step(1);
  $('#v-fit').onclick = () => { fit(); };
  $('#v-info').onclick = () => { showInfo = !showInfo; updateMeta(); };
  host().querySelectorAll('[data-a]').forEach(b => (b.onclick = async () => {
    const it = list[index];
    if (b.dataset.a === 'edit') { closeViewer(); openEditor(it.path); return; }
    await runAction(b.dataset.a, it);
    if (b.dataset.a === 'delete' && !S.items.some(i => i.path === it.path)) closeViewer();
    else if (b.dataset.a === 'rename') closeViewer();
    else updateMeta();
  }));

  const stage = $('#v-stage');
  stage.addEventListener('wheel', onWheel, { passive: false });
  stage.addEventListener('mousedown', e => {
    if (e.button !== 0 || e.target.closest('button, .info-panel')) return;
    drag = { x: e.clientX - z.x, y: e.clientY - z.y };
    stage.classList.add('dragging');
  });
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', () => { drag = null; stage.classList.remove('dragging'); });
  stage.addEventListener('dblclick', e => {
    if (e.target.closest('button, .info-panel')) return;
    z.scale > z.fit * 1.01 ? fit() : zoomAt(e.clientX, e.clientY, 1 / z.scale);
  });
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', fit);
}

function load() {
  const it = list[index];
  const img = $('#v-img');
  img.style.visibility = 'hidden';
  img.onload = () => { z.w = img.naturalWidth / dpr(); z.h = img.naturalHeight / dpr(); fit(); img.style.visibility = 'visible'; };
  img.src = assetUrl(it.path);
  updateMeta();
}

function updateMeta() {
  const it = list[index];
  if (!it) return;
  $('#v-title').textContent = it.name;
  $('#v-sub').textContent = `${index + 1} / ${list.length}  ·  ${it.width}×${it.height}  ·  ${humanSize(it.size)}`;
  $('#v-favt').textContent = isFav(it.path) ? t('act.unfavorite') : t('act.favorite');
  $('#v-prev').hidden = index <= 0;
  $('#v-next').hidden = index >= list.length - 1;
  const panel = $('#v-panel');
  panel.hidden = !showInfo;
  if (showInfo) {
    const d = new Date(it.mtime * 1000).toLocaleString(locale());
    panel.innerHTML = `<dl>
      <div><dt>${esc(t('info.dims'))}</dt><dd>${it.width} × ${it.height}</dd></div>
      <div><dt>${esc(t('info.size'))}</dt><dd>${humanSize(it.size)}</dd></div>
      <div><dt>${esc(t('info.date'))}</dt><dd>${esc(d)}</dd></div>
      ${it.app ? `<div><dt>${esc(t('info.app'))}</dt><dd>${esc(it.app)}</dd></div>` : ''}
      <div><dt>${esc(t('info.path'))}</dt><dd>${esc(it.path)}</dd></div></dl>`;
  }
}

function step(d) {
  const n = index + d;
  if (n < 0 || n >= list.length) return;
  index = n;
  load();
}

// z.w/z.h are CSS sizes of the image at 1 image px = 1 device px, so scale 1 is pixel-exact.
const dpr = () => window.devicePixelRatio || 1;
function apply() {
  const img = $('#v-img');
  if (!img) return;
  const d = dpr(), snap = v => Math.round(v * d) / d;   // whole device pixels: no half-pixel blur
  img.style.width = `${z.w}px`;
  img.style.height = `${z.h}px`;
  img.style.imageRendering = z.scale * d > 1.01 ? 'pixelated' : 'auto';
  img.style.transform = `translate(${snap(z.x)}px, ${snap(z.y)}px) scale(${z.scale})`;
}

function fit() {
  const stage = $('#v-stage');
  if (!stage || !z.w) return;
  const r = stage.getBoundingClientRect();
  const s = Math.min((r.width - 120) / z.w, (r.height - 20) / z.h, 1);
  z.fit = z.scale = Math.max(s, 0.02);
  z.x = (r.width - z.w * z.scale) / 2;
  z.y = (r.height - z.h * z.scale) / 2;
  apply();
}

function zoomAt(cx, cy, factor) {
  const r = $('#v-stage').getBoundingClientRect();
  const px = cx - r.left, py = cy - r.top;
  const next = clamp(z.scale * factor, z.fit * 0.5, 16);
  const f = next / z.scale;
  z.x = px - (px - z.x) * f;
  z.y = py - (py - z.y) * f;
  z.scale = next;
  apply();
}

function onWheel(e) {
  e.preventDefault();
  zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
}

function onMove(e) {
  if (!drag) return;
  z.x = e.clientX - drag.x;
  z.y = e.clientY - drag.y;
  apply();
}

function onKey(e) {
  if (!viewerOpen()) return;
  if (document.querySelector('.modal-back')) return;
  const k = e.key;
  const rtl = document.documentElement.dir === 'rtl';
  if (k === 'Escape') { e.stopPropagation(); closeViewer(); }
  else if (k === 'ArrowLeft') step(rtl ? 1 : -1);
  else if (k === 'ArrowRight') step(rtl ? -1 : 1);
  else if (k === '+' || k === '=') zoomAt(innerWidth / 2, innerHeight / 2, 1.25);
  else if (k === '-') zoomAt(innerWidth / 2, innerHeight / 2, 0.8);
  else if (k === '0') fit();
  else if (k.toLowerCase() === 'e') { closeViewer(); openEditor(list[index].path); }
  else if (k.toLowerCase() === 'c' && !e.ctrlKey) { runAction('copy', list[index]); }
  else if (k.toLowerCase() === 'i') { showInfo = !showInfo; updateMeta(); }
  else if (k === 'Delete') { runAction('delete', list[index]).then(() => { if (!S.items.some(i => i.path === list[index].path)) closeViewer(); }); }
  else return;
  e.preventDefault();
}
