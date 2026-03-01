import { initFirebase } from './firebase.js';
import { authApi } from './auth.js';
import { dbApi } from './db.js';
import { ui } from './ui.js';

(async function main(){
  'use strict';

  // =========================
  // Helpers
  // =========================
  const $ = (id) => document.getElementById(id);

  const isAuthVisible = () => {
    const authScreen = $('authScreen');
    // si no existe, asumimos "no auth"
    return authScreen ? !authScreen.classList.contains('hidden') : false;
  };

  const showMsg = (msg) => {
    // ui.showAuthMsg solo existe para el auth screen, así que
    // cuando ya estás en la app, si algo revienta, al menos lo ves.
    if (isAuthVisible()) {
      ui.showAuthMsg(msg);
    } else {
      // Minimalismo brutal: alert y consola. (No hay toast en ui.js)
      console.warn('[APP MSG]', msg);
      window.alert(msg);
    }
  };

  const normalizeErrMsg = (e, fallbackMsg) => {
    const raw = (e?.message || '').trim();
    if (raw.includes('Missing or insufficient permissions')) {
      return 'No tienes permisos en Firestore. Revisa Rules / allowlist 🔒';
    }
    return raw || fallbackMsg;
  };

  const safe = async (fn, fallbackMsg = 'Algo falló. Porque claro que sí.') => {
    try {
      return await fn();
    } catch (e) {
      console.error(e);
      showMsg(normalizeErrMsg(e, fallbackMsg));
      return null;
    }
  };

  // =========================
  // Demo mode state
  // =========================
  let isDemo = false;

  // Mini DB en memoria para demo (sin Firestore)
  let demoEvents = [];

  const demoDb = {
    async listEvents(){ return demoEvents.slice(); },

    async upsertEvent(data){
      const now = Date.now();
      const item = {
        id: data.id || `demo-${Math.random().toString(16).slice(2)}${now.toString(16)}`,
        title: String(data.title || '').trim(),
        start: data.start,
        end: data.end || null,
        category: data.category || 'personal',
        priority: data.priority || 'normal',
        notes: data.notes || '',
        createdAt: data.createdAt || now,
        updatedAt: now,
      };
      const idx = demoEvents.findIndex(e => e.id === item.id);
      if(idx >= 0) demoEvents[idx] = item;
      else demoEvents.push(item);
      return item;
    },

    async deleteEvent(id){
      demoEvents = demoEvents.filter(e => e.id !== id);
      return true;
    },
  };

  const activeDb = () => (isDemo ? demoDb : dbApi);

  // Mantener contexto del user para queries seguras (Firestore rules-friendly)
  let session = {
    uid: null,
    email: null,
  };

  const setSession = ({ uid = null, email = null } = {}) => {
    session.uid = uid || null;
    session.email = email || null;

    // Solo aplica a Firestore real
    dbApi.setContext({ uid: session.uid, email: session.email });
  };

  const clearSession = () => setSession({ uid: null, email: null });

  const loadAndRender = async () => {
    // IMPORTANTE: si no pasas uid, db.js puede intentar listar "todo"
    // y Firestore te va a decir: "jaja no" (rules).
    const opts = (!isDemo && session.uid) ? { uid: session.uid } : {};
    const events = await safe(
      () => activeDb().listEvents(opts),
      'No pude cargar eventos.'
    );

    if (events) ui.setEvents(events);
    ui.render();
  };

  // =========================
  // Init Firebase + UI
  // =========================
  initFirebase();
  ui.init();

  // =========================
  // Auth wiring
  // =========================
  authApi.init({
    onSignedIn: async (user) => {
      isDemo = false; // si hay user real, no demo

      const email = user?.email || '';
      const uid = user?.uid || null;

      setSession({ uid, email });

      ui.setUser(email);
      ui.showApp();

      // Limpia mensajes viejos del auth screen
      ui.showAuthMsg('');

      await loadAndRender();
    },

    onSignedOut: () => {
      isDemo = false;
      clearSession();

      ui.setUser(null);
      ui.showAuth();
    },

    onAuthError: (msg) => {
      // Esto pasa típicamente en pantalla de auth, entonces está perfecto
      ui.showAuthMsg(msg);
    },
  });

  // =========================
  // UI action wiring
  // =========================
  ui.onLogin(async ({ email, password }) => safe(
    () => authApi.signInEmail(email, password),
    'No se pudo iniciar sesión.'
  ));

  ui.onGoogle(async () => safe(
    () => authApi.signInGoogle(),
    'No se pudo iniciar sesión con Google.'
  ));

  ui.onDemo(async () => {
    isDemo = true;
    clearSession(); // por si venías de login real

    ui.setUser('demo@alekk-y-cata.local');
    ui.showApp();

    const now = new Date();
    const iso = (d) => new Date(d).toISOString();
    const stamp = Date.now();

    demoEvents = [
      {
        id: 'demo-1',
        title: '💰 Pago arriendo (demo)',
        start: iso(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0)),
        end: null,
        category: 'finanzas',
        priority: 'critico',
        notes: 'Demo: aquí todo se guarda solo en memoria (no Firestore).',
        createdAt: stamp,
        updatedAt: stamp,
      },
      {
        id: 'demo-2',
        title: '🩺 Cita / salud (demo)',
        start: iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 16, 30)),
        end: null,
        category: 'salud',
        priority: 'importante',
        notes: '',
        createdAt: stamp,
        updatedAt: stamp,
      },
      {
        id: 'demo-3',
        title: '🎂 Cumple (demo)',
        start: iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 3, 12, 0)),
        end: null,
        category: 'cumple',
        priority: 'normal',
        notes: 'Solo para probar badges y panel.',
        createdAt: stamp,
        updatedAt: stamp,
      },
      {
        id: 'demo-4',
        title: '✨ Plan chill (demo)',
        start: iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 5, 19, 0)),
        end: null,
        category: 'experiencias',
        priority: 'normal',
        notes: 'A ver si la vida coopera.',
        createdAt: stamp,
        updatedAt: stamp,
      },
    ];

    ui.setEvents(await demoDb.listEvents());
    ui.render();
  });

  ui.onLogout(async () => {
    if (isDemo) {
      // Salir demo = volver a auth screen sin pegarle a Firebase
      isDemo = false;
      clearSession();
      ui.setUser(null);
      ui.showAuth();
      return;
    }
    await safe(() => authApi.signOut(), 'No se pudo cerrar sesión.');
  });

  ui.onCreateEvent(async (data) => {
    const saved = await safe(
      () => activeDb().upsertEvent(data),
      'No se pudo guardar el evento.'
    );
    if (!saved) return;

    ui.upsertEvent(saved);
    ui.render();
  });

  ui.onDeleteEvent(async (id) => {
    const ok = await safe(
      () => activeDb().deleteEvent(id),
      'No se pudo eliminar el evento.'
    );
    if (!ok) return;

    ui.removeEvent(id);
    ui.render();
  });

})();