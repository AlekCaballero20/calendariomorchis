// firebase.js
// Firebase wiring (Auth + Firestore) — Vanilla modules (CDN, sin bundler)
// ✅ Sin Proxy (Firebase necesita instancias reales)
// ✅ Seguro contra doble inicialización
// ✅ Funciona en GitHub Pages / HTML estático
// ✅ Devuelve instancias reales, no objetos envueltos

'use strict';

import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

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

export function initFirebase() {
  if (_initialized && app && auth && db) {
    return { app, auth, db };
  }

  // Si ya existe una app (hot reload / múltiples cargas), reutiliza
  const apps = getApps();
  app = apps.length ? apps[0] : initializeApp(firebaseConfig);

  auth = getAuth(app);
  db = getFirestore(app);

  _initialized = true;

  return { app, auth, db };
}

// Opcional: utilidad para debug rápido
export function isFirebaseReady() {
  return !!(app && auth && db);
}