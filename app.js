// app.js — Calendar bootstrap + wiring (Auth ⇄ DB ⇄ UI ⇄ Recurrence ⇄ Reminders)
// v3: más coherente, menos “por qué no aparece lo mío”
// ✅ Import robusto de recurrence (prefiere ./recurrence.js; fallback a ./holidays-co.js)
// ✅ Festivos CO inyectados como eventos “system” (si settings.holidaysCO === 'on')
// ✅ Cache por año de festivos (no recalcula todo cada render)
// ✅ Settings guardan y refrescan UI + eventos sin romper nada
// ✅ Reminders siguen igual (in-app + Notifications + mailto helper)

import { initFirebase } from './firebase.js';
import { authApi } from './auth.js';
import { dbApi } from './db.js';
import { ui } from './ui.js';

import { holidaysCO } from './settings.js';            // helpers festivos (con stub + ready())
import { settings as settingsStore } from './stats.js'; // store en memoria (sí, el nombre miente)
import { reminders } from './reminders.js';

(async function main(){
  'use strict';

  // =========================
  // Helpers
  // =========================
  const normalizeErrMsg = (e, fallbackMsg) => {
    const raw = String(e?.message || '').trim();
    if(!raw) return fallbackMsg;

    const low = raw.toLowerCase();

    if(raw.includes('Missing or insufficient permissions')){
      return 'No tienes permisos en Firestore. Revisa Rules / allowlist 🔒';
    }
    if(low.includes('failed-precondition') && low.includes('index')){
      return 'Firestore necesita un índice para esa consulta. Mira la consola: suele darte el link para crearlo.';
    }
    if(low.includes('network') || low.includes('offline')){
      return 'Parece un problema de red. Revisa conexión e inténtalo de nuevo.';
    }
    return raw;
  };

  const safe = async (fn, fallbackMsg = 'Algo falló. Porque claro que sí.') => {
    try{
      return await fn();
    }catch(e){
      console.error(e);
      try{ ui.showMsg(normalizeErrMsg(e, fallbackMsg)); }catch{}
      return null;
    }
  };

  const pad2 = (n) => String(n).padStart(2,'0');

  const safeDate = (v) => {
    if(!v) return null;
    const d = (v instanceof Date) ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  };

  const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;

  const nowYear = () => new Date().getFullYear();

  // Ventana de expansión: año anterior → año siguiente (navegar sin “huecos”)
  const getExpandWindow = () => {
    const y = nowYear();
    const start = new Date(y - 1, 0, 1, 0, 0, 0, 0);
    const end   = new Date(y + 1, 11, 31, 23, 59, 59, 999);
    return { start, end };
  };

  // =========================
  // Recurrence (import robusto)
  // =========================
  let recurrence = null;

  const loadRecurrence = async () => {
    // Preferimos recurrence.js (lo correcto)
    try{
      const mod = await import('./recurrence.js');
      if(mod?.recurrence?.expandEvents){
        recurrence = mod.recurrence;
        return recurrence;
      }
    }catch{}

    // Fallback: tu proyecto viejo lo tenía “cruzado” en holidays-co.js
    try{
      const mod2 = await import('./holidays-co.js');
      if(mod2?.recurrence?.expandEvents){
        recurrence = mod2.recurrence;
        console.warn('[app.js] Usando recurrence desde ./holidays-co.js (fallback). Ideal: moverlo a ./recurrence.js');
        return recurrence;
      }
    }catch(e){
      console.error('[app.js] No pude cargar recurrence.', e);
    }

    throw new Error('No se encontró recurrence.expandEvents en ./recurrence.js ni en ./holidays-co.js');
  };

  // =========================
  // Session + demo
  // =========================
  let isDemo = false;

  let demoEvents = [];
  let demoSettings = {
    holidaysCO: 'on',
    emailDigest: 'on',
    emailDigestTime: '07:00',
  };

  const demoDb = {
    async listEvents(){ return demoEvents.slice(); },
    async upsertEvent(data){
      const t = Date.now();
      const item = {
        id: data.id || `demo-${Math.random().toString(16).slice(2)}${t.toString(16)}`,
        title: String(data.title || '').trim(),
        start: data.start,
        end: data.end || null,
        category: data.category || 'personal',
        priority: data.priority || 'normal',
        notes: data.notes || '',
        ...(data.repeat ? { repeat: data.repeat } : {}),
        ...(Array.isArray(data.reminders) ? { reminders: data.reminders } : {}),
        createdAt: data.createdAt || t,
        updatedAt: t,
      };

      const idx = demoEvents.findIndex(e => e.id === item.id);
      if(idx >= 0) demoEvents[idx] = item;
      else demoEvents.push(item);
      return item;
    },
    async deleteEvent(id){
      demoEvents = demoEvents.filter(e => e.id !== id);
      return true;
    },
    async getSettings(){
      return { ...demoSettings };
    },
    async saveSettings(s){
      demoSettings = { ...demoSettings, ...(s || {}) };
      return { ...demoSettings };
    },
  };

  const activeDb = () => (isDemo ? demoDb : dbApi);

  let session = { uid: null, email: null };

  const setSession = ({ uid = null, email = null } = {}) => {
    session.uid = uid || null;
    session.email = email || null;
    // db.js usa este contexto para queries rules-friendly
    try{ dbApi.setContext({ uid: session.uid, email: session.email }); }catch{}
  };

  const clearSession = () => setSession({ uid: null, email: null });

  // =========================
  // Caches
  // =========================
  let currentEvents = [];          // raw DB (solo usuario)
  let currentExpandedEvents = [];  // expanded (usuario + system holidays)

  // Cache por año de festivos para no recalcular
  const holidayCache = new Map(); // year -> { map: Map(ymd->name), events: [] }

  const getHolidayMapForYear = async (year) => {
    if(holidayCache.has(year)) return holidayCache.get(year).map;

    // Espera a que settings.js termine de cargar el módulo opcional de festivos
    try{ await holidaysCO.ready(); }catch{}

    let map;
    try{
      map = holidaysCO.holidayMapForYear(year);
    }catch{
      map = new Map();
    }
    if(!(map instanceof Map)){
      // por si algún día cambia a objeto plano
      map = new Map(Object.entries(map || {}));
    }

    holidayCache.set(year, { map, events: null });
    return map;
  };

  const buildHolidayEventsForYear = async (year) => {
    const cached = holidayCache.get(year);
    if(cached?.events) return cached.events;

    const map = await getHolidayMapForYear(year);
    const out = [];

    for(const [dateStr, name] of map.entries()){
      // dateStr esperado: YYYY-MM-DD
      const d = safeDate(`${dateStr}T00:00:00`);
      if(!d) continue;

      // Evento “all-day”: lo representamos como start 00:00 y end null
      // (tu UI ya tolera end null)
      out.push({
        id: `holiday-${dateStr}`,
        title: `🇨🇴 ${String(name || 'Festivo').trim()}`,
        start: new Date(d).toISOString(),
        end: null,
        category: 'holiday',
        priority: 'normal',
        notes: 'Festivo de Colombia (auto).',
        createdAt: 0,
        updatedAt: 0,
        system: true,
      });
    }

    // Orden estable por fecha
    out.sort((a,b)=>{
      const ta = safeDate(a.start)?.getTime() ?? 0;
      const tb = safeDate(b.start)?.getTime() ?? 0;
      return ta - tb;
    });

    holidayCache.set(year, { map, events: out });
    return out;
  };

  const ensureHolidayCategory = (s) => {
    // Si el usuario tiene categories, añadimos "holiday" si no existe
    try{
      const cats = (s && typeof s === 'object' && s.categories && typeof s.categories === 'object')
        ? s.categories
        : null;

      if(cats && !cats.holiday){
        const next = { ...cats, holiday: { label: 'Festivos CO' } };
        ui.setCategories(next);
      }else if(!cats){
        // Si UI está usando defaults, igual intentamos meterla
        // (ui.js es robusto: no se muere si no existe)
        ui.setCategories?.({ holiday: { label: 'Festivos CO' } });
      }
    }catch{}
  };

  const expandUserEvents = (eventsRaw, start, end) => {
    // expandEvents debe tolerar eventos sin repeat
    return recurrence.expandEvents(eventsRaw, start, end);
  };

  const mergeSystemEvents = (userExpanded, systemEvents) => {
    const list = (userExpanded || []).slice();
    const seen = new Set(list.map(e => String(e?.id || '')));
    for(const ev of (systemEvents || [])){
      const id = String(ev?.id || '');
      if(id && seen.has(id)) continue;
      list.push(ev);
      if(id) seen.add(id);
    }
    // Orden por start
    list.sort((a,b)=>{
      const ta = (typeof a?.startMs === 'number') ? a.startMs : (safeDate(a?.start)?.getTime() ?? 0);
      const tb = (typeof b?.startMs === 'number') ? b.startMs : (safeDate(b?.start)?.getTime() ?? 0);
      return ta - tb;
    });
    return list;
  };

  const recomputeExpanded = async () => {
    const { start, end } = getExpandWindow();

    // 1) eventos del usuario (recurrence)
    const userExpanded = expandUserEvents(currentEvents, start, end);

    // 2) festivos (system), solo si están ON
    const s = settingsStore.get?.() || {};
    const holidaysOn = String(s.holidaysCO || 'off').toLowerCase() !== 'off';

    let merged = userExpanded;

    if(holidaysOn){
      ensureHolidayCategory(s);

      // Construimos festivos para todos los años que cubre el rango
      const years = [];
      for(let y = start.getFullYear(); y <= end.getFullYear(); y++) years.push(y);

      const allHolidayEvents = [];
      for(const y of years){
        const evs = await buildHolidayEventsForYear(y);
        allHolidayEvents.push(...evs);
      }

      // Filtra por rango (por si acaso)
      const inRange = allHolidayEvents.filter(ev=>{
        const d = safeDate(ev.start);
        if(!d) return false;
        const t = d.getTime();
        return t >= start.getTime() && t <= end.getTime();
      });

      merged = mergeSystemEvents(userExpanded, inRange);
    }

    currentExpandedEvents = merged;
    ui.setEvents(currentExpandedEvents);
  };

  // =========================
  // Settings
  // =========================
  const applySettingsToUI = (s) => {
    if(!s || typeof s !== 'object') return;

    // Store (para reminders/logic)
    try{ settingsStore.set(s); }catch{}

    // UI modal shell
    try{ ui.setSettings(s); }catch{}

    // categorías dinámicas
    if(s.categories && typeof s.categories === 'object'){
      try{ ui.setCategories(s.categories); }catch{}
    }

    // Si festivos ON, garantizamos categoría “holiday”
    try{
      const holidaysOn = String(s.holidaysCO || 'off').toLowerCase() !== 'off';
      if(holidaysOn) ensureHolidayCategory(s);
    }catch{}
  };

  const loadSettings = async () => {
    const opts = (!isDemo && session.uid) ? { uid: session.uid } : {};
    const s = await safe(
      () => activeDb().getSettings ? activeDb().getSettings(opts) : Promise.resolve(null),
      'No pude cargar configuración.'
    );

    if(s){
      applySettingsToUI(s);
      return s;
    }

    // Defaults si backend no devolvió nada
    try{ settingsStore.reset(); }catch{}
    try{ ui.setSettings(settingsStore.get()); }catch{}
    try{
      const d = settingsStore.get?.() || {};
      if(String(d.holidaysCO || 'off').toLowerCase() !== 'off') ensureHolidayCategory(d);
    }catch{}
    return null;
  };

  // =========================
  // Events
  // =========================
  const loadEvents = async () => {
    const opts = (!isDemo && session.uid) ? { uid: session.uid } : {};
    const events = await safe(
      () => activeDb().listEvents(opts),
      'No pude cargar eventos.'
    );

    if(events){
      currentEvents = events.slice();
      await recomputeExpanded();
    }else{
      currentEvents = [];
      await recomputeExpanded();
    }

    ui.render();
    return events;
  };

  const loadAndRender = async () => {
    // settings primero (chips/labels), luego eventos
    await loadSettings();
    await loadEvents();
  };

  const upsertLocalRaw = (saved) => {
    const i = currentEvents.findIndex(e => e.id === saved.id);
    if(i >= 0) currentEvents[i] = saved;
    else currentEvents.push(saved);
  };

  const removeLocalRaw = (id) => {
    currentEvents = currentEvents.filter(e => e.id !== id);
  };

  // =========================
  // Init Firebase + UI
  // =========================
  initFirebase();
  ui.init();

  // Load recurrence engine before anything that expands events
  await safe(loadRecurrence, 'No pude inicializar el motor de recurrencias.');

  // =========================
  // Reminders
  // =========================
  reminders.init({
    getEvents: () => currentExpandedEvents,
    getSettings: () => settingsStore.get(),
    notify: ({ title, body }) => {
      try{ ui.showMsg(`${title}${body ? `\n${body}` : ''}`); }catch{}
    }
  });

  // =========================
  // Auth wiring
  // =========================
  authApi.init({
    onSignedIn: async (user) => {
      isDemo = false;

      const email = user?.email || '';
      const uid = user?.uid || null;

      setSession({ uid, email });

      ui.setUser(email);
      ui.showApp();
      ui.showAuthMsg('');

      await loadAndRender();

      try{ reminders.start(); }catch{}
    },

    onSignedOut: () => {
      isDemo = false;
      clearSession();

      try{ reminders.stop(); }catch{}

      ui.setUser(null);
      ui.showAuth();
    },

    onAuthError: (msg) => {
      ui.showAuthMsg(msg);
    },
  });

  // =========================
  // UI actions
  // =========================
  ui.onLogin(async ({ email, password }) => safe(
    () => authApi.signInEmail(email, password),
    'No se pudo iniciar sesión.'
  ));

  ui.onGoogle(async () => safe(
    () => authApi.signInGoogle(),
    'No se pudo iniciar sesión con Google.'
  ));

  // Demo: solo si existe el botón/handler en UI (no rompe si no hay)
  ui.onDemo(async () => {
    isDemo = true;
    clearSession();

    ui.setUser('demo@alek-y-cata.local');
    ui.showApp();

    const now = new Date();
    const iso = (d) => new Date(d).toISOString();
    const stamp = Date.now();

    demoEvents = [
      {
        id: 'demo-1',
        title: '💰 Pago arriendo (demo)',
        start: iso(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0)),
        end: null,
        category: 'finanzas',
        priority: 'critico',
        notes: 'Demo: esto se guarda solo en memoria (no Firestore).',
        reminders: [60, 1440],
        createdAt: stamp,
        updatedAt: stamp,
      },
      {
        id: 'demo-2',
        title: '🩺 Cita / salud (demo)',
        start: iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 16, 30)),
        end: null,
        category: 'salud',
        priority: 'importante',
        notes: '',
        reminders: [30],
        createdAt: stamp,
        updatedAt: stamp,
      },
      {
        id: 'demo-3',
        title: '🎂 Cumple (demo)',
        start: iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 3, 12, 0)),
        end: null,
        category: 'cumple',
        priority: 'normal',
        notes: 'Solo para probar badges y panel.',
        repeat: { freq: 'yearly', interval: 1 },
        reminders: [1440],
        createdAt: stamp,
        updatedAt: stamp,
      },
      {
        id: 'demo-4',
        title: '✨ Plan chill (demo)',
        start: iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 5, 19, 0)),
        end: null,
        category: 'experiencias',
        priority: 'normal',
        notes: 'A ver si la vida coopera.',
        createdAt: stamp,
        updatedAt: stamp,
      },
    ];

    demoSettings = {
      holidaysCO: 'on',
      emailDigest: 'on',
      emailDigestTime: '07:00',
      categories: {
        personal: { label: 'Personal' },
        salud: { label: 'Salud' },
        finanzas: { label: 'Finanzas' },
        familia: { label: 'Familia' },
        cumple: { label: 'Cumpleaños' },
        experiencias: { label: 'Experiencias' },
        holiday: { label: 'Festivos CO' },
      },
    };

    await loadAndRender();
    try{ reminders.start(); }catch{}
  });

  ui.onLogout(async () => {
    if(isDemo){
      isDemo = false;
      clearSession();
      try{ reminders.stop(); }catch{}
      ui.setUser(null);
      ui.showAuth();
      return;
    }
    await safe(() => authApi.signOut(), 'No se pudo cerrar sesión.');
  });

  ui.onCreateEvent(async (data) => {
    const saved = await safe(
      () => activeDb().upsertEvent(data),
      'No se pudo guardar el evento.'
    );
    if(!saved) return;

    upsertLocalRaw(saved);
    await recomputeExpanded();
    ui.render();
  });

  ui.onDeleteEvent(async (id) => {
    const ok = await safe(
      () => activeDb().deleteEvent(id),
      'No se pudo eliminar el evento.'
    );
    if(!ok) return;

    removeLocalRaw(id);
    await recomputeExpanded();
    ui.render();
  });

  // =========================
  // Settings wiring (⚙️)
  // =========================
  ui.onSaveSettings(async (settings) => {
    const opts = (!isDemo && session.uid) ? { uid: session.uid } : {};

    const saved = await safe(
      () => activeDb().saveSettings
        ? activeDb().saveSettings(settings, opts)
        : Promise.resolve(null),
      'No se pudo guardar la configuración.'
    );

    const next = saved || settings;
    if(next) applySettingsToUI(next);

    // Al cambiar settings (incluye toggle de festivos), recomputamos y render
    await recomputeExpanded();
    ui.render();
  });

})();