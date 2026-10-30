import { api } from './api.js';

export const S = {
  settings: null,
  env: null,
  items: [],
  view: 'library',        // library | favorites | settings | editor
  query: '',
  sort: 'newest',
  app: 'all',
  selected: new Set(),
  cardSize: 250,
  loaded: false,
};

const listeners = new Map();
export const on = (name, fn) => { (listeners.get(name) ?? listeners.set(name, []).get(name)).push(fn); };
export const emit = (name, detail) => (listeners.get(name) || []).forEach(fn => fn(detail));

export async function saveSettings(patch) {
  const prev = S.settings;
  S.settings = { ...S.settings, ...patch };
  try {
    await api.setSettings(S.settings);
  } catch (e) {
    S.settings = prev;   // the backend refused (e.g. unusable shortcut): keep the old value
    throw e;
  }
  S.settings = await api.getSettings();   // backend may normalise values
  emit('settings', S.settings);
}

export const isFav = p => S.settings.favorites.includes(p);

export async function toggleFav(path) {
  const fav = new Set(S.settings.favorites);
  fav.has(path) ? fav.delete(path) : fav.add(path);
  await saveSettings({ favorites: [...fav] });
}

export function shortcutLabel() {
  const L = { Backslash: '\\', Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Backquote: '`' };
  return (S.settings?.shortcut || 'Ctrl+Shift+E').split('+').map(k => L[k] || k).join('+');
}
