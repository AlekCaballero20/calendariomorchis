// auth.js - Firebase Auth API (Google)
// Exporta authApi como espera app.js

import { initFirebase, auth } from './firebase.js';

import {
  onAuthStateChanged,
  signOut,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

/**
 * ALLOWLIST:
 * - Si esta vacia => no bloquea
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
  switch(code){
    case 'auth/too-many-requests': return 'Demasiados intentos. Espera un poquito y vuelve a intentar.';
    case 'auth/popup-blocked': return 'El navegador bloqueo el popup de Google. Permite popups o intenta de nuevo.';
    case 'auth/popup-closed-by-user': return 'Cerraste el popup de Google.';
    case 'auth/unauthorized-domain': return 'Dominio no autorizado en Firebase (Authorized domains).';
    case 'auth/cancelled-popup-request': return 'Se cancelo el popup anterior.';
    case 'auth/network-request-failed': return 'Fallo la red. Revisa internet y vuelve a intentar.';
    case 'auth/operation-not-allowed': return 'Metodo de login no habilitado en Firebase (Auth > Sign-in method).';
    default:
      return String(err?.message || '').trim() || 'Fallo el login.';
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
      throw new Error('Acceso restringido. Ese correo no esta en la lista.');
    }
    return true;
  }

  async function finishRedirectIfAny(){
    try{
      const res = await getRedirectResult(auth);
      return res || null;
    }catch(e){
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

    if(inited) return;
    inited = true;

    void finishRedirectIfAny();

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

  async function signInGoogle(){
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });

    try{
      try{
        const cred = await signInWithPopup(auth, provider);
        const user = cred.user;

        await enforceAllowlistOrSignOut(user);
        return user;
      }catch(e){
        const code = e?.code || '';
        if(
          code === 'auth/popup-blocked' ||
          code === 'auth/operation-not-supported-in-this-environment'
        ){
          await signInWithRedirect(auth, provider);
          return null;
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

  function dispose(){
    try{ if(unsubAuth) unsubAuth(); }catch{}
    unsubAuth = null;
    inited = false;
  }

  return { init, signInGoogle, signOut: signOutNow, dispose };
})();
