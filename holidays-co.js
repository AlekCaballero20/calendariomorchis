// holidays-co.js — Festivos de Colombia (y compat: re-export de recurrence)
// ✅ Exporta `holidaysCO` (lo que tu settings.js y tu app quieren)
// ✅ Mantiene compatibilidad: `export { recurrence }` para no romper imports viejos
//
// Nota (importante, humanos):
// - Este archivo YA NO “miente”: ahora sí trae festivos.
// - La recurrencia vive en recurrence.js (como debe ser). Aquí solo la re-exportamos.

export { recurrence } from './recurrence.js';

/* ============================================================================
   holidaysCO
   API:
     holidaysCO.getHolidaysForYear(year) -> [{ date:'YYYY-MM-DD', name, type }]
     holidaysCO.holidayMapForYear(year)  -> Map('YYYY-MM-DD' -> name)
     holidaysCO.isHoliday(dateLike)      -> { date, name } | null
============================================================================ */

const MS_DAY = 24 * 60 * 60 * 1000;

function pad2(n){ return String(n).padStart(2,'0'); }
function ymd(d){ return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`; }

function safeDate(v){
  if(v == null) return null;

  // ms number
  if(typeof v === 'number' && Number.isFinite(v)){
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // Firestore Timestamp-like
  if(typeof v === 'object' && typeof v.toDate === 'function'){
    try{
      const d = v.toDate();
      return Number.isNaN(d.getTime()) ? null : d;
    }catch{
      return null;
    }
  }

  const d = (v instanceof Date) ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function dateUTC(y, m, d){
  // m: 1..12
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
}

function addDaysUTC(d, days){
  return new Date(d.getTime() + days * MS_DAY);
}

function nextMondayUTC(d){
  // d en UTC (00:00)
  const dow = d.getUTCDay(); // 0=Dom,1=Lun...
  const delta = (dow === 1) ? 0 : ((8 - dow) % 7);
  return addDaysUTC(d, delta);
}

// Algoritmo de Pascua (Gregorian) en UTC
function easterSundayUTC(year){
  // Meeus/Jones/Butcher
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);      // 3=Marzo, 4=Abril
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return dateUTC(year, month, day);
}

/* ----------------------------------------------------------------------------
  Definiciones Colombia (Ley Emiliani)
  - Algunos festivos se “corren al lunes” si caen otro día.
  - Otros son fijos y no se mueven.
---------------------------------------------------------------------------- */

// Fijos NO movibles
const FIXED = [
  { m: 1,  d: 1,  name: 'Año Nuevo', type: 'fixed' },
  { m: 5,  d: 1,  name: 'Día del Trabajo', type: 'fixed' },
  { m: 7,  d: 20, name: 'Independencia de Colombia', type: 'fixed' },
  { m: 8,  d: 7,  name: 'Batalla de Boyacá', type: 'fixed' },
  { m: 12, d: 8,  name: 'Inmaculada Concepción', type: 'fixed' },
  { m: 12, d: 25, name: 'Navidad', type: 'fixed' },
];

// Fijos MOVIBLES (al lunes siguiente si no caen lunes)
const MONDAYIZED_FIXED = [
  { m: 1,  d: 6,  name: 'Reyes Magos', type: 'emiliani' },
  { m: 3,  d: 19, name: 'San José', type: 'emiliani' },
  { m: 6,  d: 29, name: 'San Pedro y San Pablo', type: 'emiliani' },
  { m: 8,  d: 15, name: 'Asunción de la Virgen', type: 'emiliani' },
  { m: 10, d: 12, name: 'Día de la Raza', type: 'emiliani' },
  { m: 11, d: 1,  name: 'Todos los Santos', type: 'emiliani' },
  { m: 11, d: 11, name: 'Independencia de Cartagena', type: 'emiliani' },
];

// Basados en Pascua
// - Jueves y Viernes Santo NO se mueven
// - Ascensión, Corpus Christi, Sagrado Corazón se mueven al lunes (Emiliani)
function easterBased(year){
  const easter = easterSundayUTC(year);

  const juevesSanto = addDaysUTC(easter, -3);
  const viernesSanto = addDaysUTC(easter, -2);

  const ascension = nextMondayUTC(addDaysUTC(easter, 39));     // Ascensión del Señor
  const corpus = nextMondayUTC(addDaysUTC(easter, 60));        // Corpus Christi
  const sagradoCorazon = nextMondayUTC(addDaysUTC(easter, 68)); // Sagrado Corazón

  return [
    { date: ymdFromUTC(juevesSanto), name: 'Jueves Santo', type: 'easter' },
    { date: ymdFromUTC(viernesSanto), name: 'Viernes Santo', type: 'easter' },

    { date: ymdFromUTC(ascension), name: 'Ascensión del Señor', type: 'easter-emiliani' },
    { date: ymdFromUTC(corpus), name: 'Corpus Christi', type: 'easter-emiliani' },
    { date: ymdFromUTC(sagradoCorazon), name: 'Sagrado Corazón de Jesús', type: 'easter-emiliani' },
  ];
}

function ymdFromUTC(d){
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth()+1)}-${pad2(d.getUTCDate())}`;
}

function uniqByDate(items){
  const map = new Map();
  for(const it of items){
    if(!it?.date) continue;
    // Si por algún caso raro se repite fecha, preferimos el “más específico”
    // (easter-emiliani > easter > emiliani > fixed)
    const prev = map.get(it.date);
    if(!prev){
      map.set(it.date, it);
      continue;
    }
    const rank = (t) => (
      t === 'easter-emiliani' ? 4 :
      t === 'easter' ? 3 :
      t === 'emiliani' ? 2 : 1
    );
    if(rank(it.type) > rank(prev.type)){
      map.set(it.date, it);
    }
  }
  return Array.from(map.values());
}

function sortByDate(items){
  return items.slice().sort((a,b)=> a.date.localeCompare(b.date));
}

function buildForYear(year){
  const out = [];

  // Fixed
  for(const h of FIXED){
    const d = dateUTC(year, h.m, h.d);
    out.push({ date: ymdFromUTC(d), name: h.name, type: h.type });
  }

  // Mondayized fixed
  for(const h of MONDAYIZED_FIXED){
    const d = dateUTC(year, h.m, h.d);
    const obs = nextMondayUTC(d);
    out.push({ date: ymdFromUTC(obs), name: h.name, type: h.type });
  }

  // Easter-based
  out.push(...easterBased(year));

  // Unique + sort
  return sortByDate(uniqByDate(out));
}

function mapForYear(year){
  const list = buildForYear(year);
  const m = new Map();
  for(const it of list){
    m.set(it.date, it.name);
  }
  return m;
}

function isHoliday(dateLike){
  const d = safeDate(dateLike);
  if(!d) return null;

  // Normalizamos a YYYY-MM-DD en hora local (lo que ve el usuario)
  const key = ymd(d);
  const year = d.getFullYear();
  const m = mapForYear(year);
  const name = m.get(key);
  return name ? { date: key, name } : null;
}

export const holidaysCO = Object.freeze({
  getHolidaysForYear(year){
    const y = Number(year);
    if(!Number.isFinite(y) || y < 1900 || y > 2200) return [];
    return buildForYear(y);
  },

  holidayMapForYear(year){
    const y = Number(year);
    if(!Number.isFinite(y) || y < 1900 || y > 2200) return new Map();
    return mapForYear(y);
  },

  isHoliday,
});