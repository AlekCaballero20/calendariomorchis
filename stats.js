// stats.js - frontend settings store

'use strict';

import { mergeWithDefaults, normalizeSettings, settingsDefaults } from './settings.js';

function clone(value){
  return JSON.parse(JSON.stringify(value || {}));
}

function hasOwn(obj, key){
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function normStr(value, max = 60){
  const s = String(value ?? '').trim();
  if(!s) return '';
  return s.length > max ? s.slice(0, max) : s;
}

function normalizePatch(patch = {}){
  const src = (patch && typeof patch === 'object') ? patch : {};
  const next = { ...src };

  if(hasOwn(src, 'categories') && (!src.categories || typeof src.categories !== 'object')){
    next.categories = clone(settingsDefaults.categories);
  }

  if(hasOwn(src, 'reminders') && (!src.reminders || typeof src.reminders !== 'object')){
    next.reminders = clone(settingsDefaults.reminders);
  }

  return next;
}

let state = mergeWithDefaults({});
const listeners = new Set();

function notify(){
  const snapshot = settings.get();
  for(const fn of listeners){
    try{
      fn(snapshot);
    }catch(err){
      console.warn('[settings.subscribe]', err);
    }
  }
}

function shallowEqualTop(a, b){
  if(a === b) return true;
  if(!a || !b) return false;

  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if(aKeys.length !== bKeys.length) return false;

  for(const key of aKeys){
    if(a[key] !== b[key]) return false;
  }
  return true;
}

export const settings = {
  set(next = {}){
    const prev = state;
    state = mergeWithDefaults(next);
    if(!shallowEqualTop(prev, state)) notify();
    return settings.get();
  },

  patch(patch = {}){
    const normalizedPatch = normalizePatch(patch);
    return settings.set({
      ...state,
      ...normalizedPatch,
    });
  },

  get(){
    return clone(state);
  },

  reset(){
    const prev = state;
    state = mergeWithDefaults({});
    if(!shallowEqualTop(prev, state)) notify();
    return settings.get();
  },

  subscribe(fn){
    if(typeof fn !== 'function') return () => {};
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  getCategories(){
    return clone(state.categories || {});
  },

  ensureCategory(key, label){
    const k = normStr(key, 50);
    if(!k) return settings.get();

    const categories = clone(state.categories || {});
    if(!categories[k]){
      categories[k] = { label: normStr(label || k, 60) || k };
      return settings.patch({ categories });
    }

    return settings.get();
  },

  isHolidaysEnabled(){
    return state.holidaysCO === 'on';
  },

  isEmailDigestEnabled(){
    return state.emailDigest === 'on';
  },

  init(initial = {}){
    return settings.set(initial);
  },

  update(patch = {}){
    return settings.patch(patch);
  },

  normalize(input = {}){
    return mergeWithDefaults(normalizeSettings(input));
  },
};
