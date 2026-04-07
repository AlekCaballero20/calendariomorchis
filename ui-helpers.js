// ui-helpers.js - pure helpers used by ui.js

'use strict';

import { getDefaultCategories, pad2, safeDate } from './shared.js';

export const DAYS = ['Dom', 'Lun', 'Mar', 'Mie', 'Jue', 'Vie', 'Sab'];
export const MONTHS = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
export const DEFAULT_CATEGORIES = getDefaultCategories();

export function toISOInputValue(dateLike){
  if(!dateLike) return '';
  const d = safeDate(dateLike);
  if(!d) return '';
  const yyyy = d.getFullYear();
  const mm = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  const hh = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

export function startOfMonth(y, m){ return new Date(y, m, 1, 0, 0, 0, 0); }
export function endOfMonth(y, m){ return new Date(y, m + 1, 0, 23, 59, 59, 999); }

export function startOfDay(d){
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function endOfDay(d){
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

export function startOfWeekSunday(d){
  const x = startOfDay(d);
  x.setDate(x.getDate() - x.getDay());
  return x;
}

export function endOfWeekSaturday(d){
  const x = startOfWeekSunday(d);
  x.setDate(x.getDate() + 6);
  return endOfDay(x);
}

export function sameDay(a, b){
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

export function inRange(date, start, end){
  const t = date.getTime();
  return t >= start.getTime() && t <= end.getTime();
}

export function formatTime(d){
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function formatLongDate(d){
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

export function formatMediumDate(d){
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

export function formatWeekRange(start, end){
  if(!start || !end) return '-';
  if(start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear()){
    return `${start.getDate()} - ${end.getDate()} ${MONTHS[start.getMonth()]} ${start.getFullYear()}`;
  }
  if(start.getFullYear() === end.getFullYear()){
    return `${start.getDate()} ${MONTHS[start.getMonth()]} - ${end.getDate()} ${MONTHS[end.getMonth()]} ${start.getFullYear()}`;
  }
  return `${formatMediumDate(start)} - ${formatMediumDate(end)}`;
}

export function dayKey(d){
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function monthKeyFromYM(y, m){
  return `${y}-${pad2(m + 1)}`;
}

export function weekKeyFromSunday(sun){
  return dayKey(sun);
}

export function isMobile(){
  return window.matchMedia('(max-width: 640px)').matches;
}

export function isTabletDown(){
  return window.matchMedia('(max-width: 920px)').matches;
}

export function getMonthMaxBadges(){
  return isMobile() ? 2 : 3;
}

export function getWeekMaxBadges(){
  return isMobile() ? 3 : 4;
}

export function normalizeRepeat(freq, interval){
  const f = String(freq || 'none').toLowerCase().trim();
  const allowed = new Set(['none', 'daily', 'weekly', 'monthly', 'yearly']);
  const safeFreq = allowed.has(f) ? f : 'none';

  let n = Number(interval);
  if(!Number.isFinite(n) || n <= 0) n = 1;
  n = Math.min(3650, Math.max(1, Math.floor(n)));

  if(safeFreq === 'none') return null;
  return { freq: safeFreq, interval: n };
}

export function parseRemindersInput(raw){
  const s = String(raw ?? '').trim();
  if(!s) return [];
  const parts = s.split(',').map(x => x.trim()).filter(Boolean);

  const nums = [];
  for(const p of parts){
    const n = Number(p);
    if(!Number.isFinite(n)) continue;
    const nn = Math.floor(n);
    if(nn < 0) continue;
    if(nn > 43200) continue;
    nums.push(nn);
  }

  return Array.from(new Set(nums)).sort((a, b) => a - b).slice(0, 8);
}

export function remindersToInput(arr){
  if(!Array.isArray(arr) || !arr.length) return '';
  return arr
    .map(n => String(Math.floor(Number(n) || 0)))
    .filter(Boolean)
    .join(', ');
}

export function escapeText(s){
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function getFocusable(container){
  if(!container) return [];
  return Array.from(container.querySelectorAll(
    'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])'
  ));
}

export function normKey(s){
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 30);
}

export function uniqKey(base, existing){
  let k = base || 'categoria';
  if(!existing.has(k)) return k;
  let i = 2;
  while(existing.has(`${k}_${i}`) && i < 999) i++;
  return `${k}_${i}`;
}

export function readDigestEvidence(lsKey){
  try{
    const raw = localStorage.getItem(lsKey);
    if(!raw) return null;
    const obj = JSON.parse(raw);
    if(!obj || typeof obj !== 'object') return null;

    let last = null;
    for(const v of Object.values(obj)){
      const n = Number(v);
      if(Number.isFinite(n)) last = Math.max(last || 0, n);
      else{
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

export function createDiv(className, text){
  const el = document.createElement('div');
  if(className) el.className = className;
  if(text != null) el.textContent = text;
  return el;
}

export function createBtn({ id = '', className = 'btn', text = '', type = 'button', title = '', ariaLabel = '' } = {}){
  const btn = document.createElement('button');
  btn.type = type;
  btn.className = className;
  if(id) btn.id = id;
  if(text) btn.textContent = text;
  if(title) btn.title = title;
  if(ariaLabel) btn.setAttribute('aria-label', ariaLabel);
  return btn;
}

export function createPill(text){
  const el = createDiv('pill', text);
  el.style.boxShadow = 'none';
  return el;
}

export function createMuted(text){
  return createDiv('muted', text);
}

export function eventStart(ev){
  return safeDate(ev?.start);
}

export function eventEnd(ev){
  return safeDate(ev?.end);
}

export function eventCategoryLabel(ev, categories){
  const key = String(ev?.category || 'personal');
  return categories?.[key]?.label || key;
}

export function sortEventsByStart(list){
  return list.slice().sort((a, b) => {
    const da = eventStart(a)?.getTime() ?? 0;
    const db = eventStart(b)?.getTime() ?? 0;
    return da - db;
  });
}

export function normalizeView(view){
  return ['month', 'week', 'agenda'].includes(view) ? view : 'month';
}
