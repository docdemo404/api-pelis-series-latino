import { CloudStore } from './cloudStore';

export interface MediaOverride {
  custom_poster?: string | null;
  custom_backdrop?: string | null;
  custom_title?: string | null;
  updated_at?: string;
}

let overridesCache: Record<string, MediaOverride> = {};
let isInitialized = false;
let loading: Promise<void> | null = null;

// Carga perezosa desde la nube: evita una llamada de red en el import (cold start).
// Se dispara en el primer acceso real a los overrides, no al cargar el módulo.
function ensureLoaded(): void {
  if (isInitialized || loading) return;
  loading = CloudStore.getOverrides()
    .then(ov => { if (ov) overridesCache = ov; })
    .catch(() => {})
    .then(() => { isInitialized = true; loading = null; });
}

export class OverrideService {
  static getOverride(key: string | number): MediaOverride | null {
    ensureLoaded();
    const k = String(key).toLowerCase().trim();
    return overridesCache[k] || null;
  }

  static getAllOverrides(): Record<string, MediaOverride> {
    ensureLoaded();
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

    // Guardar en nube y disco local
    CloudStore.saveOverride(k, updated).catch(err => {
      console.warn('[OverrideService] Cloud save error:', err);
    });

    return updated;
  }

  static removeOverride(key: string | number): boolean {
    const k = String(key).toLowerCase().trim();
    if (overridesCache[k]) {
      delete overridesCache[k];
      CloudStore.deleteOverride(k).catch(() => {});
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
