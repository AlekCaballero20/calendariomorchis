// app.js - Calendar bootstrap + wiring (Auth <-> DB <-> UI <-> Recurrence <-> Reminders)
// v4 responsive / cleaner / safer
// - Import robusto de recurrence
// - Festivos CO como eventos system
// - Cache por ano de festivos
// - Mejor sesion / recarga / recompute
// - Compatible con ui.js mejorado

import { initFirebase } from './firebase.js';
import { authApi } from './auth.js';
import { dbApi } from './db.js';
import { ui } from './ui.js';
import { getDefaultCategories, pad2, safeDate } from './shared.js';

import { holidaysCO } from './settings.js';
import { settings as settingsStore } from './stats.js';
import { reminders } from './reminders.js';

(async function main(){
  'use strict';

  // =========================================================
  // Helpers
  // =========================================================
  const ymd = (d) => {
    const dd = safeDate(d);
    if(!dd) return '';
    return `${dd.getFullYear()}-${pad2(dd.getMonth() + 1)}-${pad2(dd.getDate())}`;
  };

  const yearNow = () => new Date().getFullYear();

  const normalizeErrMsg = (e, fallbackMsg) => {
    const raw = String(e?.message || '').trim();
    if(!raw) return fallbackMsg;

    const low = raw.toLowerCase();

    if(raw.includes('Missing or insufficient permissions')){
      return 'No tienen permisos en Firestore. Revisen Rules o la allowlist.';
    }
    if(low.includes('failed-precondition') && low.includes('index')){
      return 'Firestore necesita un indice para esa consulta. La consola suele soltar el link para crearlo.';
    }
    if(low.includes('network') || low.includes('offline')){
      return 'Parece problema de red. Revisen conexion e intentenlo otra vez.';
    }
    if(low.includes('popup')){
      return 'El inicio de sesion con popup fue bloqueado o cancelado.';
    }
    return raw;
  };

  const safe = async (fn, fallbackMsg = 'Algo fallo. Porque aparentemente la paz nunca fue una opcion.') => {
    try{
      return await fn();
    }catch(e){
      console.error(e);
      try{ ui.showMsg(normalizeErrMsg(e, fallbackMsg)); }catch{}
      return null;
    }
  };

  // =========================================================
  // Expand window
  // =========================================================
  // Dejamos una ventana razonable para que el calendario no se sienta hueco
  // cuando navegan cerca del presente.
  const getExpandWindow = (cursor = new Date()) => {
    const c = safeDate(cursor) || new Date();
    const y = c.getFullYear();

    const start = new Date(y - 1, 0, 1, 0, 0, 0, 0);
    const end   = new Date(y + 1, 11, 31, 23, 59, 59, 999);

    return { start, end };
  };

  // =========================================================
  // Recurrence
  // =========================================================
  let recurrence = null;

  const loadRecurrence = async () => {
    try{
      const mod = await import('./recurrence.js');
      if(mod?.recurrence?.expandEvents){
        recurrence = mod.recurrence;
        return recurrence;
      }
    }catch{}

    try{
      const mod2 = await import('./holidays-co.js');
      if(mod2?.recurrence?.expandEvents){
        recurrence = mod2.recurrence;
        console.warn('[app.js] recurrence cargado desde ./holidays-co.js como fallback. Si, raro. Pero util.');
        return recurrence;
      }
    }catch(e){
      console.error('[app.js] No se pudo cargar recurrence.', e);
    }

    throw new Error('No se encontro recurrence.expandEvents en ./recurrence.js ni en ./holidays-co.js');
  };

  // =========================================================
  // Session / demo
  // =========================================================
  let isDemo = false;

  let demoEvents = [];
  let demoSettings = {
    holidaysCO: 'on',
    emailDigest: 'on',
    emailDigestTime: '07:00',
    categories: getDefaultCategories({ includeHoliday: true }),
  };

  const demoDb = {
    async listEvents(){
      return demoEvents.slice();
    },
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
      return { ...demoSettings, categories: { ...(demoSettings.categories || {}) } };
    },
    async saveSettings(s){
      demoSettings = {
        ...demoSettings,
        ...(s || {}),
        categories: { ...(s?.categories || demoSettings.categories || {}) },
      };
      return { ...demoSettings, categories: { ...(demoSettings.categories || {}) } };
    },
  };

  const activeDb = () => (isDemo ? demoDb : dbApi);

  let session = { uid: null, email: null };
  let authCycle = 0;

  const setSession = ({ uid = null, email = null } = {}) => {
    session.uid = uid || null;
    session.email = email || null;
    try{ dbApi.setContext({ uid: session.uid, email: session.email }); }catch{}
  };

  const clearSession = () => setSession({ uid: null, email: null });

  // =========================================================
  // Runtime state
  // =========================================================
  let currentEvents = [];
  let currentExpandedEvents = [];

  // Cache por ano
  const holidayCache = new Map(); // year -> { map: Map, events: array|null }

  const resetRuntimeEvents = () => {
    currentEvents = [];
    currentExpandedEvents = [];
    ui.setEvents([]);
  };

  // =========================================================
  // Holiday helpers
  // =========================================================
  const mergeCategoryMaps = (...maps) => {
    const out = {};
    for(const m of maps){
      if(!m || typeof m !== 'object') continue;
      for(const [k, v] of Object.entries(m)){
        out[k] = { ...(out[k] || {}), ...(v || {}) };
      }
    }
    return out;
  };

  const ensureHolidayCategoryInSettings = (s) => {
    const baseCats = (s?.categories && typeof s.categories === 'object') ? s.categories : {};
    if(baseCats.holiday) return { ...s, categories: { ...baseCats } };

    return {
      ...(s || {}),
      categories: {
        ...baseCats,
        holiday: { label: 'Festivos CO' },
      },
    };
  };

  const getHolidayMapForYear = async (year) => {
    if(holidayCache.has(year)) return holidayCache.get(year).map;

    try{ await holidaysCO.ready(); }catch{}

    let map;
    try{
      map = holidaysCO.holidayMapForYear(year);
    }catch{
      map = new Map();
    }

    if(!(map instanceof Map)){
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
      const d = safeDate(`${dateStr}T00:00:00`);
      if(!d) continue;

      out.push({
        id: `holiday-${dateStr}`,
        title: `CO ${String(name || 'Festivo').trim()}`,
        start: new Date(d).toISOString(),
        end: null,
        category: 'holiday',
        priority: 'normal',
        notes: 'Festivo de Colombia (auto).',
        createdAt: 0,
        updatedAt: 0,
        isSystem: true,
        system: true,
      });
    }

    out.sort((a, b) => {
      const ta = safeDate(a.start)?.getTime() ?? 0;
      const tb = safeDate(b.start)?.getTime() ?? 0;
      return ta - tb;
    });

    holidayCache.set(year, { map, events: out });
    return out;
  };

  // =========================================================
  // Event normalization / expansion
  // =========================================================
  const normalizeSavedEvent = (ev) => {
    if(!ev || typeof ev !== 'object') return null;
    return {
      ...ev,
      title: String(ev.title || '').trim(),
      category: ev.category || 'personal',
      priority: ev.priority || 'normal',
      notes: ev.notes || '',
      end: ev.end || null,
    };
  };

  const expandUserEvents = (eventsRaw, start, end) => {
    if(!recurrence?.expandEvents) return (eventsRaw || []).slice();
    return recurrence.expandEvents(eventsRaw, start, end);
  };

  const mergeSystemEvents = (userExpanded, systemEvents) => {
    const list = (userExpanded || []).slice();
    const seen = new Set();

    for(const ev of list){
      const key = `${String(ev?.id || '')}::${String(ev?.start || '')}`;
      seen.add(key);
    }

    for(const ev of (systemEvents || [])){
      const key = `${String(ev?.id || '')}::${String(ev?.start || '')}`;
      if(seen.has(key)) continue;
      list.push(ev);
      seen.add(key);
    }

    list.sort((a, b) => {
      const ta = (typeof a?.startMs === 'number') ? a.startMs : (safeDate(a?.start)?.getTime() ?? 0);
      const tb = (typeof b?.startMs === 'number') ? b.startMs : (safeDate(b?.start)?.getTime() ?? 0);
      return ta - tb;
    });

    return list;
  };

  const recomputeExpanded = async ({ render = true } = {}) => {
    const { start, end } = getExpandWindow(new Date());
    const rawSettings = settingsStore.get?.() || {};
    const holidaysOn = String(rawSettings.holidaysCO || 'off').toLowerCase() !== 'off';

    let userExpanded = [];
    try{
      userExpanded = expandUserEvents(currentEvents, start, end) || [];
    }catch(e){
      console.error('[app.js] Error expandiendo recurrencias', e);
      userExpanded = currentEvents.slice();
    }

    let merged = userExpanded;

    if(holidaysOn){
      const years = [];
      for(let y = start.getFullYear(); y <= end.getFullYear(); y++) years.push(y);

      const allHolidayEvents = [];
      for(const y of years){
        const evs = await buildHolidayEventsForYear(y);
        allHolidayEvents.push(...evs);
      }

      const holidayInRange = allHolidayEvents.filter(ev => {
        const d = safeDate(ev.start);
        if(!d) return false;
        const t = d.getTime();
        return t >= start.getTime() && t <= end.getTime();
      });

      merged = mergeSystemEvents(userExpanded, holidayInRange);
    }

    currentExpandedEvents = merged;
    ui.setEvents(currentExpandedEvents);

    if(render) ui.render();
  };

  // =========================================================
  // Settings
  // =========================================================
  const applySettingsToUI = (incoming) => {
    const base = (incoming && typeof incoming === 'object') ? incoming : {};
    const holidaysOn = String(base.holidaysCO || 'off').toLowerCase() !== 'off';

    const normalized = holidaysOn
      ? ensureHolidayCategoryInSettings(base)
      : {
          ...base,
          categories: { ...(base.categories || {}) }
        };

    try{ settingsStore.set(normalized); }catch{}
    try{ ui.setSettings(normalized); }catch{}

    const uiCats = mergeCategoryMaps(
      normalized.categories || {},
      holidaysOn ? { holiday: { label: 'Festivos CO' } } : {}
    );

    if(Object.keys(uiCats).length){
      try{ ui.setCategories(uiCats); }catch{}
    }
  };

  const getDefaultSettings = () => {
    try{
      settingsStore.reset?.();
      const s = settingsStore.get?.() || {
        holidaysCO: 'on',
        emailDigest: 'on',
        emailDigestTime: '07:00',
        categories: {},
      };
      return ensureHolidayCategoryInSettings(s);
    }catch{
      return ensureHolidayCategoryInSettings({
        holidaysCO: 'on',
        emailDigest: 'on',
        emailDigestTime: '07:00',
        categories: {},
      });
    }
  };

  const loadSettings = async () => {
    const opts = (!isDemo && session.uid) ? { uid: session.uid } : {};

    const s = await safe(
      () => activeDb().getSettings ? activeDb().getSettings(opts) : Promise.resolve(null),
      'No se pudo cargar la configuracion.'
    );

    const finalSettings = s || getDefaultSettings();
    applySettingsToUI(finalSettings);
    return finalSettings;
  };

  // =========================================================
  // Events
  // =========================================================
  const loadEvents = async () => {
    const opts = (!isDemo && session.uid) ? { uid: session.uid } : {};

    const events = await safe(
      () => activeDb().listEvents(opts),
      'No se pudieron cargar los eventos.'
    );

    currentEvents = Array.isArray(events)
      ? events.map(normalizeSavedEvent).filter(Boolean)
      : [];

    await recomputeExpanded({ render: false });
    ui.render();
    return currentEvents;
  };

  const loadAndRender = async (guardToken = authCycle) => {
    await loadSettings();
    if(guardToken !== authCycle) return;

    await loadEvents();
    if(guardToken !== authCycle) return;

    ui.render();
  };

  const upsertLocalRaw = (saved) => {
    const clean = normalizeSavedEvent(saved);
    if(!clean?.id) return;

    const i = currentEvents.findIndex(e => e.id === clean.id);
    if(i >= 0) currentEvents[i] = clean;
    else currentEvents.push(clean);
  };

  const removeLocalRaw = (id) => {
    currentEvents = currentEvents.filter(e => e.id !== id);
  };

  // =========================================================
  // Firebase + UI init
  // =========================================================
  initFirebase();
  ui.init();

  await safe(
    loadRecurrence,
    'No se pudo inicializar el motor de recurrencias.'
  );

  // =========================================================
  // Reminders
  // =========================================================
  reminders.init({
    getEvents: () => currentExpandedEvents,
    getSettings: () => settingsStore.get?.() || {},
    notify: ({ title, body }) => {
      try{
        ui.showMsg(`${title}${body ? `\n${body}` : ''}`);
      }catch{}
    }
  });

  const restartReminders = () => {
    try{ reminders.stop?.(); }catch{}
    try{ reminders.start?.(); }catch{}
  };

  // =========================================================
  // Auth wiring
  // =========================================================
  authApi.init({
    onSignedIn: async (user) => {
      authCycle++;
      const myCycle = authCycle;

      isDemo = false;

      const email = user?.email || '';
      const uid = user?.uid || null;

      setSession({ uid, email });

      ui.setUser(email);
      ui.showApp();
      ui.showAuthMsg('');

      await loadAndRender(myCycle);
      if(myCycle !== authCycle) return;

      restartReminders();
    },

    onSignedOut: () => {
      authCycle++;

      isDemo = false;
      clearSession();

      try{ reminders.stop?.(); }catch{}

      resetRuntimeEvents();
      ui.setUser(null);
      ui.showAuth();
    },

    onAuthError: (msg) => {
      ui.showAuthMsg(msg);
    },
  });

  // =========================================================
  // UI actions
  // =========================================================
  ui.onGoogle(async () => safe(
    () => authApi.signInGoogle(),
    'No se pudo iniciar sesion con Google.'
  ));

  ui.onDemo(async () => {
    authCycle++;
    isDemo = true;
    clearSession();

    ui.setUser('demo@alek-y-cata.local');
    ui.showApp();
    ui.showAuthMsg('');

    const now = new Date();
    const iso = (d) => new Date(d).toISOString();
    const stamp = Date.now();

    demoEvents = [
      {
        id: 'demo-1',
        title: 'Pago arriendo (demo)',
        start: iso(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0)),
        end: null,
        category: 'finanzas',
        priority: 'critico',
        notes: 'Demo: esto vive solo en memoria.',
        reminders: [60, 1440],
        createdAt: stamp,
        updatedAt: stamp,
      },
      {
        id: 'demo-2',
        title: 'Cita / salud (demo)',
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
        title: 'Cumple (demo)',
        start: iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 3, 12, 0)),
        end: null,
        category: 'cumple',
        priority: 'normal',
        notes: 'Para probar badges, panel y recurrencia.',
        repeat: { freq: 'yearly', interval: 1 },
        reminders: [1440],
        createdAt: stamp,
        updatedAt: stamp,
      },
      {
        id: 'demo-4',
        title: 'Plan chill (demo)',
        start: iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 5, 19, 0)),
        end: null,
        category: 'experiencias',
        priority: 'normal',
        notes: 'A ver si la vida deja.',
        createdAt: stamp,
        updatedAt: stamp,
      },
    ];

    demoSettings = ensureHolidayCategoryInSettings({
      holidaysCO: 'on',
      emailDigest: 'on',
      emailDigestTime: '07:00',
      categories: getDefaultCategories(),
    });

    await loadAndRender(authCycle);
    restartReminders();
  });

  ui.onLogout(async () => {
    if(isDemo){
      authCycle++;
      isDemo = false;
      clearSession();

      try{ reminders.stop?.(); }catch{}

      resetRuntimeEvents();
      ui.setUser(null);
      ui.showAuth();
      return;
    }

    await safe(
      () => authApi.signOut(),
      'No se pudo cerrar sesion.'
    );
  });

  ui.onCreateEvent(async (data) => {
    const saved = await safe(
      () => activeDb().upsertEvent(data),
      'No se pudo guardar el evento.'
    );
    if(!saved) return;

    upsertLocalRaw(saved);
    await recomputeExpanded({ render: false });
    ui.render();
  });

  ui.onDeleteEvent(async (id) => {
    const ok = await safe(
      () => activeDb().deleteEvent(id),
      'No se pudo eliminar el evento.'
    );
    if(!ok) return;

    removeLocalRaw(id);
    await recomputeExpanded({ render: false });
    ui.render();
  });

  ui.onSaveSettings(async (settings) => {
    const opts = (!isDemo && session.uid) ? { uid: session.uid } : {};

    const normalizedSettings = {
      ...(settings || {}),
      categories: { ...(settings?.categories || {}) },
    };

    const saved = await safe(
      () => activeDb().saveSettings
        ? activeDb().saveSettings(normalizedSettings, opts)
        : Promise.resolve(null),
      'No se pudo guardar la configuracion.'
    );

    const next = saved || normalizedSettings;
    applySettingsToUI(next);

    await recomputeExpanded({ render: false });
    ui.render();
    restartReminders();
  });

  ui.onTestDigest(async () => {
    const recipients = session.email ? [session.email] : [];

    const result = await safe(
      () => reminders.sendDailyDigestNow({
        to: recipients,
        day: new Date(),
        includeTomorrow: true,
      }),
      'No se pudo preparar el digest de prueba.'
    );

    if(!result) return;

    if(result.mode === 'mailto'){
      ui.showMsg(
        recipients.length
          ? `Se abrio el borrador del digest para ${recipients[0]}. Ojo: esto no envia solo el correo.`
          : 'Se abrio el borrador del digest, pero no habia destinatario cargado.'
      );
      return;
    }

    ui.showMsg('El digest de prueba se envio con el backend configurado.');
  });

  // =========================================================
  // Estado inicial
  // =========================================================
  // authApi.init deberia resolver la vista real. Mientras tanto, mostramos auth.
  ui.showAuth();

})();
