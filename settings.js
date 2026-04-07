// settings.js - configuracion + defaults + helpers (client-side)
// Se usa para:
// - Defaults consistentes (sin depender de Firestore)
// - Normalizacion (UI/Firestore pueden mandar cosas raras)
// - Helpers para festivos CO (toggle on/off)
// - Config de recordatorios (settings.reminders)
//
// API:
//   import { settingsDefaults, normalizeSettings, settingsHelpers, holidaysCO } from './settings.js';
//
// Nota:
//   - Este archivo NO calcula festivos: intenta re-exportar holidaysCO desde ./holidays-co.js
//   - Si ./holidays-co.js NO exporta holidaysCO (porque en tu repo ese archivo es "recurrence"),
//     no tumbamos la app: usamos un stub seguro (devuelve vacio) y dejamos warning en consola.

'use strict';

/* ----------------------------------------------------------------------------
  Import tolerante
  - En ESM "import { x } from ..." falla duro si el export no existe.
  - Para no romper toda la app si el archivo esta "cruzado", usamos import dinamico.
----------------------------------------------------------------------------- */

let _holidaysCO = null;
let _recurrence = null;

const holidaysStub = Object.freeze({
  getHolidaysForYear(){ return []; },
  holidayMapForYear(){ return new Map(); },
  isHoliday(){ return null; },
});

async function loadOptionalModules(){
  try{
    const mod = await import('./holidays-co.js');

    if(mod && mod.holidaysCO){
      _holidaysCO = mod.holidaysCO;
    }

    if(mod && mod.recurrence){
      _recurrence = mod.recurrence;
    }

    if(!_holidaysCO){
      console.warn(
        "[settings.js] './holidays-co.js' no exporta 'holidaysCO'. " +
        "Se usara stub (sin festivos). Revisa que el archivo correcto exporte holidaysCO."
      );
      _holidaysCO = holidaysStub;
    }
  }catch(err){
    console.warn(
      "[settings.js] No se pudo cargar './holidays-co.js'. Se usara stub (sin festivos).",
      err
    );
    _holidaysCO = holidaysStub;
  }
}

const _ready = loadOptionalModules();

export const holidaysCO = {
  async ready(){ await _ready; return true; },

  getHolidaysForYear(year){
    return (_holidaysCO || holidaysStub).getHolidaysForYear(year);
  },
  holidayMapForYear(year){
    return (_holidaysCO || holidaysStub).holidayMapForYear(year);
  },
  isHoliday(dateLike){
    return (_holidaysCO || holidaysStub).isHoliday(dateLike);
  },
};

export const recurrence = {
  async ready(){ await _ready; return !!_recurrence; },
  get api(){ return _recurrence || null; },
};

export const settingsDefaults = Object.freeze({
  holidaysCO: 'on',
  emailDigest: 'on',
  emailDigestTime: '07:00',
  categories: {
    personal: { label: 'Personal' },
    trabajo: { label: 'Trabajo' },
    musicala: { label: 'Musicala' },
    familia: { label: 'Familia' },
    salud: { label: 'Salud' },
    finanzas: { label: 'Finanzas' },
    experiencias: { label: 'Experiencias' },
  },
  reminders: {
    enabled: true,
    leadMinutes: [5, 15, 60],
    quietHours: { on: true, from: '22:00', to: '07:00' },
    channel: 'both',
    onlyImportant: false,
    includeCategories: null,
    fireWindowSec: 70,
    graceAfterStartMin: 5,
    horizonDays: 7,
  },
});

function pad2(n){ return String(n).padStart(2, '0'); }

function parseHHMM(s, fallback){
  const m = String(s || '').trim().match(/^(\d{2}):(\d{2})$/);
  if(!m) return fallback;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if(!Number.isFinite(hh) || !Number.isFinite(mm)) return fallback;
  if(hh < 0 || hh > 23 || mm < 0 || mm > 59) return fallback;
  return `${pad2(hh)}:${pad2(mm)}`;
}

function normOnOff(v, def){
  const x = String(v ?? def).toLowerCase().trim();
  return x === 'off' ? 'off' : 'on';
}

function clampInt(n, min, max, fallback){
  const x = Number(n);
  if(!Number.isFinite(x)) return fallback;
  const v = Math.floor(x);
  return Math.min(max, Math.max(min, v));
}

function normStr(v, max = 120){
  const s = String(v ?? '').trim();
  if(!s) return '';
  return s.length > max ? s.slice(0, max) : s;
}

function normCategories(obj){
  if(!obj || typeof obj !== 'object') return null;
  const out = {};
  for(const [k, v] of Object.entries(obj)){
    const key = normStr(k, 50);
    if(!key) continue;
    const label = normStr(v?.label ?? key, 60) || key;
    out[key] = { label };
  }
  return Object.keys(out).length ? out : null;
}

function normReminders(r){
  const base = settingsDefaults.reminders;

  if(!r || typeof r !== 'object'){
    return {
      enabled: base.enabled,
      leadMinutes: base.leadMinutes.slice(),
      quietHours: { ...base.quietHours },
      channel: base.channel,
      onlyImportant: base.onlyImportant,
      includeCategories: base.includeCategories,
      fireWindowSec: base.fireWindowSec,
      graceAfterStartMin: base.graceAfterStartMin,
      horizonDays: base.horizonDays,
    };
  }

  const enabled = r.enabled !== false;

  const leadMinutes = Array.isArray(r.leadMinutes)
    ? Array.from(new Set(
        r.leadMinutes
          .map(x => clampInt(x, 1, 45 * 24 * 60, null))
          .filter(x => x != null)
      )).sort((a, b) => a - b).slice(0, 10)
    : base.leadMinutes.slice();

  const quietHours = (r.quietHours && typeof r.quietHours === 'object')
    ? {
        on: r.quietHours.on === true,
        from: parseHHMM(r.quietHours.from, base.quietHours.from),
        to: parseHHMM(r.quietHours.to, base.quietHours.to),
      }
    : { ...base.quietHours };

  const channel = (r.channel === 'inapp' || r.channel === 'notify' || r.channel === 'both')
    ? r.channel
    : base.channel;

  const onlyImportant = r.onlyImportant === true;

  const includeCategories = Array.isArray(r.includeCategories)
    ? r.includeCategories.map(x => normStr(x, 50)).filter(Boolean)
    : null;

  const fireWindowSec = clampInt(r.fireWindowSec, 10, 120, base.fireWindowSec);
  const graceAfterStartMin = clampInt(r.graceAfterStartMin, 0, 60, base.graceAfterStartMin);
  const horizonDays = clampInt(r.horizonDays, 1, 60, base.horizonDays);

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

export function normalizeSettings(raw = {}){
  const s = (raw && typeof raw === 'object') ? raw : {};

  const holidaysCOFlag = normOnOff(s.holidaysCO, settingsDefaults.holidaysCO);
  const emailDigest = normOnOff(s.emailDigest, settingsDefaults.emailDigest);
  const emailDigestTime = parseHHMM(s.emailDigestTime, settingsDefaults.emailDigestTime);

  const cats = normCategories(s.categories);
  const categories = cats || { ...settingsDefaults.categories };
  const reminders = normReminders(s.reminders);

  const extra = {};
  for(const [k, v] of Object.entries(s)){
    if(k in settingsDefaults) continue;
    extra[k] = v;
  }

  return {
    ...extra,
    holidaysCO: holidaysCOFlag,
    emailDigest,
    emailDigestTime,
    categories,
    reminders,
  };
}

export function mergeWithDefaults(raw = {}){
  const clean = normalizeSettings(raw);
  return {
    ...settingsDefaults,
    ...clean,
    categories: clean.categories || { ...settingsDefaults.categories },
    reminders: clean.reminders || normReminders(null),
  };
}

function getNormalized(settings){
  return mergeWithDefaults(settings || {});
}

export const settingsHelpers = {
  getNormalized,

  isHolidaysEnabled(settings){
    return getNormalized(settings).holidaysCO === 'on';
  },

  getHolidaysForYear(settings, year){
    const s = getNormalized(settings);
    if(s.holidaysCO !== 'on') return [];
    return holidaysCO.getHolidaysForYear(year);
  },

  holidayMapForYear(settings, year){
    const s = getNormalized(settings);
    if(s.holidaysCO !== 'on') return new Map();
    return holidaysCO.holidayMapForYear(year);
  },

  isHoliday(settings, dateLike){
    const s = getNormalized(settings);
    if(s.holidaysCO !== 'on') return null;
    return holidaysCO.isHoliday(dateLike);
  },

  categoriesList(settings){
    const s = getNormalized(settings);
    const obj = (s.categories && typeof s.categories === 'object') ? s.categories : {};
    return Object.entries(obj).map(([key, v]) => ({
      key,
      label: normStr(v?.label ?? key, 60) || key,
    }));
  },

  categoryLabel(settings, key){
    const s = getNormalized(settings);
    const k = String(key || '').trim();
    if(!k) return '';
    return s.categories?.[k]?.label || k;
  },

  toggleFlag(settings, keyOnOff){
    const s = getNormalized(settings);
    if(!(keyOnOff in s)) return s;
    const cur = s[keyOnOff];
    if(cur === 'on' || cur === 'off'){
      return { ...s, [keyOnOff]: cur === 'on' ? 'off' : 'on' };
    }
    return s;
  },

  setEmailDigestTime(settings, hhmm){
    const s = getNormalized(settings);
    return { ...s, emailDigestTime: parseHHMM(hhmm, settingsDefaults.emailDigestTime) };
  },
};
