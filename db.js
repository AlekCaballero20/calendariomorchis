// db.js - Firestore implementation (events + per-user settings)

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
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  where,
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';

const COL_EVENTS = 'events';
const COL_USERS = 'users';
const SUB_SETTINGS = 'settings';
const SETTINGS_DOC_ID = 'main';

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
    ownerUid: normStr(data.ownerUid, 128) || (ctx.uid || ''),
    ownerEmail: normStr(data.ownerEmail, 180) || (ctx.email || ''),
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
    ownerUid: normStr(raw?.ownerUid, 128),
    ownerEmail: normStr(raw?.ownerEmail, 180),
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

function errMsg(err, fallback = 'Firestore no explico el error.'){
  const msg = String(err?.message || '').trim();
  return msg || fallback;
}

function explainFirestoreErr(err){
  const code = String(err?.code || '');
  const msg = String(err?.message || '');
  const lower = msg.toLowerCase();

  if(msg.includes('Missing or insufficient permissions') || code === 'permission-denied'){
    return 'Permisos insuficientes en Firestore. Revisa Rules y la allowlist.';
  }
  if((lower.includes('failed-precondition') && lower.includes('index')) || code === 'failed-precondition'){
    return 'Falta un indice en Firestore para esa consulta.';
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

async function runQueryWithOptionalFallback(primaryQuery, fallbackQuery){
  try{
    const snap = await getDocs(primaryQuery);
    return snap.docs.map(d => normalizeEventFromDb(d.id, d.data()));
  }catch(err){
    if(!fallbackQuery || !shouldTryFallback(err)){
      throw new Error(explainFirestoreErr(err) || errMsg(err));
    }

    try{
      const snap = await getDocs(fallbackQuery);
      const list = snap.docs.map(d => normalizeEventFromDb(d.id, d.data()));
      list.sort((a, b) => {
        const aMs = isFiniteNum(a.startMs) ? a.startMs : Number.POSITIVE_INFINITY;
        const bMs = isFiniteNum(b.startMs) ? b.startMs : Number.POSITIVE_INFINITY;
        if(aMs !== bMs) return aMs - bMs;
        return String(a.start || '9999').localeCompare(String(b.start || '9999'));
      });
      return list;
    }catch(fallbackErr){
      throw new Error(explainFirestoreErr(fallbackErr) || errMsg(fallbackErr));
    }
  }
}

function settingsDocRef(uid){
  return doc(db, COL_USERS, uid, SUB_SETTINGS, SETTINGS_DOC_ID);
}

export const dbApi = {
  setContext({ uid = null, email = null } = {}){
    ctx.uid = uid ? String(uid) : null;
    ctx.email = email ? normEmail(email) : null;
  },

  async listEvents(opts = {}){
    const uid = normStr(opts.uid, 128) || ctx.uid || '';
    if(!uid) return [];

    const base = collection(db, COL_EVENTS);
    const orderedQuery = query(
      base,
      where('ownerUid', '==', uid),
      orderBy('startMs', 'asc')
    );
    const fallbackQuery = query(
      base,
      where('ownerUid', '==', uid)
    );

    return runQueryWithOptionalFallback(orderedQuery, fallbackQuery);
  },

  async upsertEvent(data){
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
      ownerUid: item.ownerUid,
      ownerEmail: item.ownerEmail || null,
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

    try{
      const snap = await getDoc(settingsDocRef(uid));
      if(!snap.exists()) return mergeWithDefaults({});
      return mergeWithDefaults(snap.data());
    }catch(err){
      console.warn('[dbApi.getSettings]', explainFirestoreErr(err) || errMsg(err));
      return mergeWithDefaults({});
    }
  },

  async saveSettings(settings, opts = {}){
    const uid = normStr(opts.uid, 128) || ctx.uid || '';
    if(!uid) throw new Error('No hay usuario en contexto. Inicia sesion antes de guardar configuracion.');

    const clean = normalizeSettings(settings || {});
    const payload = {
      ...clean,
      ownerUid: uid,
      ownerEmail: ctx.email || null,
      updatedAt: nowMs(),
      updatedAtServer: serverTimestamp(),
    };

    try{
      await setDoc(settingsDocRef(uid), payload, { merge: true });
      return mergeWithDefaults(clean);
    }catch(err){
      throw new Error(explainFirestoreErr(err) || errMsg(err, 'No se pudo guardar la configuracion.'));
    }
  },

  async ping(){
    try{
      const qRef = query(collection(db, COL_EVENTS), limit(1));
      await getDocs(qRef);
      return true;
    }catch(err){
      throw new Error(explainFirestoreErr(err) || errMsg(err, 'No pude leer Firestore.'));
    }
  },
};
