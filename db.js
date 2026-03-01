// db.js — Firestore implementation (colección: events)
// Mantiene API compatible con UI:
//   - listEvents(opts?)
//   - upsertEvent(data)
//   - deleteEvent(id)
// Extra opcional:
//   - setContext({ uid, email })
//   - ping()
//
// Mejoras:
// ✅ Nunca hace "list all" si no hay uid (evita romper por Rules)
// ✅ Fallback inteligente si orderBy("start") falla (docs viejos) pero respetando uid
// ✅ Normalización consistente (ISO) + validaciones claras
// ✅ Payload mínimo, merge seguro, auditoría serverTimestamp
// ✅ Mensajes de error más útiles

'use strict';

import { db } from './firebase.js';

import {
  collection,
  getDocs,
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

const COL = 'events';

const DEFAULTS = {
  category: 'personal',
  priority: 'normal',
};

let ctx = {
  uid: null,
  email: null,
};

function normStr(v, max = 4000) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  return s.length > max ? s.slice(0, max) : s;
}

function normISO(v) {
  if (!v) return null;
  try {
    const d = (v instanceof Date) ? v : new Date(v);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
  } catch {
    return null;
  }
}

function nowMs() { return Date.now(); }

function normalizeEventInput(data = {}) {
  const startIso = normISO(data.start);
  const endIso = normISO(data.end);

  const createdAt = Number(data.createdAt) || nowMs();
  const updatedAt = nowMs();

  const ownerUid = normStr(data.ownerUid, 128) || (ctx.uid || '');
  const ownerEmail = normStr(data.ownerEmail, 180) || (ctx.email || '');

  return {
    id: data.id || null,
    title: normStr(data.title, 180),
    start: startIso,
    end: endIso,
    category: normStr(data.category, 50) || DEFAULTS.category,
    priority: normStr(data.priority, 20) || DEFAULTS.priority,
    notes: normStr(data.notes, 4000),

    createdAt,
    updatedAt,

    ownerUid,
    ownerEmail,
  };
}

function normalizeEventFromDb(id, raw) {
  return {
    id,
    title: normStr(raw?.title, 180),
    start: normISO(raw?.start),
    end: normISO(raw?.end),
    category: normStr(raw?.category, 50) || DEFAULTS.category,
    priority: normStr(raw?.priority, 20) || DEFAULTS.priority,
    notes: normStr(raw?.notes, 4000),

    createdAt: Number(raw?.createdAt) || nowMs(),
    updatedAt: Number(raw?.updatedAt) || nowMs(),

    ownerUid: normStr(raw?.ownerUid, 128) || '',
    ownerEmail: normStr(raw?.ownerEmail, 180) || '',
  };
}

function errMsg(e, fallback = 'Firestore se puso dramático y no explicó nada.') {
  const msg = e?.message ? String(e.message) : fallback;
  return msg || fallback;
}

function explainFirestoreErr(e) {
  const m = String(e?.message || '');
  if (m.includes('Missing or insufficient permissions')) {
    return 'Permisos insuficientes en Firestore (Rules). Si estás filtrando por ownerUid y aún falla, revisa allowlist/claims 🔒';
  }
  if (m.includes('failed-precondition') && m.toLowerCase().includes('index')) {
    return 'Falta un índice en Firestore para esta query (te lo pide en consola).';
  }
  return null;
}

async function safeListQuery(qRef, fallbackQRef) {
  try {
    const snap = await getDocs(qRef);
    return snap.docs.map(d => normalizeEventFromDb(d.id, d.data()));
  } catch (e) {
    // Fallback: intenta sin orderBy si hay docs viejos, PERO mantén el filtro de uid
    if (!fallbackQRef) {
      const friendly = explainFirestoreErr(e);
      throw new Error(friendly || errMsg(e));
    }

    try {
      const snap = await getDocs(fallbackQRef);
      const list = snap.docs.map(d => normalizeEventFromDb(d.id, d.data()));
      // Orden local por start (si no existe, queda al final)
      list.sort((a, b) => (a.start || '9999').localeCompare(b.start || '9999'));
      return list;
    } catch (e2) {
      const friendly = explainFirestoreErr(e2);
      throw new Error(friendly || errMsg(e2));
    }
  }
}

export const dbApi = {
  // Extra opcional: setContext
  setContext({ uid = null, email = null } = {}) {
    ctx.uid = uid ? String(uid) : null;
    ctx.email = email ? String(email) : null;
  },

  async listEvents(opts = {}) {
    // Regla de oro: en prod NO listamos "todo". Eso rompe Rules y es mala práctica.
    const uid = normStr(opts.uid, 128) || ctx.uid || '';
    if (!uid) {
      // Silencioso y seguro: sin uid => sin eventos.
      // Si quieres que sea más ruidoso, cambia a: throw new Error(...)
      return [];
    }

    const base = collection(db, COL);

    // Query normal (ordenada)
    const qOrdered = query(
      base,
      where('ownerUid', '==', uid),
      orderBy('start', 'asc')
    );

    // Fallback sin orderBy (si start falta en docs viejos)
    const qUnordered = query(
      base,
      where('ownerUid', '==', uid)
    );

    return await safeListQuery(qOrdered, qUnordered);
  },

  async upsertEvent(data) {
    const item = normalizeEventInput(data);

    // Validaciones
    if (!item.title) throw new Error('Título vacío: no voy a guardar un evento fantasma 👻');
    if (!item.start) throw new Error('Inicio inválido: necesito fecha/hora de inicio.');
    if (item.end && item.end < item.start) throw new Error('La fecha fin no puede ser antes del inicio.');

    // Si no hay ownerUid, en un sistema con Rules por usuario te vas a pegar un tiro en el pie.
    // Mejor fallar claro.
    if (!item.ownerUid) {
      throw new Error('No hay usuario (uid) en contexto. Inicia sesión antes de guardar.');
    }

    const payload = {
      title: item.title,
      start: item.start,
      end: item.end,
      category: item.category,
      priority: item.priority,
      notes: item.notes,

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
        const ref = await addDoc(collection(db, COL), payload);
        return { ...item, id: ref.id };
      }

      // UPDATE (merge seguro)
      await setDoc(doc(db, COL, item.id), payload, { merge: true });
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
      await deleteDoc(doc(db, COL, safeId));
      return true;
    } catch (e) {
      const friendly = explainFirestoreErr(e);
      throw new Error(friendly || errMsg(e, 'No se pudo borrar el evento.'));
    }
  },

  async ping() {
    // Ping simple: intenta leer 1 doc de la colección.
    // No fuerza uid porque esto suele ser para debug de conexión/rules generales,
    // pero en reglas estrictas también puede fallar. Está bien: te dirá por qué.
    try {
      const qRef = query(collection(db, COL), limit(1));
      await getDocs(qRef);
      return true;
    } catch (e) {
      const friendly = explainFirestoreErr(e);
      throw new Error(friendly || errMsg(e, 'No pude leer Firestore (rules o config).'));
    }
  },
};