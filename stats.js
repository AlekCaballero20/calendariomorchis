// stats.js — Settings Store (frontend) [sí, el nombre miente]
// v2: más sólido, con migraciones, validaciones y “no explota si te llega basura”
//
// Maneja estado de settings y notifica cambios.
// No toca DOM. No depende de Firestore. Solo estado + suscripción.
//
// API usada por app.js:
//   settings.set(obj)     // reemplaza con normalize
//   settings.patch(obj)   // merge parcial
//   settings.get()
//   settings.reset()
//   settings.subscribe(fn)
//
// Back-compat:
//   settings.init == settings.set
//   settings.update == settings.patch
//
// Nota: Si algún día quieres stats de verdad, crea otro módulo.
// Este archivo hoy es claramente "settings-store".

'use strict';

// -------------------------
// Defaults
// -------------------------

const DEFAULT_SETTINGS = Object.freeze({
  schemaVersion: 1,        // para migraciones futuras
  holidaysCO: 'on',        // 'on'|'off'
  emailDigest: 'on',       // 'on'|'off'
  emailDigestTime: '07:00',// HH:mm

  // categorías por defecto (si Firestore no trae nada)
  categories: {
    personal:     { label: 'Personal' },
    salud:        { label: 'Salud' },
    finanzas:     { label: 'Finanzas' },
    familia:      { label: 'Familia' },
    cumple:       { label: 'Cumpleaños' },
    experiencias: { label: 'Experiencias' },
    // Nota: "holiday" la puede inyectar app.js/ui.js si activa festivos
  },

  // opcional: config global de recordatorios (reminders.js la consume)
  reminders: {
    enabled: true,
    leadMinutes: [5, 15, 60],
    quietHours: { on: true, from: '22:00', to: '07:00' },
    channel: 'both',           // 'inapp' | 'notify' | 'both'
    onlyImportant: false,
    includeCategories: null,   // null o ['salud','finanzas'...]
    fireWindowSec: 70,
    graceAfterStartMin: 5,
    horizonDays: 7,
  },
});

// -------------------------
// Internal state
// -------------------------

let state = clone(DEFAULT_SETTINGS);
const listeners = new Set();

// -------------------------
// Helpers
// -------------------------

function clone(obj){
  // Clone estable y suficiente para settings (objetos simples)
  return JSON.parse(JSON.stringify(obj || {}));
}

function hasOwn(obj, key){
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function normOnOff(v, fallback){
  const x = String(v ?? fallback).toLowerCase().trim();
  return (x === 'off') ? 'off' : 'on';
}

function isHHmm(v){
  return typeof v === 'string' && /^\d{2}:\d{2}$/.test(v);
}

function normHHmm(v, fallback){
  if(!isHHmm(v)) return fallback;
  const [hh, mm] = v.split(':').map(Number);
  if(!Number.isFinite(hh) || !Number.isFinite(mm)) return fallback;
  if(hh < 0 || hh > 23 || mm < 0 || mm > 59) return fallback;
  return v;
}

function normStr(v, max = 60){
  const s = String(v ?? '').trim();
  if(!s) return '';
  return s.length > max ? s.slice(0, max) : s;
}

function clampInt(n, min, max, fallback){
  const x = Number(n);
  if(!Number.isFinite(x)) return fallback;
  const v = Math.floor(x);
  return Math.min(max, Math.max(min, v));
}

function normCategories(inputCats){
  if(!inputCats || typeof inputCats !== 'object') return null;

  const clean = {};
  for(const [key, val] of Object.entries(inputCats)){
    const k = normStr(key, 50);
    if(!k) continue;
    const label = normStr(val?.label ?? k, 60) || k;
    clean[k] = { label };
  }

  return Object.keys(clean).length ? clean : null;
}

function normReminders(r){
  const base = DEFAULT_SETTINGS.reminders;

  if(!r || typeof r !== 'object'){
    return clone(base);
  }

  const enabled = r.enabled !== false;

  const leadMinutes = Array.isArray(r.leadMinutes)
    ? Array.from(new Set(
        r.leadMinutes
          .map(x => clampInt(x, 1, 45*24*60, null))
          .filter(x => x != null)
      )).sort((a,b)=>a-b).slice(0, 10)
    : base.leadMinutes.slice();

  const quietHours = (r.quietHours && typeof r.quietHours === 'object')
    ? {
        on: r.quietHours.on === true,
        from: normHHmm(r.quietHours.from, base.quietHours.from),
        to:   normHHmm(r.quietHours.to,   base.quietHours.to),
      }
    : clone(base.quietHours);

  const channel = (r.channel === 'inapp' || r.channel === 'notify' || r.channel === 'both')
    ? r.channel
    : base.channel;

  const onlyImportant = r.onlyImportant === true;

  const includeCategories = Array.isArray(r.includeCategories)
    ? r.includeCategories.map(x => normStr(x, 50)).filter(Boolean)
    : null;

  const fireWindowSec = clampInt(r.fireWindowSec, 10, 180, base.fireWindowSec);
  const graceAfterStartMin = clampInt(r.graceAfterStartMin, 0, 120, base.graceAfterStartMin);
  const horizonDays = clampInt(r.horizonDays, 1, 120, base.horizonDays);

  return {
    enabled,
    leadMinutes: leadMinutes.length ? leadMinutes : base.leadMinutes.slice(),
    quietHours,
    channel,
    onlyImportant,
    includeCategories: includeCategories && includeCategories.length ? includeCategories : null,
    fireWindowSec,
    graceAfterStartMin,
    horizonDays,
  };
}

// -------------------------
// Migrations (future-proof)
// -------------------------

function migrateSettings(raw){
  // raw: lo que viene de Firestore/localStorage/etc.
  const src = (raw && typeof raw === 'object') ? raw : {};
  const v = clampInt(src.schemaVersion, 0, 999, 0);

  // v0 / no version: asumir estructura vieja (sin schemaVersion)
  if(v === 0){
    const next = { ...src, schemaVersion: 1 };
    // Si en alguna versión vieja guardabas "correoHora" o similares, aquí se mapearía.
    // Por ahora, no hay mapeos conocidos: solo setear versión.
    return next;
  }

  // v1 actual: no hay cambios
  return src;
}

function normalizeSettings(input = {}){
  const src0 = (input && typeof input === 'object') ? input : {};
  const src = migrateSettings(src0);

  // base defaults
  const out = clone(DEFAULT_SETTINGS);

  // schema
  out.schemaVersion = 1;

  // flags + time
  out.holidaysCO = normOnOff(src.holidaysCO, out.holidaysCO);
  out.emailDigest = normOnOff(src.emailDigest, out.emailDigest);
  out.emailDigestTime = normHHmm(src.emailDigestTime, out.emailDigestTime);

  // categories: si vienen, reemplazan; si no, se quedan defaults
  const cats = normCategories(src.categories);
  if(cats) out.categories = cats;

  // reminders: si vienen, se normalizan; si no, quedan defaults
  out.reminders = normReminders(src.reminders);

  // preserva campos extra (para futuro) sin romper el contrato
  for(const [k, v] of Object.entries(src)){
    if(k in out) continue;
    out[k] = v;
  }

  return out;
}

function notify(){
  const snapshot = settings.get();
  for(const fn of listeners){
    try{ fn(snapshot); }catch(e){ console.warn('[settings.subscribe]', e); }
  }
}

function shallowEqualTop(a, b){
  // suficiente para evitar notificar cuando no cambia nada en top-level
  if(a === b) return true;
  if(!a || !b) return false;

  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if(ak.length !== bk.length) return false;

  for(const k of ak){
    if(a[k] !== b[k]) return false;
  }
  return true;
}

// -------------------------
// Public API
// -------------------------

export const settings = {
  // Reemplaza completamente (con normalize)
  set(next = {}){
    const clean = normalizeSettings(next);
    const prev = state;
    state = clean;

    if(!shallowEqualTop(prev, state)) notify();
    return settings.get();
  },

  // Merge parcial (con normalize final)
  patch(patch = {}){
    const p = (patch && typeof patch === 'object') ? patch : {};
    const merged = { ...state, ...p };

    // categories: si viene, lo tomamos como reemplazo total (limpio)
    if(hasOwn(p, 'categories')){
      const cats = normCategories(p.categories);
      merged.categories = cats || clone(DEFAULT_SETTINGS.categories);
    }

    // reminders: si viene, lo normalizamos
    if(hasOwn(p, 'reminders')){
      merged.reminders = normReminders(p.reminders);
    }

    // flags/time normalizados via set()
    return settings.set(merged);
  },

  // Devuelve copia
  get(){
    return clone(state);
  },

  reset(){
    const prev = state;
    state = clone(DEFAULT_SETTINGS);
    if(!shallowEqualTop(prev, state)) notify();
    return settings.get();
  },

  subscribe(fn){
    if(typeof fn !== 'function') return () => {};
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  // Helpers prácticos
  getCategories(){
    return clone(state.categories || {});
  },

  ensureCategory(key, label){
    const k = normStr(key, 50);
    if(!k) return settings.get();

    const cats = clone(state.categories || {});
    if(!cats[k]){
      cats[k] = { label: normStr(label || k, 60) || k };
      return settings.patch({ categories: cats });
    }
    return settings.get();
  },

  isHolidaysEnabled(){
    return state.holidaysCO === 'on';
  },

  isEmailDigestEnabled(){
    return state.emailDigest === 'on';
  },

  // Back-compat
  init(initial = {}){ return settings.set(initial); },
  update(p = {}){ return settings.patch(p); },
};