// index.js — bootstrap del calendario (ES Modules)
// Conecta UI + settings store + (opcional) app.js
// No rompe si falta app.js: funciona en modo "UI shell".

'use strict';

import { ui } from './ui.js';
import { settings } from './stats.js';

// Opcional: si tienes app.js que orquesta auth/db/events, lo conectamos.
// Si no existe, esto NO debe tumbar la app: lo manejamos con import dinámico.
async function loadAppController() {
  try {
    const mod = await import('./app.js');
    return mod?.app || mod?.default || mod || null;
  } catch (e) {
    console.warn('[index.js] No se pudo cargar ./app.js (modo UI shell).', e);
    return null;
  }
}

function safe(fn) {
  return (...args) => {
    try { return fn(...args); } catch (e) { console.error(e); }
  };
}

function wireUIWithStore() {
  // 1) Set inicial de settings hacia UI
  ui.setSettings(settings.get());
  if (settings.get()?.categories) ui.setCategories(settings.get().categories);

  // 2) Si settings cambia (por DB o lo que sea), reflejar en UI
  settings.subscribe((next) => {
    ui.setSettings(next);
    if (next?.categories) ui.setCategories(next.categories);
  });

  // 3) Cuando UI guarda settings, actualizamos store (y app.js puede persistir)
  ui.onSaveSettings((next) => {
    // next incluye: holidaysCO/emailDigest/emailDigestTime/categories
    settings.set(next);
  });
}

async function wireUIWithApp(appController) {
  if (!appController) return;

  // Si tu app.js expone un init/wire, úsalo. Si no, hacemos wiring básico.
  if (typeof appController.init === 'function') {
    // Le pasamos ui + settings store para que app.js haga lo suyo
    await appController.init({ ui, settings });
    return;
  }

  // Wiring "compatible" si app.js no tiene init formal:
  // Busca handlers típicos (login/logout/etc) y los conecta si existen.
  if (typeof appController.login === 'function') ui.onLogin(safe(appController.login));
  if (typeof appController.loginGoogle === 'function') ui.onGoogle(safe(appController.loginGoogle));
  if (typeof appController.loginDemo === 'function') ui.onDemo(safe(appController.loginDemo));
  if (typeof appController.logout === 'function') ui.onLogout(safe(appController.logout));

  if (typeof appController.createEvent === 'function') ui.onCreateEvent(safe(appController.createEvent));
  if (typeof appController.deleteEvent === 'function') ui.onDeleteEvent(safe(appController.deleteEvent));

  // Persistencia settings
  if (typeof appController.saveSettings === 'function') {
    ui.onSaveSettings(safe(appController.saveSettings));
  }

  // Si app.js tiene "start" o "bootstrap"
  if (typeof appController.start === 'function') {
    await appController.start();
  }
}

async function main() {
  // Arranca UI
  ui.init();

  // Conecta UI <-> settings store
  wireUIWithStore();

  // Render inicial
  ui.render();

  // Carga controlador si existe
  const appController = await loadAppController();
  await wireUIWithApp(appController);
}

// Ejecuta
main().catch((e) => {
  console.error('[index.js] Error fatal al iniciar:', e);
  try { ui?.showMsg?.('Se dañó el arranque. Revisa consola.'); } catch {}
});