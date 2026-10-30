// X11 capture overlay: a frozen frame of the desktop; click a window or drag an area.
const { invoke, convertFileSrc } = window.__TAURI__.core;
const $ = id => document.getElementById(id);

const ar = (navigator.language || '').toLowerCase().startsWith('ar');
$('hint').textContent = ar
  ? 'انقر على نافذة أو اسحب لتحديد منطقة  ·  Space: الشاشة كاملة  ·  Esc: إلغاء'
  : 'Click a window or drag an area  ·  Space: full screen  ·  Esc: cancel';
setTimeout(() => ($('hint').style.opacity = '.0'), 4500);

let st, dpr = window.devicePixelRatio || 1;
let down = null, rect = null, hover = null;

const toImg = v => v * dpr;     // css px -> image px
const toCss = v => v / dpr;     // image px -> css px

async function init() {
  st = await invoke('overlay_state');
  const img = $('frozen');
  img.style.width = `${toCss(st.width)}px`;
  img.style.height = `${toCss(st.height)}px`;
  img.src = convertFileSrc(st.image);
  layout(null);
}

function layout(r) {
  const W = innerWidth, H = innerHeight;
  const set = (id, x, y, w, h) => Object.assign($(id).style, { left: `${x}px`, top: `${y}px`, width: `${Math.max(0, w)}px`, height: `${Math.max(0, h)}px` });
  const sel = $('sel');
  if (!r) {
    set('d-t', 0, 0, W, H); set('d-b', 0, 0, 0, 0); set('d-l', 0, 0, 0, 0); set('d-r', 0, 0, 0, 0);
    sel.hidden = true;
    return;
  }
  const x = toCss(r.x), y = toCss(r.y), w = toCss(r.w), h = toCss(r.h);
  set('d-t', 0, 0, W, y);
  set('d-b', 0, y + h, W, H - y - h);
  set('d-l', 0, y, x, h);
  set('d-r', x + w, y, W - x - w, h);
  sel.hidden = false;
  sel.classList.toggle('win', !!r.win);
  sel.classList.toggle('bottom', y < 30);
  Object.assign(sel.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
  $('tag').textContent = `${r.win ? (r.win.app || r.win.title) + '  ' : ''}${Math.round(r.w)} × ${Math.round(r.h)}`;
}

function winAt(px, py) {
  return st.windows.find(w => px >= w.x && px < w.x + w.w && py >= w.y && py < w.y + w.h) || null;
}

addEventListener('mousemove', e => {
  if (!st) return;
  const px = toImg(e.clientX), py = toImg(e.clientY);
  if (down) {
    const x0 = Math.min(down.x, px), y0 = Math.min(down.y, py);
    rect = { x: x0, y: y0, w: Math.abs(px - down.x), h: Math.abs(py - down.y) };
    down.moved = down.moved || rect.w > 4 || rect.h > 4;
    if (down.moved) layout(rect);
  } else {
    hover = winAt(px, py);
    layout(hover ? { x: hover.x, y: hover.y, w: hover.w, h: hover.h, win: hover } : null);
  }
});

addEventListener('mousedown', e => {
  if (e.button !== 0 || !st) return;
  down = { x: toImg(e.clientX), y: toImg(e.clientY), moved: false };
  rect = null;
});

addEventListener('mouseup', e => {
  if (!down || e.button !== 0) return;
  const d = down; down = null;
  if (d.moved && rect && rect.w >= 4 && rect.h >= 4) {
    finish({ x: rect.x, y: rect.y, w: rect.w, h: rect.h, label: 'Region' });
  } else if (hover) {
    finish({ x: hover.x, y: hover.y, w: hover.w, h: hover.h, label: hover.app || 'Window' });
  }
});

addEventListener('contextmenu', e => { e.preventDefault(); cancel(); });
addEventListener('keydown', e => {
  if (e.key === 'Escape') cancel();
  else if (e.key === ' ' || e.key === 'Enter') finish({ x: 0, y: 0, w: st.width, h: st.height, label: 'Screen' });
});

let closing = false;
function finish(sel) {
  if (closing) return; closing = true;
  invoke('overlay_done', { selection: { x: Math.round(sel.x), y: Math.round(sel.y), w: Math.round(sel.w), h: Math.round(sel.h), label: sel.label } });
}
function cancel() {
  if (closing) return; closing = true;
  invoke('overlay_done', { selection: null });
}

init().catch(e => { document.body.textContent = String(e); });

addEventListener('error', e => invoke('js_log', { message: `overlay: ${e.message}` }));
