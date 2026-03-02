// reminders.js — recordatorios (in-app + Notifications + digest por correo)
//
// Lo que sí hace:
// ✅ Recordatorios por evento (ev.reminders) o defaults por settings.reminders.leadMinutes
// ✅ Dedupe persistente (no repite el mismo aviso)
// ✅ Quiet hours (no molestar) cruzando medianoche
// ✅ Digest diario a una hora (settings.emailDigest + settings.emailDigestTime)
// ✅ Digest por correo vía:
//    - sendEmail() (opcional, recomendado si quieres “seguro”)
//    - fallback mailto (abre el cliente de correo)
//
// Lo que NO puede prometer desde frontend:
// ❌ “El correo se envió” (si usas mailto, el usuario manda o no manda)
//
// API:
//   reminders.init({ getEvents, getSettings, notify, sendEmail? })
//   reminders.start(); reminders.stop();
//   reminders.requestNotificationPermission()
//   reminders.tick() / reminders.tickDigest() (debug)
//   reminders.openEmailDigest(...)
//   reminders.sendDailyDigestNow(...) (forzar)

'use strict';

const LS_SENT_KEY = 'cal_reminders_sent_v2';
const LS_DIGEST_KEY = 'cal_digest_sent_v2';
const MS_MIN = 60 * 1000;
const MS_HOUR = 60 * MS_MIN;
const MS_DAY = 24 * MS_HOUR;

function isFiniteNum(n){ return typeof n === 'number' && Number.isFinite(n); }

function safeDate(v){
  if(v == null) return null;

  if(isFiniteNum(v)){
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  if(typeof v === 'object' && typeof v.toDate === 'function'){
    try{
      const d = v.toDate();
      return Number.isNaN(d.getTime()) ? null : d;
    }catch{ return null; }
  }

  const d = (v instanceof Date) ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function pad2(n){ return String(n).padStart(2,'0'); }
function ymd(d){ return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`; }
function hm(d){ return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }

function clampInt(n, min, max, fallback){
  const x = Number(n);
  if(!Number.isFinite(x)) return fallback;
  const v = Math.floor(x);
  return Math.min(max, Math.max(min, v));
}

function uniqStr(arr){
  return Array.from(new Set((arr || []).map(x => String(x).trim()).filter(Boolean)));
}

function sortByStart(list){
  return (list || []).slice().sort((a,b)=>{
    const da = isFiniteNum(a?.startMs) ? a.startMs : (safeDate(a?.start)?.getTime() ?? 0);
    const db = isFiniteNum(b?.startMs) ? b.startMs : (safeDate(b?.start)?.getTime() ?? 0);
    return da - db;
  });
}

function isNotificationsSupported(){
  return typeof window !== 'undefined' && 'Notification' in window;
}
function canNotify(){
  return isNotificationsSupported() && Notification.permission === 'granted';
}

function parseHHMM(s, fallback){
  const m = String(s || '').match(/^(\d{2}):(\d{2})$/);
  if(!m) return fallback;
  const hh = Number(m[1]), mm = Number(m[2]);
  if(!Number.isFinite(hh) || !Number.isFinite(mm)) return fallback;
  if(hh < 0 || hh > 23 || mm < 0 || mm > 59) return fallback;
  return `${pad2(hh)}:${pad2(mm)}`;
}

// -------- Settings normalize --------

function normCfg(settings = {}){
  const rem = (settings.reminders && typeof settings.reminders === 'object') ? settings.reminders : {};

  const enabled = rem.enabled !== false;

  const leadMinutes = Array.isArray(rem.leadMinutes)
    ? Array.from(new Set(
        rem.leadMinutes
          .map(x => clampInt(x, 1, 45*24*60, null))
          .filter(x => x != null)
      )).sort((a,b)=>a-b).slice(0, 12)
    : [5, 15, 60];

  const quiet = (rem.quietHours && typeof rem.quietHours === 'object')
    ? {
        on: rem.quietHours.on === true,
        from: parseHHMM(rem.quietHours.from, '22:00'),
        to:   parseHHMM(rem.quietHours.to,   '07:00')
      }
    : { on: true, from: '22:00', to: '07:00' };

  const channel = (rem.channel === 'inapp' || rem.channel === 'notify' || rem.channel === 'both')
    ? rem.channel
    : 'both';

  const onlyImportant = rem.onlyImportant === true;

  const includeCategories = Array.isArray(rem.includeCategories)
    ? rem.includeCategories.map(x => String(x).trim()).filter(Boolean)
    : null;

  const fireWindowSec = clampInt(rem.fireWindowSec, 10, 180, 70);
  const graceAfterStartMin = clampInt(rem.graceAfterStartMin, 0, 120, 5);
  const horizonDays = clampInt(rem.horizonDays, 1, 120, 7);

  // Digest (top-level, como en tu store)
  const emailDigest = (String(settings.emailDigest || 'on').toLowerCase() === 'off') ? 'off' : 'on';
  const emailDigestTime = parseHHMM(settings.emailDigestTime, '07:00');

  // Destinatarios opcionales (si los guardas en settings)
  const emailDigestTo = Array.isArray(settings.emailDigestTo)
    ? uniqStr(settings.emailDigestTo)
    : [];

  return {
    enabled,
    leadMinutes,
    quiet,
    channel,
    onlyImportant,
    includeCategories,
    fireWindowSec,
    graceAfterStartMin,
    horizonDays,
    emailDigest,
    emailDigestTime,
    emailDigestTo,
  };
}

function withinQuietHours(d, quiet){
  if(!quiet?.on) return false;

  const [fh, fm] = String(quiet.from || '22:00').split(':').map(Number);
  const [th, tm] = String(quiet.to || '07:00').split(':').map(Number);

  if(!Number.isFinite(fh) || !Number.isFinite(fm) || !Number.isFinite(th) || !Number.isFinite(tm)) return false;

  const mins = d.getHours()*60 + d.getMinutes();
  const from = fh*60 + fm;
  const to   = th*60 + tm;

  // Normal: from < to
  if(from < to) return mins >= from && mins < to;

  // Cruza medianoche
  return (mins >= from) || (mins < to);
}

// -------- Event helpers --------

function eventLabel(ev){
  const title = String(ev?.title || '(Sin título)');
  const cat = String(ev?.category || '');
  const pri = String(ev?.priority || 'normal');
  const tag = cat ? `[${cat}]` : '';
  const p = pri !== 'normal' ? `(${pri})` : '';
  return `${title} ${tag} ${p}`.trim();
}

function shouldConsider(ev, cfg){
  if(!ev) return false;

  if(cfg.onlyImportant){
    const pri = String(ev.priority || 'normal');
    if(pri === 'normal') return false;
  }

  if(cfg.includeCategories && cfg.includeCategories.length){
    const cat = String(ev.category || 'personal');
    if(!cfg.includeCategories.includes(cat)) return false;
  }

  const s = safeDate(ev?.startMs ?? ev?.start);
  if(!s) return false;

  return true;
}

function getEventStartMs(ev){
  if(isFiniteNum(ev?.startMs)) return ev.startMs;
  const d = safeDate(ev?.start);
  return d ? d.getTime() : null;
}

function reminderKey(ev, leadMin){
  const id = String(ev?.id || '');
  const s = String(ev?.start || '');
  const ms = isFiniteNum(ev?.startMs) ? String(ev.startMs) : '';
  return `${id}::${s}::${ms}::${leadMin}`;
}

function buildBody(ev, startDate, leadMin){
  const when = `${ymd(startDate)} ${hm(startDate)}`;
  const leadTxt = (leadMin === 60) ? '1 hora' : `${leadMin} min`;
  const notes = String(ev?.notes || '').trim();
  return `${when} · En ${leadTxt}${notes ? `\n\n${notes}` : ''}`.trim();
}

function getLeadMinutesForEvent(ev, cfg){
  // Prioridad: ev.reminders (minutos antes)
  if(Array.isArray(ev?.reminders) && ev.reminders.length){
    const arr = ev.reminders
      .map(x => clampInt(x, 1, 45*24*60, null))
      .filter(x => x != null);
    const uniqSorted = Array.from(new Set(arr)).sort((a,b)=>a-b).slice(0, 12);
    if(uniqSorted.length) return uniqSorted;
  }
  return cfg.leadMinutes || [5,15,60];
}

// -------- Mail digest helpers --------

function mailtoUrl({ to = [], subject = '', body = '' }){
  const recipients = uniqStr(to).join(',');
  const qs = new URLSearchParams();
  if(subject) qs.set('subject', subject);
  if(body) qs.set('body', body);
  return `mailto:${recipients}?${qs.toString()}`;
}

function buildEmailDigest({ day = new Date(), events = [], includeTomorrow = true }){
  const d = safeDate(day) || new Date();
  const dayKey = ymd(d);
  const list = sortByStart(events);

  const dayEvents = list.filter(ev=>{
    const s = safeDate(ev?.startMs ?? ev?.start);
    return s && ymd(s) === dayKey;
  });

  const tomKey = includeTomorrow ? ymd(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) : null;
  const tomEvents = includeTomorrow
    ? list.filter(ev=>{
        const s = safeDate(ev?.startMs ?? ev?.start);
        return s && ymd(s) === tomKey;
      })
    : [];

  const subject = `Agenda ${dayKey} · Alek & Cata`;

  const lines = [];
  lines.push(`Agenda del ${dayKey}`);
  lines.push('');

  const pushEventLine = (ev) => {
    const s = safeDate(ev?.startMs ?? ev?.start);
    const t = s ? hm(s) : '--:--';
    const title = String(ev?.title || '(Sin título)');
    const cat = ev?.category ? ` · ${ev.category}` : '';
    const pri = (ev?.priority && ev.priority !== 'normal') ? ` · ${ev.priority}` : '';
    lines.push(`- ${t} · ${title}${cat}${pri}`);

    const note = String(ev?.notes || '').trim();
    if(note) lines.push(`  ${note}`);
  };

  if(dayEvents.length === 0){
    lines.push('No hay eventos para hoy. Qué sospechosamente pacífico.');
  } else {
    for(const ev of dayEvents) pushEventLine(ev);
  }

  if(includeTomorrow){
    lines.push('');
    lines.push(`Mañana (${tomKey})`);
    lines.push('');
    if(tomEvents.length === 0){
      lines.push('Nada programado. Puede ser trampa.');
    } else {
      for(const ev of tomEvents) pushEventLine(ev);
    }
  }

  lines.push('');
  lines.push('Enviado por tu calendario (no garantiza que tú no lo ignores).');

  return { subject, body: lines.join('\n') };
}

// Persist dedupe store (reminders)
function loadSentStore(){
  try{
    const raw = localStorage.getItem(LS_SENT_KEY);
    if(!raw) return new Map();
    const obj = JSON.parse(raw);
    const m = new Map();
    for(const [k, v] of Object.entries(obj || {})){
      const t = Number(v);
      if(Number.isFinite(t)) m.set(k, t);
    }
    return m;
  }catch{
    return new Map();
  }
}

function saveSentStore(map){
  try{
    const obj = {};
    for(const [k, v] of map.entries()) obj[k] = v;
    localStorage.setItem(LS_SENT_KEY, JSON.stringify(obj));
  }catch{}
}

// Persist digest store (one per day)
function loadDigestStore(){
  try{
    const raw = localStorage.getItem(LS_DIGEST_KEY);
    if(!raw) return {};
    const obj = JSON.parse(raw);
    return (obj && typeof obj === 'object') ? obj : {};
  }catch{
    return {};
  }
}

function saveDigestStore(obj){
  try{
    localStorage.setItem(LS_DIGEST_KEY, JSON.stringify(obj || {}));
  }catch{}
}

export const reminders = (()=>{

  // wiring
  let getEvents = () => [];
  let getSettings = () => ({});
  let notifyCb = null;
  // optional backend sender: async ({to, subject, body, meta}) => { ok:true/false }
  let sendEmailCb = null;

  // runtime cfg
  let cfg = normCfg({});
  let timer = null;
  let lastTickMs = 0;

  // dedupe
  const sent = loadSentStore();
  const digestSent = loadDigestStore(); // { "YYYY-MM-DD": timestampMs }

  function init(opts = {}){
    getEvents = (typeof opts.getEvents === 'function') ? opts.getEvents : (()=>[]);
    getSettings = (typeof opts.getSettings === 'function') ? opts.getSettings : (()=>({}));
    notifyCb = (typeof opts.notify === 'function') ? opts.notify : null;
    sendEmailCb = (typeof opts.sendEmail === 'function') ? opts.sendEmail : null;

    refreshConfig();
  }

  function refreshConfig(){
    const s = getSettings?.() || {};
    cfg = normCfg(s);
  }

  function requestNotificationPermission(){
    if(!isNotificationsSupported()) return Promise.resolve('unsupported');
    return Notification.requestPermission();
  }

  function sendInApp(payload){
    if(notifyCb){
      try { notifyCb(payload); } catch (e) { console.warn(e); }
      return true;
    }
    console.log('[REMINDER]', payload.title, payload.body);
    return true;
  }

  function sendNotification(payload){
    if(!canNotify()) return false;
    try{
      const n = new Notification(payload.title, { body: payload.body });
      // click: enfoca pestaña
      n.onclick = () => {
        try{ window.focus(); }catch{}
      };
      return true;
    }catch(e){
      console.warn(e);
      return false;
    }
  }

  function dispatch(payload){
    const channel = cfg.channel;
    let ok = false;
    if(channel === 'notify' || channel === 'both') ok = sendNotification(payload) || ok;
    if(channel === 'inapp'  || channel === 'both') ok = sendInApp(payload) || ok;
    return ok;
  }

  function gcSent(nowMs){
    // Limpia dedupe viejo: 72h (un poquito más realista)
    const ttl = 72 * MS_HOUR;
    let changed = false;
    for(const [k, t] of sent.entries()){
      if(nowMs - t > ttl){
        sent.delete(k);
        changed = true;
      }
    }
    if(changed) saveSentStore(sent);
  }

  function gcDigest(nowMs){
    // Limpia entradas de digest viejas (30 días)
    const ttl = 30 * MS_DAY;
    let changed = false;
    for(const [k, t] of Object.entries(digestSent)){
      const tt = Number(t);
      if(!Number.isFinite(tt) || (nowMs - tt) > ttl){
        delete digestSent[k];
        changed = true;
      }
    }
    if(changed) saveDigestStore(digestSent);
  }

  // -------------------------
  // Tick: recordatorios evento
  // -------------------------
  function tick(){
    const now = new Date();
    const nowMs = now.getTime();

    // Throttle
    if(nowMs - lastTickMs < 400) return;
    lastTickMs = nowMs;

    refreshConfig();
    if(!cfg.enabled) return;

    // Quiet hours: bloquea notificaciones (pero deja el digest, si quieres)
    if(withinQuietHours(now, cfg.quiet)) return;

    const events = Array.isArray(getEvents?.()) ? getEvents() : [];
    if(!events.length) return;

    gcSent(nowMs);

    const sorted = sortByStart(events);

    const maxLead = Math.max(0, ...(cfg.leadMinutes || [0]));
    const horizonMs = (cfg.horizonDays * MS_DAY) + (maxLead * MS_MIN);
    const horizon = nowMs + horizonMs;

    const fireWindowMs = cfg.fireWindowSec * 1000;
    const graceAfterStartMs = cfg.graceAfterStartMin * MS_MIN;

    for(const ev of sorted){
      if(!shouldConsider(ev, cfg)) continue;

      const ts = getEventStartMs(ev);
      if(ts == null) continue;

      if(ts < (nowMs - graceAfterStartMs)) continue;
      if(ts > horizon) break; // sorted

      const leadList = getLeadMinutesForEvent(ev, cfg);
      if(!leadList || !leadList.length) continue;

      for(const leadMin of leadList){
        const fireAt = ts - (leadMin * MS_MIN);

        // ventana tolerante
        const delta = Math.abs(nowMs - fireAt);
        if(delta > fireWindowMs) continue;

        const k = reminderKey(ev, leadMin);
        if(sent.has(k)) continue;

        const startDate = new Date(ts);

        const payload = {
          level: (String(ev.priority || 'normal') === 'critico') ? 'critico' : 'normal',
          title: `⏰ ${eventLabel(ev)}`,
          body: buildBody(ev, startDate, leadMin),
          event: ev,
          leadMin,
          kind: 'event-reminder',
        };

        const ok = dispatch(payload);
        if(ok){
          sent.set(k, nowMs);
          saveSentStore(sent);
        }
      }
    }
  }

  // -------------------------
  // Tick: digest diario
  // -------------------------
  function tickDigest(){
    refreshConfig();
    if(cfg.emailDigest !== 'on') return;

    const now = new Date();
    const todayKey = ymd(now);

    // Si ya se “envió” hoy, no repetir.
    if(digestSent[todayKey]) return;

    // ¿Ya es la hora?
    const target = parseHHMM(cfg.emailDigestTime, '07:00');
    const [hh, mm] = target.split(':').map(Number);
    const targetDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);

    // Ventana de disparo: 2 minutos (por intervalos de 30s)
    const diff = now.getTime() - targetDate.getTime();
    if(diff < 0) return;
    if(diff > 2 * MS_MIN) return;

    // Dispara
    sendDailyDigestNow({ day: now, includeTomorrow: true }).catch((e)=>{
      console.warn('[digest] failed', e);
    });
  }

  async function sendDailyDigestNow({ to = null, day = new Date(), includeTomorrow = true } = {}){
    refreshConfig();

    const now = new Date();
    const key = ymd(day || now);
    const events = Array.isArray(getEvents?.()) ? getEvents() : [];
    const digest = buildEmailDigest({ day, events, includeTomorrow });

    const recipients = Array.isArray(to) ? uniqStr(to)
      : (cfg.emailDigestTo && cfg.emailDigestTo.length) ? cfg.emailDigestTo
      : [];

    // Si no hay destinatarios, igual se puede abrir mailto vacío (sirve para copiar/pegar)
    const payload = {
      to: recipients,
      subject: digest.subject,
      body: digest.body,
      meta: { day: key, createdAt: now.toISOString() }
    };

    let sentOk = false;

    if(sendEmailCb){
      // Backend sender (recomendado si quieres “seguro”)
      const res = await sendEmailCb(payload);
      sentOk = !!(res && (res.ok === true || res.sent === true));
    } else {
      // Fallback: mailto
      try{
        const url = mailtoUrl({ to: recipients, subject: digest.subject, body: digest.body });
        window.open(url, '_blank', 'noopener,noreferrer');
        sentOk = true; // “abrimos el correo”, no significa que lo enviaron
      }catch{
        sentOk = false;
      }
    }

    // Marcamos como “enviado” si al menos se disparó el flujo
    if(sentOk){
      digestSent[key] = Date.now();
      saveDigestStore(digestSent);

      // feedback in-app
      dispatch({
        title: '📩 Digest listo',
        body: sendEmailCb
          ? `Se envió el digest de hoy (${key}).`
          : `Abrí el correo del digest de hoy (${key}). Tú lo envías (humanos…).`,
        kind: 'digest',
        level: 'normal',
      });
    }

    return { ok: sentOk, mode: sendEmailCb ? 'sendEmail' : 'mailto', day: key, to: recipients };
  }

  // -------------------------
  // Public start/stop
  // -------------------------
  function start(){
    if(timer) return;
    // engancha de una
    try{ tick(); }catch{}
    try{ tickDigest(); }catch{}

    timer = setInterval(()=>{
      try{ tick(); }catch(e){ console.warn('[reminders.tick]', e); }
      try{ tickDigest(); }catch(e){ console.warn('[reminders.digest]', e); }
      try{ gcDigest(Date.now()); }catch{}
    }, 30 * 1000);
  }

  function stop(){
    if(timer){
      clearInterval(timer);
      timer = null;
    }
  }

  // Debug helpers
  function openEmailDigest({ to = [], day = new Date(), events = null, includeTomorrow = true } = {}){
    const list = Array.isArray(events) ? events : (Array.isArray(getEvents?.()) ? getEvents() : []);
    const digest = buildEmailDigest({ day, events: list, includeTomorrow });

    const url = mailtoUrl({
      to,
      subject: digest.subject,
      body: digest.body
    });

    window.open(url, '_blank', 'noopener,noreferrer');
    return true;
  }

  return {
    init,
    start,
    stop,

    tick,        // manual (debug)
    tickDigest,  // manual (debug)

    requestNotificationPermission,

    // digest
    buildEmailDigest,
    openEmailDigest,
    sendDailyDigestNow,
  };

})();