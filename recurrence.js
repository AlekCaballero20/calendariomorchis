// recurrence.js — expansión de eventos recurrentes (client-side)
// v3: rápido, estable y sin loops infinitos 🫠
//
// Soporta repeat: { freq:'daily|weekly|monthly|yearly', interval:number, until?, count? }
// Devuelve ocurrencias dentro de un rango [rangeStart, rangeEnd] (inclusive)
//
// Uso:
//   import { recurrence } from './recurrence.js';
//   const expanded = recurrence.expandEvents(events, rangeStart, rangeEnd);
//
// Notas:
// - No escribe en Firestore. Solo genera eventos virtuales.
// - Mantiene hora y duración (end-start) si existe end.
// - Para monthly/yearly si el día no existe (31 en Feb), cae al último día del mes.
// - Prefiere startMs/endMs si existen.
// - Evita drift por DST calculando saltos por “días calendario” cuando aplica.
// - Tiene guardas duras contra configuraciones absurdas.

'use strict';

const MS_DAY = 24 * 60 * 60 * 1000;
const MAX_GUARD = 8000;   // loop protector duro
const MAX_COUNT = 100000; // límite razonable (por seguridad)

function isFiniteNum(n){ return typeof n === 'number' && Number.isFinite(n); }

function safeDate(v){
  if(v == null) return null;

  // number ms
  if(isFiniteNum(v)){
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

function toISO(d){ return d.toISOString(); }

function clampInt(n, min, max, fallback){
  const x = Number(n);
  if(!Number.isFinite(x)) return fallback;
  const v = Math.floor(x);
  if(v < min) return min;
  if(v > max) return max;
  return v;
}

function normRepeat(r){
  if(!r || typeof r !== 'object') return null;

  const freq = String(r.freq || '').toLowerCase().trim();
  const allowed = new Set(['daily','weekly','monthly','yearly']);
  if(!allowed.has(freq)) return null;

  const interval = clampInt(r.interval, 1, 3650, 1);

  // until: Date | ms | ISO | Firestore Timestamp-like
  const until = safeDate(r.until);

  // count: total occurrences including first
  const count = (r.count == null) ? null : clampInt(r.count, 1, MAX_COUNT, null);

  return { freq, interval, until: until || null, count: count || null };
}

function startOfDay(d){
  const x = new Date(d);
  x.setHours(0,0,0,0);
  return x;
}

function endOfDay(d){
  const x = new Date(d);
  x.setHours(23,59,59,999);
  return x;
}

function inRangeInclusive(d, a, b){
  const t = d.getTime();
  return t >= a.getTime() && t <= b.getTime();
}

function daysInMonth(y, m){
  return new Date(y, m + 1, 0).getDate();
}

// Diferencia de días calendario (ignora horas y DST)
function dayKeyUTC(d){
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
}
function diffCalendarDays(a, b){
  // b - a en días calendario
  return Math.floor((dayKeyUTC(b) - dayKeyUTC(a)) / MS_DAY);
}

function addDaysKeepTime(base, days){
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}

function addWeeksKeepTime(base, weeks){
  return addDaysKeepTime(base, weeks * 7);
}

function addMonthsKeepDay(base, months){
  // Mantiene hora/minutos/segundos. Ajusta día al último del mes si no existe.
  const day = base.getDate();
  const target = new Date(base);

  target.setDate(1); // evita overflow raro
  target.setMonth(target.getMonth() + months);

  const dim = daysInMonth(target.getFullYear(), target.getMonth());
  target.setDate(Math.min(day, dim));
  return target;
}

function addYearsKeepMonthDay(base, years){
  const m = base.getMonth();
  const day = base.getDate();

  const target = new Date(base);
  target.setFullYear(target.getFullYear() + years);

  // overflow (Feb 29)
  if(target.getMonth() !== m){
    target.setMonth(m + 1, 0); // último día del mes m
  }else{
    const dim = daysInMonth(target.getFullYear(), target.getMonth());
    target.setDate(Math.min(day, dim));
  }
  return target;
}

function stepDate(d, repeat){
  switch(repeat.freq){
    case 'daily':   return addDaysKeepTime(d, repeat.interval);
    case 'weekly':  return addWeeksKeepTime(d, repeat.interval);
    case 'monthly': return addMonthsKeepDay(d, repeat.interval);
    case 'yearly':  return addYearsKeepMonthDay(d, repeat.interval);
    default: return null;
  }
}

// Preferimos startMs/endMs si existen
function getStartDate(ev){
  if(isFiniteNum(ev?.startMs)) return safeDate(ev.startMs);
  return safeDate(ev?.start);
}
function getEndDate(ev){
  if(isFiniteNum(ev?.endMs)) return safeDate(ev.endMs);
  return safeDate(ev?.end);
}

function monthsDiff(a, b){
  // b - a en meses (ignora día)
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
}

function safeIdPart(x){
  const s = String(x ?? '');
  return s.replace(/\s+/g,' ').trim().slice(0, 200);
}

function buildOccurrence(ev, occStart, durationMs){
  const occEnd = (durationMs != null && Number.isFinite(durationMs))
    ? new Date(occStart.getTime() + durationMs)
    : null;

  const startIso = toISO(occStart);
  const endIso = occEnd ? toISO(occEnd) : null;

  const baseId = safeIdPart(ev?.id || 'evt');

  return {
    ...ev,

    // ID estable por fecha/hora de ocurrencia (no pisar el original)
    id: `${baseId}::${startIso}`,

    // Marcadores
    isOccurrence: true,
    parentId: ev?.id ?? null,
    occurrenceStart: startIso,

    // Fechas expandidas
    start: startIso,
    end: endIso,

    // Campos ms útiles para ordenar/filtrar
    startMs: occStart.getTime(),
    endMs: occEnd ? occEnd.getTime() : null,
  };
}

function passesRepeatLimits(repeat, occStart, producedCount, originalStart){
  if(repeat?.until){
    if(occStart.getTime() > repeat.until.getTime()) return false;
  }
  if(repeat?.count){
    if(producedCount >= repeat.count) return false;
  }
  if(originalStart && occStart.getTime() < originalStart.getTime()) return false;
  return true;
}

// Evita iterar desde el año 1997 si alguien pone una repetición diaria 🙃
// Calcula el primer start >= rangeStart con “saltos aritméticos” cuando se puede.
function firstOccurrenceOnOrAfter(eventStart, repeat, rangeStart){
  if(eventStart.getTime() >= rangeStart.getTime()) return new Date(eventStart);

  // Daily/weekly: salto por días calendario
  if(repeat.freq === 'daily' || repeat.freq === 'weekly'){
    const stepDays = repeat.freq === 'daily' ? repeat.interval : repeat.interval * 7;
    const diffDays = diffCalendarDays(eventStart, rangeStart);

    const k = Math.max(0, Math.floor(diffDays / stepDays));
    let candidate = addDaysKeepTime(eventStart, k * stepDays);

    while(candidate.getTime() < rangeStart.getTime()){
      candidate = addDaysKeepTime(candidate, stepDays);
    }
    return candidate;
  }

  // Monthly: salto por meses
  if(repeat.freq === 'monthly'){
    const diffM = monthsDiff(eventStart, rangeStart);
    const stepM = repeat.interval;

    const k = Math.max(0, Math.floor(diffM / stepM));
    let candidate = addMonthsKeepDay(eventStart, k * stepM);

    while(candidate.getTime() < rangeStart.getTime()){
      candidate = addMonthsKeepDay(candidate, stepM);
    }
    return candidate;
  }

  // Yearly: salto por años
  if(repeat.freq === 'yearly'){
    const diffY = rangeStart.getFullYear() - eventStart.getFullYear();
    const stepY = repeat.interval;

    const k = Math.max(0, Math.floor(diffY / stepY));
    let candidate = addYearsKeepMonthDay(eventStart, k * stepY);

    while(candidate.getTime() < rangeStart.getTime()){
      candidate = addYearsKeepMonthDay(candidate, stepY);
    }
    return candidate;
  }

  // Fallback (no debería pasar)
  let guard = 0;
  let cur = new Date(eventStart);
  while(cur.getTime() < rangeStart.getTime() && guard < MAX_GUARD){
    const next = stepDate(cur, repeat);
    if(!next) break;
    cur = next;
    guard++;
  }
  return cur;
}

export const recurrence = (() => {

  function expandEvents(events, rangeStart, rangeEnd){
    const a0 = safeDate(rangeStart);
    const b0 = safeDate(rangeEnd);
    const list = Array.isArray(events) ? events : [];

    if(!a0 || !b0) return list.slice();

    // si vienen cruzados, los enderezamos sin drama
    const a = (a0.getTime() <= b0.getTime()) ? a0 : b0;
    const b = (a0.getTime() <= b0.getTime()) ? b0 : a0;

    const start = startOfDay(a);
    const end = endOfDay(b);

    const out = [];

    for(const ev of list){
      if(!ev) continue;

      const s0 = getStartDate(ev);
      if(!s0){
        // evento roto: lo dejamos pasar tal cual
        out.push(ev);
        continue;
      }

      const repeat = normRepeat(ev.repeat);
      const e0 = getEndDate(ev);
      const durationMs = e0 ? (e0.getTime() - s0.getTime()) : null;

      // No recurrente: incluir si start cae en rango
      if(!repeat){
        if(inRangeInclusive(s0, start, end)) out.push(ev);
        continue;
      }

      // Recurrente: ocurrencias cuyo start cae en rango
      let cur = firstOccurrenceOnOrAfter(s0, repeat, start);

      let guard = 0;
      let produced = 0;

      while(cur && cur.getTime() <= end.getTime() && guard < MAX_GUARD){
        if(!passesRepeatLimits(repeat, cur, produced, s0)) break;

        if(inRangeInclusive(cur, start, end)){
          out.push(buildOccurrence(ev, cur, durationMs));
        }

        produced++;
        cur = stepDate(cur, repeat);
        guard++;
      }

      // si algo está muy loco, preferimos no congelar la app
      if(guard >= MAX_GUARD){
        // console.warn('[recurrence] guard hit', ev?.id, repeat);
      }
    }

    // Orden final por startMs si existe
    out.sort((x, y) => {
      const ax = isFiniteNum(x?.startMs) ? x.startMs : (safeDate(x?.start)?.getTime() ?? 0);
      const ay = isFiniteNum(y?.startMs) ? y.startMs : (safeDate(y?.start)?.getTime() ?? 0);
      return ax - ay;
    });

    return out;
  }

  // Próxima ocurrencia (Date) >= fromDate
  function nextOccurrence(ev, fromDate = new Date()){
    const s0 = getStartDate(ev);
    const repeat = normRepeat(ev?.repeat);
    const from = safeDate(fromDate) || new Date();

    if(!s0) return null;

    if(!repeat){
      return (s0.getTime() >= from.getTime()) ? s0 : null;
    }

    const next = firstOccurrenceOnOrAfter(s0, repeat, from);
    if(!next) return null;

    if(repeat.until && next.getTime() > repeat.until.getTime()) return null;

    // count exacto puede ser caro; lo hacemos exacto solo si es pequeño
    if(repeat.count && repeat.count <= 5000){
      let cur = new Date(s0);
      let i = 0;
      while(cur && i < repeat.count){
        if(cur.getTime() >= from.getTime()){
          if(repeat.until && cur.getTime() > repeat.until.getTime()) return null;
          return cur;
        }
        cur = stepDate(cur, repeat);
        i++;
      }
      return null;
    }

    return next;
  }

  return { expandEvents, nextOccurrence };
})();