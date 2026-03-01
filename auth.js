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

const ALLOWLIST = new Set([
  // ⬇️ PON AQUÍ EXACTO los correos permitidos (Alek/Cata)
  // "alguien@gmail.com",
  // "otro@dominio.com",
]);

function niceAuthError(err){
  const code = err?.code || '';
  if(code === 'auth/invalid-credential') return "Correo o contraseña incorrectos.";
  if(code === 'auth/user-not-found') return "Ese usuario no existe.";
  if(code === 'auth/wrong-password') return "Contraseña incorrecta.";
  if(code === 'auth/too-many-requests') return "Demasiados intentos. Espera un poquito.";
  if(code === 'auth/popup-blocked') return "El navegador bloqueó el popup de Google.";
  if(code === 'auth/popup-closed-by-user') return "Cerraste el popup de Google.";
  if(code === 'auth/unauthorized-domain') return "Dominio no autorizado en Firebase (Authorized domains).";
  return err?.message || "Falló el login. Porque el universo quiso.";
}

function isAllowed(email){
  if(!ALLOWLIST.size) return true; // si no configuras allowlist, no bloquea
  return ALLOWLIST.has(String(email || '').toLowerCase().trim());
}

export const authApi = (() => {
  let cbs = {
    onSignedIn: () => {},
    onSignedOut: () => {},
    onAuthError: () => {},
  };

  function init(callbacks = {}){
    cbs = { ...cbs, ...callbacks };
    initFirebase();

    // Si vienes de redirect de Google, esto lo termina
    getRedirectResult(auth).catch((e)=>{
      // No siempre hay redirect result, entonces no molestamos
      const msg = niceAuthError(e);
      // Solo muestra si es un error real útil
      if(e?.code && e.code !== 'auth/no-auth-event') cbs.onAuthError(msg);
    });

    onAuthStateChanged(auth, async (user) => {
      if(!user){
        cbs.onSignedOut();
        return;
      }

      const email = user.email || '';
      if(!isAllowed(email)){
        await signOut(auth);
        cbs.onAuthError("Acceso restringido. Ese correo no está en la lista 🔒");
        return;
      }

      cbs.onSignedIn(user);
    });
  }

  async function signInEmail(email, password){
    try{
      const cred = await signInWithEmailAndPassword(auth, email, password);
      const user = cred.user;

      if(!isAllowed(user.email)){
        await signOut(auth);
        throw new Error("Acceso restringido. Ese correo no está en la lista 🔒");
      }
      return user;
    }catch(e){
      throw new Error(niceAuthError(e));
    }
  }

  async function signInGoogle(){
    try{
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });

      try{
        const cred = await signInWithPopup(auth, provider);
        const user = cred.user;

        if(!isAllowed(user.email)){
          await signOut(auth);
          throw new Error("Acceso restringido. Ese correo no está en la lista 🔒");
        }
        return user;
      }catch(e){
        // Fallback (móvil / webview / popup bloqueado)
        const code = e?.code || '';
        if(code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment'){
          await signInWithRedirect(auth, provider);
          return null; // el flujo continúa tras redirect
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

  return { init, signInEmail, signInGoogle, signOut: signOutNow };
})();
