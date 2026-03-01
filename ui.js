// ui.js — Calendar UI (Month / Week / Agenda) + Modals + Filters
// Mejoras (sin romper API):
// ✅ Render más rápido (indexa por día/semana una sola vez)
// ✅ Panel día usa el mismo index (no refiltra todo)
// ✅ Modal: valida start + no cierra si está mal (y muestra mensaje)
// ✅ Mensajes: soporte para "appMsg" (si existe) y fallback a authMsg/alert
// ✅ Accesibilidad: foco básico al abrir/cerrar modal/panel
// ✅ Robustez: null-safety, fechas seguras, no se cae con categorías nuevas

'use strict';

const DAYS = ["Dom","Lun","Mar","Mié","Jue","Vie","Sáb"];
const MONTHS = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];

const CAT_META = {
  personal: { label: "Personal" },
  salud: { label: "Salud" },
  finanzas: { label: "Finanzas" },
  familia: { label: "Familia" },
  cumple: { label: "Cumpleaños" },
  experiencias: { label: "Experiencias" },
};

function $(id){ return document.getElementById(id); }
function on(el, evt, fn){ if(el) el.addEventListener(evt, fn); }

function pad2(n){ return String(n).padStart(2,'0'); }

function toISOInputValue(dateLike){
  if(!dateLike) return '';
  const d = (dateLike instanceof Date) ? dateLike : new Date(dateLike);
  if(Number.isNaN(d.getTime())) return '';
  const yyyy = d.getFullYear();
  const mm = pad2(d.getMonth()+1);
  const dd = pad2(d.getDate());
  const hh = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

function startOfMonth(y,m){ return new Date(y,m,1,0,0,0,0); }
function endOfMonth(y,m){ return new Date(y,m+1,0,23,59,59,999); }

function sameDay(a,b){
  return a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate();
}

function inRange(date, start, end){
  const t = date.getTime();
  return t >= start.getTime() && t <= end.getTime();
}

function safeDate(v){
  if(!v) return null;
  const d = (v instanceof Date) ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
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

function escapeText(s){
  // UI actual usa textContent casi siempre, pero por si acaso.
  return String(s ?? '');
}

export const ui = (() => {
  let state = {
    userEmail: null,
    view: 'month',
    cursor: new Date(),
    events: [],
    filters: Object.fromEntries(Object.keys(CAT_META).map(k => [k,true])),
    q: '',
    selectedDay: null,
    editingEventId: null,

    // index internos para render rápido
    _cache: {
      key: '',
      filtered: [],
      byDayInMonth: new Map(), // dayNum -> events[]
      byDayISO: new Map(),     // YYYY-MM-DD -> events[]
      monthKey: '',            // "YYYY-MM"
      weekKey: '',             // "YYYY-MM-DD(startSunday)"
    },
  };

  let handlers = {
    onLogin: () => {},
    onGoogle: () => {},
    onDemo: () => {},       // opcional
    onLogout: () => {},
    onCreateEvent: () => {},
    onDeleteEvent: () => {},
  };

  // foco básico
  let lastFocusEl = null;

  // ===== Messages =====
  function showMsg(msg){
    // Si existe un contenedor de mensajes para la app, úsalo.
    // Si no existe, reutiliza authMsg o hace alert.
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

    // Fallback: auth box si está visible, si no alert
    const authVisible = $('authScreen') && !$('authScreen').classList.contains('hidden');
    if(authVisible && authMsg){
      showAuthMsg(msg);
    }else{
      if(msg) window.alert(msg);
    }
  }

  function init(){
    // ===== Auth UI =====
    const loginForm = $('loginForm');
    on(loginForm, 'submit', (e)=>{
      e.preventDefault();
      handlers.onLogin({
        email: ($('email')?.value || '').trim(),
        password: $('password')?.value || ''
      });
    });

    // Demo button is optional (because reality)
    on($('btnDemo'), 'click', ()=> handlers.onDemo());
    on($('btnGoogle'), 'click', ()=> handlers.onGoogle());
    on($('btnLogout'), 'click', ()=> handlers.onLogout());

    // ===== Nav =====
    on($('btnPrev'), 'click', ()=> shiftCursor(-1));
    on($('btnNext'), 'click', ()=> shiftCursor(1));
    on($('btnToday'), 'click', ()=>{
      state.cursor = new Date();
      state.selectedDay = new Date();
      render();
    });

    // ===== View segmented =====
    document.querySelectorAll('.segmented .seg').forEach(btn=>{
      on(btn, 'click', ()=>{
        document.querySelectorAll('.segmented .seg').forEach(b=> b.classList.remove('on'));
        btn.classList.add('on');
        state.view = btn.dataset.view || 'month';
        render();
      });
    });

    // ===== Search =====
    on($('search'), 'input', (e)=>{
      state.q = (e.target.value || '').trim().toLowerCase();
      render();
    });

    // ===== Chips =====
    renderChips();

    // ===== Modal =====
    on($('btnNew'), 'click', ()=> openModal(null));
    on($('btnCloseModal'), 'click', closeModal);
    on($('btnCancel'), 'click', closeModal);

    on($('eventForm'), 'submit', (e)=>{
      e.preventDefault();
      const payload = getFormPayload();
      if(!payload) return; // payload null cuando hay error (no cerramos modal)
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

    // ===== Panel =====
    on($('btnClosePanel'), 'click', closePanel);

    // Escape to close
    on(document, 'keydown', (e)=>{
      if(e.key !== 'Escape') return;
      const modal = $('modal');
      const panel = $('panel');
      if(modal && !modal.classList.contains('hidden')) closeModal();
      if(panel && !panel.classList.contains('hidden')) closePanel();
    });

    // Click outside (si existe overlay)
    on($('modal'), 'click', (e)=>{
      if(e.target?.id === 'modal') closeModal();
    });
    on($('panel'), 'click', (e)=>{
      if(e.target?.id === 'panel') closePanel();
    });
  }

  // ===== Handlers wiring =====
  function onLogin(fn){ handlers.onLogin = fn; }
  function onGoogle(fn){ handlers.onGoogle = fn; }
  function onDemo(fn){ handlers.onDemo = fn; }
  function onLogout(fn){ handlers.onLogout = fn; }
  function onCreateEvent(fn){ handlers.onCreateEvent = fn; }
  function onDeleteEvent(fn){ handlers.onDeleteEvent = fn; }

  // ===== Auth screens =====
  function showAuth(){
    $('authScreen')?.classList.remove('hidden');
    $('appScreen')?.classList.add('hidden');
    $('btnLogout')?.classList.add('hidden');
    $('userPill')?.classList.add('hidden');
    showAuthMsg('');
    showMsg(''); // limpia appMsg si existe
  }

  function showApp(){
    $('authScreen')?.classList.add('hidden');
    $('appScreen')?.classList.remove('hidden');
    $('btnLogout')?.classList.remove('hidden');
    $('userPill')?.classList.remove('hidden');
    showAuthMsg('');
    showMsg('');
  }

  function setUser(email){
    state.userEmail = email || null;
    const pill = $('userPill');
    if(!pill) return;
    if(email){
      pill.textContent = email;
      pill.classList.remove('hidden');
    }else{
      pill.classList.add('hidden');
      pill.textContent = '';
    }
  }

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

  // ===== Events state =====
  function setEvents(events){
    state.events = Array.isArray(events) ? events : [];
    invalidateCache();
  }

  function upsertEvent(ev){
    if(!ev || !ev.id) return;
    const idx = state.events.findIndex(e => e.id === ev.id);
    if(idx >= 0) state.events[idx] = ev;
    else state.events.push(ev);
    invalidateCache();
  }

  function removeEvent(id){
    state.events = state.events.filter(e => e.id !== id);
    invalidateCache();
  }

  function setEventsAndRender(events){
    setEvents(events);
    render();
  }

  function invalidateCache(){
    state._cache.key = '';
    state._cache.filtered = [];
    state._cache.byDayInMonth = new Map();
    state._cache.byDayISO = new Map();
    state._cache.monthKey = '';
    state._cache.weekKey = '';
  }

  // ===== Cursor =====
  function shiftCursor(deltaMonths){
    const d = new Date(state.cursor);
    d.setMonth(d.getMonth() + deltaMonths);
    state.cursor = d;
    render();
  }

  // ===== Chips =====
  function renderChips(){
    const wrap = $('filterChips');
    if(!wrap) return;
    wrap.innerHTML = '';

    Object.keys(CAT_META).forEach(key=>{
      const el = document.createElement('div');
      el.className = 'chip';
      el.textContent = CAT_META[key].label;
      el.dataset.key = key;

      if(!state.filters[key]) el.classList.add('off');

      el.addEventListener('click', ()=>{
        state.filters[key] = !state.filters[key];
        el.classList.toggle('off', !state.filters[key]);
        render();
      });

      wrap.appendChild(el);
    });
  }

  // ===== Filtering + indexing =====
  function filteredEvents(){
    const q = state.q;
    const filterKey = Object.keys(state.filters).sort().map(k => `${k}:${state.filters[k]?'1':'0'}`).join('|');
    const key = `${filterKey}::${q}`;

    if(state._cache.key === key){
      return state._cache.filtered;
    }

    const list = (state.events || [])
      .filter(e => state.filters[e.category] !== false)
      .filter(e => {
        if(!q) return true;
        const blob = `${e.title || ''} ${e.notes || ''}`.toLowerCase();
        return blob.includes(q);
      })
      .slice()
      .sort((a,b)=> {
        const da = safeDate(a.start)?.getTime() ?? 0;
        const db = safeDate(b.start)?.getTime() ?? 0;
        return da - db;
      });

    state._cache.key = key;
    state._cache.filtered = list;
    // Nota: los índices por vista se construyen bajo demanda (renderMonth/renderWeek/panel)

    return list;
  }

  function ensureMonthIndex(y,m){
    const mk = `${y}-${pad2(m+1)}`;
    if(state._cache.monthKey === mk) return;

    state._cache.monthKey = mk;
    state._cache.byDayInMonth = new Map();

    const start = startOfMonth(y,m);
    const end = endOfMonth(y,m);

    const events = filteredEvents().filter(e => {
      const ds = safeDate(e.start);
      return ds ? inRange(ds, start, end) : false;
    });

    for(const ev of events){
      const ds = safeDate(ev.start);
      if(!ds) continue;
      const dayNum = ds.getDate();
      if(!state._cache.byDayInMonth.has(dayNum)) state._cache.byDayInMonth.set(dayNum, []);
      state._cache.byDayInMonth.get(dayNum).push(ev);
    }

    for(const [k,arr] of state._cache.byDayInMonth.entries()){
      arr.sort((a,b)=> (safeDate(a.start)?.getTime() ?? 0) - (safeDate(b.start)?.getTime() ?? 0));
      state._cache.byDayInMonth.set(k, arr);
    }
  }

  function ensureWeekIndex(startSunday){
    const wk = dayKey(startSunday);
    if(state._cache.weekKey === wk) return;

    state._cache.weekKey = wk;
    state._cache.byDayISO = new Map();

    const start = new Date(startSunday);
    start.setHours(0,0,0,0);
    const end = new Date(start);
    end.setDate(start.getDate()+6);
    end.setHours(23,59,59,999);

    const events = filteredEvents().filter(e => {
      const ds = safeDate(e.start);
      return ds ? inRange(ds, start, end) : false;
    });

    for(const ev of events){
      const ds = safeDate(ev.start);
      if(!ds) continue;
      const k = dayKey(ds);
      if(!state._cache.byDayISO.has(k)) state._cache.byDayISO.set(k, []);
      state._cache.byDayISO.get(k).push(ev);
    }

    for(const [k,arr] of state._cache.byDayISO.entries()){
      arr.sort((a,b)=> (safeDate(a.start)?.getTime() ?? 0) - (safeDate(b.start)?.getTime() ?? 0));
      state._cache.byDayISO.set(k, arr);
    }
  }

  // ===== Render main =====
  function render(){
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
      return;
    }
    if(state.view === 'week'){
      renderWeek(cal);
      return;
    }
    renderMonth(cal, y, m);
  }

  // ===== Month view =====
  function renderMonth(root, y, m){
    ensureMonthIndex(y,m);

    const start = startOfMonth(y,m);
    const firstDow = start.getDay();
    const daysInMonth = new Date(y, m+1, 0).getDate();

    // Weekday header
    const wd = document.createElement('div');
    wd.className = 'grid weekdays';
    DAYS.forEach(d=>{
      const el = document.createElement('div');
      el.className = 'weekday';
      el.textContent = d;
      wd.appendChild(el);
    });
    root.appendChild(wd);

    // Days grid
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

    for(let d=1; d<=daysInMonth; d++){
      const date = new Date(y,m,d);
      const cell = document.createElement('div');
      cell.className = 'day';
      if(sameDay(date,today)) cell.classList.add('today');

      const dayEvents = state._cache.byDayInMonth.get(d) || [];

      cell.innerHTML = `<div class="dayNum">${d}</div>`;

      const badges = document.createElement('div');
      badges.className = 'badges';

      dayEvents.slice(0,3).forEach(ev=>{
        const b = document.createElement('div');
        b.className = 'badge';
        if(ev.priority === 'importante') b.classList.add('important');
        if(ev.priority === 'critico') b.classList.add('critico');
        b.textContent = ev.title || '(Sin título)';
        badges.appendChild(b);
      });

      if(dayEvents.length > 3){
        const more = document.createElement('div');
        more.className = 'badge';
        more.textContent = `+${dayEvents.length - 3} más`;
        badges.appendChild(more);
      }

      cell.appendChild(badges);

      cell.addEventListener('click', ()=>{
        state.selectedDay = date;
        openPanelForDay(date);
      });

      grid.appendChild(cell);
    }

    root.appendChild(grid);
  }

  // ===== Week view =====
  function renderWeek(root){
    const base = state.selectedDay ? new Date(state.selectedDay) : new Date();
    const start = new Date(base);
    start.setDate(base.getDate() - base.getDay()); // Sunday start
    start.setHours(0,0,0,0);

    ensureWeekIndex(start);

    // Weekday header
    const wd = document.createElement('div');
    wd.className = 'grid weekdays';
    DAYS.forEach((d,i)=>{
      const el = document.createElement('div');
      el.className = 'weekday';
      const dayDate = new Date(start); dayDate.setDate(start.getDate()+i);
      el.textContent = `${d} ${dayDate.getDate()}`;
      wd.appendChild(el);
    });
    root.appendChild(wd);

    const grid = document.createElement('div');
    grid.className = 'grid';

    for(let i=0;i<7;i++){
      const date = new Date(start); date.setDate(start.getDate()+i);
      const cell = document.createElement('div');
      cell.className = 'day';
      if(sameDay(date, new Date())) cell.classList.add('today');

      const key = dayKey(date);
      const dayEvents = state._cache.byDayISO.get(key) || [];

      cell.innerHTML = `<div class="dayNum">${date.getDate()}</div>`;

      const badges = document.createElement('div');
      badges.className = 'badges';

      dayEvents.slice(0,4).forEach(ev=>{
        const b = document.createElement('div');
        b.className = 'badge';
        if(ev.priority === 'importante') b.classList.add('important');
        if(ev.priority === 'critico') b.classList.add('critico');
        b.textContent = ev.title || '(Sin título)';
        badges.appendChild(b);
      });

      cell.appendChild(badges);
      cell.addEventListener('click', ()=>{
        state.selectedDay = date;
        openPanelForDay(date);
      });

      grid.appendChild(cell);
    }

    root.appendChild(grid);
  }

  // ===== Agenda view =====
  function renderAgenda(root){
    const list = filteredEvents();
    const box = document.createElement('div');
    box.style.padding = '12px';
    box.style.display = 'flex';
    box.style.flexDirection = 'column';
    box.style.gap = '10px';

    if(list.length === 0){
      const p = document.createElement('div');
      p.className = 'muted';
      p.textContent = 'No hay eventos (por ahora).';
      box.appendChild(p);
      root.appendChild(box);
      return;
    }

    list.forEach(ev=>{
      const card = document.createElement('div');
      card.className = 'badge';

      const s = safeDate(ev.start);
      if(!s){
        card.textContent = ev.title || '(Sin título)';
      }else{
        const date = `${s.getDate()} ${MONTHS[s.getMonth()]} ${s.getFullYear()}`;
        const time = formatTime(s);
        card.textContent = `${date} · ${time} · ${ev.title || '(Sin título)'}`;
      }

      card.addEventListener('click', ()=> openPanelForEvent(ev));
      box.appendChild(card);
    });

    root.appendChild(box);
  }

  // ===== Panel =====
  function openPanelForDay(date){
    // Usa índice si está disponible según vista/cursor
    const d = safeDate(date) || new Date();
    const list = (() => {
      if(state.view === 'month'){
        const y = state.cursor.getFullYear();
        const m = state.cursor.getMonth();
        ensureMonthIndex(y,m);
        if(d.getFullYear() === y && d.getMonth() === m){
          return (state._cache.byDayInMonth.get(d.getDate()) || []);
        }
      }
      if(state.view === 'week'){
        const base = state.selectedDay ? new Date(state.selectedDay) : new Date();
        const start = new Date(base);
        start.setDate(base.getDate() - base.getDay());
        start.setHours(0,0,0,0);
        ensureWeekIndex(start);
        return (state._cache.byDayISO.get(dayKey(d)) || []);
      }
      // fallback: filtra
      return filteredEvents().filter(e => {
        const ds = safeDate(e.start);
        return ds ? sameDay(ds, d) : false;
      });
    })();

    const body = $('panelBody');
    if(!body) return;
    body.innerHTML = '';

    const head = document.createElement('div');
    head.className = 'pill';
    head.style.boxShadow = 'none';
    head.textContent = formatLongDate(d);
    body.appendChild(head);

    if(list.length === 0){
      const p = document.createElement('div');
      p.className = 'muted';
      p.textContent = 'Nada por aquí. Excelente.';
      body.appendChild(p);

      const btn = document.createElement('button');
      btn.className = 'btn primary';
      btn.textContent = 'Crear evento este día';
      btn.addEventListener('click', ()=>{
        const dd = new Date(d);
        dd.setHours(9,0,0,0);
        openModal({ start: dd, end: '' });
      });
      body.appendChild(btn);
    }else{
      list.forEach(ev=>{
        const item = document.createElement('div');
        item.className = 'badge';
        item.textContent = ev.title || '(Sin título)';
        item.addEventListener('click', ()=> openPanelForEvent(ev));
        body.appendChild(item);
      });

      const btn = document.createElement('button');
      btn.className = 'btn primary';
      btn.textContent = 'Nuevo evento';
      btn.addEventListener('click', ()=>{
        const dd = new Date(d); dd.setHours(9,0,0,0);
        openModal({ start: dd, end: '' });
      });
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

    const s = safeDate(ev.start);

    const title = document.createElement('div');
    title.className = 'pill';
    title.style.boxShadow = 'none';
    title.textContent = ev.title || '(Sin título)';

    const when = document.createElement('div');
    when.className = 'muted';
    when.textContent = s
      ? `${formatLongDate(s)} · ${formatTime(s)}`
      : 'Fecha inválida (arregla el dato)';

    const catLabel = CAT_META[ev.category]?.label || (ev.category || 'personal');
    const meta = document.createElement('div');
    meta.className = 'muted';
    meta.textContent = `Categoría: ${catLabel} · Prioridad: ${ev.priority || 'normal'}`;

    body.appendChild(title);
    body.appendChild(when);
    body.appendChild(meta);

    if(ev.notes){
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
    del.addEventListener('click', ()=>{
      if(!ev?.id) return;
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

  // ===== Modal =====
  function openModal(ev){
    state.editingEventId = ev?.id || null;

    const modalTitle = $('modalTitle');
    if(modalTitle) modalTitle.textContent = ev?.id ? 'Editar evento' : 'Nuevo evento';

    $('btnDelete')?.classList.toggle('hidden', !ev?.id);

    if($('evTitle')) $('evTitle').value = ev?.title || '';

    // start/end may be ISO string or Date or empty
    const startVal = ev?.start ? toISOInputValue(ev.start) : '';
    const endVal   = ev?.end   ? toISOInputValue(ev.end)   : '';

    if($('evStart')) $('evStart').value = startVal;
    if($('evEnd')) $('evEnd').value = endVal;

    if($('evCategory')) $('evCategory').value = ev?.category || 'personal';
    if($('evPriority')) $('evPriority').value = ev?.priority || 'normal';
    if($('evNotes')) $('evNotes').value = ev?.notes || '';

    lastFocusEl = document.activeElement;
    $('modal')?.classList.remove('hidden');

    // Limpia mensajes app
    showMsg('');

    // foco
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

    return {
      id: state.editingEventId || null,
      title,
      start: startIso,
      end: endIso,
      category: $('evCategory')?.value || 'personal',
      priority: $('evPriority')?.value || 'normal',
      notes: ($('evNotes')?.value || '').trim(),
    };
  }

  return {
    init,
    render,
    setUser,
    showAuth,
    showApp,
    showAuthMsg,
    setEvents: setEventsAndRender,
    upsertEvent,
    removeEvent,
    onLogin,
    onGoogle,
    onDemo,
    onLogout,
    onCreateEvent,
    onDeleteEvent,
  };
})();