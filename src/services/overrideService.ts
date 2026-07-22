import fs from 'fs';
import path from 'path';

export interface MediaOverride {
  custom_poster?: string | null;
  custom_backdrop?: string | null;
  custom_title?: string | null;
  updated_at?: string;
}

const OVERRIDES_FILE = path.join(__dirname, '../data/overrides.json');

let overridesCache: Record<string, MediaOverride> = loadOverrides();

function loadOverrides(): Record<string, MediaOverride> {
  try {
    if (fs.existsSync(OVERRIDES_FILE)) {
      const content = fs.readFileSync(OVERRIDES_FILE, 'utf8');
      return JSON.parse(content) || {};
    }
  } catch (err) {
    console.warn('[OverrideService] Error leyendo overrides.json:', err);
  }
  return {};
}

function saveOverrides(data: Record<string, MediaOverride>) {
  try {
    const dir = path.dirname(OVERRIDES_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(OVERRIDES_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.warn('[OverrideService] Error guardando overrides.json:', err);
  }
}

export class OverrideService {
  static getOverride(key: string | number): MediaOverride | null {
    const k = String(key).toLowerCase().trim();
    return overridesCache[k] || null;
  }

  static getAllOverrides(): Record<string, MediaOverride> {
    return { ...overridesCache };
  }

  static setOverride(key: string | number, override: MediaOverride): MediaOverride {
    const k = String(key).toLowerCase().trim();
    const existing = overridesCache[k] || {};
    const updated: MediaOverride = {
      ...existing,
      ...override,
      updated_at: new Date().toISOString()
    };
    overridesCache[k] = updated;
    saveOverrides(overridesCache);
    return updated;
  }

  static removeOverride(key: string | number): boolean {
    const k = String(key).toLowerCase().trim();
    if (overridesCache[k]) {
      delete overridesCache[k];
      saveOverrides(overridesCache);
      return true;
    }
    return false;
  }

  static applyOverridesToItem(item: any): any {
    if (!item) return item;
    const keysToTry = [String(item.id), String(item.tmdb_id)].filter(Boolean);
    for (const key of keysToTry) {
      const ov = this.getOverride(key);
      if (ov) {
        if (ov.custom_poster) item.poster = ov.custom_poster;
        if (ov.custom_backdrop) item.backdrop = ov.custom_backdrop;
        if (ov.custom_title) item.title = ov.custom_title;
      }
    }
    return item;
  }
}
