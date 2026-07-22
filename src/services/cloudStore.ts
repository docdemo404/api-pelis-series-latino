import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { SourceConfig } from './sourceManager';
import { MediaOverride } from './overrideService';

const CLOUD_OBJECT_ID = 'ff8081819f7e10ae019f880dc30d0f6b';
const CLOUD_URL = `https://api.restful-api.dev/objects/${CLOUD_OBJECT_ID}`;

const SOURCES_FILE = path.join(__dirname, '../data/sources.json');
const OVERRIDES_FILE = path.join(__dirname, '../data/overrides.json');

const DEFAULT_SOURCES: SourceConfig[] = [
  { id: 'tioplus', name: 'TioPlus / PelisPlus Latino', enabled: true, priority: 1 },
  { id: 'fuegocine', name: 'FuegoCine', enabled: true, priority: 2 },
  { id: 'supabase', name: 'Base de Datos Supabase', enabled: true, priority: 3 }
];

let cachedSources: SourceConfig[] | null = null;
let cachedOverrides: Record<string, MediaOverride> | null = null;
let lastCloudSync = 0;
const CLOUD_SYNC_TTL = 30000; // 30s cache

export class CloudStore {
  /**
   * Carga las fuentes desde la nube o archivo local con caché en memoria
   */
  static async getSources(): Promise<SourceConfig[]> {
    if (cachedSources && Date.now() - lastCloudSync < CLOUD_SYNC_TTL) {
      return [...cachedSources];
    }

    try {
      const res = await axios.get(CLOUD_URL, { timeout: 4000 });
      const cloudSources = res.data?.data?.sources;
      if (Array.isArray(cloudSources) && cloudSources.length > 0) {
        cachedSources = cloudSources.sort((a, b) => a.priority - b.priority);
        lastCloudSync = Date.now();
        this.saveLocalSources(cachedSources);
        return [...cachedSources];
      }
    } catch (err) {
      // Fallback a local o memoria
    }

    if (!cachedSources) {
      cachedSources = this.loadLocalSources();
    }
    return [...cachedSources];
  }

  /**
   * Guarda las fuentes en la nube y localmente
   */
  static async saveSources(sources: SourceConfig[]): Promise<void> {
    cachedSources = [...sources].sort((a, b) => a.priority - b.priority);
    this.saveLocalSources(cachedSources);

    try {
      const overrides = await this.getOverrides();
      await axios.put(CLOUD_URL, {
        name: 'api_pelis_config',
        data: {
          sources: cachedSources,
          overrides
        }
      }, { timeout: 5000 });
      lastCloudSync = Date.now();
    } catch (err: any) {
      console.warn('[CloudStore] Warning al guardar fuentes en la nube:', err.message);
    }
  }

  /**
   * Carga los overrides de portadas desde la nube
   */
  static async getOverrides(): Promise<Record<string, MediaOverride>> {
    if (cachedOverrides && Date.now() - lastCloudSync < CLOUD_SYNC_TTL) {
      return { ...cachedOverrides };
    }

    try {
      const res = await axios.get(CLOUD_URL, { timeout: 4000 });
      const cloudOverrides = res.data?.data?.overrides;
      if (cloudOverrides && typeof cloudOverrides === 'object') {
        cachedOverrides = cloudOverrides as Record<string, MediaOverride>;
        lastCloudSync = Date.now();
        this.saveLocalOverrides(cachedOverrides);
        return { ...cachedOverrides };
      }
    } catch (err) {}

    if (!cachedOverrides) {
      cachedOverrides = this.loadLocalOverrides();
    }
    return { ...cachedOverrides };
  }

  /**
   * Guarda un override de portada en la nube y localmente
   */
  static async saveOverride(key: string | number, override: MediaOverride): Promise<void> {
    const k = String(key).toLowerCase().trim();
    const current = await this.getOverrides();
    current[k] = {
      ...current[k],
      ...override,
      updated_at: new Date().toISOString()
    };
    cachedOverrides = current;
    this.saveLocalOverrides(cachedOverrides);

    try {
      const sources = await this.getSources();
      await axios.put(CLOUD_URL, {
        name: 'api_pelis_config',
        data: {
          sources,
          overrides: cachedOverrides
        }
      }, { timeout: 5000 });
      lastCloudSync = Date.now();
    } catch (err: any) {
      console.warn('[CloudStore] Warning al guardar override en la nube:', err.message);
    }
  }

  /**
   * Elimina un override de portada
   */
  static async deleteOverride(key: string | number): Promise<boolean> {
    const k = String(key).toLowerCase().trim();
    const current = await this.getOverrides();
    if (current[k]) {
      delete current[k];
      cachedOverrides = current;
      this.saveLocalOverrides(cachedOverrides);

      try {
        const sources = await this.getSources();
        await axios.put(CLOUD_URL, {
          name: 'api_pelis_config',
          data: {
            sources,
            overrides: cachedOverrides
          }
        }, { timeout: 5000 });
        lastCloudSync = Date.now();
      } catch (err) {}
      return true;
    }
    return false;
  }

  // --- Auxiliares para lectura/escritura de archivos locales ---
  private static loadLocalSources(): SourceConfig[] {
    try {
      if (fs.existsSync(SOURCES_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(SOURCES_FILE, 'utf8'));
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch (e) {}
    return DEFAULT_SOURCES;
  }

  private static saveLocalSources(sources: SourceConfig[]) {
    try {
      const dir = path.dirname(SOURCES_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(SOURCES_FILE, JSON.stringify(sources, null, 2), 'utf8');
    } catch (e) {}
  }

  private static loadLocalOverrides(): Record<string, MediaOverride> {
    try {
      if (fs.existsSync(OVERRIDES_FILE)) {
        return JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8')) || {};
      }
    } catch (e) {}
    return {};
  }

  private static saveLocalOverrides(overrides: Record<string, MediaOverride>) {
    try {
      const dir = path.dirname(OVERRIDES_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(OVERRIDES_FILE, JSON.stringify(overrides, null, 2), 'utf8');
    } catch (e) {}
  }
}
