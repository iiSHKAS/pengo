// Pengo UI kit. Every reusable control lives here (markup/behaviour) and in
// css/components.css (look). Change a component once and the whole app follows.
//
//   Popover  - animated floating panel anchored to an element (base of Select/Menu)
//   Select   - dropdown list            Menu      - action menu (openMenu)
//   Switch   - on/off toggle            Segmented - pill group with a sliding highlight
//   toast / confirmDialog / promptDialog - feedback + modal dialogs (animated in & out)
import { icon } from './icons.js';
import { esc, el, $ } from './util.js';
import { t } from './i18n.js';
import { jsLog } from './api.js';

const OUT_MS = 150;   // keep in step with the transition duration in components.css

// ============================================================ Popover
let current = null;

export function closePopover(instant = false) {
  const c = current;
  if (!c) return;
  current = null;
  document.removeEventListener('pointerdown', c.onDown, true);
  document.removeEventListener('keydown', c.onKey, true);
  window.removeEventListener('resize', c.onAway);
  window.removeEventListener('blur', c.onAway);
  c.anchor?.setAttribute('aria-expanded', 'false');
  c.panel.classList.remove('open');           // CSS transitions it back out
  setTimeout(() => c.panel.remove(), instant ? 0 : OUT_MS);
  c.onClose?.();
}

export const popoverOpenFor = anchor => current?.anchor === anchor;

/** Shows `panel` next to `anchor` (flips up when there is no room below). */
export function openPopover(anchor, panel, { matchWidth = false, align = 'start', onClose } = {}) {
  closePopover(true);
  panel.classList.add('popover');
  $('#popover-root').appendChild(panel);

  const r = anchor.getBoundingClientRect();
  const top = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--tb')) || 0;
  if (matchWidth) panel.style.minWidth = `${r.width}px`;
  const below = innerHeight - r.bottom - 10, above = r.top - top - 10;
  const natural = panel.scrollHeight;
  const up = natural > below && above > below;
  const room = Math.max(120, up ? above : below);
  panel.style.maxHeight = `${room}px`;
  const w = panel.offsetWidth, h = Math.min(natural, room);
  const rtl = document.documentElement.dir === 'rtl';
  const startSide = (align === 'start') !== rtl;          // anchor the left edge?
  let left = startSide ? r.left : r.right - w;
  left = Math.max(8, Math.min(left, innerWidth - w - 8));
  panel.style.left = `${left}px`;
  panel.style.top = `${up ? r.top - h - 6 : r.bottom + 6}px`;
  panel.style.setProperty('--origin', `${up ? 'bottom' : 'top'} ${startSide ? 'left' : 'right'}`);
  panel.style.setProperty('--dy', up ? '6px' : '-6px');

  const c = {
    anchor, panel, onClose,
    onDown: e => { if (!panel.contains(e.target) && !anchor.contains(e.target)) closePopover(); },
    onKey: e => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); const a = anchor; closePopover(); a.focus?.(); } },
    onAway: () => closePopover(),
  };
  current = c;
  document.addEventListener('pointerdown', c.onDown, true);
  document.addEventListener('keydown', c.onKey, true);
  window.addEventListener('resize', c.onAway);
  window.addEventListener('blur', c.onAway);
  anchor.setAttribute('aria-expanded', 'true');
  panel.getBoundingClientRect();                 // commit the start state, then animate in
  panel.classList.add('open');
}

/** Arrow-key / Home / End navigation between the focusable items of a panel. */
function listNav(panel, sel = '.pop-item:not([disabled])') {
  panel.addEventListener('keydown', e => {
    const items = [...panel.querySelectorAll(sel)];
    const i = items.indexOf(document.activeElement);
    const go = n => { e.preventDefault(); items[(n + items.length) % items.length]?.focus(); };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i < 0 ? items.length - 1 : i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(items.length - 1);
    else if (e.key === 'Tab') closePopover();
  });
}

// ============================================================ Menu
/** items: {label, icon?, onClick, danger?, disabled?, checked?} | 'sep' */
export function openMenu(anchor, items, opts = {}) {
  if (popoverOpenFor(anchor)) return closePopover();
  const panel = el('<div class="pop-panel" role="menu"></div>');
  for (const it of items) {
    if (it === 'sep') { panel.appendChild(el('<div class="pop-sep"></div>')); continue; }
    const b = el(`<button class="pop-item ${it.danger ? 'danger' : ''}" role="menuitem" ${it.disabled ? 'disabled' : ''}>
      ${it.icon ? icon(it.icon, 16) : ''}<span class="pop-label">${esc(it.label)}</span>${it.checked ? icon('check', 15, 'pop-check') : ''}</button>`);
    b.onclick = () => { closePopover(); it.onClick?.(); };
    panel.appendChild(b);
  }
  listNav(panel);
  openPopover(anchor, panel, { align: opts.align ?? 'start', matchWidth: opts.matchWidth });
  (panel.querySelector('.pop-item:not([disabled])'))?.focus({ preventScroll: true });
}

// ============================================================ Select
/** options: [{value, label, icon?}]. Returns the trigger button; use .setOptions/.setValue/.value. */
export function Select({ options = [], value, onChange, ariaLabel = '' } = {}) {
  const btn = el(`<button type="button" class="select-btn" aria-haspopup="listbox" aria-expanded="false" aria-label="${esc(ariaLabel)}">
    <span class="select-label"></span>${icon('chevD', 16, 'select-caret')}</button>`);
  const label = btn.querySelector('.select-label');
  const sync = () => { label.textContent = options.find(o => o.value === value)?.label ?? ''; };

  const open = () => {
    if (popoverOpenFor(btn)) return closePopover();
    const panel = el('<div class="pop-panel" role="listbox"></div>');
    for (const o of options) {
      const b = el(`<button class="pop-item ${o.value === value ? 'selected' : ''}" role="option" aria-selected="${o.value === value}">
        ${o.icon ? icon(o.icon, 16) : ''}<span class="pop-label">${esc(o.label)}</span>${icon('check', 15, 'pop-check')}</button>`);
      b.onclick = () => { value = o.value; sync(); closePopover(); btn.focus(); onChange?.(value); };
      panel.appendChild(b);
    }
    listNav(panel);
    openPopover(btn, panel, { matchWidth: true });
    (panel.querySelector('.selected') || panel.querySelector('.pop-item'))?.focus({ preventScroll: true });
  };
  btn.addEventListener('click', open);
  btn.addEventListener('keydown', e => {
    if (['ArrowDown', 'ArrowUp'].includes(e.key) && !popoverOpenFor(btn)) { e.preventDefault(); open(); }
  });
  btn.setOptions = o => { options = o; sync(); };
  btn.setValue = v => { value = v; sync(); };
  Object.defineProperty(btn, 'value', { get: () => value });
  sync();
  return btn;
}

// ============================================================ Switch
export function Switch({ checked = false, onChange, ariaLabel = '', disabled = false } = {}) {
  const node = el(`<label class="switch"><input type="checkbox" role="switch" aria-label="${esc(ariaLabel)}"><span></span></label>`);
  const input = node.querySelector('input');
  input.checked = checked;
  input.disabled = disabled;
  node.classList.toggle('disabled', disabled);
  input.addEventListener('change', () => onChange?.(input.checked));
  node.setChecked = v => { input.checked = v; };
  return node;
}

// ============================================================ Segmented
/** items: [[value, label]]. A highlight pill slides to the selected item. */
export function Segmented({ items, value, onChange, fill = false } = {}) {
  const node = el(`<div class="seg ${fill ? 'fill' : ''}" role="radiogroup"><i class="seg-pill"></i></div>`);
  const pill = node.querySelector('.seg-pill');
  for (const [v, label] of items) {
    const b = el(`<button type="button" role="radio" data-v="${esc(v)}"></button>`);
    b.textContent = label;
    b.onclick = () => { if (String(v) === String(value)) return; value = v; mark(true); onChange?.(v); };
    node.appendChild(b);
  }
  const mark = animate => {
    const on = [...node.querySelectorAll('button')].find(b => b.dataset.v === String(value));
    node.querySelectorAll('button').forEach(b => { b.classList.toggle('on', b === on); b.setAttribute('aria-checked', b === on); });
    if (!on || !on.offsetWidth) { pill.style.opacity = 0; return; }
    pill.style.transition = animate ? '' : 'none';
    pill.style.opacity = 1;
    pill.style.width = `${on.offsetWidth}px`;
    pill.style.transform = `translateX(${on.offsetLeft - 3}px)`;
  };
  node.setValue = v => { value = v; mark(false); };
  // Layout is only measurable once attached; re-mark when the element gets a size.
  new ResizeObserver(() => mark(false)).observe(node);
  mark(false);
  return node;
}

/** Replaces `<span data-slot="name">` placeholders in `root` with ready components. */
export function mountSlots(root, slots) {
  for (const [name, node] of Object.entries(slots)) root.querySelector(`[data-slot="${name}"]`)?.replaceWith(node);
}

// ============================================================ toast
export function toast(msg, kind = 'ok') {
  if (kind === 'err') jsLog(`toast error: ${msg}`);
  const node = el(`<div class="toast ${kind}">${icon(kind === 'ok' ? 'check' : 'warn', 17)}<span>${esc(msg)}</span></div>`);
  $('#toasts').appendChild(node);
  requestAnimationFrame(() => node.classList.add('in'));
  setTimeout(() => { node.classList.remove('in'); setTimeout(() => node.remove(), OUT_MS + 60); }, 2600);
}

// ============================================================ dialogs
function dialog(html, setup) {
  return new Promise(resolve => {
    const back = el(`<div class="modal-back"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`);
    const done = v => {
      back.classList.remove('in');
      setTimeout(() => back.remove(), OUT_MS + 40);
      resolve(v);
    };
    back.addEventListener('mousedown', e => { if (e.target === back) done(null); });
    back.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } });
    $('#modal-root').appendChild(back);
    requestAnimationFrame(() => back.classList.add('in'));
    setup(back, done);
  });
}

export function confirmDialog({ title, body, ok, danger = false }) {
  return dialog(`
    <h3>${esc(title)}</h3><p>${esc(body || '')}</p>
    <div class="modal-actions">
      <button class="btn" data-no>${esc(t('act.cancel'))}</button>
      <button class="btn ${danger ? 'danger' : 'primary'}" data-yes>${esc(ok)}</button>
    </div>`, (root, done) => {
    $('[data-no]', root).onclick = () => done(false);
    const yes = $('[data-yes]', root);
    yes.onclick = () => done(true);
    yes.focus();
  }).then(v => v === true);
}

export function promptDialog({ title, value }) {
  return dialog(`
    <h3>${esc(title)}</h3>
    <input class="text" value="${esc(value)}" spellcheck="false">
    <div class="modal-actions">
      <button class="btn" data-no>${esc(t('act.cancel'))}</button>
      <button class="btn primary" data-yes>${esc(t('act.save'))}</button>
    </div>`, (root, done) => {
    const input = $('input', root);
    $('[data-no]', root).onclick = () => done(null);
    $('[data-yes]', root).onclick = () => done(input.value);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') done(input.value); });
    input.focus();
    const dot = value.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : value.length);
  });
}
