// Sonux's update store, adapted to Pengo's plain-JavaScript UI.
import { api, listen } from './api.js';
import { emit } from './store.js';
export const updates = { info: null, actionError: null, pending: false, restarting: false };
let statusRevision = 0;
let latestStatus;
const changed = () => emit('updates');
export async function refreshUpdates() {
  const revision = statusRevision;
  try {
    const info = await api.getUpdateStatus();
    // A slow snapshot must not replace a newer progress/completion event.
    if (statusRevision !== revision && latestStatus) info.status = latestStatus;
    updates.info = info;
  } catch (error) { updates.actionError = String(error); }
  changed();
}
export async function toggleUpdates(enabled) {
  if (updates.pending) return;
  updates.pending = true; updates.actionError = null; changed();
  try { await api.setAutoUpdate(enabled); await refreshUpdates(); }
  catch (error) { updates.actionError = String(error); }
  finally { updates.pending = false; changed(); }
}
export async function checkUpdates() {
  if (updates.pending) return;
  updates.pending = true; updates.actionError = null; changed();
  try { await api.checkAndInstallUpdate(); }
  catch (error) { updates.actionError = String(error); }
  finally { await refreshUpdates(); updates.pending = false; changed(); }
}
export async function restartApplication() {
  if (updates.restarting) return;
  updates.restarting = true; updates.actionError = null; changed();
  try { await api.restartApp(); }
  catch (error) { updates.restarting = false; updates.actionError = String(error); changed(); }
}
export async function subscribeUpdates() {
  const unlisten = await listen('pengo://update', ({ payload }) => {
    statusRevision++;
    latestStatus = payload;
    if (updates.info) { updates.info = { ...updates.info, status: payload }; changed(); }
    else void refreshUpdates();
  });
  await refreshUpdates();
  return unlisten;
}
