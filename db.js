// db.js - Firestore implementation (shared calendar + shared settings)
// v5 Morchis shared
// - Alek y Cata ven el mismo calendario usando calendarId.
// - Mantiene ownerUid/ownerEmail como auditoria, pero YA NO filtra por ownerUid.
// - Incluye fallback/migracion suave para eventos viejos que quedaron guardados por usuario.

'use strict';

import { db } from './firebase.js';
import { mergeWithDefaults, normalizeSettings } from './settings.js';

import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  where,
  writeBatch,
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';

const COL_EVENTS = 'events';
const COL_USERS = 'users';
const COL_CALENDARS = 'calendars';
const SUB_SETTINGS = 'settings';
const SETTINGS_DOC_ID = 'main';

// Calendario unico compartido para ustedes dos.
// Si algun dia crean otro calendario familiar/proyecto, cambia/duplica este id.
const SHARED_CALENDAR_ID = 'morchis-main';
const SHARED_CALENDAR_NAME = 'Calendario Morchis';

const SHARED_EMAILS = Object.freeze([
  'alekcaballeromusic@gmail.com',
  'catalina.medina.leal@gmail.com',
]);

const DEFAULT_EVENTS = {
  category: 'personal',
  priority: 'normal',
};

let ctx = {
  uid: null,
  email: null,
};

const ALLOWED_REPEAT_FREQ = new Set(['daily', 'weekly', 'monthly', 'yearly']);

function normEmail(value){
  return String(value || '').trim().toLowerCase();
}

function isSharedUser(email){
  return SHARED_EMAILS.includes(normEmail(email));
}

function normStr(value, max = 4000){
  const s = String(value ?? '').trim();
  if(!s) return '';
  return s.length > max ? s.slice(0, max) : s;
}

function isFiniteNum(value){
  return typeof value === 'number' && Number.isFinite(value);
}

function toDate(value){
  if(!value) return null;
  if(value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

  if(typeof value === 'object' && typeof value.toDate === 'function'){
    try{
      const d = value.toDate();
      return Number.isNaN(d.getTime()) ? null : d;
    }catch{
      return null;
    }
  }

  try{
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }catch{
    return null;
  }
}

function normISO(value){
  const d = toDate(value);
  return d ? d.toISOString() : null;
}

function normMs(value){
  if(isFiniteNum(value)) return Math.floor(value);
  const d = toDate(value);
  return d ? d.getTime() : null;
}

function nowMs(){
  return Date.now();
}

function clampInt(value, min, max, fallback){
  const n = Number(value);
  if(!Number.isFinite(n)) return fallback;
  const v = Math.floor(n);
  if(v < min) return min;
  if(v > max) return max;
  return v;
}

function normalizeRepeat(repeat){
  if(!repeat || typeof repeat !== 'object') return null;

  const freq = normStr(repeat.freq, 16).toLowerCase();
  if(!ALLOWED_REPEAT_FREQ.has(freq)) return null;

  const interval = clampInt(repeat.interval, 1, 365, 1);
  return { freq, interval };
}

function normalizeReminders(arr){
  if(!Array.isArray(arr)) return [];

  const out = [];
  for(const value of arr){
    const n = clampInt(value, 0, 43200, null);
    if(n === null) continue;
    out.push(n);
  }

  return Array.from(new Set(out)).sort((a, b) => a - b).slice(0, 8);
}

function normalizeEventInput(data = {}){
  const start = normISO(data.start);
  const end = normISO(data.end);

  const startMs = normMs(data.startMs ?? data.start);
  const endMs = normMs(data.endMs ?? data.end);

  const createdAt = isFiniteNum(Number(data.createdAt)) ? Number(data.createdAt) : nowMs();
  const updatedAt = nowMs();

  return {
    id: data.id || null,
    title: normStr(data.title, 180),
    start,
    end,
    startMs,
    endMs,
    category: normStr(data.category, 50) || DEFAULT_EVENTS.category,
    priority: normStr(data.priority, 20) || DEFAULT_EVENTS.priority,
    notes: normStr(data.notes, 4000),
    repeat: normalizeRepeat(data.repeat),
    reminders: normalizeReminders(data.reminders),
    createdAt,
    updatedAt,
    calendarId: SHARED_CALENDAR_ID,
    calendarName: SHARED_CALENDAR_NAME,
    sharedWith: SHARED_EMAILS.slice(),
    ownerUid: normStr(data.ownerUid, 128) || (ctx.uid || ''),
    ownerEmail: normEmail(data.ownerEmail) || (ctx.email || ''),
    updatedByUid: ctx.uid || null,
    updatedByEmail: ctx.email || null,
  };
}

function normalizeEventFromDb(id, raw){
  const out = {
    id,
    title: normStr(raw?.title, 180),
    start: normISO(raw?.start),
    end: normISO(raw?.end),
    category: normStr(raw?.category, 50) || DEFAULT_EVENTS.category,
    priority: normStr(raw?.priority, 20) || DEFAULT_EVENTS.priority,
    notes: normStr(raw?.notes, 4000),
    createdAt: isFiniteNum(Number(raw?.createdAt)) ? Number(raw.createdAt) : nowMs(),
    updatedAt: isFiniteNum(Number(raw?.updatedAt)) ? Number(raw.updatedAt) : nowMs(),
    calendarId: normStr(raw?.calendarId, 80),
    calendarName: normStr(raw?.calendarName, 120),
    sharedWith: Array.isArray(raw?.sharedWith) ? raw.sharedWith.map(normEmail).filter(Boolean) : [],
    ownerUid: normStr(raw?.ownerUid, 128),
    ownerEmail: normEmail(raw?.ownerEmail),
    updatedByUid: normStr(raw?.updatedByUid, 128) || null,
    updatedByEmail: normEmail(raw?.updatedByEmail) || null,
  };

  const startMs = normMs(raw?.startMs ?? raw?.start);
  const endMs = normMs(raw?.endMs ?? raw?.end);
  const repeat = normalizeRepeat(raw?.repeat);
  const reminders = normalizeReminders(raw?.reminders);

  if(startMs !== null) out.startMs = startMs;
  if(endMs !== null) out.endMs = endMs;
  if(repeat) out.repeat = repeat;
  if(reminders.length) out.reminders = reminders;

  return out;
}

function sortEvents(list){
  return (list || []).slice().sort((a, b) => {
    const aMs = isFiniteNum(a.startMs) ? a.startMs : Number.POSITIVE_INFINITY;
    const bMs = isFiniteNum(b.startMs) ? b.startMs : Number.POSITIVE_INFINITY;
    if(aMs !== bMs) return aMs - bMs;
    return String(a.start || '9999').localeCompare(String(b.start || '9999'));
  });
}

function mergeEvents(...groups){
  const map = new Map();
  for(const group of groups){
    for(const ev of group || []){
      if(!ev?.id) continue;
      map.set(ev.id, ev);
    }
  }
  return sortEvents(Array.from(map.values()));
}

function errMsg(err, fallback = 'Firestore no explico el error.'){
  const msg = String(err?.message || '').trim();
  return msg || fallback;
}

function explainFirestoreErr(err){
  const code = String(err?.code || '');
  const msg = String(err?.message || '');
  const lower = msg.toLowerCase();

  if(msg.includes('Missing or insufficient permissions') || code === 'permission-denied'){
    return 'Permisos insuficientes en Firestore. Revisa firestore.rules: los dos correos deben poder leer/escribir calendarId=morchis-main.';
  }
  if((lower.includes('failed-precondition') && lower.includes('index')) || code === 'failed-precondition'){
    return 'Falta un indice en Firestore para esa consulta. Puedes crearlo desde el enlace que muestra Firebase o usar el fallback sin ordenamiento.';
  }
  if(code === 'unavailable' || lower.includes('network')){
    return 'Firestore no esta disponible ahora. Revisa la conexion e intenta otra vez.';
  }
  return null;
}

function shouldTryFallback(err){
  const code = String(err?.code || '');
  const msg = String(err?.message || '').toLowerCase();
  return code === 'failed-precondition' || msg.includes('index') || msg.includes('failed-precondition');
}

async function runEventQuery(primaryQuery, fallbackQuery){
  try{
    const snap = await getDocs(primaryQuery);
    return snap.docs.map(d => normalizeEventFromDb(d.id, d.data()));
  }catch(err){
    if(!fallbackQuery || !shouldTryFallback(err)){
      throw new Error(explainFirestoreErr(err) || errMsg(err));
    }

    const snap = await getDocs(fallbackQuery);
    return sortEvents(snap.docs.map(d => normalizeEventFromDb(d.id, d.data())));
  }
}

function sharedSettingsDocRef(){
  return doc(db, COL_CALENDARS, SHARED_CALENDAR_ID, SUB_SETTINGS, SETTINGS_DOC_ID);
}

function legacySettingsDocRef(uid){
  return doc(db, COL_USERS, uid, SUB_SETTINGS, SETTINGS_DOC_ID);
}

function allowedOrThrow(){
  if(!ctx.uid) throw new Error('No hay usuario en contexto. Inicia sesion antes de continuar.');
  if(!isSharedUser(ctx.email)) throw new Error('Este calendario es privado de Alek y Cata. Ese correo no esta autorizado.');
}

async function ensureSharedCalendarDoc(){
  if(!ctx.uid) return;

  try{
    await setDoc(doc(db, COL_CALENDARS, SHARED_CALENDAR_ID), {
      name: SHARED_CALENDAR_NAME,
      calendarId: SHARED_CALENDAR_ID,
      sharedWith: SHARED_EMAILS.slice(),
      updatedAt: nowMs(),
      updatedAtServer: serverTimestamp(),
    }, { merge: true });
  }catch(err){
    // No tumbamos la app por metadata. Si falla, las reglas probablemente faltan.
    console.warn('[dbApi.ensureSharedCalendarDoc]', explainFirestoreErr(err) || errMsg(err));
  }
}

async function migrateLegacyEventsForCurrentUser(list){
  const legacy = (list || []).filter(ev => ev?.id && ev.calendarId !== SHARED_CALENDAR_ID);
  if(!legacy.length) return;

  try{
    let batch = writeBatch(db);
    let count = 0;

    for(const ev of legacy){
      batch.set(doc(db, COL_EVENTS, ev.id), {
        calendarId: SHARED_CALENDAR_ID,
        calendarName: SHARED_CALENDAR_NAME,
        sharedWith: SHARED_EMAILS.slice(),
        migratedFromOwnerUid: ev.ownerUid || null,
        migratedAt: nowMs(),
        migratedAtServer: serverTimestamp(),
      }, { merge: true });

      count++;
      if(count % 450 === 0){
        await batch.commit();
        batch = writeBatch(db);
      }
    }

    if(count % 450 !== 0) await batch.commit();
  }catch(err){
    // Carga primero; migracion despues. No hay que romper el calendario por una mudanza incompleta.
    console.warn('[dbApi.migrateLegacyEventsForCurrentUser]', explainFirestoreErr(err) || errMsg(err));
  }
}

export const dbApi = {
  setContext({ uid = null, email = null } = {}){
    ctx.uid = uid ? String(uid) : null;
    ctx.email = email ? normEmail(email) : null;
  },

  async listEvents(opts = {}){
    const uid = normStr(opts.uid, 128) || ctx.uid || '';
    if(!uid) return [];
    allowedOrThrow();
    await ensureSharedCalendarDoc();

    const base = collection(db, COL_EVENTS);

    const sharedOrderedQuery = query(
      base,
      where('calendarId', '==', SHARED_CALENDAR_ID),
      orderBy('startMs', 'asc')
    );
    const sharedFallbackQuery = query(
      base,
      where('calendarId', '==', SHARED_CALENDAR_ID)
    );

    const legacyOrderedQuery = query(
      base,
      where('ownerUid', '==', uid),
      orderBy('startMs', 'asc')
    );
    const legacyFallbackQuery = query(
      base,
      where('ownerUid', '==', uid)
    );
    const allEventsQuery = query(base);

    const sharedEvents = await runEventQuery(sharedOrderedQuery, sharedFallbackQuery);

    // Rescate de datos viejos:
    // 1) con las reglas nuevas, cualquiera de los dos puede leer la coleccion y migrar
    //    eventos antiguos aunque los haya creado el otro correo.
    // 2) si todavia tienen reglas viejas ownerUid==request.auth.uid, al menos rescata
    //    los eventos del usuario actual.
    let legacyEvents = [];
    try{
      const snap = await getDocs(allEventsQuery);
      legacyEvents = snap.docs
        .map(d => normalizeEventFromDb(d.id, d.data()))
        .filter(ev => ev.calendarId !== SHARED_CALENDAR_ID);
      await migrateLegacyEventsForCurrentUser(legacyEvents);
    }catch(allErr){
      console.warn('[dbApi.listEvents all legacy]', explainFirestoreErr(allErr) || errMsg(allErr));
      try{
        legacyEvents = await runEventQuery(legacyOrderedQuery, legacyFallbackQuery);
        await migrateLegacyEventsForCurrentUser(legacyEvents);
      }catch(ownerErr){
        console.warn('[dbApi.listEvents owner legacy]', explainFirestoreErr(ownerErr) || errMsg(ownerErr));
      }
    }

    return mergeEvents(sharedEvents, legacyEvents.map(ev => ({
      ...ev,
      calendarId: ev.calendarId || SHARED_CALENDAR_ID,
      calendarName: ev.calendarName || SHARED_CALENDAR_NAME,
      sharedWith: ev.sharedWith?.length ? ev.sharedWith : SHARED_EMAILS.slice(),
    })));
  },

  async upsertEvent(data){
    allowedOrThrow();
    await ensureSharedCalendarDoc();

    const item = normalizeEventInput(data);

    if(!item.title) throw new Error('Titulo vacio: necesito un nombre para el evento.');
    if(!item.start || item.startMs === null) throw new Error('Inicio invalido: necesito fecha y hora de inicio.');
    if(item.end && item.endMs !== null && item.endMs < item.startMs){
      throw new Error('La fecha final no puede ser antes del inicio.');
    }
    if(!item.ownerUid){
      throw new Error('No hay usuario en contexto. Inicia sesion antes de guardar.');
    }

    const payload = {
      title: item.title,
      start: item.start,
      end: item.end || null,
      startMs: item.startMs,
      endMs: item.endMs ?? null,
      category: item.category,
      priority: item.priority,
      notes: item.notes || '',
      repeat: item.repeat || null,
      reminders: item.reminders.length ? item.reminders : [],
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      calendarId: item.calendarId,
      calendarName: item.calendarName,
      sharedWith: item.sharedWith,
      ownerUid: item.ownerUid,
      ownerEmail: item.ownerEmail || null,
      updatedByUid: item.updatedByUid,
      updatedByEmail: item.updatedByEmail,
      updatedAtServer: serverTimestamp(),
    };

    try{
      if(!item.id){
        payload.createdAtServer = serverTimestamp();
        const ref = await addDoc(collection(db, COL_EVENTS), payload);
        return { ...item, id: ref.id };
      }

      await setDoc(doc(db, COL_EVENTS, item.id), payload, { merge: true });
      return item;
    }catch(err){
      throw new Error(explainFirestoreErr(err) || errMsg(err, 'No se pudo guardar el evento.'));
    }
  },

  async deleteEvent(id){
    allowedOrThrow();

    const safeId = normStr(id, 200);
    if(!safeId) return true;

    try{
      await deleteDoc(doc(db, COL_EVENTS, safeId));
      return true;
    }catch(err){
      throw new Error(explainFirestoreErr(err) || errMsg(err, 'No se pudo borrar el evento.'));
    }
  },

  async getSettings(opts = {}){
    const uid = normStr(opts.uid, 128) || ctx.uid || '';
    if(!uid) return mergeWithDefaults({});
    allowedOrThrow();
    await ensureSharedCalendarDoc();

    try{
      const sharedSnap = await getDoc(sharedSettingsDocRef());
      if(sharedSnap.exists()) return mergeWithDefaults(sharedSnap.data());

      // Primer arranque despues del cambio: si el usuario actual tenia configuracion vieja,
      // la copiamos como configuracion compartida.
      try{
        const legacySnap = await getDoc(legacySettingsDocRef(uid));
        if(legacySnap.exists()){
          const migrated = mergeWithDefaults(legacySnap.data());
          await this.saveSettings(migrated, { uid });
          return migrated;
        }
      }catch(legacyErr){
        console.warn('[dbApi.getSettings legacy]', explainFirestoreErr(legacyErr) || errMsg(legacyErr));
      }

      return mergeWithDefaults({});
    }catch(err){
      console.warn('[dbApi.getSettings]', explainFirestoreErr(err) || errMsg(err));
      return mergeWithDefaults({});
    }
  },

  async saveSettings(settings, opts = {}){
    const uid = normStr(opts.uid, 128) || ctx.uid || '';
    if(!uid) throw new Error('No hay usuario en contexto. Inicia sesion antes de guardar configuracion.');
    allowedOrThrow();
    await ensureSharedCalendarDoc();

    const clean = normalizeSettings(settings || {});
    const payload = {
      ...clean,
      calendarId: SHARED_CALENDAR_ID,
      calendarName: SHARED_CALENDAR_NAME,
      sharedWith: SHARED_EMAILS.slice(),
      ownerUid: uid,
      ownerEmail: ctx.email || null,
      updatedByUid: ctx.uid || null,
      updatedByEmail: ctx.email || null,
      updatedAt: nowMs(),
      updatedAtServer: serverTimestamp(),
    };

    try{
      await setDoc(sharedSettingsDocRef(), payload, { merge: true });
      return mergeWithDefaults(clean);
    }catch(err){
      throw new Error(explainFirestoreErr(err) || errMsg(err, 'No se pudo guardar la configuracion.'));
    }
  },

  async ping(){
    allowedOrThrow();
    try{
      const qRef = query(collection(db, COL_EVENTS), where('calendarId', '==', SHARED_CALENDAR_ID));
      await getDocs(qRef);
      return true;
    }catch(err){
      throw new Error(explainFirestoreErr(err) || errMsg(err, 'No pude leer Firestore.'));
    }
  },
};
