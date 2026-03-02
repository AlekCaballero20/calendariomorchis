// ui.js — Calendar UI (Month / Week / Agenda) + Modals + Filters + Settings
// vNext (real):
// ✅ Resumen del mes funciona (statsBox) y oculta el "(Próximamente)"
// ✅ Categorías funcionan en Settings: crear/editar/eliminar + orden básico
// ✅ Digest por correo: muestra estado y "evidencia" (última ejecución) desde localStorage
// ✅ Limpia textos "(Próximamente)" en Settings/Stats automáticamente
// ✅ Mantiene API pública y no rompe app.js
//
// Nota importante sobre "correo":
// - Este proyecto NO puede "enviar" emails directo desde frontend (sin backend).
// - reminders.js usa "mailto:" (abre el cliente de correo).
// - Aquí damos trazabilidad: última ejecución guardada en localStorage.

'use strict';

const DAYS = ["Dom","Lun","Mar","Mié","Jue","Vie","Sáb"];
const MONTHS = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];

// Defaults (si Firestore no trae nada)
const DEFAULT_CATEGORIES = {
  personal:     { label: "Personal" },
  salud:        { label: "Salud" },
  finanzas:     { label: "Finanzas" },
  familia:      { label: "Familia" },
  cumple:       { label: "Cumpleaños" },
  experiencias: { label: "Experiencias" },
};

const LS_SENT_KEY = 'cal_reminders_sent_v1'; // mismo que reminders.js

function $(id){ return document.getElementById(id); }
function on(el, evt, fn){ if(el) el.addEventListener(evt, fn); }

function pad2(n){ return String(n).padStart(2,'0'); }

function safeDate(v){
  if(!v) return null;
  const d = (v instanceof Date) ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toISOInputValue(dateLike){
  if(!dateLike) return '';
  const d = safeDate(dateLike);
  if(!d) return '';
  const yyyy = d.getFullYear();
  const mm = pad2(d.getMonth()+1);
  const dd = pad2(d.getDate());
  const hh = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

function startOfMonth(y,m){ return new Date(y,m,1,0,0,0,0); }
function endOfMonth(y,m){ return new Date(y,m+1,0,23,59,59,999); }

function startOfDay(d){
  const x = new Date(d);
  x.setHours(0,0,0,0);
  return x;
}
function endOfDay(d){
  const x = new Date(d);
  x.setHours(23,59,59,999);
  return x;
}

function sameDay(a,b){
  return a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate();
}

function inRange(date, start, end){
  const t = date.getTime();
  return t >= start.getTime() && t <= end.getTime();
}

function formatTime(d){
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function formatLongDate(d){
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function dayKey(d){
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
}

function monthKeyFromYM(y,m){
  return `${y}-${pad2(m+1)}`;
}

function weekKeyFromSunday(sun){
  return dayKey(sun);
}

// ----- Helpers: repeat / reminders -----

function normalizeRepeat(freq, interval){
  const f = String(freq || 'none').toLowerCase().trim();
  const allowed = new Set(['none','daily','weekly','monthly','yearly']);
  const safeFreq = allowed.has(f) ? f : 'none';

  let n = Number(interval);
  if(!Number.isFinite(n) || n <= 0) n = 1;
  n = Math.min(3650, Math.max(1, Math.floor(n)));

  if(safeFreq === 'none') return null;
  return { freq: safeFreq, interval: n };
}

function parseRemindersInput(raw){
  const s = String(raw ?? '').trim();
  if(!s) return [];
  const parts = s.split(',').map(x => x.trim()).filter(Boolean);

  const nums = [];
  for(const p of parts){
    const n = Number(p);
    if(!Number.isFinite(n)) continue;
    const nn = Math.floor(n);
    if(nn < 0) continue;
    if(nn > 43200) continue; // 30 días
    nums.push(nn);
  }

  return Array.from(new Set(nums)).sort((a,b)=>a-b).slice(0, 8);
}

function remindersToInput(arr){
  if(!Array.isArray(arr) || !arr.length) return '';
  return arr
    .map(n => String(Math.floor(Number(n) || 0)))
    .filter(Boolean)
    .join(', ');
}

function escapeText(s){
  return String(s ?? '')
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'","&#039;");
}

// Focus helpers (mini a11y)
function getFocusable(container){
  if(!container) return [];
  return Array.from(container.querySelectorAll(
    'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])'
  ));
}

// ---------- categories helpers ----------
function normKey(s){
  return String(s || '')
    .toLowerCase()
    .trim()
    .replace(/[áàä]/g,'a')
    .replace(/[éèë]/g,'e')
    .replace(/[íìï]/g,'i')
    .replace(/[óòö]/g,'o')
    .replace(/[úùü]/g,'u')
    .replace(/ñ/g,'n')
    .replace(/[^a-z0-9]+/g,'_')
    .replace(/^_+|_+$/g,'')
    .slice(0, 30);
}

function uniqKey(base, existing){
  let k = base || 'categoria';
  if(!existing.has(k)) return k;
  let i = 2;
  while(existing.has(`${k}_${i}`) && i < 999) i++;
  return `${k}_${i}`;
}

function readDigestEvidence(){
  // reminders.js suele guardar un map { "YYYY-MM-DD": timestampMs } o algo parecido.
  // Aquí no asumimos forma perfecta: intentamos extraer "última vez" decente.
  try{
    const raw = localStorage.getItem(LS_SENT_KEY);
    if(!raw) return null;
    const obj = JSON.parse(raw);
    if(!obj || typeof obj !== 'object') return null;

    // si es map por día -> timestamp
    let last = null;
    for(const v of Object.values(obj)){
      const n = Number(v);
      if(Number.isFinite(n)) last = Math.max(last || 0, n);
      else{
        // a veces guarda {sentAt:..}
        const s = Number(v?.sentAt);
        if(Number.isFinite(s)) last = Math.max(last || 0, s);
      }
    }
    if(!last) return null;

    const d = new Date(last);
    if(Number.isNaN(d.getTime())) return null;

    return d;
  }catch{
    return null;
  }
}

export const ui = (() => {
  let state = {
    userEmail: null,

    view: 'month',
    cursor: new Date(),
    events: [],

    categories: { ...DEFAULT_CATEGORIES },
    filters: {},

    settings: {
      holidaysCO: 'on',
      emailDigest: 'on',
      emailDigestTime: '07:00',
      categories: { ...DEFAULT_CATEGORIES },
    },

    q: '',
    selectedDay: null,
    editingEventId: null,

    _dirtySettingsCats: false,

    // índices internos
    _cache: {
      filterKey: '',
      filtered: [],

      monthKey: '',
      monthStart: null,
      monthEnd: null,
      byDayNumInMonth: new Map(), // 1..31 -> events[]

      weekKey: '',
      weekStart: null,
      weekEnd: null,
      byDayISOInWeek: new Map(),  // YYYY-MM-DD -> events[]

      byDayISOAll: new Map(),     // YYYY-MM-DD -> events[]
      byDayISOAllKey: '',
    },
  };

  let handlers = {
    onLogin: () => {},
    onGoogle: () => {},
    onDemo: () => {},
    onLogout: () => {},
    onCreateEvent: () => {},
    onDeleteEvent: () => {},
    onSaveSettings: () => {},
  };

  // focus restore
  let lastFocusEl = null;
  let lastFocusSettingsEl = null;

  // ---------------------
  // Messages
  // ---------------------
  function showAuthMsg(msg){
    const box = $('authMsg');
    if(!box) return;
    if(!msg){
      box.classList.add('hidden');
      box.textContent = '';
      return;
    }
    box.textContent = msg;
    box.classList.remove('hidden');
  }

  function showMsg(msg){
    const appMsg = $('appMsg');
    const authMsg = $('authMsg');

    if(appMsg){
      if(!msg){
        appMsg.classList.add('hidden');
        appMsg.textContent = '';
      }else{
        appMsg.textContent = msg;
        appMsg.classList.remove('hidden');
      }
      return;
    }

    const authVisible = $('authScreen') && !$('authScreen').classList.contains('hidden');
    if(authVisible && authMsg){
      showAuthMsg(msg);
    }else{
      if(msg) window.alert(msg);
    }
  }

  function showSettingsMsg(msg){
    const box = $('settingsMsg');
    if(!box){
      showMsg(msg);
      return;
    }
    if(!msg){
      box.classList.add('hidden');
      box.textContent = '';
      return;
    }
    box.textContent = msg;
    box.classList.remove('hidden');
  }

  // ---------------------
  // Init
  // ---------------------
  function init(){
    // Auth
    const loginForm = $('loginForm');
    on(loginForm, 'submit', (e)=>{
      e.preventDefault();
      handlers.onLogin({
        email: ($('email')?.value || '').trim(),
        password: $('password')?.value || ''
      });
    });

    on($('btnDemo'), 'click', ()=> handlers.onDemo());
    on($('btnGoogle'), 'click', ()=> handlers.onGoogle());
    on($('btnLogout'), 'click', ()=> handlers.onLogout());

    // Settings
    on($('btnSettings'), 'click', openSettings);
    on($('btnCloseSettings'), 'click', closeSettings);
    on($('btnSettingsCancel'), 'click', closeSettings);
    on($('btnSettingsSave'), 'click', saveSettingsFromUI);
    on($('settingsModal'), 'click', (e)=>{ if(e.target?.id === 'settingsModal') closeSettings(); });

    // categories editor
    on($('btnAddCategory'), 'click', ()=> addCategoryUI());

    // Nav
    on($('btnPrev'), 'click', ()=> shiftCursor(-1));
    on($('btnNext'), 'click', ()=> shiftCursor(1));
    on($('btnToday'), 'click', ()=>{
      state.cursor = new Date();
      state.selectedDay = new Date();
      render();
    });

    // View segmented
    document.querySelectorAll('.segmented .seg').forEach(btn=>{
      on(btn, 'click', ()=>{
        document.querySelectorAll('.segmented .seg').forEach(b=>{
          b.classList.remove('on');
          b.setAttribute('aria-selected','false');
        });
        btn.classList.add('on');
        btn.setAttribute('aria-selected','true');
        state.view = btn.dataset.view || 'month';
        render();
      });
    });

    // Search
    on($('search'), 'input', (e)=>{
      state.q = (e.target.value || '').trim().toLowerCase();
      invalidateFilterCache();
      render();
    });

    // Chips: delegation
    ensureFiltersForCategories();
    renderChips();

    const chipsWrap = $('filterChips');
    if(chipsWrap){
      on(chipsWrap, 'click', (e)=>{
        const chip = e.target?.closest?.('.chip');
        if(!chip) return;
        const key = chip.dataset.key;
        if(!key) return;

        const cur = (state.filters[key] !== false);
        state.filters[key] = !cur;

        chip.classList.toggle('off', state.filters[key] === false);
        invalidateFilterCache();
        render();
      });
    }

    // Modal (Event)
    on($('btnNew'), 'click', ()=> openModal(null));
    on($('btnCloseModal'), 'click', closeModal);
    on($('btnCancel'), 'click', closeModal);

    on($('eventForm'), 'submit', (e)=>{
      e.preventDefault();
      const payload = getFormPayload();
      if(!payload) return;
      handlers.onCreateEvent(payload);
      closeModal();
    });

    on($('btnDelete'), 'click', ()=>{
      const id = state.editingEventId;
      if(!id) return;
      handlers.onDeleteEvent(id);
      closeModal();
      closePanel();
    });

    // Panel
    on($('btnClosePanel'), 'click', closePanel);

    // Click outside modal
    on($('modal'), 'click', (e)=>{
      if(e.target?.id === 'modal') closeModal();
    });

    // Global Esc + focus trap
    on(document, 'keydown', (e)=>{
      if(e.key === 'Escape'){
        const settings = $('settingsModal');
        const modal = $('modal');
        const panel = $('panel');

        if(settings && !settings.classList.contains('hidden')) { closeSettings(); return; }
        if(modal && !modal.classList.contains('hidden')) { closeModal(); return; }
        if(panel && !panel.classList.contains('hidden')) { closePanel(); return; }
        return;
      }

      if(e.key === 'Tab'){
        const settings = $('settingsModal');
        const modal = $('modal');
        const activeModal = (settings && !settings.classList.contains('hidden')) ? settings
                          : (modal && !modal.classList.contains('hidden')) ? modal
                          : null;
        if(!activeModal) return;

        const focusables = getFocusable(activeModal);
        if(!focusables.length) return;

        const first = focusables[0];
        const last = focusables[focusables.length - 1];

        if(e.shiftKey && document.activeElement === first){
          e.preventDefault();
          last.focus();
        }else if(!e.shiftKey && document.activeElement === last){
          e.preventDefault();
          first.focus();
        }
      }
    });

    // Calendar clicks: delegation
    const cal = $('calendar');
    if(cal){
      on(cal, 'click', (e)=>{
        const dayCell = e.target?.closest?.('[data-day-iso]');
        if(dayCell){
          const iso = dayCell.dataset.dayIso;
          const d = safeDate(iso);
          state.selectedDay = d || null;
          if(d) openPanelForDay(d);
          return;
        }

        const evRow = e.target?.closest?.('[data-ev-id]');
        if(evRow){
          const id = evRow.dataset.evId;
          const ev = state.events.find(x => String(x?.id||'') === String(id));
          if(ev) openPanelForEvent(ev);
          return;
        }
      });
    }

    // Panel body clicks: delegation
    const panelBody = $('panelBody');
    if(panelBody){
      on(panelBody, 'click', (e)=>{
        const btnNew = e.target?.closest?.('[data-action="new-on-day"]');
        if(btnNew){
          const iso = btnNew.dataset.dayIso;
          const d = safeDate(iso);
          if(d){
            const dd = new Date(d);
            dd.setHours(9,0,0,0);
            openModal({ start: dd, end: '' });
          }
          return;
        }

        const item = e.target?.closest?.('[data-ev-id]');
        if(item){
          const id = item.dataset.evId;
          const ev = state.events.find(x => String(x?.id||'') === String(id));
          if(ev) openPanelForEvent(ev);
        }
      });
    }

    // primera pasada: quitar "Próximamente" si ya podemos renderizar cosas
    scrubSoonText();
  }

  // ---------------------
  // Handlers wiring
  // ---------------------
  function onLogin(fn){ handlers.onLogin = fn; }
  function onGoogle(fn){ handlers.onGoogle = fn; }
  function onDemo(fn){ handlers.onDemo = fn; }
  function onLogout(fn){ handlers.onLogout = fn; }
  function onCreateEvent(fn){ handlers.onCreateEvent = fn; }
  function onDeleteEvent(fn){ handlers.onDeleteEvent = fn; }
  function onSaveSettings(fn){ handlers.onSaveSettings = fn; }

  // ---------------------
  // Auth screens
  // ---------------------
  function showAuth(){
    $('authScreen')?.classList.remove('hidden');
    $('appScreen')?.classList.add('hidden');
    $('btnLogout')?.classList.add('hidden');
    $('userPill')?.classList.add('hidden');
    $('btnSettings')?.classList.add('hidden');

    showAuthMsg('');
    showMsg('');
    showSettingsMsg('');
  }

  function showApp(){
    $('authScreen')?.classList.add('hidden');
    $('appScreen')?.classList.remove('hidden');
    $('btnLogout')?.classList.remove('hidden');
    $('userPill')?.classList.remove('hidden');
    $('btnSettings')?.classList.remove('hidden');

    showAuthMsg('');
    showMsg('');
    showSettingsMsg('');
  }

  function setUser(email){
    state.userEmail = email || null;
    const pill = $('userPill');
    if(pill){
      if(email){
        pill.textContent = email;
        pill.classList.remove('hidden');
      }else{
        pill.classList.add('hidden');
        pill.textContent = '';
      }
    }
  }

  // ---------------------
  // “Próximamente” scrubber
  // ---------------------
  function scrubSoonText(){
    // Stats block
    const statsBlock = $('statsBlock');
    if(statsBlock){
      const muted = statsBlock.querySelector('.muted');
      const box = $('statsBox');
      if(muted && box && box.children.length){
        if(String(muted.textContent || '').includes('Próximamente')){
          muted.textContent = 'Resumen calculado con lo que hay en este mes.';
        }
      }
    }

    // Settings modal blocks: reemplaza textos si ya hay UI real
    const sm = $('settingsModal');
    if(sm){
      const muted = Array.from(sm.querySelectorAll('.railBlock .muted'));
      for(const el of muted){
        const t = String(el.textContent || '');
        if(!t.includes('Próximamente')) continue;

        // holiday hint
        if(t.includes('Festivos') || t.includes('Se generan automáticamente')){
          el.textContent = 'Se muestran como eventos del sistema (si están habilitados).';
          continue;
        }
        // email hint
        if(t.includes('correo') || t.includes('hoy/mañana')){
          el.textContent = 'Se dispara localmente (abre tu cliente de correo vía mailto). Abajo ves evidencia de ejecución.';
          continue;
        }
        // categories hint
        if(t.toLowerCase().includes('categor')){
          el.textContent = 'Puedes crear/editar/eliminar categorías aquí mismo. Se guardan con la configuración.';
          continue;
        }
      }
    }
  }

  // ---------------------
  // Settings
  // ---------------------
  function setSettings(s){
    if(!s || typeof s !== 'object') return;

    // categorías desde settings (autoridad)
    if(s.categories && typeof s.categories === 'object'){
      try{ setCategories(s.categories, { fromSettings: true }); }catch{}
      state.settings.categories = { ...s.categories };
    }else{
      state.settings.categories = { ...(state.categories || DEFAULT_CATEGORIES) };
    }

    const next = {
      holidaysCO: (s.holidaysCO === 'off' ? 'off' : 'on'),
      emailDigest: (s.emailDigest === 'off' ? 'off' : 'on'),
      emailDigestTime: (typeof s.emailDigestTime === 'string' && /^\d{2}:\d{2}$/.test(s.emailDigestTime))
        ? s.emailDigestTime
        : (state.settings.emailDigestTime || '07:00'),
    };

    state.settings = { ...state.settings, ...next };

    if(!$('settingsModal')?.classList.contains('hidden')){
      syncSettingsToUI();
    }

    scrubSoonText();
  }

  function getSettings(){
    return { ...state.settings, categories: { ...(state.settings.categories || {}) } };
  }

  function openSettings(){
    const modal = $('settingsModal');
    if(!modal) return;

    syncSettingsToUI();
    renderCategoriesEditor();
    renderEmailEvidence();

    lastFocusSettingsEl = document.activeElement;
    modal.classList.remove('hidden');
    showSettingsMsg('');

    $('setHolidaysCO')?.focus?.();

    scrubSoonText();
  }

  function closeSettings(){
    const modal = $('settingsModal');
    if(!modal) return;

    modal.classList.add('hidden');
    showSettingsMsg('');

    if(lastFocusSettingsEl && lastFocusSettingsEl.focus) lastFocusSettingsEl.focus();
    lastFocusSettingsEl = null;
  }

  function syncSettingsToUI(){
    if($('setHolidaysCO')) $('setHolidaysCO').value = state.settings.holidaysCO || 'on';
    if($('setEmailDigest')) $('setEmailDigest').value = state.settings.emailDigest || 'on';
    if($('setEmailDigestTime')) $('setEmailDigestTime').value = state.settings.emailDigestTime || '07:00';
  }

  function readSettingsFromUI(){
    const holidaysCO = $('setHolidaysCO')?.value || 'on';
    const emailDigest = $('setEmailDigest')?.value || 'on';
    const emailDigestTime = $('setEmailDigestTime')?.value || '07:00';

    const timeOk = /^\d{2}:\d{2}$/.test(emailDigestTime);

    // categories: lo que esté en editor
    const cats = readCategoriesFromEditor() || (state.settings.categories || state.categories || DEFAULT_CATEGORIES);

    return {
      holidaysCO: (holidaysCO === 'off' ? 'off' : 'on'),
      emailDigest: (emailDigest === 'off' ? 'off' : 'on'),
      emailDigestTime: timeOk ? emailDigestTime : '07:00',
      categories: cats,
    };
  }

  function saveSettingsFromUI(){
    const next = readSettingsFromUI();
    state.settings = { ...state.settings, ...next, categories: { ...(next.categories || {}) } };

    try{ handlers.onSaveSettings({ ...state.settings, categories: { ...(state.settings.categories || {}) } }); }catch{}

    showSettingsMsg('Guardado.');
    closeSettings();
    render();
  }

  // ---------------------
  // Categories editor (Settings)
  // ---------------------
  function setCategories(map, opts = {}){
    state.categories = (map && typeof map === 'object') ? { ...map } : { ...DEFAULT_CATEGORIES };
    ensureFiltersForCategories();
    renderChips();
    syncCategorySelect();
    invalidateFilterCache();

    // si viene desde settings, mantenemos state.settings.categories consistente
    if(opts.fromSettings){
      state.settings.categories = { ...state.categories };
    }

    render();
  }

  function ensureFiltersForCategories(){
    const cats = state.categories || {};
    const next = { ...(state.filters || {}) };

    for(const k of Object.keys(cats)){
      if(typeof next[k] !== 'boolean') next[k] = true;
    }
    state.filters = next;
  }

  function renderChips(){
    const wrap = $('filterChips');
    if(!wrap) return;
    wrap.innerHTML = '';

    const cats = state.categories || {};
    const keys = Object.keys(cats);
    const finalMap = keys.length ? cats : DEFAULT_CATEGORIES;

    for(const key of Object.keys(finalMap)){
      const meta = finalMap[key] || {};
      const label = meta.label || key;

      const el = document.createElement('div');
      el.className = 'chip';
      el.textContent = label;
      el.dataset.key = key;
      if(state.filters[key] === false) el.classList.add('off');
      wrap.appendChild(el);
    }
  }

  function syncCategorySelect(){
    const sel = $('evCategory');
    if(!sel) return;

    const current = sel.value || 'personal';
    sel.innerHTML = '';

    const cats = state.categories || {};
    const keys = Object.keys(cats);
    const finalMap = keys.length ? cats : DEFAULT_CATEGORIES;
    const finalKeys = Object.keys(finalMap);

    for(const k of finalKeys){
      const opt = document.createElement('option');
      opt.value = k;
      opt.textContent = finalMap[k]?.label || k;
      sel.appendChild(opt);
    }

    if(finalKeys.includes(current)) sel.value = current;
    else if(finalKeys.includes('personal')) sel.value = 'personal';
    else sel.value = finalKeys[0] || '';
  }

  function renderCategoriesEditor(){
    const box = $('setCategoriesBox');
    if(!box) return;

    box.innerHTML = '';
    const cats = state.settings.categories || state.categories || DEFAULT_CATEGORIES;

    const keys = Object.keys(cats);

    if(keys.length === 0){
      const p = document.createElement('div');
      p.className = 'muted';
      p.style.fontSize = '12px';
      p.textContent = 'No hay categorías. Crea una.';
      box.appendChild(p);
      return;
    }

    // orden: personal primero si existe, luego alfabético
    const ordered = keys.slice().sort((a,b)=>{
      if(a === 'personal') return -1;
      if(b === 'personal') return 1;
      return a.localeCompare(b);
    });

    for(const key of ordered){
      const row = document.createElement('div');
      row.style.display = 'grid';
      row.style.gridTemplateColumns = '120px 1fr auto';
      row.style.gap = '8px';
      row.style.alignItems = 'center';

      const pill = document.createElement('div');
      pill.className = 'pill';
      pill.style.boxShadow = 'none';
      pill.style.padding = '8px 10px';
      pill.style.fontSize = '12px';
      pill.textContent = key;

      const input = document.createElement('input');
      input.type = 'text';
      input.value = String(cats[key]?.label || key);
      input.dataset.catKey = key;
      input.placeholder = 'Nombre visible';
      input.setAttribute('aria-label', `Nombre de categoría ${key}`);
      input.addEventListener('input', ()=>{
        state._dirtySettingsCats = true;
      });

      const del = document.createElement('button');
      del.className = 'btn';
      del.type = 'button';
      del.textContent = 'Eliminar';
      del.disabled = (key === 'personal'); // no borrar "personal" para no romper UX básica
      del.title = (key === 'personal') ? 'No puedes eliminar la categoría base.' : 'Eliminar categoría';
      del.addEventListener('click', ()=>{
        if(key === 'personal') return;
        deleteCategory(key);
      });

      row.appendChild(pill);
      row.appendChild(input);
      row.appendChild(del);
      box.appendChild(row);
    }

    scrubSoonText();
  }

  function readCategoriesFromEditor(){
    const box = $('setCategoriesBox');
    if(!box) return null;

    const inputs = Array.from(box.querySelectorAll('input[data-cat-key]'));
    if(!inputs.length) return null;

    const cats = {};
    for(const inp of inputs){
      const k = String(inp.dataset.catKey || '').trim();
      if(!k) continue;
      const label = String(inp.value || '').trim() || k;
      cats[k] = { label: label.slice(0, 60) };
    }

    // seguridad: si el usuario borra todo por accidente
    if(!cats.personal) cats.personal = { label: 'Personal' };

    return cats;
  }

  function addCategoryUI(){
    const name = window.prompt('Nombre de la nueva categoría:');
    const label = String(name || '').trim();
    if(!label) return;

    const existing = new Set(Object.keys(state.settings.categories || state.categories || {}));
    const base = normKey(label) || 'categoria';
    const key = uniqKey(base, existing);

    const cats = { ...(state.settings.categories || state.categories || DEFAULT_CATEGORIES) };
    cats[key] = { label: label.slice(0, 60) };

    state.settings.categories = cats;
    state.categories = { ...cats };

    state._dirtySettingsCats = true;

    ensureFiltersForCategories();
    renderChips();
    syncCategorySelect();
    renderCategoriesEditor();
    invalidateFilterCache();
    render();
  }

  function deleteCategory(key){
    const cats = { ...(state.settings.categories || state.categories || {}) };
    if(!cats[key]) return;

    // si hay eventos con esa categoría, no borramos silencioso
    const hasEvents = (state.events || []).some(ev => String(ev?.category || '') === key);
    if(hasEvents){
      const ok = window.confirm(`Hay eventos usando "${key}". Si la borras, esos eventos quedarán como "personal". ¿Borrarla igual?`);
      if(!ok) return;

      // re-mapea eventos en UI (solo vista). El backend igual debería guardarse al editar eventos.
      for(const ev of state.events){
        if(String(ev?.category || '') === key){
          ev.category = 'personal';
        }
      }
    }

    delete cats[key];
    if(!cats.personal) cats.personal = { label: 'Personal' };

    state.settings.categories = cats;
    state.categories = { ...cats };

    state._dirtySettingsCats = true;

    ensureFiltersForCategories();
    renderChips();
    syncCategorySelect();
    renderCategoriesEditor();
    invalidateFilterCache();
    render();
  }

  // ---------------------
  // Digest evidence (Settings)
  // ---------------------
  function renderEmailEvidence(){
    const modal = $('settingsModal');
    if(!modal) return;

    // buscamos el railBlock de "Recordatorios por correo" y le inyectamos un mini estado
    const blocks = Array.from(modal.querySelectorAll('.railBlock'));
    const emailBlock = blocks.find(b => (b.querySelector('.railTitle')?.textContent || '').includes('Recordatorios por correo'));
    if(!emailBlock) return;

    let host = emailBlock.querySelector('[data-email-evidence]');
    if(!host){
      host = document.createElement('div');
      host.dataset.emailEvidence = '1';
      host.style.marginTop = '8px';
      host.style.display = 'flex';
      host.style.flexDirection = 'column';
      host.style.gap = '6px';
      emailBlock.appendChild(host);
    }

    host.innerHTML = '';

    const enabled = (state.settings.emailDigest !== 'off');
    const time = state.settings.emailDigestTime || '07:00';

    const ev = readDigestEvidence();

    const row1 = document.createElement('div');
    row1.className = 'pill';
    row1.style.boxShadow = 'none';
    row1.style.fontSize = '12px';
    row1.textContent = enabled
      ? `Digest activado · ${time}`
      : `Digest desactivado`;

    const row2 = document.createElement('div');
    row2.className = 'muted';
    row2.style.fontSize = '12px';
    row2.style.lineHeight = '1.35';
    row2.textContent = ev
      ? `Última ejecución registrada: ${formatLongDate(ev)} · ${formatTime(ev)}`
      : `Aún no hay ejecución registrada (o el navegador no guardó evidencia).`;

    host.appendChild(row1);
    host.appendChild(row2);
  }

  // ---------------------
  // Events state
  // ---------------------
  function setEvents(events){
    state.events = Array.isArray(events) ? events : [];
    learnCategoriesFromEvents(state.events);
    invalidateFilterCache();
  }

  function learnCategoriesFromEvents(events){
    const cats = { ...(state.categories || {}) };
    let changed = false;

    for(const ev of (events || [])){
      const k = String(ev?.category || '').trim();
      if(!k) continue;
      if(!cats[k]){
        cats[k] = { label: k.charAt(0).toUpperCase() + k.slice(1) };
        changed = true;
      }
    }

    if(changed){
      state.categories = cats;
      ensureFiltersForCategories();
      renderChips();
      syncCategorySelect();
    }
  }

  function upsertEvent(ev){
    if(!ev || !ev.id) return;
    const idx = state.events.findIndex(e => e.id === ev.id);
    if(idx >= 0) state.events[idx] = ev;
    else state.events.push(ev);

    learnCategoriesFromEvents([ev]);
    invalidateFilterCache();
  }

  function removeEvent(id){
    state.events = state.events.filter(e => e.id !== id);
    invalidateFilterCache();
  }

  function setEventsAndRender(events){
    setEvents(events);
    render();
  }

  // ---------------------
  // Cache / filtering
  // ---------------------
  function invalidateFilterCache(){
    state._cache.filterKey = '';
    state._cache.filtered = [];
    state._cache.monthKey = '';
    state._cache.monthStart = null;
    state._cache.monthEnd = null;
    state._cache.byDayNumInMonth = new Map();

    state._cache.weekKey = '';
    state._cache.weekStart = null;
    state._cache.weekEnd = null;
    state._cache.byDayISOInWeek = new Map();

    state._cache.byDayISOAll = new Map();
    state._cache.byDayISOAllKey = '';
  }

  function buildFilterKey(){
    const filterKey = Object.keys(state.filters)
      .sort()
      .map(k => `${k}:${state.filters[k]===false?'0':'1'}`)
      .join('|');
    const q = state.q || '';
    return `${filterKey}::${q}`;
  }

  function filteredEvents(){
    const key = buildFilterKey();
    if(state._cache.filterKey === key) return state._cache.filtered;

    const q = state.q;

    const list = (state.events || [])
      .filter(e => {
        const cat = e?.category;
        if(cat && state.filters[cat] === false) return false;
        return true;
      })
      .filter(e => {
        if(!q) return true;
        const blob = `${e?.title || ''} ${e?.notes || ''}`.toLowerCase();
        return blob.includes(q);
      })
      .slice()
      .sort((a,b)=>{
        const da = safeDate(a?.start)?.getTime() ?? 0;
        const db = safeDate(b?.start)?.getTime() ?? 0;
        return da - db;
      });

    state._cache.filterKey = key;
    state._cache.filtered = list;
    return list;
  }

  function ensureMonthIndex(y,m){
    const mk = monthKeyFromYM(y,m);
    if(state._cache.monthKey === mk) return;

    state._cache.monthKey = mk;
    state._cache.byDayNumInMonth = new Map();

    const start = startOfMonth(y,m);
    const end = endOfMonth(y,m);
    state._cache.monthStart = start;
    state._cache.monthEnd = end;

    const list = filteredEvents();
    for(const ev of list){
      const ds = safeDate(ev?.start);
      if(!ds) continue;
      if(!inRange(ds, start, end)) continue;

      const dayNum = ds.getDate();
      if(!state._cache.byDayNumInMonth.has(dayNum)) state._cache.byDayNumInMonth.set(dayNum, []);
      state._cache.byDayNumInMonth.get(dayNum).push(ev);
    }

    for(const [k,arr] of state._cache.byDayNumInMonth.entries()){
      arr.sort((a,b)=> (safeDate(a?.start)?.getTime() ?? 0) - (safeDate(b?.start)?.getTime() ?? 0));
      state._cache.byDayNumInMonth.set(k, arr);
    }
  }

  function ensureWeekIndex(startSunday){
    const wk = weekKeyFromSunday(startSunday);
    if(state._cache.weekKey === wk) return;

    state._cache.weekKey = wk;
    state._cache.byDayISOInWeek = new Map();

    const start = startOfDay(startSunday);
    const end = endOfDay(new Date(startSunday.getFullYear(), startSunday.getMonth(), startSunday.getDate()+6));
    state._cache.weekStart = start;
    state._cache.weekEnd = end;

    const list = filteredEvents();
    for(const ev of list){
      const ds = safeDate(ev?.start);
      if(!ds) continue;
      if(!inRange(ds, start, end)) continue;

      const k = dayKey(ds);
      if(!state._cache.byDayISOInWeek.has(k)) state._cache.byDayISOInWeek.set(k, []);
      state._cache.byDayISOInWeek.get(k).push(ev);
    }

    for(const [k,arr] of state._cache.byDayISOInWeek.entries()){
      arr.sort((a,b)=> (safeDate(a?.start)?.getTime() ?? 0) - (safeDate(b?.start)?.getTime() ?? 0));
      state._cache.byDayISOInWeek.set(k, arr);
    }
  }

  function ensureAgendaIndex(){
    const key = state._cache.filterKey;
    if(state._cache.byDayISOAllKey === key) return;

    const map = new Map();
    const list = filteredEvents();

    for(const ev of list){
      const ds = safeDate(ev?.start);
      if(!ds) continue;
      const k = dayKey(ds);
      if(!map.has(k)) map.set(k, []);
      map.get(k).push(ev);
    }

    for(const [k,arr] of map.entries()){
      arr.sort((a,b)=> (safeDate(a?.start)?.getTime() ?? 0) - (safeDate(b?.start)?.getTime() ?? 0));
      map.set(k, arr);
    }

    state._cache.byDayISOAll = map;
    state._cache.byDayISOAllKey = key;
  }

  // ---------------------
  // Cursor / render
  // ---------------------
  function shiftCursor(deltaMonths){
    const d = new Date(state.cursor);
    d.setMonth(d.getMonth() + deltaMonths);
    state.cursor = d;
    render();
  }

  function render(){
    syncCategorySelect();

    const cur = new Date(state.cursor);
    const y = cur.getFullYear();
    const m = cur.getMonth();

    const titleMain = $('titleMain');
    const titleSub = $('titleSub');
    if(titleMain) titleMain.textContent = `${MONTHS[m]} ${y}`;
    if(titleSub) titleSub.textContent =
      state.view === 'month' ? 'Vista mensual' :
      state.view === 'week'  ? 'Vista semanal' :
      'Agenda';

    const cal = $('calendar');
    if(!cal) return;
    cal.innerHTML = '';

    if(state.view === 'agenda'){
      renderAgenda(cal);
    }else if(state.view === 'week'){
      renderWeek(cal);
    }else{
      renderMonth(cal, y, m);
    }

    renderMonthStats(y, m);
    scrubSoonText();
  }

  // ---------------------
  // Resumen del mes (Stats)
  // ---------------------
  function renderMonthStats(y, m){
    const box = $('statsBox');
    const block = $('statsBlock');
    if(!box || !block) return;

    ensureMonthIndex(y, m);

    const start = state._cache.monthStart || startOfMonth(y,m);
    const end = state._cache.monthEnd || endOfMonth(y,m);

    const list = filteredEvents().filter(ev=>{
      const ds = safeDate(ev?.start);
      return ds && inRange(ds, start, end);
    });

    box.innerHTML = '';

    const dim = new Date(y, m+1, 0).getDate();

    const byDay = new Map();
    const byCat = new Map();
    let crit = 0;
    let imp = 0;

    for(const ev of list){
      const ds = safeDate(ev?.start);
      if(!ds) continue;

      const kDay = dayKey(ds);
      byDay.set(kDay, (byDay.get(kDay) || 0) + 1);

      const cat = String(ev?.category || 'personal');
      byCat.set(cat, (byCat.get(cat) || 0) + 1);

      const p = String(ev?.priority || 'normal');
      if(p === 'critico') crit++;
      else if(p === 'importante') imp++;
    }

    const busyDays = byDay.size;
    const freeDays = Math.max(0, dim - busyDays);

    // streak (racha de días con eventos)
    let longest = 0;
    let current = 0;
    for(let d=1; d<=dim; d++){
      const dk = `${y}-${pad2(m+1)}-${pad2(d)}`;
      if(byDay.has(dk)){
        current++;
        longest = Math.max(longest, current);
      }else{
        current = 0;
      }
    }

    const topCats = Array.from(byCat.entries())
      .sort((a,b)=> b[1]-a[1])
      .slice(0, 4);

    const mkPill = (txt) => {
      const el = document.createElement('div');
      el.className = 'pill';
      el.style.boxShadow = 'none';
      el.style.fontSize = '12px';
      el.textContent = txt;
      return el;
    };

    box.appendChild(mkPill(`Eventos: ${list.length}`));
    box.appendChild(mkPill(`Críticos: ${crit} · Importantes: ${imp}`));
    box.appendChild(mkPill(`Días ocupados: ${busyDays} · Días libres: ${freeDays}`));
    box.appendChild(mkPill(`Racha más larga: ${longest} día(s)`));

    if(topCats.length){
      const catsWrap = document.createElement('div');
      catsWrap.style.display = 'flex';
      catsWrap.style.flexWrap = 'wrap';
      catsWrap.style.gap = '8px';

      for(const [cat, n] of topCats){
        const label = state.categories?.[cat]?.label || cat;
        const chip = document.createElement('div');
        chip.className = 'chip';
        chip.textContent = `${label} · ${n}`;
        catsWrap.appendChild(chip);
      }

      box.appendChild(catsWrap);
    }

    // Si está vacío, igual mostramos algo (para que no parezca roto)
    if(list.length === 0){
      const muted = document.createElement('div');
      muted.className = 'muted';
      muted.style.fontSize = '12px';
      muted.textContent = 'Este mes está sospechosamente vacío.';
      box.appendChild(muted);
    }
  }

  // ---------------------
  // Month view
  // ---------------------
  function renderMonth(root, y, m){
    ensureMonthIndex(y,m);

    const start = startOfMonth(y,m);
    const firstDow = start.getDay();
    const dim = new Date(y, m+1, 0).getDate();

    const wd = document.createElement('div');
    wd.className = 'grid weekdays';
    for(const d of DAYS){
      const el = document.createElement('div');
      el.className = 'weekday';
      el.textContent = d;
      wd.appendChild(el);
    }
    root.appendChild(wd);

    const grid = document.createElement('div');
    grid.className = 'grid';

    // leading blanks
    for(let i=0;i<firstDow;i++){
      const blank = document.createElement('div');
      blank.className = 'day';
      blank.style.opacity = .35;
      blank.style.cursor = 'default';
      blank.innerHTML = `<div class="dayNum"> </div>`;
      grid.appendChild(blank);
    }

    const today = new Date();

    for(let d=1; d<=dim; d++){
      const date = new Date(y,m,d);
      const iso = dayKey(date);

      const cell = document.createElement('div');
      cell.className = 'day';
      cell.dataset.dayIso = iso;
      if(sameDay(date,today)) cell.classList.add('today');

      const dayEvents = state._cache.byDayNumInMonth.get(d) || [];

      cell.innerHTML = `<div class="dayNum">${d}</div>`;

      const badges = document.createElement('div');
      badges.className = 'badges';

      for(const ev of dayEvents.slice(0,3)){
        const b = document.createElement('div');
        b.className = 'badge';
        if(ev?.priority === 'importante') b.classList.add('important');
        if(ev?.priority === 'critico') b.classList.add('critico');
        if(ev?.isSystem) b.style.opacity = '0.95';
        b.textContent = ev?.title || '(Sin título)';
        badges.appendChild(b);
      }

      if(dayEvents.length > 3){
        const more = document.createElement('div');
        more.className = 'badge';
        more.textContent = `+${dayEvents.length - 3} más`;
        badges.appendChild(more);
      }

      cell.appendChild(badges);
      grid.appendChild(cell);
    }

    root.appendChild(grid);
  }

  // ---------------------
  // Week view
  // ---------------------
  function renderWeek(root){
    const base = state.selectedDay ? new Date(state.selectedDay) : new Date();
    const start = new Date(base);
    start.setDate(base.getDate() - base.getDay());
    start.setHours(0,0,0,0);

    ensureWeekIndex(start);

    const wd = document.createElement('div');
    wd.className = 'grid weekdays';
    for(let i=0;i<7;i++){
      const el = document.createElement('div');
      el.className = 'weekday';
      const dayDate = new Date(start); dayDate.setDate(start.getDate()+i);
      el.textContent = `${DAYS[i]} ${dayDate.getDate()}`;
      wd.appendChild(el);
    }
    root.appendChild(wd);

    const grid = document.createElement('div');
    grid.className = 'grid';

    const today = new Date();

    for(let i=0;i<7;i++){
      const date = new Date(start); date.setDate(start.getDate()+i);
      const iso = dayKey(date);

      const cell = document.createElement('div');
      cell.className = 'day';
      cell.dataset.dayIso = iso;
      if(sameDay(date, today)) cell.classList.add('today');

      const dayEvents = state._cache.byDayISOInWeek.get(iso) || [];

      cell.innerHTML = `<div class="dayNum">${date.getDate()}</div>`;

      const badges = document.createElement('div');
      badges.className = 'badges';

      for(const ev of dayEvents.slice(0,4)){
        const b = document.createElement('div');
        b.className = 'badge';
        if(ev?.priority === 'importante') b.classList.add('important');
        if(ev?.priority === 'critico') b.classList.add('critico');
        if(ev?.isSystem) b.style.opacity = '0.95';
        b.textContent = ev?.title || '(Sin título)';
        badges.appendChild(b);
      }

      cell.appendChild(badges);
      grid.appendChild(cell);
    }

    root.appendChild(grid);
  }

  // ---------------------
  // Agenda view
  // ---------------------
  function renderAgenda(root){
    ensureAgendaIndex();

    const box = document.createElement('div');
    box.style.padding = '12px';
    box.style.display = 'flex';
    box.style.flexDirection = 'column';
    box.style.gap = '12px';

    const map = state._cache.byDayISOAll;
    const keys = Array.from(map.keys()).sort((a,b)=> a.localeCompare(b));

    if(keys.length === 0){
      const p = document.createElement('div');
      p.className = 'muted';
      p.textContent = 'No hay eventos (por ahora).';
      box.appendChild(p);
      root.appendChild(box);
      return;
    }

    for(const k of keys){
      const d = safeDate(k);
      const dayHead = document.createElement('div');
      dayHead.className = 'pill';
      dayHead.style.boxShadow = 'none';
      dayHead.textContent = d ? formatLongDate(d) : k;
      box.appendChild(dayHead);

      const list = map.get(k) || [];
      for(const ev of list){
        const row = document.createElement('div');
        row.className = 'badge';
        row.dataset.evId = String(ev?.id || '');
        const s = safeDate(ev?.start);
        const t = s ? formatTime(s) : '--:--';
        row.textContent = `${t} · ${ev?.title || '(Sin título)'}`;
        box.appendChild(row);
      }
    }

    root.appendChild(box);
  }

  // ---------------------
  // Panel
  // ---------------------
  function openPanelForDay(date){
    const d = safeDate(date) || new Date();
    const k = dayKey(d);

    let list = [];

    if(state.view === 'month'){
      const y = state.cursor.getFullYear();
      const m = state.cursor.getMonth();
      ensureMonthIndex(y,m);
      if(d.getFullYear() === y && d.getMonth() === m){
        list = state._cache.byDayNumInMonth.get(d.getDate()) || [];
      }else{
        list = filteredEvents().filter(e=>{
          const ds = safeDate(e?.start);
          return ds ? sameDay(ds, d) : false;
        });
      }
    } else if(state.view === 'week'){
      const base = state.selectedDay ? new Date(state.selectedDay) : new Date();
      const start = new Date(base);
      start.setDate(base.getDate() - base.getDay());
      start.setHours(0,0,0,0);
      ensureWeekIndex(start);
      list = state._cache.byDayISOInWeek.get(k) || [];
    } else {
      ensureAgendaIndex();
      list = state._cache.byDayISOAll.get(k) || [];
    }

    const body = $('panelBody');
    if(!body) return;
    body.innerHTML = '';

    const head = document.createElement('div');
    head.className = 'pill';
    head.style.boxShadow = 'none';
    head.textContent = formatLongDate(d);
    body.appendChild(head);

    if(!list.length){
      const p = document.createElement('div');
      p.className = 'muted';
      p.textContent = 'Nada por aquí. Excelente.';
      body.appendChild(p);

      const btn = document.createElement('button');
      btn.className = 'btn primary';
      btn.textContent = 'Crear evento este día';
      btn.dataset.action = 'new-on-day';
      btn.dataset.dayIso = k;
      body.appendChild(btn);
    } else {
      for(const ev of list){
        const item = document.createElement('div');
        item.className = 'badge';
        item.dataset.evId = String(ev?.id || '');
        const s = safeDate(ev?.start);
        item.textContent = s
          ? `${formatTime(s)} · ${ev?.title || '(Sin título)'}`
          : (ev?.title || '(Sin título)');
        body.appendChild(item);
      }

      const btn = document.createElement('button');
      btn.className = 'btn primary';
      btn.textContent = 'Nuevo evento';
      btn.dataset.action = 'new-on-day';
      btn.dataset.dayIso = k;
      body.appendChild(btn);
    }

    lastFocusEl = document.activeElement;
    $('panel')?.classList.remove('hidden');
    $('btnClosePanel')?.focus?.();
  }

  function openPanelForEvent(ev){
    const body = $('panelBody');
    if(!body) return;
    body.innerHTML = '';

    const s = safeDate(ev?.start);

    const title = document.createElement('div');
    title.className = 'pill';
    title.style.boxShadow = 'none';
    title.textContent = ev?.title || '(Sin título)';

    const when = document.createElement('div');
    when.className = 'muted';
    when.textContent = s
      ? `${formatLongDate(s)} · ${formatTime(s)}`
      : 'Fecha inválida (arregla el dato)';

    const catKey = ev?.category || 'personal';
    const catLabel = state.categories?.[catKey]?.label || catKey;
    const meta = document.createElement('div');
    meta.className = 'muted';
    meta.textContent = `Categoría: ${catLabel} · Prioridad: ${ev?.priority || 'normal'}${ev?.isSystem ? ' · Sistema' : ''}`;

    body.appendChild(title);
    body.appendChild(when);
    body.appendChild(meta);

    if(ev?.repeat?.freq){
      const rep = document.createElement('div');
      rep.className = 'muted';
      const interval = Number(ev.repeat.interval) || 1;
      const freq = String(ev.repeat.freq);
      rep.textContent = `Repite: ${freq}${interval > 1 ? ` (cada ${interval})` : ''}`;
      body.appendChild(rep);
    }

    if(Array.isArray(ev?.reminders) && ev.reminders.length){
      const rem = document.createElement('div');
      rem.className = 'muted';
      rem.textContent = `Recordatorios: ${ev.reminders.join(', ')} min antes`;
      body.appendChild(rem);
    }

    if(ev?.notes){
      const notes = document.createElement('div');
      notes.className = 'badge';
      notes.textContent = ev.notes;
      body.appendChild(notes);
    }

    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.gap = '10px';
    actions.style.marginTop = '8px';

    const edit = document.createElement('button');
    edit.className = 'btn primary';
    edit.textContent = 'Editar';
    edit.addEventListener('click', ()=> openModal(ev));

    const del = document.createElement('button');
    del.className = 'btn';
    del.textContent = 'Eliminar';
    del.disabled = !!ev?.isSystem; // no borrar festivos "del sistema" desde UI
    del.title = ev?.isSystem ? 'Evento del sistema' : 'Eliminar';
    del.addEventListener('click', ()=>{
      if(!ev?.id || ev?.isSystem) return;
      handlers.onDeleteEvent(ev.id);
      closePanel();
    });

    actions.appendChild(edit);
    actions.appendChild(del);
    body.appendChild(actions);

    lastFocusEl = document.activeElement;
    $('panel')?.classList.remove('hidden');
    edit.focus?.();
  }

  function closePanel(){
    $('panel')?.classList.add('hidden');
    if($('panelBody')) $('panelBody').innerHTML = '';
    if(lastFocusEl && lastFocusEl.focus) lastFocusEl.focus();
    lastFocusEl = null;
  }

  // ---------------------
  // Modal (Event)
  // ---------------------
  function openModal(ev){
    state.editingEventId = ev?.id || null;

    const modalTitle = $('modalTitle');
    if(modalTitle) modalTitle.textContent = ev?.id ? 'Editar evento' : 'Nuevo evento';

    $('btnDelete')?.classList.toggle('hidden', !ev?.id || !!ev?.isSystem);

    if($('evTitle')) $('evTitle').value = ev?.title || '';

    const startVal = ev?.start ? toISOInputValue(ev.start) : '';
    const endVal   = ev?.end   ? toISOInputValue(ev.end)   : '';

    if($('evStart')) $('evStart').value = startVal;
    if($('evEnd')) $('evEnd').value = endVal;

    syncCategorySelect();

    if($('evCategory')){
      const cat = ev?.category || 'personal';
      $('evCategory').value = cat;
      if($('evCategory').value !== cat){
        $('evCategory').value = 'personal';
      }
    }

    if($('evPriority')) $('evPriority').value = ev?.priority || 'normal';
    if($('evNotes')) $('evNotes').value = ev?.notes || '';

    const r = ev?.repeat;
    if($('evRepeat')) $('evRepeat').value = (r?.freq ? String(r.freq) : 'none');
    if($('evRepeatInterval')) $('evRepeatInterval').value = String((Number(r?.interval) || 1));

    if($('evReminders')) $('evReminders').value = remindersToInput(ev?.reminders);

    lastFocusEl = document.activeElement;
    $('modal')?.classList.remove('hidden');

    showMsg('');
    $('evTitle')?.focus?.();
  }

  function closeModal(){
    state.editingEventId = null;
    $('modal')?.classList.add('hidden');
    if(lastFocusEl && lastFocusEl.focus) lastFocusEl.focus();
    lastFocusEl = null;
  }

  function getFormPayload(){
    const title = ($('evTitle')?.value || '').trim();
    const start = $('evStart')?.value || '';
    const end = $('evEnd')?.value || '';

    if(!title){
      showMsg('Ponle un título al evento. Los eventos sin nombre son muy existencialistas.');
      $('evTitle')?.focus?.();
      return null;
    }
    if(!start){
      showMsg('Te faltó la fecha/hora de inicio.');
      $('evStart')?.focus?.();
      return null;
    }

    const startDate = new Date(start);
    if(Number.isNaN(startDate.getTime())){
      showMsg('Inicio inválido. Revisa la fecha/hora.');
      $('evStart')?.focus?.();
      return null;
    }

    const endDate = end ? new Date(end) : null;
    if(endDate && Number.isNaN(endDate.getTime())){
      showMsg('Fin inválido. Revisa la fecha/hora.');
      $('evEnd')?.focus?.();
      return null;
    }

    const startIso = startDate.toISOString();
    const endIso = endDate ? endDate.toISOString() : null;

    if(endIso && endIso < startIso){
      showMsg('La fecha fin no puede ser antes del inicio.');
      $('evEnd')?.focus?.();
      return null;
    }

    const repeatFreq = $('evRepeat')?.value || 'none';
    const repeatInterval = $('evRepeatInterval')?.value || '1';
    const repeat = normalizeRepeat(repeatFreq, repeatInterval);

    const remindersRaw = $('evReminders')?.value || '';
    const reminders = parseRemindersInput(remindersRaw);

    const category = $('evCategory')?.value || 'personal';
    const priority = $('evPriority')?.value || 'normal';
    const notes = ($('evNotes')?.value || '').trim();

    const payload = {
      id: state.editingEventId || null,
      title,
      start: startIso,
      end: endIso,
      category,
      priority,
      notes,
    };

    if(repeat) payload.repeat = repeat;
    if(reminders.length) payload.reminders = reminders;

    return payload;
  }

  // ---------------------
  // Public API
  // ---------------------
  return {
    init,
    render,

    setUser,
    showAuth,
    showApp,

    showAuthMsg,
    showMsg,

    // events
    setEvents: setEventsAndRender,
    upsertEvent,
    removeEvent,

    // categories/settings
    setCategories,

    setSettings,
    getSettings,
    openSettings,
    closeSettings,

    // handlers
    onLogin,
    onGoogle,
    onDemo,
    onLogout,
    onCreateEvent,
    onDeleteEvent,
    onSaveSettings,
  };
})();