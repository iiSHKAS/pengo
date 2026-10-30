// Mouse-wheel scrolling for WebKitGTK: its default is a small, steppy jump per notch.
// This eases toward a longer target instead. Touchpads (tiny pixel deltas) keep the native
// kinetic scrolling, and anything that already handled the wheel (viewer zoom, ctrl+wheel) is left alone.
const SPEED = 2.4;       // pixels scrolled per reported wheel pixel
const EASE = 0.22;       // share of the remaining distance covered per frame
const NOTCH_MIN = 40;    // smaller deltas are touchpad / precision input

const anim = new WeakMap();   // element -> { target, raf }

function scroller(el, dy) {
  for (; el && el !== document.documentElement; el = el.parentElement) {
    const oy = getComputedStyle(el).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 1) {
      const max = el.scrollHeight - el.clientHeight;
      if ((dy < 0 && el.scrollTop > 0) || (dy > 0 && el.scrollTop < max - 1)) return el;
    }
  }
  return null;
}

function run(el) {
  const a = anim.get(el);
  const diff = a.target - el.scrollTop;
  if (Math.abs(diff) < 0.5) { el.scrollTop = a.target; a.raf = 0; return; }
  el.scrollTop += diff * EASE;
  a.raf = requestAnimationFrame(() => run(el));
}

document.addEventListener('wheel', e => {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.shiftKey || !e.deltaY) return;
  let dy = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
  if (Math.abs(dy) < NOTCH_MIN) return;
  const el = scroller(e.target, dy);
  if (!el) return;
  e.preventDefault();
  let a = anim.get(el);
  if (!a) anim.set(el, a = { target: el.scrollTop, raf: 0 });
  if (!a.raf) a.target = el.scrollTop;
  a.target = Math.max(0, Math.min(el.scrollHeight - el.clientHeight, a.target + dy * SPEED));
  if (!a.raf) a.raf = requestAnimationFrame(() => run(el));
}, { passive: false });
