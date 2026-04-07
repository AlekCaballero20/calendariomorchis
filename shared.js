export function pad2(n){
  return String(n).padStart(2, '0');
}

export function safeDate(v){
  if(!v) return null;
  if(typeof v === 'string'){
    const s = v.trim();
    const dayOnly = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if(dayOnly){
      const year = Number(dayOnly[1]);
      const month = Number(dayOnly[2]) - 1;
      const day = Number(dayOnly[3]);
      const d = new Date(year, month, day, 0, 0, 0, 0);
      return Number.isNaN(d.getTime()) ? null : d;
    }
  }
  const d = (v instanceof Date) ? new Date(v) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function asOnOff(value){
  return value === 'off' ? 'off' : 'on';
}

const BASE_CATEGORIES = Object.freeze({
  personal: { label: 'Personal' },
  salud: { label: 'Salud' },
  finanzas: { label: 'Finanzas' },
  familia: { label: 'Familia' },
  cumple: { label: 'Cumpleanos' },
  experiencias: { label: 'Experiencias' },
});

const HOLIDAY_CATEGORY = Object.freeze({
  holiday: { label: 'Festivos CO' },
});

export function getDefaultCategories({ includeHoliday = false } = {}){
  return includeHoliday
    ? { ...BASE_CATEGORIES, ...HOLIDAY_CATEGORY }
    : { ...BASE_CATEGORIES };
}
