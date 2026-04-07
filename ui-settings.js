// ui-settings.js - pure helpers for settings/category state in ui.js

'use strict';

import { asOnOff } from './shared.js';

export function normalizeEmailDigestTime(value, fallback = '07:00'){
  return (typeof value === 'string' && /^\d{2}:\d{2}$/.test(value))
    ? value
    : fallback;
}

export function getEffectiveCategories(settingsCategories, categories, defaultCategories){
  if(settingsCategories && typeof settingsCategories === 'object'){
    return { ...settingsCategories };
  }
  if(categories && typeof categories === 'object'){
    return { ...categories };
  }
  return { ...defaultCategories };
}

export function ensurePersonalCategory(categories){
  const next = (categories && typeof categories === 'object') ? { ...categories } : {};
  if(!next.personal) next.personal = { label: 'Personal' };
  return next;
}

export function ensureCategoryFilters(filters, categories){
  const next = { ...(filters || {}) };
  for(const key of Object.keys(categories || {})){
    if(typeof next[key] !== 'boolean') next[key] = true;
  }
  return next;
}

export function sortCategoryKeys(categories){
  return Object.keys(categories || {}).slice().sort((a, b) => {
    if(a === 'personal') return -1;
    if(b === 'personal') return 1;
    return a.localeCompare(b);
  });
}

export function buildSettingsStateUpdate(currentSettings, incoming, categoriesFallback){
  const categories = getEffectiveCategories(
    incoming?.categories,
    categoriesFallback,
    categoriesFallback
  );

  return {
    ...currentSettings,
    holidaysCO: asOnOff(incoming?.holidaysCO),
    emailDigest: asOnOff(incoming?.emailDigest),
    emailDigestTime: normalizeEmailDigestTime(
      incoming?.emailDigestTime,
      currentSettings?.emailDigestTime || '07:00'
    ),
    categories,
  };
}

export function buildSettingsPayload(values, categories){
  return {
    holidaysCO: asOnOff(values?.holidaysCO),
    emailDigest: asOnOff(values?.emailDigest),
    emailDigestTime: normalizeEmailDigestTime(values?.emailDigestTime, '07:00'),
    categories: ensurePersonalCategory(categories),
  };
}
