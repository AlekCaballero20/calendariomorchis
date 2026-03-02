// db.js — Firestore implementation (Eventos + Settings por usuario)
//
// Colecciones:
//   - events
//   - users/{uid}/settings (doc: "main")
//
// API (compatible):
//   - listEvents(opts?)
//   - upsertEvent(data)
//   - deleteEvent(id)
// Extras:
//   - setContext({ uid, email })
//   - ping()
// Settings (⚙️):
//   - getSettings(opts?)
//   - saveSettings(settings, opts?)
//
// Mejoras clave:
// ✅ Nunca hace "list all" sin uid
// ✅ Query principal ordena por startMs (estable) + fallback si no hay índice
// ✅ Guarda start ISO + startMs (y end ISO + endMs) para compatibilidad y orden
// ✅ Normalización consistente + payload mínimo
// ✅ Settings por usuario con defaults + merge seguro
// ✅ Mensajes de error útiles

import { db } from './firebase.js';

import {
  collection,
  getDocs,
  getDoc,
  addDoc,
  doc,
  setDoc,
  deleteDoc,
  query,
  orderBy,
  where,
  serverTimestamp,
  limit,
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';

const COL_EVENTS = 'events';

// users/{uid}/settings/main
const COL_USERS = 'users';
const SUB_SETTINGS = 'settings';
const SETTINGS_DOC_ID = 'main';

const DEFAULTS = {
  category: 'personal',
  priority: 'normal',
};

const DEFAULT_SETTINGS = {
  holidaysCO: 'on',         // on/off
  emailDigest: 'on',        // on/off
  emailDigestTime: '07:00', // HH:mm
  // categories: { key: {label}, ... } // opcional
};

let ctx = {
  uid: null,
  email: null,
};

// -------------------- helpers --------------------

const normEmail = (v) => String(v || '').trim().toLowerCase();

function normStr(v, max = 4000) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  return s.length > max ? s.slice(0, max) : s;
}

function isFiniteNum(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

function toDate(v) {
  if (!v) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;

  // Firestore Timestamp support (si lo llegan a meter algún día)
  if (typeof v === 'object' && typeof v.toDate === 'function') {
    try {
      const d = v.toDate();
      return Number.isNaN(d.getTime()) ? null : d;
    } catch {
      return null;
    }
  }

  try {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

function normISO(v) {
  const d = toDate(v);
  return d ? d.toISOString() : null;
}

function normMs(v) {
  // acepta number ms o fecha/ISO/timestamp
  if (isFiniteNum(v)) return Math.floor(v);
  const d = toDate(v);
  return d ? d.getTime() : null;
}

function nowMs() { return Date.now(); }

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  const v = Math.floor(x);
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

function normalizeRepeat(r) {
  // {freq:'daily|weekly|monthly|yearly', interval:int}
  if (!r || typeof r !== 'object') return null;
  const freq = normStr(r.freq, 16).toLowerCase();
  const allowed = new Set(['daily','weekly','monthly','yearly']);
  if (!allowed.has(freq)) return null;

  const interval = clampInt(r.interval, 1, 365, 1);
  return { freq, interval };
}

function normalizeReminders(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const v of arr) {
    const n = clampInt(v, 0, 43200, null); // hasta 30 días
    if (n === null) continue;
    out.push(n);
  }
  // únicos + orden asc
  const uniq = Array.from(new Set(out)).sort((a, b) => a - b);
  return uniq.slice(0, 8);
}

function normalizeEventInput(data = {}) {
  const startIso = normISO(data.start);
  const endIso = normISO(data.end);

  const startMs = normMs(data.startMs ?? data.start);
  const endMs = normMs(data.endMs ?? data.end);

  const createdAt = isFiniteNum(Number(data.createdAt)) ? Number(data.createdAt) : nowMs();
  const updatedAt = nowMs();

  const ownerUid = normStr(data.ownerUid, 128) || (ctx.uid || '');
  const ownerEmail = normStr(data.ownerEmail, 180) || (ctx.email || '');

  const repeat = normalizeRepeat(data.repeat);
  const reminders = normalizeReminders(data.reminders);

  return {
    id: data.id || null,
    title: normStr(data.title, 180),
    start: startIso,
    end: endIso,
    startMs,
    endMs,

    category: normStr(data.category, 50) || DEFAULTS.category,
    priority: normStr(data.priority, 20) || DEFAULTS.priority,
    notes: normStr(data.notes, 4000),

    repeat,          // null o {freq, interval}
    reminders,       // [] o [min...]

    createdAt,
    updatedAt,

    ownerUid,
    ownerEmail,
  };
}

function normalizeEventFromDb(id, raw) {
  const title = normStr(raw?.title, 180);
  const start = normISO(raw?.start);
  const end = normISO(raw?.end);

  // Preferimos startMs si está, si no lo inferimos de start ISO
  const startMs = normMs(raw?.startMs ?? raw?.start);
  const endMs = normMs(raw?.endMs ?? raw?.end);

  const repeat = normalizeRepeat(raw?.repeat);
  const reminders = normalizeReminders(raw?.reminders);

  const out = {
    id,
    title,
    start,
    end,
    category: normStr(raw?.category, 50) || DEFAULTS.category,
    priority: normStr(raw?.priority, 20) || DEFAULTS.priority,
    notes: normStr(raw?.notes, 4000),

    createdAt: isFiniteNum(Number(raw?.createdAt)) ? Number(raw?.createdAt) : nowMs(),
    updatedAt: isFiniteNum(Number(raw?.updatedAt)) ? Number(raw?.updatedAt) : nowMs(),

    ownerUid: normStr(raw?.ownerUid, 128) || '',
    ownerEmail: normStr(raw?.ownerEmail, 180) || '',
  };

  // Mantener compatibilidad: solo agregamos extras si existen/son útiles
  if (repeat) out.repeat = repeat;
  if (reminders.length) out.reminders = reminders;

  // startMs/endMs ayudan a ordenar localmente y a futuro a filtrar
  if (startMs !== null) out.startMs = startMs;
  if (endMs !== null) out.endMs = endMs;

  return out;
}

function errMsg(e, fallback = 'Firestore se puso dramático y no explicó nada.') {
  const msg = e?.message ? String(e.message) : fallback;
  return msg || fallback;
}

function explainFirestoreErr(e) {
  const code = String(e?.code || '');
  const msg = String(e?.message || '');
  const lower = msg.toLowerCase();

  if (msg.includes('Missing or insufficient permissions') || code === 'permission-denied') {
    return 'Permisos insuficientes en Firestore (Rules). Revisa que tus reglas permitan ownerUid == uid y settings del usuario 🔒';
  }
  if ((lower.includes('failed-precondition') && lower.includes('index')) || code === 'failed-precondition') {
    return 'Falta un índice en Firestore para esta consulta (la consola te da el link para crearlo).';
  }
  if (code === 'unavailable' || lower.includes('network')) {
    return 'Firestore no está disponible (red/servicio). Revisa conexión e intenta de nuevo.';
  }
  return null;
}

function shouldTryFallback(e) {
  const code = String(e?.code || '');
  const msg = String(e?.message || '').toLowerCase();
  // Si es falta de índice o precondition, el fallback sin orderBy puede salvar.
  return code === 'failed-precondition' || msg.includes('index') || msg.includes('failed-precondition');
}

async function runQueryWithOptionalFallback(primaryQ, fallbackQ) {
  try {
    const snap = await getDocs(primaryQ);
    return snap.docs.map(d => normalizeEventFromDb(d.id, d.data()));
  } catch (e) {
    if (!fallbackQ || !shouldTryFallback(e)) {
      const friendly = explainFirestoreErr(e);
      throw new Error(friendly || errMsg(e));
    }
    try {
      const snap2 = await getDocs(fallbackQ);
      const list = snap2.docs.map(d => normalizeEventFromDb(d.id, d.data()));
      // Orden local por startMs si existe, si no por start ISO
      list.sort((a, b) => {
        const am = isFiniteNum(a.startMs) ? a.startMs : Number.POSITIVE_INFINITY;
        const bm = isFiniteNum(b.startMs) ? b.startMs : Number.POSITIVE_INFINITY;
        if (am !== bm) return am - bm;
        return String(a.start || '9999').localeCompare(String(b.start || '9999'));
      });
      return list;
    } catch (e2) {
      const friendly = explainFirestoreErr(e2);
      throw new Error(friendly || errMsg(e2));
    }
  }
}

function normalizeSettingsInput(s = {}) {
  const holidaysCOVal = String(s.holidaysCO || DEFAULT_SETTINGS.holidaysCO);
  const holidaysCO = (holidaysCOVal === 'off') ? 'off' : 'on';

  const emailDigestVal = String(s.emailDigest || DEFAULT_SETTINGS.emailDigest);
  const emailDigest = (emailDigestVal === 'off') ? 'off' : 'on';

  const time = normStr(s.emailDigestTime, 10) || DEFAULT_SETTINGS.emailDigestTime;
  const timeOk = /^\d{2}:\d{2}$/.test(time);
  const emailDigestTime = timeOk ? time : DEFAULT_SETTINGS.emailDigestTime;

  // categories opcional: { key: {label} }
  let categories = null;
  if (s.categories && typeof s.categories === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(s.categories)) {
      const key = normStr(k, 50);
      if (!key) continue;
      const label = normStr(v?.label ?? key, 60) || key;
      out[key] = { label };
    }
    if (Object.keys(out).length) categories = out;
  }

  const res = { holidaysCO, emailDigest, emailDigestTime };
  if (categories) res.categories = categories;
  return res;
}

function normalizeSettingsFromDb(raw) {
  return normalizeSettingsInput(raw || {});
}

function settingsDocRef(uid) {
  return doc(db, COL_USERS, uid, SUB_SETTINGS, SETTINGS_DOC_ID);
}

// -------------------- API --------------------

export const dbApi = {
  setContext({ uid = null, email = null } = {}) {
    ctx.uid = uid ? String(uid) : null;
    ctx.email = email ? normEmail(email) : null;
  },

  async listEvents(opts = {}) {
    const uid = normStr(opts.uid, 128) || ctx.uid || '';
    if (!uid) return [];

    const base = collection(db, COL_EVENTS);

    // Query preferida: estable y rápida
    // (requiere índice compuesto ownerUid + startMs)
    const qOrdered = query(
      base,
      where('ownerUid', '==', uid),
      orderBy('startMs', 'asc')
    );

    // Fallback: sin orderBy (si falta índice o docs viejos)
    const qUnordered = query(
      base,
      where('ownerUid', '==', uid)
    );

    return await runQueryWithOptionalFallback(qOrdered, qUnordered);
  },

  async upsertEvent(data) {
    const item = normalizeEventInput(data);

    // Validaciones
    if (!item.title) throw new Error('Título vacío: no voy a guardar un evento fantasma 👻');
    if (!item.start || item.startMs === null) throw new Error('Inicio inválido: necesito fecha/hora de inicio.');
    if (item.end && item.endMs !== null && item.endMs < item.startMs) {
      throw new Error('La fecha fin no puede ser antes del inicio.');
    }

    if (!item.ownerUid) {
      throw new Error('No hay usuario (uid) en contexto. Inicia sesión antes de guardar.');
    }

    // Payload mínimo, con compatibilidad:
    // - start/end ISO (como ya lo usa UI)
    // - startMs/endMs para orden/queries
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

    try {
      // CREATE
      if (!item.id) {
        payload.createdAtServer = serverTimestamp();
        const ref = await addDoc(collection(db, COL_EVENTS), payload);
        return { ...item, id: ref.id };
      }

      // UPDATE (merge seguro)
      await setDoc(doc(db, COL_EVENTS, item.id), payload, { merge: true });
      return item;

    } catch (e) {
      const friendly = explainFirestoreErr(e);
      throw new Error(friendly || errMsg(e, 'No se pudo guardar el evento.'));
    }
  },

  async deleteEvent(id) {
    const safeId = normStr(id, 200);
    if (!safeId) return true;

    try {
      await deleteDoc(doc(db, COL_EVENTS, safeId));
      return true;
    } catch (e) {
      const friendly = explainFirestoreErr(e);
      throw new Error(friendly || errMsg(e, 'No se pudo borrar el evento.'));
    }
  },

  async getSettings(opts = {}) {
    const uid = normStr(opts.uid, 128) || ctx.uid || '';
    if (!uid) return { ...DEFAULT_SETTINGS };

    try {
      const ref = settingsDocRef(uid);
      const snap = await getDoc(ref);
      if (!snap.exists()) return { ...DEFAULT_SETTINGS };
      return normalizeSettingsFromDb(snap.data());
    } catch (e) {
      const friendly = explainFirestoreErr(e);
      console.warn('[dbApi.getSettings]', friendly || errMsg(e));
      return { ...DEFAULT_SETTINGS };
    }
  },

  async saveSettings(settings, opts = {}) {
    const uid = normStr(opts.uid, 128) || ctx.uid || '';
    if (!uid) throw new Error('No hay usuario (uid) en contexto. Inicia sesión antes de guardar configuración.');

    const clean = normalizeSettingsInput(settings || {});
    const payload = {
      ...clean,
      ownerUid: uid,
      ownerEmail: ctx.email || null,

      updatedAt: nowMs(),
      updatedAtServer: serverTimestamp(),
    };

    try {
      const ref = settingsDocRef(uid);
      await setDoc(ref, payload, { merge: true });
      return clean;
    } catch (e) {
      const friendly = explainFirestoreErr(e);
      throw new Error(friendly || errMsg(e, 'No se pudo guardar la configuración.'));
    }
  },

  async ping() {
    try {
      // Ping simple: intenta leer 1 doc de events.
      // En rules estrictas puede fallar. Eso también es información útil.
      const qRef = query(collection(db, COL_EVENTS), limit(1));
      await getDocs(qRef);
      return true;
    } catch (e) {
      const friendly = explainFirestoreErr(e);
      throw new Error(friendly || errMsg(e, 'No pude leer Firestore (rules o config).'));
    }
  },
};