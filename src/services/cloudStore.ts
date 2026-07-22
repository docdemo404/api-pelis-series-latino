import axios from 'axios';
import { SourceConfig } from './sourceManager';
import { MediaOverride } from './overrideService';

// ─── Credenciales desde variables de entorno (nunca hardcodeadas) ────────────
const VERCEL_TOKEN = () => process.env.VERCEL_API_TOKEN || '';
const VERCEL_PROJECT_ID = () => process.env.VERCEL_PROJECT_ID || '';
const VERCEL_TEAM_ID = () => process.env.VERCEL_TEAM_ID || '';
const VERCEL_API = 'https://api.vercel.com';

const DEFAULT_SOURCES: SourceConfig[] = [
  { id: 'tioplus', name: 'TioPlus / PelisPlus Latino', enabled: true, priority: 1 },
  { id: 'fuegocine', name: 'FuegoCine', enabled: true, priority: 2 },
  { id: 'supabase', name: 'Base de Datos Supabase', enabled: true, priority: 3 }
];

// Cache en memoria (válido durante el proceso serverless)
let cachedSources: SourceConfig[] | null = null;
let cachedOverrides: Record<string, MediaOverride> | null = null;

// ─── Helpers Vercel Env API ─────────────────────────────────────────────────

async function getVercelEnv(key: string): Promise<string | null> {
  const token = VERCEL_TOKEN();
  const projectId = VERCEL_PROJECT_ID();
  const teamId = VERCEL_TEAM_ID();
  if (!token || !projectId) return null;

  try {
    const teamParam = teamId ? `&teamId=${teamId}` : '';
    const { data } = await axios.get(
      `${VERCEL_API}/v9/projects/${projectId}/env?${teamParam}`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 5000 }
    );
    const envVar = data.envs?.find((e: any) => e.key === key);
    if (!envVar) return null;

    // Las env vars encriptadas requieren GET separado al ID del valor
    const valRes = await axios.get(
      `${VERCEL_API}/v9/projects/${projectId}/env/${envVar.id}?${teamParam}`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 5000 }
    );
    return valRes.data?.value ?? null;
  } catch {
    return null;
  }
}

async function setVercelEnv(key: string, value: string): Promise<void> {
  const token = VERCEL_TOKEN();
  const projectId = VERCEL_PROJECT_ID();
  const teamId = VERCEL_TEAM_ID();
  if (!token || !projectId) return;

  const teamParam = teamId ? `?teamId=${teamId}` : '';
  const teamParamAmp = teamId ? `&teamId=${teamId}` : '';

  try {
    const { data } = await axios.get(
      `${VERCEL_API}/v9/projects/${projectId}/env${teamParam}`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 5000 }
    );
    const existing = data.envs?.find((e: any) => e.key === key);

    if (existing) {
      await axios.patch(
        `${VERCEL_API}/v9/projects/${projectId}/env/${existing.id}${teamParam}`,
        { value, target: ['production', 'preview', 'development'], type: 'encrypted' },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 5000 }
      );
    } else {
      await axios.post(
        `${VERCEL_API}/v10/projects/${projectId}/env${teamParamAmp ? '?' + teamParamAmp.slice(1) : ''}`,
        [{ key, value, target: ['production', 'preview', 'development'], type: 'encrypted' }],
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 5000 }
      );
    }
  } catch (err: any) {
    console.warn('[CloudStore] Vercel env save error:', err?.response?.data || err.message);
  }
}

// ─── CloudStore principal ────────────────────────────────────────────────────

export class CloudStore {
  /**
   * Carga fuentes — prioridad: memoria → env del proceso → Vercel API
   */
  static async getSources(): Promise<SourceConfig[]> {
    if (cachedSources) return [...cachedSources];

    // 1. Env var inyectada por Vercel en runtime (tras redeploy)
    const envVal = process.env.APP_SOURCES_CONFIG;
    if (envVal) {
      try {
        const parsed = JSON.parse(envVal);
        if (Array.isArray(parsed) && parsed.length > 0) {
          cachedSources = parsed.sort((a: SourceConfig, b: SourceConfig) => a.priority - b.priority);
          return [...cachedSources];
        }
      } catch {}
    }

    // 2. Leer desde la Vercel API (no requiere redeploy, siempre actualizado)
    try {
      const raw = await getVercelEnv('APP_SOURCES_CONFIG');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          cachedSources = parsed.sort((a: SourceConfig, b: SourceConfig) => a.priority - b.priority);
          return [...cachedSources];
        }
      }
    } catch {}

    cachedSources = [...DEFAULT_SOURCES];
    return [...cachedSources];
  }

  /**
   * Guarda fuentes en Vercel env var (persistente entre deploys)
   */
  static async saveSources(sources: SourceConfig[]): Promise<void> {
    const sorted = [...sources].sort((a, b) => a.priority - b.priority);
    cachedSources = sorted;
    await setVercelEnv('APP_SOURCES_CONFIG', JSON.stringify(sorted));
  }

  /**
   * Carga overrides — prioridad: memoria → env del proceso → Vercel API
   */
  static async getOverrides(): Promise<Record<string, MediaOverride>> {
    if (cachedOverrides) return { ...cachedOverrides };

    const envVal = process.env.APP_OVERRIDES_CONFIG;
    if (envVal) {
      try {
        const parsed = JSON.parse(envVal);
        if (parsed && typeof parsed === 'object') {
          cachedOverrides = parsed as Record<string, MediaOverride>;
          return { ...cachedOverrides };
        }
      } catch {}
    }

    try {
      const raw = await getVercelEnv('APP_OVERRIDES_CONFIG');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          cachedOverrides = parsed as Record<string, MediaOverride>;
          return { ...cachedOverrides };
        }
      }
    } catch {}

    cachedOverrides = {};
    return {};
  }

  /**
   * Guarda un override de portada
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
    await setVercelEnv('APP_OVERRIDES_CONFIG', JSON.stringify(current));
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
      await setVercelEnv('APP_OVERRIDES_CONFIG', JSON.stringify(current));
      return true;
    }
    return false;
  }
}
