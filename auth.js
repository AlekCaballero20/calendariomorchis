// auth.js — Firebase Auth API (Email/Pass + Google)
// Exporta authApi como espera app.js

import { initFirebase, auth } from './firebase.js';

import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

/**
 * ALLOWLIST:
 * - Si está vacía => no bloquea (modo “no me fastidies con config”)
 * - Si tiene '*' => permite todo
 * - Si tiene correos => solo esos
 */
const ALLOWLIST = new Set([
  // Ej:
  // "alek@gmail.com",
  // "cata@gmail.com",
  // "*",
]);

const normEmail = (email) => String(email || '').trim().toLowerCase();

function isAllowed(email){
  if(!ALLOWLIST.size) return true;
  if(ALLOWLIST.has('*')) return true;
  return ALLOWLIST.has(normEmail(email));
}

function niceAuthError(err){
  const code = err?.code || '';
  // Mensajes “humanos”, porque Firebase ama el drama.
  switch(code){
    case 'auth/invalid-credential': return "Correo o contraseña incorrectos.";
    case 'auth/user-not-found': return "Ese usuario no existe.";
    case 'auth/wrong-password': return "Contraseña incorrecta.";
    case 'auth/too-many-requests': return "Demasiados intentos. Espera un poquito y vuelve a intentar.";
    case 'auth/popup-blocked': return "El navegador bloqueó el popup de Google. (Permite popups o intenta de nuevo).";
    case 'auth/popup-closed-by-user': return "Cerraste el popup de Google.";
    case 'auth/unauthorized-domain': return "Dominio no autorizado en Firebase (Authorized domains).";
    case 'auth/cancelled-popup-request': return "Se canceló el popup anterior (típico cuando se le da doble click).";
    case 'auth/network-request-failed': return "Falló la red. Revisa internet y vuelve a intentar.";
    case 'auth/operation-not-allowed': return "Método de login no habilitado en Firebase (Auth > Sign-in method).";
    default:
      return (String(err?.message || '').trim()) || "Falló el login. Porque el universo quiso.";
  }
}

export const authApi = (() => {
  let cbs = {
    onSignedIn: () => {},
    onSignedOut: () => {},
    onAuthError: () => {},
  };

  let inited = false;
  let unsubAuth = null;

  async function enforceAllowlistOrSignOut(user){
    const email = user?.email || '';
    if(!isAllowed(email)){
      try{ await signOut(auth); }catch{}
      throw new Error("Acceso restringido. Ese correo no está en la lista 🔒");
    }
    return true;
  }

  async function finishRedirectIfAny(){
    // getRedirectResult:
    // - Si no hubo redirect, normalmente retorna null (o puede lanzar según entorno).
    // - No queremos “alertas” porque sí.
    try{
      const res = await getRedirectResult(auth);
      // Si res existe, onAuthStateChanged manejará el estado igual.
      return res || null;
    }catch(e){
      // Solo reportamos errores reales útiles.
      const code = e?.code || '';
      if(code && code !== 'auth/no-auth-event'){
        cbs.onAuthError(niceAuthError(e));
      }
      return null;
    }
  }

  function init(callbacks = {}){
    cbs = { ...cbs, ...callbacks };
    initFirebase();

    // Evita doble init (que duplica listeners y luego todo se siente “poseído”)
    if(inited) return;
    inited = true;

    // Completa flujos de redirect si existen
    void finishRedirectIfAny();

    // Listener único
    unsubAuth = onAuthStateChanged(auth, async (user) => {
      if(!user){
        cbs.onSignedOut();
        return;
      }

      try{
        await enforceAllowlistOrSignOut(user);
        cbs.onSignedIn(user);
      }catch(e){
        cbs.onAuthError(niceAuthError(e));
        cbs.onSignedOut();
      }
    });
  }

  async function signInEmail(email, password){
    try{
      const em = normEmail(email);
      const cred = await signInWithEmailAndPassword(auth, em, password);
      const user = cred.user;

      await enforceAllowlistOrSignOut(user);
      return user;
    }catch(e){
      throw new Error(niceAuthError(e));
    }
  }

  async function signInGoogle(){
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });

    try{
      // Intento 1: popup
      try{
        const cred = await signInWithPopup(auth, provider);
        const user = cred.user;

        await enforceAllowlistOrSignOut(user);
        return user;
      }catch(e){
        // Fallback: redirect (móvil/webview/popup bloqueado)
        const code = e?.code || '';
        if(
          code === 'auth/popup-blocked' ||
          code === 'auth/operation-not-supported-in-this-environment'
        ){
          await signInWithRedirect(auth, provider);
          return null; // onAuthStateChanged se encargará al volver
        }
        throw e;
      }
    }catch(e){
      throw new Error(niceAuthError(e));
    }
  }

  async function signOutNow(){
    try{
      await signOut(auth);
    }catch(e){
      throw new Error(niceAuthError(e));
    }
  }

  // Por si algún día quieres “desmontar” (tests, hot reload, etc.)
  function dispose(){
    try{ if(unsubAuth) unsubAuth(); }catch{}
    unsubAuth = null;
    inited = false;
  }

  return { init, signInEmail, signInGoogle, signOut: signOutNow, dispose };
})();