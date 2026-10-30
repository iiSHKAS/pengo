import { api, assetUrl } from './api.js';
import { icon } from './icons.js';
import { t } from './i18n.js';
import { S, emit } from './store.js';
import { $, $$, esc, clamp } from './util.js';
import { toast, confirmDialog, Segmented, mountSlots, openMenu } from './components.js';
import {
  EFFECTS, FONT, bbox, hitTest, normRect, loadImageFile, canvasToPng, renderEffects, renderShapes,
} from './annotate.js';

const PALETTE = [
  [0.95, 0.23, 0.21], [1, 0.55, 0], [1, 0.84, 0.04], [0.2, 0.78, 0.35], [0, 0.74, 0.83],
  [0.2, 0.5, 1], [0.58, 0.35, 0.96], [0.96, 0.3, 0.66], [1, 1, 1], [0.1, 0.1, 0.12],
];
const WIDTHS = [2, 4, 6, 10];
const TEXT_SIZES = [['S', 18], ['M', 28], ['L', 44], ['XL', 72]];
const TOOLS = [
  ['select', 'V'], ['rect', 'R'], ['ellipse', 'O'], ['line', 'L'], ['arrow', 'A'], ['pen', 'P'], ['highlight', 'H'],
  ['text', 'T'], ['step', 'N'], ['blur', 'B'], ['pixelate', 'X'], ['erase', 'E'], ['crop', 'C'],
];
const COLOR_TOOLS = ['rect', 'ellipse', 'line', 'arrow', 'pen', 'highlight', 'text', 'step'];
const WIDTH_TOOLS = ['rect', 'ellipse', 'line', 'arrow', 'pen', 'highlight', 'step'];

const E = {
  open: false, path: '', name: '', base: null, w: 0, h: 0,
  anns: [], sel: -1, tool: 'rect', cur: null, drag: null, crop: null,
  opts: { color: PALETTE[0], width: 4, size: 28, bold: false, bg: 'none', strength: 1 },
  zoom: 1, fit: true, k: 1,
  hist: [], hi: 0, saved: 0,
  fx: null, textEdit: null, raf: 0,
  shift: false, lastP: null,   // Shift is tracked from key events too: pointer events don't always carry it
};
let cv, ctx, ov, octx, wrap, stage;

const root = () => $('#view-editor');
const dirty = () => E.hi !== E.saved;
const clone = v => JSON.parse(JSON.stringify(v));

// ------------------------------------------------------------------ open / close
export async function openEditor(path) {
  try {
    const img = await loadImageFile(path);
    const base = document.createElement('canvas');
    base.width = img.naturalWidth; base.height = img.naturalHeight;
    base.getContext('2d').drawImage(img, 0, 0);
    Object.assign(E, {
      open: true, path, name: path.split('/').pop(), base, w: base.width, h: base.height,
      anns: [], sel: -1, cur: null, drag: null, crop: null, textEdit: null,
      tool: 'rect', zoom: 1, fit: true, hist: [{ anns: [], base }], hi: 0, saved: 0,
      k: Math.max(1, Math.round(Math.max(base.width, base.height) / 1200)),
    });
    S.view = 'editor';
    build();
    emit('view');
    rebuildFx();
    requestAnimationFrame(() => { fitZoom(); draw(); });
  } catch (e) {
    toast(String(e), 'err');
  }
}

export async function closeEditor(force = false) {
  if (!force && dirty()) {
    const ok = await confirmDialog({ title: t('ed.discard'), body: t('ed.discard.body'), ok: t('ed.discard.yes'), danger: true });
    if (!ok) return false;
  }
  E.open = false;
  document.removeEventListener('keydown', onKey, true);
  document.removeEventListener('keydown', onShiftKey, true);
  document.removeEventListener('keyup', onShiftKey, true);
  window.removeEventListener('resize', onResize);
  S.view = 'library';
  emit('view');
  return true;
}
export const editorOpen = () => E.open;

// ------------------------------------------------------------------ UI
function build() {
  root().innerHTML = `
    <div class="ed-top">
      <button class="btn icon ghost" id="ed-back" title="${esc(t('ed.back'))}">${icon('back', 19)}</button>
      <div class="ed-name"><span id="ed-title"></span><i class="dirty-dot" id="ed-dirty" hidden></i></div>
      <div class="spacer"></div>
      <div class="ed-group">
        <button class="btn icon sm ghost" id="ed-undo" title="${esc(t('ed.undo'))} (Ctrl+Z)">${icon('undo', 17)}</button>
        <button class="btn icon sm ghost" id="ed-redo" title="${esc(t('ed.redo'))} (Ctrl+Shift+Z)">${icon('redo', 17)}</button>
      </div>
      <div class="ed-group">
        <button class="btn icon sm ghost" id="ed-zout" title="${esc(t('ed.zoomout'))}">${icon('zoomOut', 17)}</button>
        <button class="btn sm ghost zoom-pct" id="ed-zpct" title="${esc(t('ed.fit'))}">100%</button>
        <button class="btn icon sm ghost" id="ed-zin" title="${esc(t('ed.zoomin'))}">${icon('zoomIn', 17)}</button>
      </div>
      <button class="btn" id="ed-copy">${icon('copy', 17)}${esc(t('ed.copy'))}</button>
      <div class="split">
        <button class="btn primary" id="ed-save">${icon('save', 17)}${esc(t('ed.saveCopy'))}</button>
        <button class="btn primary more" id="ed-more">${icon('chevD', 16)}</button>
      </div>
    </div>
    <div class="ed-body">
      <div class="ed-tools" id="ed-tools">${TOOLS.map(([id, key]) =>
        `<button class="tool" data-tool="${id}" title="${esc(t('ed.tool.' + id))}  (${key})">${icon(id, 20)}</button>`).join('')}</div>
      <div class="ed-stage" id="ed-stage">
        <div class="ed-wrap" id="ed-wrap"><canvas id="ed-cv"></canvas><canvas id="ed-ov"></canvas></div>
      </div>
      <div class="ed-props" id="ed-props"></div>
    </div>`;

  stage = $('#ed-stage'); wrap = $('#ed-wrap'); cv = $('#ed-cv'); ov = $('#ed-ov');
  ctx = cv.getContext('2d'); octx = ov.getContext('2d');
  cv.width = ov.width = E.w; cv.height = ov.height = E.h;

  $('#ed-title').textContent = E.name;
  $('#ed-back').onclick = () => closeEditor();
  $('#ed-undo').onclick = undo;
  $('#ed-redo').onclick = redo;
  $('#ed-zin').onclick = () => setZoom(E.zoom * 1.25);
  $('#ed-zout').onclick = () => setZoom(E.zoom / 1.25);
  $('#ed-zpct').onclick = () => { E.fit = true; fitZoom(); };
  $('#ed-copy').onclick = copyImage;
  $('#ed-save').onclick = () => save('copy');
  $('#ed-more').onclick = e => openMenu(e.currentTarget, [
    { label: t('ed.saveCopy'), icon: 'save', onClick: () => save('copy') },
    { label: t('ed.replace'), icon: 'download', onClick: () => save('replace') },
  ], { align: 'end' });
  $$('#ed-tools .tool').forEach(b => (b.onclick = () => setTool(b.dataset.tool)));

  ov.addEventListener('pointerdown', onDown);
  ov.addEventListener('pointermove', onMove);
  ov.addEventListener('pointerup', onUp);
  ov.addEventListener('pointercancel', onUp);
  ov.addEventListener('dblclick', onDbl);
  stage.addEventListener('wheel', onWheel, { passive: false });
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('keydown', onShiftKey, true);
  document.addEventListener('keyup', onShiftKey, true);
  window.addEventListener('blur', () => { E.shift = false; });
  window.addEventListener('resize', onResize);
  setTool('rect');
  updateTop();
}

function setTool(tool) {
  commitText();
  if (tool !== E.tool) E.last = null;
  E.tool = tool; E.sel = tool === 'select' ? E.sel : -1; E.crop = null;
  $$('#ed-tools .tool').forEach(b => b.classList.toggle('on', b.dataset.tool === tool));
  ov.style.cursor = tool === 'select' ? 'default' : 'crosshair';
  renderProps();
  drawOverlay();
}

function swatch(c, on) {
  const hex = '#' + c.map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
  return `<button class="sw ${on ? 'on' : ''}" data-color="${hex}" style="--c:${hex}"></button>`;
}

const hexToRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
const sameColor = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 0.01);

// Segmented controls are real components; renderProps drops a slot and mounts them afterwards.
let segSpecs = {};
function seg(name, items, current) {
  segSpecs[name] = { items, current };
  return `<span data-slot="${name}"></span>`;
}

function renderProps() {
  const p = $('#ed-props');
  const tool = E.tool, o = E.opts;
  const sel = E.sel >= 0 ? E.anns[E.sel] : null;
  segSpecs = {};
  const parts = [];
  if (COLOR_TOOLS.includes(tool) || (tool === 'select' && sel && COLOR_TOOLS.includes(sel.type))) {
    const cur = sel && tool === 'select' ? sel.color : o.color;
    parts.push(`<div class="prop"><label>${esc(t('ed.color'))}</label><div class="swatches">
      ${PALETTE.map(c => swatch(c, sameColor(c, cur))).join('')}
      <button class="sw custom ${PALETTE.some(c => sameColor(c, cur)) ? '' : 'on has-color'}" id="ed-color" style="--cc:${rgbToHex(cur)}" title="#"></button>
    </div><div class="cp" id="ed-cp" hidden>
      <div class="cp-sv" id="cp-sv"><div class="cp-knob" id="cp-knob"></div></div>
      <div class="cp-hue" id="cp-hue"><div class="cp-thumb" id="cp-thumb"></div></div>
      <div class="cp-row"><span class="cp-prev" id="cp-prev"></span><input class="cp-hex" id="cp-hex" maxlength="7" spellcheck="false" dir="ltr"></div>
    </div></div>`);
  }
  if (WIDTH_TOOLS.includes(tool)) {
    parts.push(`<div class="prop"><label>${esc(t('ed.width'))}</label>${seg('width', WIDTHS.map(w => [w, '●'.repeat(1) + ' ' + w]), o.width)}</div>`);
  }
  if (tool === 'text') {
    parts.push(`<div class="prop"><label>${esc(t('ed.size'))}</label>${seg('size', TEXT_SIZES.map(([l, v]) => [v, l]), o.size)}</div>`);
    parts.push(`<div class="prop"><label>${esc(t('ed.bg'))}</label>${seg('bg', [['none', t('ed.bg.none')], ['dark', t('ed.bg.dark')], ['light', t('ed.bg.light')]], o.bg)}</div>`);
    parts.push(`<div class="prop"><button class="btn sm ${o.bold ? 'primary' : ''}" id="ed-bold">${icon('bold', 15)}${esc(t('ed.bold'))}</button></div>`);
    parts.push(`<div class="prop-hint">${esc(t('ed.textHint'))}</div>`);
  }
  if (['rect', 'ellipse', 'line', 'arrow', 'pen', 'highlight'].includes(tool)) {
    parts.push(`<div class="prop-hint">${icon('keyboard', 14)} ${esc(t(tool === 'rect' || tool === 'ellipse' ? 'ed.shift.square' : 'ed.shift.line'))}</div>`);
  }
  const fxType = tool === 'select' && sel ? sel.type : tool;
  if (EFFECTS.includes(fxType) && fxType !== 'erase') {
    const cur = tool === 'select' && sel ? (sel.strength ?? 1) : o.strength;
    parts.push(`<div class="prop"><label>${esc(t('ed.strength'))}</label>${seg('strength', [[0, t('ed.low')], [1, t('ed.medium')], [2, t('ed.high')]], cur)}</div>`);
  }
  if (tool === 'crop') {
    parts.push(`<div class="prop-hint">${esc(t('ed.cropHint'))}</div>
      <div class="prop"><button class="btn primary sm" id="ed-crop-apply" ${E.crop ? '' : 'disabled'}>${icon('check', 15)}${esc(t('ed.cropApply'))}</button></div>`);
  }
  if (tool === 'select') {
    parts.push(`<div class="prop-hint">${esc(sel ? '' : '↖')}</div>`);
    if (sel) parts.push(`<div class="prop"><button class="btn sm danger" id="ed-del">${icon('trash', 15)}${esc(t('ed.delete'))}</button></div>`);
  }
  p.innerHTML = `<div class="props-title">${esc(t('ed.tool.' + tool))}</div>${parts.join('')}`;

  $$('.sw[data-color]', p).forEach(b => (b.onclick = () => setColor(hexToRgb(b.dataset.color))));
  if ($('#ed-color', p)) mountPicker(p, sel && tool === 'select' ? sel.color : o.color);
  mountSlots(p, Object.fromEntries(Object.entries(segSpecs).map(([name, sp]) =>
    [name, Segmented({ items: sp.items, value: sp.current, fill: true, onChange: v => setOpt(name, v) })])));
  $('#ed-bold', p)?.addEventListener('click', () => { E.opts.bold = !E.opts.bold; applyToSelected({ bold: E.opts.bold }); renderProps(); });
  $('#ed-crop-apply', p)?.addEventListener('click', applyCrop);
  $('#ed-del', p)?.addEventListener('click', deleteSelected);
}

const rgbToHex = c => '#' + c.map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
function hsvToRgb(h, s, v) {
  const f = n => { const k = (n + h * 6) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [f(5), f(3), f(1)];
}
function rgbToHsv([r, g, b]) {
  const mx = Math.max(r, g, b), d = mx - Math.min(r, g, b);
  let h = 0;
  if (d) h = (mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4) / 6;
  return { h, s: mx ? d / mx : 0, v: mx };
}

/** Custom colour popover: saturation/value square + hue bar + hex field (replaces the system dialog). */
function mountPicker(root, cur) {
  const btn = $('#ed-color', root), pop = $('#ed-cp', root);
  const sv = $('#cp-sv', root), knob = $('#cp-knob', root), hue = $('#cp-hue', root), thumb = $('#cp-thumb', root);
  const prev = $('#cp-prev', root), hex = $('#cp-hex', root);
  const st = rgbToHsv(cur);
  const paint = () => {
    const c = hsvToRgb(st.h, st.s, st.v), h = rgbToHex(c);
    sv.style.setProperty('--hue', rgbToHex(hsvToRgb(st.h, 1, 1)));
    knob.style.left = `${st.s * 100}%`; knob.style.top = `${(1 - st.v) * 100}%`; knob.style.background = h;
    thumb.style.left = `${st.h * 100}%`; thumb.style.background = rgbToHex(hsvToRgb(st.h, 1, 1));
    prev.style.background = h;
    if (document.activeElement !== hex) hex.value = h.toUpperCase();
    return c;
  };
  const push = () => { setColor(paint(), false); mark(); };
  const drag = (el, fn) => {
    el.onpointerdown = e => {
      el.setPointerCapture(e.pointerId);
      const at = ev => { const r = el.getBoundingClientRect(); fn(Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height))); push(); };
      at(e);
      el.onpointermove = at;
      el.onpointerup = el.onpointercancel = () => { el.onpointermove = null; };
    };
  };
  drag(sv, (x, y) => { st.s = x; st.v = 1 - y; });
  drag(hue, x => { st.h = Math.min(x, .9999); });
  hex.oninput = () => {
    if (/^#?[0-9a-f]{6}$/i.test(hex.value)) { Object.assign(st, rgbToHsv(hexToRgb('#' + hex.value.replace('#', '')))); setColor(paint(), false); }
  };
  hex.onblur = () => paint();
  const mark = () => { btn.style.setProperty('--cc', rgbToHex(hsvToRgb(st.h, st.s, st.v))); btn.classList.add('has-color'); };
  btn.onclick = () => { pop.hidden = !pop.hidden; if (!pop.hidden) paint(); };
}

function setColor(c, rerender = true) {
  E.opts.color = c;
  applyToSelected({ color: c });
  if (rerender) renderProps();
}

function setOpt(name, v) {
  const num = name !== 'bg';
  v = num ? Number(v) : v;
  const key = { width: 'width', size: 'size', bg: 'bg', strength: 'strength' }[name];
  E.opts[key] = v;
  applyToSelected({ [key]: name === 'width' ? v * E.k : name === 'size' ? v * E.k : v });
}

/** Changing an option while a shape is selected edits that shape. */
function applyToSelected(patch) {
  // Select tool: the selected shape. Blur / pixelate tool: the effect just drawn, so changing
  // its strength is visible straight away.
  const target = E.tool === 'select'
    ? (E.sel >= 0 ? E.anns[E.sel] : null)
    : (E.last && E.last.type === E.tool && E.anns.includes(E.last) ? E.last : null);
  if (!target) return;
  Object.assign(target, patch);
  commit();
  if (EFFECTS.includes(target.type)) rebuildFx();
  draw();
}

function updateTop() {
  if (!E.open) return;
  $('#ed-undo').disabled = E.hi === 0;
  $('#ed-redo').disabled = E.hi >= E.hist.length - 1;
  $('#ed-dirty').hidden = !dirty();
  $('#ed-zpct').textContent = `${Math.round(E.zoom * dpr() * 100)}%`;
}

// ------------------------------------------------------------------ history
function commit() {
  E.hist = E.hist.slice(0, E.hi + 1);
  E.hist.push({ anns: clone(E.anns), base: E.base });
  E.hi = E.hist.length - 1;
  if (E.hist.length > 80) { E.hist.shift(); E.hi--; E.saved--; }
  updateTop();
}

function restore(i) {
  E.hi = i;
  const h = E.hist[i];
  E.anns = clone(h.anns);
  if (h.base !== E.base) { E.base = h.base; E.w = h.base.width; E.h = h.base.height; cv.width = ov.width = E.w; cv.height = ov.height = E.h; applyZoom(); }
  E.sel = -1; E.cur = null;
  rebuildFx(); draw(); renderProps(); updateTop();
}
function undo() { commitText(); if (E.hi > 0) restore(E.hi - 1); }
function redo() { if (E.hi < E.hist.length - 1) restore(E.hi + 1); }

// ------------------------------------------------------------------ drawing
function rebuildFx() {
  E.fx ??= document.createElement('canvas');
  E.fx.width = E.w; E.fx.height = E.h;
  const c = E.fx.getContext('2d');
  c.drawImage(E.base, 0, 0);
  renderEffects(c, E.anns.filter(a => EFFECTS.includes(a.type)), { ox: 0, oy: 0, scale: 1 });
}

function draw() {
  if (!E.open) return;
  ctx.clearRect(0, 0, E.w, E.h);
  ctx.drawImage(E.fx, 0, 0);
  const tf = { ox: 0, oy: 0, scale: 1 };
  if (E.cur && EFFECTS.includes(E.cur.type)) renderEffects(ctx, [E.cur], tf);
  const shapes = E.anns.filter(a => !EFFECTS.includes(a.type));
  if (E.cur && !EFFECTS.includes(E.cur.type)) shapes.push(E.cur);
  renderShapes(ctx, shapes, tf);
  drawOverlay();
}

function schedule() {
  if (E.raf) return;
  E.raf = requestAnimationFrame(() => { E.raf = 0; draw(); });
}

function drawOverlay() {
  if (!octx) return;
  octx.clearRect(0, 0, E.w, E.h);
  const u = 1 / E.zoom;   // keep UI strokes a constant on-screen size
  const outline = b => {
    octx.save();
    octx.lineWidth = 1.5 * u; octx.strokeStyle = '#7c83ff'; octx.setLineDash([6 * u, 4 * u]);
    octx.strokeRect(b.x, b.y, b.w, b.h);
    octx.restore();
  };
  if (E.sel >= 0 && E.anns[E.sel] && E.tool === 'select') outline(bbox(E.anns[E.sel]));
  if (E.cur && EFFECTS.includes(E.cur.type)) {
    outline(normRect(E.cur.pts[0], E.cur.pts[E.cur.pts.length - 1]));
  }
  if (E.crop) {
    const c = E.crop;
    octx.save();
    octx.fillStyle = 'rgba(0,0,0,.55)';
    octx.beginPath(); octx.rect(0, 0, E.w, E.h); octx.rect(c.x, c.y, c.w, c.h); octx.fill('evenodd');
    octx.strokeStyle = '#fff'; octx.lineWidth = 1.5 * u; octx.strokeRect(c.x, c.y, c.w, c.h);
    octx.fillStyle = 'rgba(0,0,0,.75)';
    octx.font = `600 ${12 * u}px ${FONT}`;
    const label = `${Math.round(c.w)} × ${Math.round(c.h)}`;
    const tw = octx.measureText(label).width + 12 * u;
    octx.fillRect(c.x, Math.max(0, c.y - 22 * u), tw, 20 * u);
    octx.fillStyle = '#fff'; octx.textBaseline = 'middle';
    octx.fillText(label, c.x + 6 * u, Math.max(0, c.y - 22 * u) + 10 * u);
    octx.restore();
  }
}

// ------------------------------------------------------------------ zoom
// Zoom is CSS px per image px. On a scaled display (devicePixelRatio 1.25...) "100%" must mean one
// image pixel per DEVICE pixel, otherwise the browser resamples the picture and it looks soft.
const dpr = () => window.devicePixelRatio || 1;
function applyZoom() {
  if (!wrap) return;
  const d = dpr();
  wrap.style.width = `${Math.round(E.w * E.zoom * d) / d}px`;
  wrap.style.height = `${Math.round(E.h * E.zoom * d) / d}px`;
  cv.style.imageRendering = E.zoom * d > 1.01 ? 'pixelated' : 'auto';   // zoomed in: crisp pixels, not blur
  updateTop();
  drawOverlay();
}
function fitZoom() {
  if (!stage) return;
  const r = stage.getBoundingClientRect();
  E.zoom = clamp(Math.min((r.width - 64) / E.w, (r.height - 64) / E.h, 1 / dpr()), 0.03, 1);
  E.fit = true;
  applyZoom();
}
function setZoom(z, cx, cy) {
  const r = wrap.getBoundingClientRect();
  const px = cx === undefined ? stage.getBoundingClientRect().left + stage.clientWidth / 2 : cx;
  const py = cy === undefined ? stage.getBoundingClientRect().top + stage.clientHeight / 2 : cy;
  const ix = (px - r.left) / E.zoom, iy = (py - r.top) / E.zoom;
  E.zoom = clamp(z, 0.03, 8); E.fit = false;
  applyZoom();
  const r2 = wrap.getBoundingClientRect();
  stage.scrollLeft += r2.left + ix * E.zoom - px;
  stage.scrollTop += r2.top + iy * E.zoom - py;
}
function onWheel(e) {
  if (!(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  setZoom(E.zoom * Math.exp(-e.deltaY * 0.0018), e.clientX, e.clientY);
}
function onResize() { if (E.open && E.fit) fitZoom(); }

// ------------------------------------------------------------------ pointer
function pos(e) {
  const r = ov.getBoundingClientRect();
  return [(e.clientX - r.left) * E.w / r.width, (e.clientY - r.top) * E.h / r.height];
}

/** Rectangle / ellipse with Shift: a perfect square / circle. */
function constrain(a, p, shift) {
  if (!shift) return p;
  const dx = p[0] - a[0], dy = p[1] - a[1];
  const m = Math.max(Math.abs(dx), Math.abs(dy));
  return [a[0] + Math.sign(dx || 1) * m, a[1] + Math.sign(dy || 1) * m];
}

/** Shift on lines / pen / marker: lock to the direction the mouse is travelling (horizontal or
 *  vertical) so the result is perfectly straight however much the hand shakes. The axis follows
 *  the dominant displacement from the anchor, with hysteresis so jitter near the start (or an
 *  overshoot) can't flip it; only a clearly different direction switches it. */
function axisLock(d, anchor, p) {
  const dx = p[0] - anchor[0], dy = p[1] - anchor[1];
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (Math.max(ax, ay) >= 3 / E.zoom) {
    if (!d.axis) d.axis = ax >= ay ? 'h' : 'v';
    else if (d.axis === 'h' && ay > ax * 1.6) d.axis = 'v';
    else if (d.axis === 'v' && ax > ay * 1.6) d.axis = 'h';
  }
  if (d.axis === 'h') return [p[0], anchor[1]];
  if (d.axis === 'v') return [anchor[0], p[1]];
  return [anchor[0], anchor[1]];
}

function onDown(e) {
  if (e.button !== 0) return;
  if (E.textEdit) { commitText(); return; }
  const p = pos(e);
  const o = E.opts;
  E.shift = E.shift || e.shiftKey;
  E.lastP = p;
  ov.setPointerCapture(e.pointerId);
  switch (E.tool) {
    case 'select': {
      E.sel = hitTest(E.anns, p[0], p[1], 6 / E.zoom);
      E.drag = E.sel >= 0 ? { from: p, orig: clone(E.anns[E.sel].pts), moved: false } : null;
      renderProps(); drawOverlay();
      break;
    }
    case 'text': beginText(p); break;
    case 'step': {
      const n = E.anns.filter(a => a.type === 'step').length + 1;
      E.anns.push({ type: 'step', color: o.color, width: o.width * E.k, pts: [p], n, r: (11 + o.width * 1.5) * E.k });
      commit(); draw();
      break;
    }
    case 'crop': E.crop = { x: p[0], y: p[1], w: 0, h: 0, ax: p[0], ay: p[1] }; E.drag = { crop: true }; renderProps(); break;
    default: {
      const pts = (E.tool === 'pen' || E.tool === 'highlight') ? [p] : [p, p];
      E.cur = { type: E.tool, color: o.color, width: o.width * E.k, strength: o.strength, pts };
      E.drag = { draw: true, start: p };
    }
  }
}

function onMove(e) {
  if (!E.drag) return;
  E.lastP = pos(e);
  E.shift = E.shift || e.shiftKey;
  applyMove(E.lastP);
}

/** Updates the in-progress shape for pointer position `p` (re-run when Shift toggles). */
function applyMove(p) {
  const shift = E.shift;
  if (E.drag.crop) {
    const c = E.crop;
    c.x = clamp(Math.min(c.ax, p[0]), 0, E.w); c.y = clamp(Math.min(c.ay, p[1]), 0, E.h);
    c.w = clamp(Math.max(c.ax, p[0]), 0, E.w) - c.x; c.h = clamp(Math.max(c.ay, p[1]), 0, E.h) - c.y;
    drawOverlay();
  } else if (E.drag.draw && E.cur) {
    const d = E.drag;
    if (E.cur.type === 'pen' || E.cur.type === 'highlight') {
      const raw = d.raw ??= [d.start];
      if (shift) {
        // Straight segment from where Shift went down; freehand points are kept untouched.
        d.anchor ??= raw[raw.length - 1];
        d.segEnd = axisLock(d, d.anchor, p);
        E.cur.pts = [...raw, d.segEnd];
      } else {
        if (d.segEnd) { raw.push(d.segEnd); d.segEnd = d.anchor = d.axis = null; }   // continue freehand from the end of the line
        const last = raw[raw.length - 1];
        if (Math.hypot(p[0] - last[0], p[1] - last[1]) > 1.5 / E.zoom) raw.push(p);
        E.cur.pts = raw.slice();
      }
    } else if (E.cur.type === 'line' || E.cur.type === 'arrow') {
      E.cur.pts[1] = shift ? axisLock(d, d.start, p) : p;
    } else {
      E.cur.pts[1] = constrain(d.start, p, shift);
    }
    schedule();
  } else if (E.drag.orig) {
    const dx = p[0] - E.drag.from[0], dy = p[1] - E.drag.from[1];
    E.anns[E.sel].pts = E.drag.orig.map(([x, y]) => [x + dx, y + dy]);
    E.drag.moved = true;
    if (EFFECTS.includes(E.anns[E.sel].type)) rebuildFx();
    schedule();
  }
}

function onShiftKey(e) {
  if (e.key !== 'Shift' || !E.open) return;
  const down = e.type === 'keydown';
  if (E.shift === down) return;
  E.shift = down;
  if (E.drag) { E.drag.axis = null; if (down) E.drag.anchor = null; }
  if (E.drag && E.lastP) applyMove(E.lastP);   // takes effect immediately, even without moving the mouse
}

function onUp(e) {
  const d = E.drag;
  E.drag = null;
  if (!d) return;
  if (d.crop) {
    if (E.crop && (E.crop.w < 4 || E.crop.h < 4)) E.crop = null;
    renderProps(); drawOverlay();
    return;
  }
  if (d.draw && E.cur) {
    const a = E.cur;
    E.cur = null;
    const pts = a.pts, tiny = Math.hypot(pts[pts.length - 1][0] - pts[0][0], pts[pts.length - 1][1] - pts[0][1]) < 3 / E.zoom;
    if (a.type === 'pen' || a.type === 'highlight' ? pts.length > 1 : !tiny) {
      E.anns.push(a);
      E.last = EFFECTS.includes(a.type) ? a : null;   // strength changes now apply to it
      commit();
      if (EFFECTS.includes(a.type)) rebuildFx();
    }
    draw();
  } else if (d.moved) {
    commit();
    draw();
  }
}

function onDbl(e) {
  if (E.tool !== 'select') return;
  const p = pos(e);
  const i = hitTest(E.anns, p[0], p[1], 6 / E.zoom);
  if (i >= 0 && E.anns[i].type === 'text') {
    const a = E.anns.splice(i, 1)[0];
    E.sel = -1;
    draw();
    beginText(a.pts[0], a);
  }
}

// ------------------------------------------------------------------ text
function beginText(p, existing) {
  const o = E.opts;
  const size = existing ? existing.size : o.size * E.k;
  const ta = document.createElement('textarea');
  ta.className = 'ed-text';
  ta.rows = 1; ta.spellcheck = false; ta.value = existing ? existing.text : '';
  const color = existing ? existing.color : o.color;
  const style = () => {
    ta.style.left = `${p[0] * E.zoom}px`; ta.style.top = `${p[1] * E.zoom}px`;
    ta.style.fontSize = `${size * E.zoom}px`;
    ta.style.lineHeight = '1.2';
    ta.style.fontWeight = (existing ? existing.bold : o.bold) ? '700' : '400';
    ta.style.color = `rgb(${color.map(v => Math.round(v * 255)).join(',')})`;
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
    ta.style.width = `${Math.max(120, ta.scrollWidth + 8)}px`;
  };
  wrap.appendChild(ta);
  style();
  ta.addEventListener('input', style);
  ta.addEventListener('keydown', ev => {
    ev.stopPropagation();
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); commitText(); }
    else if (ev.key === 'Escape') { ev.preventDefault(); E.textEdit = null; ta.remove(); if (existing) { E.anns.push(existing); draw(); } }
  });
  ta.addEventListener('blur', () => setTimeout(commitText, 0));
  E.textEdit = { ta, p, size, color, existing };
  requestAnimationFrame(() => ta.focus());
}

function commitText() {
  const te = E.textEdit;
  if (!te) return;
  E.textEdit = null;
  const text = te.ta.value.replace(/\s+$/, '');
  te.ta.remove();
  if (!text) { if (te.existing) { draw(); commit(); } return; }
  const o = E.opts;
  E.anns.push({
    type: 'text', color: te.color, text, size: te.size, bold: te.existing ? te.existing.bold : o.bold,
    bg: te.existing ? te.existing.bg : o.bg, width: 4, pts: [te.p],
  });
  commit(); draw();
}

// ------------------------------------------------------------------ edit ops
function deleteSelected() {
  if (E.sel < 0) return;
  const a = E.anns.splice(E.sel, 1)[0];
  E.sel = -1;
  commit();
  if (EFFECTS.includes(a.type)) rebuildFx();
  draw(); renderProps();
}

function applyCrop() {
  const c = E.crop;
  if (!c || c.w < 4 || c.h < 4) return;
  const x = Math.round(c.x), y = Math.round(c.y), w = Math.round(c.w), h = Math.round(c.h);
  const nb = document.createElement('canvas');
  nb.width = w; nb.height = h;
  nb.getContext('2d').drawImage(E.base, x, y, w, h, 0, 0, w, h);
  E.anns.forEach(a => (a.pts = a.pts.map(([px, py]) => [px - x, py - y])));
  E.base = nb; E.w = w; E.h = h; E.crop = null; E.sel = -1;
  cv.width = ov.width = w; cv.height = ov.height = h;
  commit();
  rebuildFx();
  fitZoom(); draw(); renderProps();
}

// ------------------------------------------------------------------ output
function renderFinal() {
  commitText();
  const out = document.createElement('canvas');
  out.width = E.w; out.height = E.h;
  const c = out.getContext('2d');
  c.drawImage(E.fx, 0, 0);
  renderShapes(c, E.anns.filter(a => !EFFECTS.includes(a.type)), { ox: 0, oy: 0, scale: 1 });
  return out;
}

async function copyImage() {
  try {
    await api.copyBytes(await canvasToPng(renderFinal()));
    toast(t('toast.copied'));
  } catch (e) { toast(String(e), 'err'); }
}

async function save(mode) {
  try {
    const bytes = await canvasToPng(renderFinal());
    const out = await api.saveImage(bytes, E.path, mode);
    E.saved = E.hi;
    updateTop();
    toast(mode === 'replace' ? t('toast.saved') : `${t('ed.saved')} ${out.split('/').pop()}`);
    const { reload } = await import('./gallery.js');
    reload();
  } catch (e) { toast(String(e), 'err'); }
}

function onKey(e) {
  if (!E.open || document.querySelector('.modal-back')) return;
  if (e.target.matches?.('textarea, input[type=text]')) return;
  const k = e.key, ctrl = e.ctrlKey || e.metaKey;
  const kl = k.toLowerCase();
  const isZ = kl === 'z' || e.code === 'KeyZ', isY = kl === 'y' || e.code === 'KeyY';   // e.code: works on any keyboard layout
  if (ctrl && isZ) { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (ctrl && isY) { e.preventDefault(); redo(); }
  else if (ctrl && k.toLowerCase() === 's') { e.preventDefault(); save('copy'); }
  else if (ctrl && k.toLowerCase() === 'c' && E.sel < 0) { e.preventDefault(); copyImage(); }
  else if (ctrl && (k === '=' || k === '+')) { e.preventDefault(); setZoom(E.zoom * 1.25); }
  else if (ctrl && k === '-') { e.preventDefault(); setZoom(E.zoom / 1.25); }
  else if (ctrl && k === '0') { e.preventDefault(); fitZoom(); }
  else if (k === 'Escape') { if (E.crop) { E.crop = null; renderProps(); drawOverlay(); } else closeEditor(); }
  else if (k === 'Enter' && E.tool === 'crop') applyCrop();
  else if ((k === 'Delete' || k === 'Backspace') && E.sel >= 0) deleteSelected();
  else if (!ctrl && !e.altKey) {
    const hit = TOOLS.find(([, key]) => key.toLowerCase() === k.toLowerCase());
    if (hit) setTool(hit[0]); else return;
  } else return;
  e.stopPropagation();
}

export function relabelEditor() {
  if (E.open) { build(); rebuildFx(); fitZoom(); draw(); }
}
