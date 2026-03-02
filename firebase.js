// firebase.js
// Firebase wiring (Auth + Firestore) — Vanilla modules (CDN, sin bundler)
//
// ✅ Seguro contra doble inicialización
// ✅ Funciona en GitHub Pages / HTML estático
// ✅ Exporta instancias reales (app/auth/db)
// ✅ Mensajes de debug útiles (Authorized domains / config)
// ✅ Hook opcional para persistence (comentado)

'use strict';

import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  getFirestore,
  // enableIndexedDbPersistence, // <- opcional (offline)
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

// Config real del proyecto
const firebaseConfig = {
  apiKey: "AIzaSyDGnvF4Y5S7hA-Sp_DMhc0EH3SnVNYYA1w",
  authDomain: "calendario-morchis-2026.firebaseapp.com",
  projectId: "calendario-morchis-2026",
  storageBucket: "calendario-morchis-2026.firebasestorage.app",
  messagingSenderId: "443973005696",
  appId: "1:443973005696:web:57f0ea7e9a95e4e137d165",
};

// Exports "vivos"
export let app = null;
export let auth = null;
export let db = null;

let _initialized = false;
let _initPromise = null;

function assertConfig(cfg){
  if(!cfg || typeof cfg !== 'object') throw new Error('firebaseConfig inválido.');
  const need = ['apiKey','authDomain','projectId','appId'];
  for(const k of need){
    if(!String(cfg[k] || '').trim()){
      throw new Error(`firebaseConfig incompleto: falta "${k}".`);
    }
  }
}

function warnIfLikelyUnauthorizedDomain(){
  // Esto NO verifica en Firebase (no podemos desde acá).
  // Solo evita perder 40 minutos por olvidar agregar github.io.
  try{
    const host = window.location.hostname || '';
    if(!host) return;

    const isGitHubPages = host.endsWith('github.io');
    const isLocal = host === 'localhost' || host === '127.0.0.1';

    if(isGitHubPages){
      console.warn(
        '[Firebase] Si el login falla con "unauthorized-domain", agrega tu dominio en Firebase Auth > Settings > Authorized domains:',
        host
      );
    }
    if(isLocal){
      // Local casi siempre está ok, pero igual sirve saberlo.
      // Nada que hacer.
    }
  }catch{}
}

async function _init(){
  if(_initialized && app && auth && db) return { app, auth, db };

  assertConfig(firebaseConfig);
  warnIfLikelyUnauthorizedDomain();

  // Si ya existe una app (hot reload / múltiples cargas), reutiliza
  const apps = getApps();
  app = apps.length ? apps[0] : initializeApp(firebaseConfig);

  auth = getAuth(app);
  db = getFirestore(app);

  // Opcional: persistence (offline). No lo activo por defecto porque:
  // - puede generar errores si hay múltiples tabs
  // - y tú no pediste PWA/offline aquí
  //
  // try {
  //   await enableIndexedDbPersistence(db);
  // } catch (e) {
  //   // failed-precondition (múltiples tabs), unimplemented (navegador raro)
  //   console.warn('[Firestore persistence] no disponible:', e?.code || e?.message || e);
  // }

  _initialized = true;
  return { app, auth, db };
}

export function initFirebase(){
  // idempotente + safe en concurrent init
  if(_initialized && app && auth && db) return { app, auth, db };
  if(_initPromise) return _initPromise;

  _initPromise = _init()
    .catch((e) => {
      // si falla, dejamos estado limpio para reintento
      _initialized = false;
      app = null; auth = null; db = null;
      _initPromise = null;

      console.error('[Firebase init error]', e);
      throw e;
    })
    .finally(() => {
      // si ya inicializó bien, no necesitas mantener promise viva
      if(_initialized) _initPromise = null;
    });

  return _initPromise;
}

// Utilidad para debug rápido
export function isFirebaseReady(){
  return !!(app && auth && db);
}

// Helper útil cuando algo falla y quieres saber "en qué host estoy corriendo"
export function getRuntimeInfo(){
  try{
    return {
      host: window.location.hostname,
      origin: window.location.origin,
      protocol: window.location.protocol,
      userAgent: navigator.userAgent,
      firebaseProjectId: firebaseConfig.projectId,
    };
  }catch{
    return { firebaseProjectId: firebaseConfig.projectId };
  }
}